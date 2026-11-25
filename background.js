// Service worker: opens the side panel and relays commands to the active tab.
'use strict';

const DEFAULT_SETTINGS = { wpm: 65, typoRate: 3, pauseScale: 1, countdown: 3, focusDelay: 1.2 };

// ---- real key events (optional) ----------------------------------------------
// Two ways to press real keys instead of inserting text by script:
//  - 'debugger': Chrome's debugger protocol. Chrome shows its "is debugging
//    this browser" banner while it runs.
//  - 'system': a small Windows helper program presses the keys through the
//    operating system (see native/). Needs a one-time install.

// Older saved settings only have the realKeys checkbox.
const keyModeOf = (settings) => settings.keyMode || (settings.realKeys ? 'debugger' : 'script');
const runMode = new Map(); // tabId -> 'debugger' | 'system'

const SHIFT = 8;
const KEY_MAP = (() => {
  const map = {};
  const add = (ch, code, vk, shift) => {
    map[ch] = { code, vk, shift };
  };
  for (let i = 0; i < 26; i++) {
    const up = String.fromCharCode(65 + i);
    add(up.toLowerCase(), 'Key' + up, 65 + i, false);
    add(up, 'Key' + up, 65 + i, true);
  }
  const digitShift = ')!@#$%^&*(';
  for (let d = 0; d < 10; d++) {
    add(String(d), 'Digit' + d, 48 + d, false);
    add(digitShift[d], 'Digit' + d, 48 + d, true);
  }
  add(' ', 'Space', 32, false);
  const punct = [
    ['-', '_', 'Minus', 189], ['=', '+', 'Equal', 187], ['[', '{', 'BracketLeft', 219],
    [']', '}', 'BracketRight', 221], ['\\', '|', 'Backslash', 220], [';', ':', 'Semicolon', 186],
    ["'", '"', 'Quote', 222], [',', '<', 'Comma', 188], ['.', '>', 'Period', 190],
    ['/', '?', 'Slash', 191], ['`', '~', 'Backquote', 192]
  ];
  for (const [plain, shifted, code, vk] of punct) {
    add(plain, code, vk, false);
    add(shifted, code, vk, true);
  }
  return map;
})();

const LEFT_HAND = new Set([
  'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Backquote'
]);
// Keys pressed with the little finger are held a bit longer.
const PINKY = new Set([
  'KeyQ', 'KeyA', 'KeyZ', 'KeyP', 'Semicolon', 'Slash', 'Quote', 'Backquote', 'Digit1', 'Digit0', 'Minus', 'Equal',
  'BracketLeft', 'BracketRight', 'Backslash', 'Backspace', 'Enter'
]);

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Sends one key event (debugger-protocol shape, plus the hardware scan code).
function keyCmd(tabId, params) {
  const { scan, ...cdp } = params;
  if (runMode.get(tabId) === 'system') return sysSend({ op: 'key', scan, down: params.type !== 'keyUp' });
  return chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', cdp);
}

// ---- system keys: the Windows helper -------------------------------------------

const SYS_HOST = 'com.autotyper.keys';
const SCAN = { ShiftLeft: 0x2a, ShiftRight: 0x36, Backspace: 0x0e, Enter: 0x1c };
let sysPort = null;
let sysSeq = 0;
let sysMap = {}; // character -> [scan code, needs Shift] for the active keyboard layout
const sysWaiting = new Map();

function sysSend(msg) {
  return new Promise((resolve, reject) => {
    if (!sysPort) return reject(new Error('the key helper is not connected'));
    const id = ++sysSeq;
    sysWaiting.set(id, { resolve, reject });
    sysPort.postMessage(Object.assign({ id }, msg));
  });
}

async function sysConnect() {
  sysClose();
  const port = chrome.runtime.connectNative(SYS_HOST);
  sysPort = port;
  port.onMessage.addListener((msg) => {
    const w = sysWaiting.get(msg && msg.id);
    if (!w) return;
    sysWaiting.delete(msg.id);
    if (msg.ok) return w.resolve(msg);
    const err = new Error(msg.error || 'key helper error');
    err.retry = !!msg.retry;
    w.reject(err);
  });
  port.onDisconnect.addListener(() => {
    const text = (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'the key helper closed';
    if (sysPort === port) sysPort = null;
    for (const w of sysWaiting.values()) w.reject(new Error(text));
    sysWaiting.clear();
  });
  const hello = await Promise.race([
    sysSend({ op: 'hello' }),
    pause(5000).then(() => {
      throw new Error('the key helper did not answer');
    })
  ]);
  sysMap = hello.map || {};
}

function sysClose() {
  const port = sysPort;
  if (!port) return;
  sysPort = null;
  try {
    // The helper also releases held keys by itself when the connection closes.
    port.postMessage({ id: 0, op: 'reset' });
    port.disconnect();
  } catch (_) {
    /* already closed */
  }
}

function gauss() {
  let u = 0;
  while (u === 0) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
}

// How long a key stays down: shorter for faster typists, varied per press.
function holdTime(code, wpm) {
  const mean = Math.min(110, Math.max(55, 110 - (Number(wpm) || 65) * 0.35));
  let h = mean * Math.exp(0.25 * gauss() - 0.03125);
  if (PINKY.has(code)) h *= 1.15;
  if (code === 'Space') h *= 1.1;
  return Math.min(220, Math.max(30, h));
}

// Keys still waiting for their release: "tabId:code" -> function that releases it now.
const pendingUp = new Map();

function releaseAll(tabId) {
  for (const [id, fire] of [...pendingUp]) if (id.startsWith(tabId + ':')) fire();
}

async function pressKey(tabId, down, up, msg) {
  // The typing plan says how long each key is held; older plans leave it to holdTime.
  const planned = Number(msg.h);
  const hold = planned > 0 ? Math.min(300, Math.max(20, planned)) : holdTime(down.code, msg.wpm);
  const id = tabId + ':' + down.code;
  // One finger, one key: the same key is released before it is pressed again.
  const prior = pendingUp.get(id);
  if (prior) await prior();
  await keyCmd(tabId, down);
  // Release a moment later, like a finger leaving the key.
  const fire = () => {
    clearTimeout(timer);
    pendingUp.delete(id);
    return keyCmd(tabId, up).catch(() => {});
  };
  const timer = setTimeout(fire, hold);
  pendingUp.set(id, fire);
}

// ---- Shift key ---------------------------------------------------------------
// Capitals and symbols get a real Shift press: down before the key, up shortly
// after, and held across a run of shifted characters.

const shiftState = new Map(); // tabId -> { held, side, timer }

function shiftEvent(type, side) {
  const left = side === 'L';
  return {
    type,
    key: 'Shift',
    code: left ? 'ShiftLeft' : 'ShiftRight',
    scan: left ? SCAN.ShiftLeft : SCAN.ShiftRight,
    windowsVirtualKeyCode: 16,
    nativeVirtualKeyCode: 16,
    location: left ? 1 : 2,
    modifiers: type === 'keyUp' ? 0 : SHIFT
  };
}

// habit: this typist's way with Shift (which side, how early down, how late up).
async function setShift(tabId, want, code, habit) {
  const h = habit || {};
  const spread = (ms) => Math.min(ms * 2.5, Math.max(ms * 0.45, ms * Math.exp(0.3 * gauss())));
  let st = shiftState.get(tabId);
  if (!st) {
    st = { held: false, side: 'L', timer: 0 };
    shiftState.set(tabId, st);
  }
  clearTimeout(st.timer);
  st.timer = 0;
  if (want && !st.held) {
    // Touch typists use the Shift on the opposite hand.
    st.side = h.side === 'L' ? 'L' : LEFT_HAND.has(code) ? 'R' : 'L';
    await keyCmd(tabId, shiftEvent('rawKeyDown', st.side));
    st.held = true;
    await pause(spread(Number(h.lead) || 52));
  } else if (!want && st.held) {
    st.held = false;
    await keyCmd(tabId, shiftEvent('keyUp', st.side));
  }
  if (want) {
    st.timer = setTimeout(() => {
      st.held = false;
      st.timer = 0;
      keyCmd(tabId, shiftEvent('keyUp', st.side)).catch(() => {});
    }, spread(Number(h.lag) || 165));
  }
}

async function realKey(tabId, msg) {
  const system = runMode.get(tabId) === 'system';
  if (msg.op === 'del') {
    await setShift(tabId, false);
    const k = { key: 'Backspace', code: 'Backspace', scan: SCAN.Backspace, windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
    return pressKey(tabId, Object.assign({ type: 'rawKeyDown' }, k), Object.assign({ type: 'keyUp' }, k), msg);
  }
  const ch = msg.ch;
  if (ch === '\n') {
    // Shift+Enter: a new line that does not submit a form or send a chat message.
    await setShift(tabId, true, 'Enter', msg.s);
    const k = { key: 'Enter', code: 'Enter', scan: SCAN.Enter, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: SHIFT };
    return pressKey(tabId, Object.assign({ type: 'keyDown', text: '\r' }, k), Object.assign({ type: 'keyUp' }, k), msg);
  }
  let info = KEY_MAP[ch];
  if (system) {
    // Use the key the active keyboard layout really has for this character.
    const sys = sysMap[ch];
    info = sys ? { code: info ? info.code : '', vk: 0, scan: sys[0], shift: !!sys[1] } : null;
  }
  if (!info) {
    // No single key for this character (accents, emoji, tabs): insert it as text.
    await setShift(tabId, false);
    if (system) return sysSend({ op: 'text', text: ch });
    return chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: ch });
  }
  await setShift(tabId, info.shift, info.code, msg.s);
  const k = {
    key: ch,
    code: info.code,
    scan: info.scan,
    windowsVirtualKeyCode: info.vk,
    nativeVirtualKeyCode: info.vk,
    modifiers: info.shift ? SHIFT : 0
  };
  return pressKey(
    tabId,
    Object.assign({ type: 'keyDown', text: ch, unmodifiedText: ch }, k),
    Object.assign({ type: 'keyUp' }, k),
    msg
  );
}

async function attachDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (err) {
    const text = String((err && err.message) || err);
    if (!/already attached/i.test(text)) throw new Error(text);
  }
  // Lets the page accept keys while the side panel holds keyboard focus.
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
}

// A run in a tab ended: let go of whatever was pressing its keys.
function endRun(tabId) {
  const mode = runMode.get(tabId);
  releaseAll(tabId); // let go of any key still held, before the run's mode is cleared
  runMode.delete(tabId);
  const st = shiftState.get(tabId);
  if (st) clearTimeout(st.timer);
  shiftState.delete(tabId);
  if (mode === 'system') sysClose();
  else chrome.debugger.detach({ tabId }).catch(() => {});
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// Resolves to undefined when no frame answered.
async function send(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    return undefined;
  }
}

async function startTyping() {
  const tab = await activeTab();
  if (!tab || tab.id === undefined) return { ok: false, error: 'No active tab found.' };

  const stored = await chrome.storage.local.get(['text', 'settings', 'profileSeed']);
  // Each install is its own typist: the same personal habits in every run.
  let profile = stored.profileSeed;
  if (!Number.isInteger(profile)) {
    profile = crypto.getRandomValues(new Uint32Array(1))[0];
    await chrome.storage.local.set({ profileSeed: profile });
  }
  const text = stored.text || '';
  if (!text.trim()) return { ok: false, error: 'There is no text to type. Enter some in the Auto Typer panel.' };
  const settings = Object.assign({}, DEFAULT_SETTINGS, stored.settings);
  const mode = keyModeOf(settings);
  const msg = { type: 'AT_START', text, settings, profile, real: mode !== 'script', system: mode === 'system' };

  if (mode === 'debugger') {
    try {
      await attachDebugger(tab.id);
    } catch (err) {
      return {
        ok: false,
        error: 'The Chrome debugger could not be attached to this tab (' + err.message + '). Close DevTools on the tab, or choose another key mode.'
      };
    }
    runMode.set(tab.id, 'debugger');
  } else if (mode === 'system') {
    try {
      await sysConnect();
    } catch (err) {
      sysClose();
      return {
        ok: false,
        error:
          'The Windows key helper is not available (' + err.message + '). Install it once: open a terminal in the extension folder and run  python native\\install.py ' +
          chrome.runtime.id + '  then try again.'
      };
    }
    runMode.set(tab.id, 'system');
  }
  const res = await sendStart(tab.id, msg);
  if (msg.real && !res.ok) endRun(tab.id);
  return res;
}

async function sendStart(tabId, msg) {
  const tab = { id: tabId };
  let res = await send(tab.id, msg);
  if (res === undefined) {
    // The tab may have been open before the extension was installed.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['engine.js', 'content.js']
      });
    } catch (_) {
      return { ok: false, error: 'Auto Typer cannot run on this page (browser pages and the Web Store are off limits).' };
    }
    res = await send(tab.id, msg);
  }
  return res || { ok: false, error: 'No text field is focused. Click into a text box on the page first.' };
}

async function command(type, extra) {
  const tab = await activeTab();
  if (!tab || tab.id === undefined) return { ok: false };
  return (await send(tab.id, Object.assign({ type }, extra))) || { ok: false };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  const fromTab = sender && sender.tab ? sender.tab.id : undefined;
  if (msg.type === 'BG_KEY' && fromTab !== undefined) {
    realKey(fromTab, msg).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, retry: !!(err && err.retry), error: String((err && err.message) || err) })
    );
    return true;
  }
  if (msg.type === 'AT_PROGRESS' && fromTab !== undefined) {
    if (msg.real && (msg.state === 'done' || msg.state === 'stopped' || msg.state === 'error')) endRun(fromTab);
    return;
  }
  if (msg.type === 'BG_START') {
    startTyping().then(sendResponse);
    return true;
  }
  if (msg.type === 'BG_SETTINGS') {
    command('AT_SETTINGS', { settings: msg.settings }).then(sendResponse);
    return true;
  }
  if (msg.type === 'BG_STOP' || msg.type === 'BG_PAUSE' || msg.type === 'BG_RESUME') {
    command('AT_' + msg.type.slice(3)).then(sendResponse);
    return true;
  }
});

// Hotkey: stop if something is typing, otherwise start.
chrome.commands.onCommand.addListener(async (name) => {
  if (name === 'toggle-pause') {
    // Only a running job answers AT_PAUSE; only a paused one answers AT_RESUME.
    const paused = await command('AT_PAUSE');
    if (!paused.ok) await command('AT_RESUME');
    return;
  }
  if (name !== 'toggle-typing') return;
  const stopped = await command('AT_STOP');
  if (stopped.ok) return;
  const res = await startTyping();
  if (!res.ok) {
    chrome.runtime
      .sendMessage({ type: 'AT_PROGRESS', state: 'error', done: 0, total: 0, note: res.error })
      .catch(() => {});
  }
});

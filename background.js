// Service worker: opens the side panel and relays commands to the active tab.
'use strict';

const DEFAULT_SETTINGS = { wpm: 65, typoRate: 3, pauseScale: 1, countdown: 3, realKeys: false };

// ---- real key events (optional) ----------------------------------------------
// With "Real key events" on, keystrokes are sent through Chrome's debugger
// protocol, so the page receives genuine keyboard events instead of text
// inserted by script. Chrome shows its "is debugging this browser" banner.

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

function pressKey(tabId, down, up) {
  const target = { tabId };
  return chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', down).then(() => {
    // Release a moment later, like a finger leaving the key.
    setTimeout(() => {
      chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', up).catch(() => {});
    }, 40 + Math.random() * 70);
  });
}

async function realKey(tabId, msg) {
  if (msg.op === 'del') {
    const k = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
    return pressKey(tabId, Object.assign({ type: 'rawKeyDown' }, k), Object.assign({ type: 'keyUp' }, k));
  }
  const ch = msg.ch;
  if (ch === '\n') {
    // Shift+Enter: a new line that does not submit a form or send a chat message.
    const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: SHIFT };
    return pressKey(tabId, Object.assign({ type: 'keyDown', text: '\r' }, k), Object.assign({ type: 'keyUp' }, k));
  }
  const info = KEY_MAP[ch];
  if (!info) {
    // No single key for this character (accents, emoji, tabs): insert it as text.
    return chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: ch });
  }
  const k = {
    key: ch,
    code: info.code,
    windowsVirtualKeyCode: info.vk,
    nativeVirtualKeyCode: info.vk,
    modifiers: info.shift ? SHIFT : 0
  };
  return pressKey(tabId, Object.assign({ type: 'keyDown', text: ch, unmodifiedText: ch }, k), Object.assign({ type: 'keyUp' }, k));
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

function detachDebugger(tabId) {
  chrome.debugger.detach({ tabId }).catch(() => {});
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

  const stored = await chrome.storage.local.get(['text', 'settings']);
  const text = stored.text || '';
  if (!text.trim()) return { ok: false, error: 'There is no text to type. Enter some in the Auto Typer panel.' };
  const settings = Object.assign({}, DEFAULT_SETTINGS, stored.settings);
  const msg = { type: 'AT_START', text, settings, real: !!settings.realKeys };

  if (msg.real) {
    try {
      await attachDebugger(tab.id);
    } catch (err) {
      return {
        ok: false,
        error: 'Real key events could not be turned on for this tab (' + err.message + '). Close DevTools on the tab, or untick "Real key events".'
      };
    }
  }
  const res = await sendStart(tab.id, msg);
  if (msg.real && !res.ok) detachDebugger(tab.id);
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
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
    return true;
  }
  if (msg.type === 'AT_PROGRESS' && fromTab !== undefined) {
    // A run in that tab ended: release the debugger if we were using it.
    if (msg.real && (msg.state === 'done' || msg.state === 'stopped' || msg.state === 'error')) detachDebugger(fromTab);
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

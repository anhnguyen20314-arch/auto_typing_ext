// Service worker: opens the side panel and relays commands to the active tab.
'use strict';

const DEFAULT_SETTINGS = { wpm: 65, typoRate: 3, pauseScale: 1, countdown: 3 };

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
  const msg = { type: 'AT_START', text, settings: Object.assign({}, DEFAULT_SETTINGS, stored.settings) };

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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
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

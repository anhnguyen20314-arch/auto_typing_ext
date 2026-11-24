// Content script: types a planned keystroke sequence into the focused field.
(() => {
  'use strict';
  if (globalThis.__autoTyperContent) return;
  globalThis.__autoTyperContent = true;

  const Engine = globalThis.AutoTyperEngine;
  const TEXT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'password', 'email', 'number']);
  let job = null;

  function deepActive() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function classify(el) {
    if (!el) return null;
    if (el.tagName === 'TEXTAREA') return el.readOnly || el.disabled ? null : 'textarea';
    if (el.tagName === 'INPUT') {
      const type = (el.getAttribute('type') || '').toLowerCase();
      return TEXT_TYPES.has(type) && !el.readOnly && !el.disabled ? 'input' : null;
    }
    if (el.isContentEditable || document.designMode === 'on') return 'rich';
    return null;
  }

  function report(state, note) {
    if (!job) return;
    try {
      chrome.runtime
        .sendMessage({ type: 'AT_PROGRESS', state, done: job.done, total: job.total, typos: job.typos, mistake: !!job.mistake, real: !!job.real, note: note || '' })
        .catch(() => {});
    } catch (_) {
      /* extension was reloaded */
    }
  }

  // ---- plain <input> / <textarea> ------------------------------------------

  function getSelection(el) {
    try {
      if (el.selectionStart !== null && el.selectionStart !== undefined) {
        return [el.selectionStart, el.selectionEnd];
      }
    } catch (_) {
      /* type=email/number have no selection API */
    }
    const len = el.value.length;
    return [len, len];
  }

  function setValue(el, value, caret) {
    // Use the native setter so frameworks (React etc.) notice the change.
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    try {
      el.setSelectionRange(caret, caret);
    } catch (_) {
      /* no selection API */
    }
    // Setting the value from script does not scroll the caret into view.
    if (caret >= value.length) {
      if (el.tagName === 'TEXTAREA') el.scrollTop = el.scrollHeight;
      else el.scrollLeft = el.scrollWidth;
    }
  }

  function keyEvent(el, type, key) {
    el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, composed: true }));
  }

  function fieldInsert(el, ch) {
    // No key events for Enter: many pages submit or send on Enter keydown.
    const withKeys = ch !== '\n';
    if (withKeys) keyEvent(el, 'keydown', ch);
    const [s, e] = getSelection(el);
    const v = el.value;
    setValue(el, v.slice(0, s) + ch + v.slice(e), s + ch.length);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ch }));
    if (withKeys) keyEvent(el, 'keyup', ch);
  }

  function fieldDelete(el) {
    keyEvent(el, 'keydown', 'Backspace');
    let [s, e] = getSelection(el);
    if (s === e) s = Math.max(0, s - 1);
    const v = el.value;
    if (s !== e) {
      setValue(el, v.slice(0, s) + v.slice(e), s);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
    }
    keyEvent(el, 'keyup', 'Backspace');
  }

  // ---- contenteditable / rich editors --------------------------------------
  // execCommand fires real beforeinput/input events, which is what editors
  // (Draft.js, Slate, ProseMirror, Quill...) listen to. No synthetic key
  // events here: editors act on them and the text would be handled twice.

  function richInsert(ch) {
    if (ch === '\n') {
      if (!document.execCommand('insertLineBreak')) document.execCommand('insertParagraph');
      return;
    }
    if (document.execCommand('insertText', false, ch)) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(ch);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    job.target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
  }

  function richDelete() {
    document.execCommand('delete');
  }

  // ---- runner ---------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function wait(j, ms) {
    const end = performance.now() + ms;
    for (;;) {
      if (j.stopped) return;
      if (j.paused) {
        const pausedAt = performance.now();
        while (j.paused && !j.stopped) {
          await sleep(120);
          // Focus-loss pauses resume by themselves when focus comes back.
          if (j.autoPaused && deepActive() === j.target) {
            j.paused = false;
            j.autoPaused = false;
            report('typing');
          }
        }
        if (j.stopped) return;
        // The time spent paused does not count against the delay.
        return wait(j, Math.max(0, end - pausedAt));
      }
      const left = end - performance.now();
      if (left <= 0) return;
      await sleep(Math.min(left, 120));
    }
  }

  async function run(j) {
    report('typing');
    for (let k = 0; k < j.actions.length; k++) {
      const action = j.actions[k];
      await wait(j, action.d);
      if (j.stopped) break;
      if (!j.target.isConnected) {
        j.stopped = true;
        j.note = 'The text field disappeared from the page.';
        break;
      }
      if (deepActive() !== j.target) {
        j.paused = true;
        j.autoPaused = true;
        report('paused', 'Focus left the field. Click back into it to continue.');
        await wait(j, 0);
        if (j.stopped) break;
      }
      try {
        if (j.real) {
          // Real key events: the background worker presses the key through Chrome's debugger.
          const res = await chrome.runtime.sendMessage(
            action.t === 'ins'
              ? { type: 'BG_KEY', op: 'ins', ch: action.ch, wpm: j.wpm }
              : { type: 'BG_KEY', op: 'del', wpm: j.wpm }
          );
          if (!res || !res.ok) throw new Error((res && res.error) || 'the debugger connection was closed');
        } else if (j.kind === 'rich') {
          if (action.t === 'ins') richInsert(action.ch);
          else richDelete();
        } else if (action.t === 'ins') fieldInsert(j.target, action.ch);
        else fieldDelete(j.target);
      } catch (err) {
        j.stopped = true;
        j.note = 'Typing failed: ' + (err && err.message ? err.message : err);
        break;
      }
      j.done = action.p;
      j.mistake = !action.c; // a typo is on screen and not yet corrected
      if (action.m) j.typosDone++;
      // Settings changed mid-run: re-plan the rest once no typo is half-corrected.
      if (j.pending && action.c) {
        const plan = buildPlan(j.chars.slice(j.done).join(''), j.pending, j.fragile);
        for (const a of plan.actions) a.p += j.done;
        j.actions = plan.actions;
        j.typos = j.typosDone + plan.typos;
        j.wpm = j.pending.wpm;
        j.pending = null;
        k = -1;
      }
      report('typing');
    }
    if (!j.real && j.kind !== 'rich' && j.target.isConnected) {
      j.target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (j.stopped) report(j.note ? 'error' : 'stopped', j.note);
    else {
      j.done = j.total;
      report('done');
    }
    if (job === j) job = null;
  }

  function buildPlan(text, settings, fragile) {
    return Engine.buildPlan(text, {
      wpm: settings.wpm,
      typoRate: (Number(settings.typoRate) || 0) / 100,
      pauseScale: settings.pauseScale,
      allowTypos: !fragile
    });
  }

  function start(msg) {
    const target = deepActive();
    const kind = classify(target);
    if (!kind) return undefined; // not this frame; let another frame answer
    if (job) return { ok: false, error: 'Already typing in this tab.' };

    const settings = msg.settings || {};
    let text = String(msg.text || '').replace(/\r\n?/g, '\n');
    if (kind === 'input') text = text.replace(/\s*\n\s*/g, ' ');
    if (!text) return { ok: false, error: 'There is no text to type.' };

    // No typos in password fields: nobody can see them and a slip would be costly.
    const fragile = kind === 'input' && (target.getAttribute('type') || '').toLowerCase() === 'password';

    const plan = buildPlan(text, settings, fragile);

    job = {
      target,
      kind,
      fragile,
      real: !!msg.real,
      wpm: settings.wpm,
      chars: Array.from(text),
      actions: plan.actions,
      total: plan.total,
      typos: plan.typos,
      typosDone: 0,
      pending: null,
      done: 0,
      paused: false,
      autoPaused: false,
      stopped: false,
      note: ''
    };
    // Tell the side panel exactly what is being typed so it can highlight progress.
    try {
      chrome.runtime.sendMessage({ type: 'AT_STARTED', text }).catch(() => {});
    } catch (_) {
      /* extension was reloaded */
    }
    run(job);
    return { ok: true, total: plan.total };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    let res;
    switch (msg.type) {
      case 'AT_START':
        res = start(msg);
        break;
      case 'AT_STOP':
        if (job) {
          job.stopped = true;
          res = { ok: true };
        }
        break;
      case 'AT_SETTINGS':
        if (job && msg.settings) {
          job.pending = msg.settings;
          res = { ok: true };
        }
        break;
      case 'AT_PAUSE':
        if (job && !job.paused) {
          job.paused = true;
          job.autoPaused = false;
          report('paused');
          res = { ok: true };
        }
        break;
      case 'AT_RESUME':
        if (job && job.paused) {
          if (job.target.isConnected && deepActive() !== job.target) job.target.focus();
          job.paused = false;
          job.autoPaused = false;
          report('typing');
          res = { ok: true };
        }
        break;
      default:
        return;
    }
    if (res !== undefined) sendResponse(res);
  });

  // A real Escape key press stops typing.
  window.addEventListener(
    'keydown',
    (e) => {
      if (job && e.isTrusted && e.key === 'Escape') job.stopped = true;
    },
    true
  );
})();

'use strict';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_SETTINGS = { wpm: 65, typoRate: 3, pauseScale: 1, countdown: 3 };

// Default model names change over time; the Model field is editable.
const PROVIDERS = {
  gemini: { model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
  groq: { model: 'llama-3.3-70b-versatile', base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
  openrouter: { model: 'meta-llama/llama-3.3-70b-instruct:free', base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  custom: { model: '', base: '' }
};

const TONES = {
  natural: 'natural and conversational, the way a thoughtful person writes',
  casual: 'casual and relaxed, like a message to a friend',
  professional: 'professional but warm, like a clear email to a colleague'
};

let settings = Object.assign({}, DEFAULT_SETTINGS);
let ai = { provider: 'gemini', tone: 'natural', cfg: {} };
let beforeHumanize = null;
let state = 'idle'; // idle | countdown | typing | paused
let countdownCancelled = false;

// ---- persistence -------------------------------------------------------------

let saveTimer = 0;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  return chrome.storage.local.set({ text: $('text').value, settings, ai });
}

function providerCfg() {
  const p = ai.provider;
  if (!ai.cfg[p]) ai.cfg[p] = { key: '', model: PROVIDERS[p].model, base: PROVIDERS[p].base || '' };
  return ai.cfg[p];
}

// ---- rendering ---------------------------------------------------------------

function renderSettings() {
  $('wpm').value = settings.wpm;
  $('typoRate').value = settings.typoRate;
  $('pauseScale').value = settings.pauseScale;
  $('countdown').value = settings.countdown;
  $('wpmOut').textContent = settings.wpm + ' wpm';
  $('typoOut').textContent = Number(settings.typoRate) === 0 ? 'off' : settings.typoRate + '% of letters';
  $('pauseOut').textContent = Number(settings.pauseScale) === 0 ? 'off' : '×' + Number(settings.pauseScale).toFixed(1);
}

function renderAi() {
  const cfg = providerCfg();
  $('provider').value = ai.provider;
  $('tone').value = ai.tone;
  $('key').value = cfg.key;
  $('model').value = cfg.model;
  $('base').value = cfg.base;
  $('baseRow').hidden = ai.provider !== 'custom';
  const link = $('keyLink');
  link.hidden = !PROVIDERS[ai.provider].keyUrl;
  if (PROVIDERS[ai.provider].keyUrl) link.href = PROVIDERS[ai.provider].keyUrl;
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

let estimateTimer = 0;
function renderEstimate() {
  const text = $('text').value;
  const n = Array.from(text).length;
  $('count').textContent = n + (n === 1 ? ' character' : ' characters');
  clearTimeout(estimateTimer);
  if (!n) {
    $('estimate').textContent = '';
    return;
  }
  estimateTimer = setTimeout(() => {
    const plan = AutoTyperEngine.buildPlan(text, {
      wpm: settings.wpm,
      typoRate: settings.typoRate / 100,
      pauseScale: settings.pauseScale
    });
    $('estimate').textContent = `about ${formatDuration(plan.durationMs)}, ~${plan.typos} typos`;
  }, 250);
}

function setStatus(text, isError) {
  $('status').textContent = text;
  $('status').classList.toggle('error', !!isError);
}

// ---- live progress view ------------------------------------------------------

let liveChars = null; // the text being typed, as an array of characters

function renderLive(done, mistake) {
  if (!liveChars) return;
  const live = $('live');
  const cur = $('liveCur');
  const ch = liveChars[done];
  $('liveDone').textContent = liveChars.slice(0, done).join('');
  // A line break has no width, so show a return sign for it.
  cur.textContent = ch === undefined ? '' : ch === '\n' ? '↵\n' : ch;
  cur.classList.toggle('typo', !!mistake);
  $('liveRest').textContent = liveChars.slice(done + 1).join('');
  // Keep the current letter in view.
  const top = cur.offsetTop;
  if (top < live.scrollTop || top + cur.offsetHeight > live.scrollTop + live.clientHeight) {
    live.scrollTop = Math.max(0, top - live.clientHeight / 2);
  }
}

function setState(next) {
  state = next;
  const busy = state !== 'idle';
  const showLive = (state === 'typing' || state === 'paused') && !!liveChars;
  if (showLive && $('live').hidden) $('live').style.height = $('text').offsetHeight + 'px';
  $('live').hidden = !showLive;
  $('text').hidden = showLive;
  $('text').readOnly = busy;
  if (!busy) liveChars = null;
  $('start').disabled = busy;
  $('stop').disabled = !busy;
  $('pause').disabled = state !== 'typing' && state !== 'paused';
  $('pause').textContent = state === 'paused' ? 'Resume' : 'Pause';
}

// ---- typing controls ---------------------------------------------------------

async function start() {
  if (!$('text').value.trim()) {
    setStatus('Enter some text first.', true);
    return;
  }
  await saveNow();
  countdownCancelled = false;
  setState('countdown');
  $('progress').value = 0;
  for (let s = Number(settings.countdown) || 0; s > 0; s--) {
    setStatus(`Click into the field you want to type in. Starting in ${s}…`);
    await sleep(1000);
    if (countdownCancelled) return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'BG_START' });
  if (countdownCancelled) return;
  if (!res || !res.ok) {
    setState('idle');
    setStatus((res && res.error) || 'Could not start typing.', true);
    return;
  }
  if (state === 'countdown') {
    setState('typing');
    setStatus('Typing…');
  }
}

async function stop() {
  if (state === 'countdown') {
    countdownCancelled = true;
    setState('idle');
    setStatus('Cancelled.');
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: 'BG_STOP' });
  if (!res || !res.ok) {
    // Nothing is typing in the active tab any more.
    setState('idle');
    setStatus('Stopped.');
  }
}

// Slider changes apply to a run that is already in progress.
let liveTimer = 0;
function pushLiveSettings() {
  if (state !== 'typing' && state !== 'paused') return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'BG_SETTINGS', settings }).catch(() => {});
  }, 150);
}

async function togglePause() {
  await chrome.runtime.sendMessage({ type: state === 'paused' ? 'BG_RESUME' : 'BG_PAUSE' });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'AT_STARTED') {
    liveChars = Array.from(String(msg.text || ''));
    return;
  }
  if (!msg || msg.type !== 'AT_PROGRESS') return;
  if ((msg.state === 'typing' || msg.state === 'paused') && !liveChars) {
    // The panel was opened mid-run: use the box's text if it is the same length.
    const chars = Array.from($('text').value.replace(/\r\n?/g, '\n'));
    if (chars.length === msg.total) liveChars = chars;
  }
  if (msg.total) $('progress').value = msg.done / msg.total;
  let counts = msg.total ? ` ${msg.done} / ${msg.total}` : '';
  if (msg.total) counts += msg.typos ? ` · ${msg.typos} typos planned` : ' · no typos planned';
  switch (msg.state) {
    case 'typing':
      setState('typing');
      renderLive(msg.done, msg.mistake);
      setStatus('Typing…' + counts);
      break;
    case 'paused':
      setState('paused');
      renderLive(msg.done, msg.mistake);
      setStatus(msg.note || 'Paused.' + counts);
      break;
    case 'done':
      setState('idle');
      setStatus('Done.' + counts);
      break;
    case 'stopped':
      setState('idle');
      setStatus('Stopped.' + counts);
      break;
    case 'error':
      setState('idle');
      setStatus(msg.note || 'Something went wrong.', true);
      break;
  }
});

// ---- AI rewrite --------------------------------------------------------------

function systemPrompt() {
  return (
    'You rewrite text so it reads as if a person wrote it. Make it ' + TONES[ai.tone] + '. ' +
    'Vary sentence length, prefer plain words, and remove stiff or formulaic phrasing. ' +
    'Keep the meaning, every fact, the language and roughly the same length. ' +
    'Use only characters found on a standard keyboard: straight quotes, no em dashes, no bullet symbols, no markdown. ' +
    'Reply with the rewritten text only, with no preface or explanation.'
  );
}

async function readError(resp) {
  let detail = '';
  try {
    const body = await resp.json();
    detail = (body.error && (body.error.message || body.error)) || '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch (_) {
    /* not JSON */
  }
  return `The provider returned ${resp.status}${detail ? ': ' + detail.slice(0, 300) : ''}`;
}

async function callAi(text) {
  const cfg = providerCfg();
  if (!cfg.model) throw new Error('Set a model name in AI settings.');
  if (!cfg.key && ai.provider !== 'custom') throw new Error('Add your API key in AI settings.');

  if (ai.provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt() }] },
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: { temperature: 0.9 }
      })
    });
    if (!resp.ok) throw new Error(await readError(resp));
    const data = await resp.json();
    const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
    return (parts || []).map((p) => p.text || '').join('');
  }

  const base = (cfg.base || '').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('Set a base URL in AI settings.');
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.key) headers.Authorization = 'Bearer ' + cfg.key;
  const resp = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.9,
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: text }
      ]
    })
  });
  if (!resp.ok) throw new Error(await readError(resp));
  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return typeof content === 'string' ? content : '';
}

async function humanize() {
  const text = $('text').value;
  const status = $('aiStatus');
  status.classList.remove('error');
  if (!text.trim()) {
    status.textContent = 'Enter some text first.';
    return;
  }
  $('humanize').disabled = true;
  status.textContent = 'Rewriting…';
  try {
    const out = (await callAi(text)).trim();
    if (!out) throw new Error('The provider returned an empty reply.');
    beforeHumanize = text;
    $('text').value = out;
    $('undo').hidden = false;
    status.textContent = 'Rewritten. Review it before typing.';
    renderEstimate();
    saveSoon();
  } catch (err) {
    status.textContent = err.message || String(err);
    status.classList.add('error');
    if (/key|model|base URL/i.test(status.textContent)) $('aiDetails').open = true;
  } finally {
    $('humanize').disabled = false;
  }
}

// ---- wiring ------------------------------------------------------------------

$('text').addEventListener('input', () => {
  renderEstimate();
  saveSoon();
});

for (const id of ['wpm', 'typoRate', 'pauseScale', 'countdown']) {
  $(id).addEventListener('input', () => {
    const v = Number($(id).value);
    settings[id] = Number.isFinite(v) ? v : DEFAULT_SETTINGS[id];
    if (id === 'countdown') settings.countdown = Math.min(30, Math.max(0, Math.round(settings.countdown)));
    else renderSettings();
    renderEstimate();
    saveSoon();
    pushLiveSettings();
  });
}

$('provider').addEventListener('change', () => {
  ai.provider = $('provider').value;
  renderAi();
  saveSoon();
});
$('tone').addEventListener('change', () => {
  ai.tone = $('tone').value;
  saveSoon();
});
for (const id of ['key', 'model', 'base']) {
  $(id).addEventListener('input', () => {
    providerCfg()[id] = $(id).value.trim();
    saveSoon();
  });
}

$('humanize').addEventListener('click', humanize);
$('undo').addEventListener('click', () => {
  if (beforeHumanize === null) return;
  $('text').value = beforeHumanize;
  beforeHumanize = null;
  $('undo').hidden = true;
  $('aiStatus').textContent = '';
  renderEstimate();
  saveSoon();
});

$('start').addEventListener('click', start);
$('stop').addEventListener('click', stop);
$('pause').addEventListener('click', togglePause);

(async function init() {
  const stored = await chrome.storage.local.get(['text', 'settings', 'ai']);
  $('text').value = stored.text || '';
  Object.assign(settings, stored.settings);
  if (stored.ai) ai = Object.assign(ai, stored.ai);
  if (!PROVIDERS[ai.provider]) ai.provider = 'gemini';
  if (!TONES[ai.tone]) ai.tone = 'natural';
  if (!ai.cfg) ai.cfg = {};
  renderSettings();
  renderAi();
  renderEstimate();
  setState('idle');
})();

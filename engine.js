// Typing planner: turns a text into a list of timed keystroke actions
// (insert / delete) with human-like rhythm and self-corrected typos.
// Pure logic, no DOM — shared by the content script, the side panel and tests.
(function (root) {
  'use strict';

  const NEIGHBORS = {
    q: 'wa', w: 'qeas', e: 'wrsd', r: 'etdf', t: 'ryfg', y: 'tugh', u: 'yihj',
    i: 'uojk', o: 'ipkl', p: 'ol', a: 'qwsz', s: 'awedxz', d: 'serfcx',
    f: 'drtgvc', g: 'ftyhbv', h: 'gyujnb', j: 'huikmn', k: 'jiolm', l: 'kop',
    z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk'
  };

  const FAST_BIGRAMS = new Set((
    'th he in er an re on at en nd ti es or te of ed is it al ar st to nt ng ' +
    'se ha as ou io le ve co me de hi ri ro ic ne ea ra ce'
  ).split(' '));

  const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?'.split(''));

  const isLetter = (ch) => /^[a-zA-Z]$/.test(ch);
  const isUpper = (ch) => /^[A-Z]$/.test(ch);
  // Characters that are safe to type and then backspace again (one key, one code unit).
  const isSafe = (ch) => ch !== undefined && /^[\x20-\x7E]$/.test(ch);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * @param {string} text
   * @param {{wpm?:number, typoRate?:number, pauseScale?:number, allowTypos?:boolean, rng?:()=>number}} opts
   *   typoRate is a probability per letter (0..1).
   * @returns {{actions:Array<{t:'ins'|'del', ch?:string, d:number, p:number}>, total:number, durationMs:number}}
   *   d = delay in ms before the action, p = number of source characters completed after it.
   */
  function buildPlan(text, opts) {
    opts = opts || {};
    const rng = opts.rng || Math.random;
    const wpm = clamp(Number(opts.wpm) || 65, 5, 400);
    const typoRate = opts.allowTypos === false ? 0 : clamp(Number(opts.typoRate) || 0, 0, 0.5);
    const pauseScale = clamp(opts.pauseScale === undefined ? 1 : Number(opts.pauseScale) || 0, 0, 5);

    const chars = Array.from(String(text).replace(/\r\n?/g, '\n'));
    const n = chars.length;
    const base = 60000 / (wpm * 5);
    const actions = [];
    let drift = 1; // slow wander of overall speed
    let typos = 0;

    const rand = (lo, hi) => lo + rng() * (hi - lo);
    const gauss = () => {
      let u = 0;
      while (u === 0) u = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
    };
    const lognormal = (sigma) => Math.exp(sigma * gauss() - (sigma * sigma) / 2);

    function keyDelay(ch, prev) {
      drift = clamp(drift + (1 - drift) * 0.05 + gauss() * 0.03, 0.75, 1.3);
      let m = lognormal(0.32);
      const lc = ch.toLowerCase();
      const lp = prev === undefined ? '' : prev.toLowerCase();
      if (FAST_BIGRAMS.has(lp + lc)) m *= 0.78;
      else if (lp === lc) m *= 0.85;
      if (isUpper(ch) || SHIFTED.has(ch)) m *= 1.35;
      else if (/^[0-9]$/.test(ch)) m *= 1.2;
      if (prev === undefined || prev === ' ') m *= 1.15;
      return Math.max(25, base * m * drift);
    }

    function pauseAfter(prev) {
      if (prev === undefined || pauseScale === 0) return 0;
      let p = 0;
      if (prev === ',' || prev === ';' || prev === ':') p = rand(120, 350);
      else if (prev === '.' || prev === '!' || prev === '?') p = rand(350, 1000);
      else if (prev === '\n') p = rand(500, 1500);
      else if (prev === ' ' && rng() < 0.03) p = rand(600, 2200); // thinking
      return p * pauseScale;
    }

    function lookahead(from, max) {
      const r = rng();
      let want = r < 0.25 ? 0 : r < 0.6 ? 1 : r < 0.85 ? 2 : 3;
      want = Math.min(want, max);
      let k = 0;
      while (k < want && isSafe(chars[from + k])) k++;
      return k;
    }

    // Type `wrong` instead of chars[i .. i+consumed), carry on for k more
    // characters, notice, backspace to the common prefix and retype correctly.
    function mistake(i, wrong, consumed, k, firstDelay) {
      const look = chars.slice(i + consumed, i + consumed + k);
      const typed = wrong.concat(look);
      const correct = chars.slice(i, i + consumed + k);
      let cp = 0;
      while (cp < typed.length && cp < correct.length && typed[cp] === correct[cp]) cp++;

      let prev = chars[i - 1];
      typed.forEach((ch, j) => {
        const d = j === 0 ? firstDelay : keyDelay(ch, prev) * (j < wrong.length ? 0.8 : 1);
        actions.push({ t: 'ins', ch, d, p: i + Math.min(j + 1, cp) });
        prev = ch;
      });

      const dels = typed.length - cp;
      if (dels > 0) typos++;
      for (let j = 0; j < dels; j++) {
        const d = j === 0 ? rand(400, 950) : rand(90, 170);
        actions.push({ t: 'del', d, p: i + cp });
      }
      prev = cp > 0 ? correct[cp - 1] : chars[i - 1];
      for (let j = cp; j < correct.length; j++) {
        const d = (j === cp ? rand(120, 300) : 0) + keyDelay(correct[j], prev) * 0.9;
        actions.push({ t: 'ins', ch: correct[j], d, p: i + j + 1 });
        prev = correct[j];
      }
      // c = the typed text matches the source again here; m = a typo was just fixed.
      const last = actions[actions.length - 1];
      last.c = true;
      if (dels > 0) last.m = true;
      return i + correct.length;
    }

    let i = 0;
    while (i < n) {
      const ch = chars[i];
      const prev = chars[i - 1];
      const d = keyDelay(ch, prev) + pauseAfter(prev);

      if (typoRate > 0 && isLetter(ch) && rng() < typoRate) {
        const next = chars[i + 1];
        const r = rng();
        if (r < 0.6) {
          // neighbouring key
          const opts2 = NEIGHBORS[ch.toLowerCase()];
          let wrong = opts2[Math.floor(rng() * opts2.length)];
          if (isUpper(ch)) wrong = wrong.toUpperCase();
          i = mistake(i, [wrong], 1, lookahead(i + 1, 3), d);
          continue;
        }
        if (r < 0.8 && next !== undefined && isLetter(next) && next.toLowerCase() !== ch.toLowerCase()) {
          // swapped letters
          i = mistake(i, [next, ch], 2, lookahead(i + 2, 2), d);
          continue;
        }
        if (r < 0.9) {
          // doubled letter
          i = mistake(i, [ch, ch], 1, lookahead(i + 1, 1), d);
          continue;
        }
        if (isSafe(next) && next !== ch) {
          // skipped letter
          const k = Math.max(1, lookahead(i + 1, 3));
          i = mistake(i, [], 1, k, d);
          continue;
        }
      }

      actions.push({ t: 'ins', ch, d, p: i + 1, c: true });
      i++;
    }

    // Safety net: the plan must reproduce the text exactly.
    const target = chars.join('');
    if (simulate(actions) !== target) {
      actions.length = 0;
      typos = 0;
      chars.forEach((ch, j) => actions.push({ t: 'ins', ch, d: keyDelay(ch, chars[j - 1]), p: j + 1, c: true }));
    }

    let durationMs = 0;
    for (const a of actions) durationMs += a.d;
    return { actions, total: n, durationMs, typos };
  }

  function simulate(actions) {
    const buf = [];
    for (const a of actions) {
      if (a.t === 'ins') buf.push(a.ch);
      else buf.pop();
    }
    return buf.join('');
  }

  const api = { buildPlan, simulate, mulberry32 };
  root.AutoTyperEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

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

  // Very common words are typed from habit, a little faster than the rest.
  const COMMON_WORDS = new Set((
    'the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she ' +
    'or an will my one all would there their what so up out if about who get which go me when make can like time no ' +
    'just him know take people into year your good some could them see other than then now look only come its over ' +
    'think also back after use two how our work first well way even new want because any these give day most us is ' +
    'are was were has had been more very much many here where why did does am too'
  ).split(' '));
  const RARE_LETTERS = /[jqxzkv]/g;

  const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?'.split(''));

  // Which finger presses each key (0 = left little finger ... 7 = right little finger).
  const FINGER = {};
  [['qaz1`', 0], ['wsx2', 1], ['edc3', 2], ['rfvtgb45', 3], ['yhnujm67', 4], ['ik,8', 5], ['ol.9', 6], ["p;/0-=[]'\\", 7]]
    .forEach(([keys, f]) => keys.split('').forEach((k) => (FINGER[k] = f)));
  FINGER.bs = 7; // Backspace
  FINGER['\n'] = 7; // Enter
  // Shifted symbol -> the key it sits on.
  const BASE_KEY = {};
  '1!2@3#4$5%6^7&8*9(0)-_=+[{]}\\|;:\'",<.>/?`~'.match(/../g).forEach((p) => (BASE_KEY[p[1]] = p[0]));

  const HOLD_BASE = 132; // ms a key stays down for a slow typist; shorter as speed goes up

  const keyOf = (ch) => {
    const lc = ch.toLowerCase();
    return BASE_KEY[lc] || lc;
  };
  // How two keys pressed one after the other relate:
  // 'same' key, same 'finger', same 'hand', 'alt' (other hand), or 'free' (thumb / unknown).
  function relation(a, b) {
    const fa = FINGER[a];
    const fb = FINGER[b];
    if (fa === undefined || fb === undefined) return 'free';
    if (a === b) return 'same';
    if (fa === fb) return 'finger';
    return fa < 4 === fb < 4 ? 'hand' : 'alt';
  }

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
   * @returns {{actions:Array<{t:'ins'|'del', ch?:string, d:number, h:number, p:number}>, total:number, durationMs:number}}
   *   d = delay in ms before the action, h = how long the key stays down,
   *   p = number of source characters completed after it.
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
    let wordMult = 1; // speed of the word being typed
    let typoCtx = 1; // slips are likelier in long, unfamiliar words
    let typos = 0;

    const rand = (lo, hi) => lo + rng() * (hi - lo);
    const gauss = () => {
      let u = 0;
      while (u === 0) u = rng();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
    };
    const lognormal = (sigma) => Math.exp(sigma * gauss() - (sigma * sigma) / 2);

    // A time with a long right tail (most values near the median, a few much longer).
    const skewed = (median, sigma, lo, hi) => clamp(median * Math.exp(sigma * gauss()), lo, hi);

    function keyDelay(ch, prev, scale) {
      drift = clamp(drift + (1 - drift) * 0.05 + gauss() * 0.03, 0.75, 1.3);
      let m = lognormal(0.32);
      const lc = ch.toLowerCase();
      const lp = prev === undefined ? '' : prev.toLowerCase();
      // The other hand can already be on its way; the same finger has to travel.
      const rel = prev === undefined ? 'free' : relation(keyOf(prev), keyOf(ch));
      if (rel === 'same') m *= 0.85;
      else if (rel === 'finger') m *= 1.22;
      else if (rel === 'alt') m *= 0.93;
      if (FAST_BIGRAMS.has(lp + lc)) m *= 0.82;
      if (isUpper(ch) || SHIFTED.has(ch)) m *= 1.35;
      else if (/^[0-9]$/.test(ch)) m *= 1.2;
      if (prev === undefined || prev === ' ') m *= 1.15;
      else if (ch === ' ' && isLetter(prev)) m *= 0.85; // the thumb is quick
      return Math.max(25, base * m * drift * wordMult * (scale || 1));
    }

    // The run of letters starting at index i.
    function wordAt(i) {
      let j = i;
      while (j < n && isLetter(chars[j])) j++;
      return chars.slice(i, j);
    }

    // Familiar short words go quicker; long words and awkward letters go slower.
    function wordSpeed(word) {
      const w = word.join('').toLowerCase();
      if (COMMON_WORDS.has(w)) return 0.9;
      let m = 1;
      if (w.length >= 7) m += Math.min(0.24, (w.length - 6) * 0.04);
      m += Math.min(0.1, (w.match(RARE_LETTERS) || []).length * 0.04);
      return m;
    }

    // A short hesitation before a long or unusual word.
    function hesitation(word, mult) {
      if (pauseScale === 0 || mult <= 1.05) return 0;
      return rng() < 0.3 ? skewed(240, 0.45, 90, 1500) * pauseScale * Math.min(1.5, mult) : 0;
    }

    const isPunct = (c) => c !== undefined && ',;:.!?'.includes(c);

    // The pause before typing chars[i].
    function pauseAfter(i) {
      const ch = chars[i];
      let prev = chars[i - 1];
      if (prev === undefined || pauseScale === 0) return 0;
      // The space after punctuation follows at once; the pause comes before the next word.
      if (ch === ' ' && isPunct(prev)) return 0;
      let afterSpace = false;
      if (prev === ' ' && isPunct(chars[i - 2])) prev = chars[i - 2];
      else afterSpace = prev === ' ';
      let p = 0;
      if (prev === ',' || prev === ';' || prev === ':') p = skewed(210, 0.45, 80, 1500);
      else if (prev === '.' || prev === '!' || prev === '?') p = skewed(600, 0.6, 180, 6000);
      else if (prev === '\n') p = skewed(1300, 0.7, 350, 12000);
      else if (afterSpace && rng() < 0.03) p = skewed(1300, 0.75, 500, 10000); // thinking
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
    // With wholeWord, everything typed is deleted and typed again, the way people
    // wipe a word they got wrong instead of fixing one letter.
    function mistake(i, wrong, consumed, k, firstDelay, wholeWord) {
      const look = chars.slice(i + consumed, i + consumed + k);
      const typed = wrong.concat(look);
      const correct = chars.slice(i, i + consumed + k);
      let cp = 0;
      while (!wholeWord && cp < typed.length && cp < correct.length && typed[cp] === correct[cp]) cp++;

      let prev = chars[i - 1];
      typed.forEach((ch, j) => {
        const d = j === 0 ? firstDelay : keyDelay(ch, prev, j < wrong.length ? 0.8 : 1);
        actions.push({ t: 'ins', ch, d, p: i + Math.min(j + 1, cp) });
        prev = ch;
      });

      const dels = typed.length - cp;
      if (dels > 0) typos++;
      for (let j = 0; j < dels; j++) {
        // Noticing takes a moment; after that Backspace is tapped in a quick, even run.
        const d = j === 0 ? skewed(600, 0.38, 280, 2500) : wholeWord ? skewed(80, 0.2, 45, 160) : skewed(125, 0.22, 70, 260);
        actions.push({ t: 'del', d, p: i + cp });
      }
      prev = cp > 0 ? correct[cp - 1] : chars[i - 1];
      for (let j = cp; j < correct.length; j++) {
        const d = (j === cp ? skewed(190, 0.35, 90, 700) : 0) + keyDelay(correct[j], prev, 0.9);
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
      let word = null;
      if (!isLetter(ch)) wordMult = typoCtx = 1;
      else if (!isLetter(prev)) {
        word = wordAt(i);
        wordMult = wordSpeed(word);
        typoCtx = clamp(1 + (wordMult - 1) * 2.5, 0.6, 1.6);
      }
      let d = keyDelay(ch, prev) + pauseAfter(i);
      if (word) d += hesitation(word, wordMult);

      // Now and then a word goes wrong early, is finished anyway, then wiped and typed again.
      if (word && typoRate > 0 && word.length >= 3 && word.length <= 9 && rng() < Math.min(0.02, typoRate * 0.25)) {
        const at = rng() < 0.5 ? 0 : 1;
        const opts2 = NEIGHBORS[word[at].toLowerCase()];
        let slip = opts2[Math.floor(rng() * opts2.length)];
        if (isUpper(word[at])) slip = slip.toUpperCase();
        const wrong = word.slice();
        wrong[at] = slip;
        // Sometimes the space after the word is typed too before the slip is noticed.
        const k = chars[i + word.length] === ' ' && rng() < 0.5 ? 1 : 0;
        i = mistake(i, wrong, word.length, k, d, true);
        continue;
      }

      if (typoRate > 0 && isLetter(ch) && rng() < typoRate * typoCtx) {
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

    // How long each key stays down. Fingers do not wait for the previous key to
    // come up: with the other hand the next key often lands first (rollover),
    // while the same finger has to leave its key before it can press another.
    const holdMean = clamp(HOLD_BASE - wpm * 0.25, 80, 125);
    const actionKey = (a) => (a.t === 'del' ? 'bs' : keyOf(a.ch));
    actions.forEach((a, k) => {
      const key = actionKey(a);
      let h = holdMean * lognormal(0.22);
      if (FINGER[key] === 0 || FINGER[key] === 7) h *= 1.1;
      else if (key === ' ') h *= 1.05;
      const next = actions[k + 1];
      if (next) {
        const rel = relation(key, actionKey(next));
        if (rel === 'same') h = Math.min(h, next.d * rand(0.45, 0.7));
        else if (rel === 'finger') h = Math.min(h, next.d - rand(20, 50));
        else if (rel === 'hand' && h > next.d && rng() < 0.5) h = next.d * rand(0.7, 0.95);
      }
      a.h = Math.round(clamp(h, 30, 260));
    });

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

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
    let wordMult = 1; // speed of the word being typed
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
      return Math.max(25, base * m * drift * wordMult);
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
      return rng() < 0.3 ? rand(120, 420) * pauseScale * Math.min(1.5, mult) : 0;
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
        const d = j === 0 ? firstDelay : keyDelay(ch, prev) * (j < wrong.length ? 0.8 : 1);
        actions.push({ t: 'ins', ch, d, p: i + Math.min(j + 1, cp) });
        prev = ch;
      });

      const dels = typed.length - cp;
      if (dels > 0) typos++;
      for (let j = 0; j < dels; j++) {
        const d = j === 0 ? rand(400, 950) : wholeWord ? rand(55, 110) : rand(90, 170);
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
      let word = null;
      if (!isLetter(ch)) wordMult = 1;
      else if (!isLetter(prev)) {
        word = wordAt(i);
        wordMult = wordSpeed(word);
      }
      let d = keyDelay(ch, prev) + pauseAfter(prev);
      if (word) d += hesitation(word, wordMult);

      // Now and then a word goes wrong early, is finished anyway, then wiped and typed again.
      if (word && typoRate > 0 && word.length >= 3 && word.length <= 9 && rng() < Math.min(0.05, typoRate * 0.6)) {
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

// Music palettes: six beds with clearly different characters. Everything is a
// pure function of the call order, so a score renders bit-identical every run.
//
//   const { makePalette, PALETTES } = require('./palettes.cjs');
//   const PAL = makePalette(name, ctx, seed);
//
// ctx: { add, play, strum, rnd, hsh, midi, SR } from the score engine (add
// schedules a sample function into the music bus; play and strum are the CC0
// sample player, see samples/LICENSES).
//
// A palette defines: its instruments (bar, pad), a tempo range and key choices
// (picked from the seed), a progression, a groove density per energy level, the
// UI blip and key-tick timbre, an appear hit and the end-card sting.
// Energy runs 0..3: 0 is the drop (pad only), 1 thin, 2 the groove, 3 full.
(function () {
  const PALETTES = {
    classic: 'Grand piano chords and vibraphone over a soft pad',
    lofi: 'Lo-fi warm electric keys, soft brushed kit, swung and unhurried',
    marimba: 'Marimba and soft plucks, bright and playful, shaker on the groove',
    glass: 'Ambient pad with glassy bells, airy and calm, no drums',
    pulse: 'Minimal electronic pulse: filtered eighths, sub and clicks',
    nylon: 'Nylon-guitar fingerpicking with soft piano, warm and close',
  };
  const fnv = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
  function makePalette(name, ctx, seed = '') {
    if (!PALETTES[name]) throw new Error(`no palette "${name}" (${Object.keys(PALETTES).join(', ')})`);
    const { add, play, strum, rnd, midi, SR } = ctx;
    const h = fnv(seed + ':' + name);
    const pick = (arr, k) => arr[(h >>> (k * 5)) % arr.length];
    const TAU = 2 * Math.PI;

    // ---------- voices ----------
    function pad(t0, dur, notes, g = 1, { att = 0.9, rel = 1.2, det = 1.003, bright = 0.12, wob = 1.3 } = {}) {
      const L = dur + rel;
      add(t0, L, (x) => {
        const e = Math.min(1, x / att) * Math.min(1, Math.max(0, (L - x) / rel));
        let v = 0;
        for (const m of notes) { const f = midi(m); v += Math.sin(TAU * f * x) + 0.35 * Math.sin(TAU * f * det * x + 1) + bright * Math.sin(2 * TAU * f * x); }
        return v * e * 0.022 * (1 + 0.08 * Math.sin(x * wob));
      }, g);
    }
    function sub(t0, dur, m, g = 1) {
      const f = midi(m);
      add(t0, dur, (x) => Math.sin(TAU * f * x) * Math.min(1, x / 0.08) * Math.min(1, (dur - x) / 0.4) * 0.16, g);
    }
    function pop(t0, m, g = 1, pan = 0) { // the original soft UI pop
      const f = midi(m);
      add(t0, 0.25, (x) => Math.sin(TAU * f * x * (1 + 0.15 * Math.exp(-x * 60))) * Math.exp(-x * 22) * 0.35, g, pan);
    }
    function fm(t0, m, g = 1, pan = 0, { ratio = 1, index = 1.5, idecay = 6, decay = 3, len = 2.5, att = 0.004, tine = 0, lp = 0 } = {}) {
      const f = midi(m); let y = 0;
      add(t0, len, (x) => {
        let v = Math.sin(TAU * f * x + index * Math.exp(-x * idecay) * Math.sin(TAU * f * ratio * x));
        if (tine) v += tine * Math.sin(TAU * f * 7.03 * x) * Math.exp(-x * 45);
        v *= Math.exp(-x * decay) * Math.min(1, x / att) * Math.min(1, (len - x) / 0.06);
        if (lp) { y += lp * (v - y); v = y; }
        return v * 0.3;
      }, g, pan);
    }
    const ep = (t0, m, g, pan = 0, len = 2.4) => fm(t0, m, g, pan, { ratio: 1, index: 1.1, idecay: 3.5, decay: 1.5, len, tine: 0.22, lp: 0.22 });
    const bell = (t0, m, g, pan = 0, len = 4) => fm(t0, m, g, pan, { ratio: 3.5, index: 2.2, idecay: 2.2, decay: 0.95, len, att: 0.002 });
    function marimba(t0, m, g = 1, pan = 0) {
      const f = midi(m);
      add(t0, 1.1, (x) => (Math.sin(TAU * f * x) * Math.exp(-x * 5.5) + 0.3 * Math.sin(TAU * f * 3.93 * x) * Math.exp(-x * 17) + 0.08 * Math.sin(TAU * f * 9.2 * x) * Math.exp(-x * 45))
        * Math.min(1, x / 0.0015) * Math.min(1, (1.1 - x) / 0.05) * 0.34, g, pan);
    }
    function pluck(t0, m, g = 1, pan = 0, { decay = 0.996, bright = 0.45, len = 2.2 } = {}) { // Karplus-Strong, a nylon-like string
      const f = midi(m), P = Math.max(2, Math.round(SR / f)), buf = new Float32Array(P);
      let lp = 0; for (let i = 0; i < P; i++) { lp += bright * (rnd() - lp); buf[i] = lp; }
      let j = 0;
      add(t0, len, (x) => { const c = buf[j], n = buf[(j + 1) % P]; buf[j] = decay * 0.5 * (c + n); j = (j + 1) % P; return c * 0.55 * Math.min(1, (len - x) / 0.08); }, g, pan);
    }
    function saw(t0, m, g = 1, pan = 0, len = 0.3, harm = 7, decay = 7) {
      const f = midi(m);
      add(t0, len, (x) => { let v = 0; for (let k = 1; k <= harm; k++) v += Math.sin(TAU * f * k * x) / k * Math.exp(-x * decay * (1 + k * 0.18)); return v * 0.13 * Math.min(1, x / 0.003) * Math.min(1, (len - x) / 0.03); }, g, pan);
    }
    function kick(t0, g = 1) { let ph = 0; add(t0, 0.42, (x) => { ph += TAU * (44 + 70 * Math.exp(-x * 26)) / SR; return Math.sin(ph) * Math.exp(-x * 8) * 0.55; }, g); }
    function noise(t0, g = 1, { len = 0.2, att = 0.002, decay = 30, lp = 0.5, hp = 0.1, pan = 0 } = {}) {
      let a = 0, b = 0;
      add(t0, len, (x) => { a += lp * (rnd() - a); b += hp * (a - b); return (a - b) * Math.min(1, x / att) * Math.exp(-x * decay) * Math.min(1, (len - x) / 0.01); }, g, pan);
    }
    const brush = (t, g, pan = 0) => noise(t, g * 0.9, { len: 0.34, att: 0.05, decay: 10, lp: 0.3, hp: 0.06, pan });
    const hat = (t, g, pan = 0.2) => noise(t, g * 0.6, { len: 0.07, decay: 75, lp: 0.95, hp: 0.55, pan });
    const shaker = (t, g, pan = -0.2) => noise(t, g * 0.55, { len: 0.1, att: 0.018, decay: 38, lp: 0.85, hp: 0.4, pan });
    function click(t0, g = 1, pan = 0) { // a crisp digital click
      add(t0, 0.035, (x) => (Math.sin(TAU * 1900 * x) * 0.5 + rnd() * 0.5) * Math.exp(-x * 260) * 0.3, g, pan);
    }
    function softTick(t0, g = 1) { let prev = 0; add(t0, 0.03, (x) => { const n = rnd(); const hp = n - prev; prev = n; return hp * Math.exp(-x * 220) * 0.25; }, g); }
    function swell(tHit, pre = 0.9, g = 1) {
      let lp = 0;
      add(tHit - pre, pre + 0.25, (x) => { const u = x / pre; const env = u < 1 ? u * u * u : Math.exp(-(x - pre) * 18); lp += (0.015 + 0.12 * Math.min(1, u)) * (rnd() - lp); return lp * env * 0.9; }, g);
    }

    // ---------- the palettes ----------
    // chords are [bass, ...voicing] in C; `key` transposes the lot
    const defs = {
      classic: {
        bpm: [96, 96], keys: [0], every: Infinity,
        prog: [[41, 53, 57, 60, 64], [36, 48, 55, 60, 64], [45, 57, 60, 64, 67], [46, 58, 62, 65, 69]],
        title: [46, 58, 62, 65, 69], end: [41, 53, 60, 64, 67, 69],
        pent: [84, 86, 88, 91, 93], mark: [77, 81, 84, 88, 89],
        pad: (t, d, ch, g) => { sub(t, d + 0.3, ch[0] + 12 * (ch[0] < 40 ? 1 : 0), 0.85); pad(t, d, ch.slice(1), g); },
        bar(t, ch, E, k, card, B) {
          if (E(t) >= 1) strum('piano', t, ch.slice(1), k ? 0.2 : 0.32, 0, 0.025, { cut: 4 * B + 0.6 });
          const arp = [1, 2, 3, 4, 3, 2].map((i) => ch[i] + 12), step = card || E(t) >= 3 ? B / 2 : B;
          for (let j = 0, tn = t; tn < t + 4 * B - 1e-6; j++, tn += step) {
            if (!card && E(tn) < 2) continue;
            play('vibes', tn, arp[j % arp.length], j % 4 === 0 ? 0.17 : 0.1, j % 2 ? 0.25 : -0.25, { cut: 0.9 });
            if (card && j % 2) softTick(tn, 0.4);
          }
        },
        blip: pop, tick: softTick,
        appear: (t, k) => play('vibes', t, [72, 76, 79, 84][k % 4] + KEY, 0.16, 0, { cut: 1.4 }),
        sting(t, dur, B) {
          swell(t + 0.1, 0.7, 0.3);
          strum('vibes', t + 0.32, [65, 69, 72, 76].map((m) => m + KEY), 0.2, 0, 0.04, { cut: 2.2 });
          [72, 76, 79, 84].forEach((m, k) => play('vibes', dur - 0.85 + k * B / 2 - 1.2, m + KEY, 0.2, (k - 1.5) * 0.15, { cut: 2.2 }));
          sub(dur - 2.6, 2.6, 41 + KEY, 0.6);
        },
      },
      lofi: {
        bpm: [78, 86], keys: [3, 5, -2], every: 2,
        prog: [[36, 52, 55, 59, 62], [33, 48, 52, 55, 59], [38, 53, 57, 60, 64], [43, 53, 57, 60, 64]], // Cmaj9 Am9 Dm9 G9sus
        title: [41, 52, 57, 60, 64], end: [36, 52, 55, 59, 62, 67],
        pent: [79, 81, 84, 86, 88], mark: [72, 76, 79, 83, 86],
        pad: (t, d, ch, g) => { sub(t, d + 0.3, ch[0], 0.7); pad(t, d, ch.slice(1, 4), g * 0.55, { att: 1.4, bright: 0.04 }); },
        bar(t, ch, E, k, card, B) {
          const sw = (j) => t + j * B / 2 + (j % 2 ? B * 0.08 : 0); // swung eighths
          if (E(t) >= 1) ch.slice(1).forEach((m, i) => ep(t + i * 0.018, m, 0.2, (i - 2) * 0.12, 4 * B));
          if (E(t) >= 2) [1, 2, 3].forEach((i) => ep(sw(5), ch[i] + 12, 0.08, 0.2, 1.2));
          if (!card) for (let j = 0; j < 8; j++) {
            const tn = sw(j), e = E(tn);
            if (e >= 2 && (j === 0 || j === 3 || j === 4)) kick(tn, j ? 0.5 : 0.7);
            if (e >= 2 && (j === 2 || j === 6)) brush(tn, 0.6);
            if (e >= 3) hat(tn, j % 2 ? 0.18 : 0.28);
          }
          if (E(t) >= 3) [ch[4] + 12, ch[3] + 12].forEach((m, i) => ep(sw(3 + i * 3), m, 0.09, 0.3, 1.4));
        },
        blip: (t, m, g, pan) => ep(t, m, g * 0.8, pan, 0.6), tick: (t, g) => noise(t, g * 0.35, { len: 0.025, decay: 180, lp: 0.6, hp: 0.3 }),
        appear: (t, k) => { ep(t, [76, 79][k % 2] + KEY, 0.16, 0, 1.2); ep(t + 0.09, [83, 84][k % 2] + KEY, 0.1, 0.2, 1.2); },
        sting(t, dur, B) {
          swell(t + 0.1, 0.8, 0.22);
          [48, 52, 55, 59, 62, 67].forEach((m, i) => ep(t + 0.3 + i * 0.05, m + KEY, 0.2, (i - 2.5) * 0.1, 3.4));
          kick(t + 0.3, 0.6); brush(t + 0.3 + B, 0.5);
          sub(t + 0.3, dur - t - 0.3, 36 + KEY, 0.7);
        },
      },
      marimba: {
        bpm: [104, 112], keys: [0, 2, 7], every: 1,
        prog: [[36, 60, 64, 67, 72], [43, 59, 62, 67, 71], [45, 60, 64, 69, 72], [41, 60, 65, 69, 72]], // C G Am F
        title: [41, 60, 65, 69, 72], end: [36, 60, 64, 67, 72, 76],
        pent: [84, 86, 88, 91, 93], mark: [72, 76, 79, 84, 88],
        pad: (t, d, ch, g) => pad(t, d, ch.slice(1, 4), g * 0.35, { att: 0.6, bright: 0.02 }),
        bar(t, ch, E, k, card, B) {
          const up = ch.slice(1);
          for (let j = 0; j < 8; j++) {
            const tn = t + j * B / 2, e = E(tn);
            if (e >= 1 && (j === 0 || j === 3 || j === 6)) marimba(tn, up[(j / 3) % up.length | 0], j ? 0.2 : 0.26, -0.2);
            if (e >= 2 && !card) { marimba(tn, up[[0, 2, 1, 3, 2, 0, 3, 1][j]] + 12, j % 2 ? 0.1 : 0.14, 0.25); shaker(tn, j % 2 ? 0.3 : 0.45); }
            if (e >= 2 && !card && (j === 0 || j === 5)) pluck(tn, ch[0] + 12, 0.38, 0, { decay: 0.993, bright: 0.35, len: 1 });
            if (e >= 3 && !card && j % 4 === 2) marimba(tn, up[3] + 24, 0.08, 0.35);
          }
        },
        blip: (t, m, g, pan) => marimba(t, m, g * 1.1, pan), tick: (t, g) => noise(t, g * 0.35, { len: 0.02, decay: 220, lp: 0.9, hp: 0.5 }),
        appear: (t, k) => { marimba(t, 79 + KEY, 0.22, -0.1); marimba(t + 0.1, [84, 86][k % 2] + KEY, 0.18, 0.1); },
        sting(t, dur, B) {
          [72, 76, 79, 84, 88].forEach((m, i) => marimba(t + 0.15 + i * B / 4, m + KEY, 0.22, (i - 2) * 0.15));
          [60, 64, 67, 72].forEach((m) => marimba(t + 0.15 + 5 * B / 4, m + KEY, 0.2));
          pluck(t + 0.15 + 5 * B / 4, 36 + KEY, 0.4, 0, { len: 2 });
          shaker(t + 0.15 + 5 * B / 4, 0.5);
          pad(t + 0.15 + 5 * B / 4, dur - t - 1.8, [60, 64, 67].map((m) => m + KEY), 0.4);
        },
      },
      glass: {
        bpm: [68, 74], keys: [2, 4, -3], every: 2,
        prog: [[29, 53, 57, 59, 64], [33, 52, 55, 59, 60], [31, 55, 57, 59, 64], [36, 55, 59, 62, 64]], // Fmaj7#11 Am(add9) G6/9 Cmaj9
        title: [29, 53, 57, 59, 64], end: [36, 55, 59, 62, 64, 67],
        pent: [88, 91, 93, 96, 98], mark: [79, 83, 86, 88, 91],
        pad: (t, d, ch, g) => { sub(t, d + 0.3, ch[0] + 12, 0.55); pad(t, d, ch.slice(1), g * 1.15, { att: 2.2, rel: 2, det: 1.006, bright: 0.2, wob: 0.6 }); },
        bar(t, ch, E, k, card, B) {
          const up = ch.slice(1).map((m) => m + 12);
          if (E(t) >= 1) bell(t, up[(k * 2) % up.length], 0.14, -0.3);
          if (E(t + 2 * B) >= 2) bell(t + 2 * B, up[(k * 2 + 3) % up.length] + 12, 0.08, 0.3);
          if (E(t) >= 3) for (let j = 1; j < 8; j += 2) bell(t + j * B / 2, up[(j + k) % up.length] + 12, 0.04, j % 4 === 1 ? -0.4 : 0.4, 2);
          if (E(t) >= 3 && !card) swell(t + 4 * B, 2 * B, 0.08);
        },
        blip: (t, m, g, pan) => bell(t, m, g * 0.7, pan, 1.2), tick: (t, g) => add(t, 0.03, (x) => Math.sin(TAU * 3200 * x) * Math.exp(-x * 200) * 0.12, g),
        appear: (t, k) => { bell(t, [79, 83][k % 2] + KEY, 0.16, -0.1, 2.5); bell(t + 0.12, [86, 88][k % 2] + KEY, 0.1, 0.15, 2.5); },
        sting(t, dur, B) {
          swell(t + 0.2, 1.2, 0.2);
          [67, 71, 74, 76, 79].forEach((m, i) => bell(t + 0.25 + i * 0.07, m + KEY, 0.13, (i - 2) * 0.18, 5));
          pad(t + 0.2, dur - t - 1.4, [55, 59, 62, 64].map((m) => m + KEY), 0.9, { att: 1.2, bright: 0.2 });
          sub(t + 0.2, dur - t - 0.2, 36 + KEY, 0.5);
        },
      },
      pulse: {
        bpm: [116, 124], keys: [-3, 2, 0], every: 2,
        prog: [[33, 57, 60, 64, 67], [29, 57, 60, 65, 69], [36, 55, 60, 64, 67], [31, 55, 59, 62, 67]], // Am7 F C G
        title: [29, 57, 60, 65, 69], end: [33, 57, 60, 64, 67, 71],
        pent: [93, 96, 98, 100, 103], mark: [81, 84, 88, 91, 93],
        pad: (t, d, ch, g) => { sub(t, d + 0.3, ch[0] + 12, 0.95); pad(t, d, ch.slice(1, 4), g * 0.4, { att: 1.2, bright: 0.05 }); },
        bar(t, ch, E, k, card, B) {
          const up = ch.slice(1);
          for (let j = 0; j < 8; j++) {
            const tn = t + j * B / 2, e = E(tn);
            if (e >= 1 && (j === 2 || j === 6)) click(tn, 0.5, j === 2 ? -0.2 : 0.2);
            if (e >= 2 && !card) saw(tn, up[[0, 1, 2, 1, 3, 1, 2, 1][j]], j % 2 ? 0.16 : 0.22, j % 2 ? 0.25 : -0.25, B * 0.45);
            if (e >= 2 && !card && j % 2 === 0) kick(tn, 0.42);
            if (e >= 3 && !card) { hat(tn + B / 4, 0.22); if (j % 4 === 3) saw(tn, up[3] + 12, 0.08, 0.4, B * 0.4, 5, 10); }
          }
        },
        blip: (t, m, g, pan) => { add(t, 0.09, (x) => Math.sin(TAU * midi(m) * x) * Math.exp(-x * 40) * 0.3, g, pan); click(t, g * 0.6, pan); }, tick: (t, g) => click(t, g * 0.5),
        appear: (t, k) => [0, 3, 7].forEach((i) => saw(t, [69, 72][k % 2] + KEY + i, 0.12, 0, 0.5, 6, 5)),
        sting(t, dur, B) {
          [57, 60, 64, 67, 71].forEach((m) => saw(t + 0.3, m + KEY, 0.14, 0, 1.6, 7, 2.2));
          kick(t + 0.3, 0.8); for (let i = 0; i < 6; i++) click(t + 0.3 + 2 * B + i * B / 4, 0.35 - i * 0.04, (i % 2 ? 0.2 : -0.2));
          pad(t + 0.3, dur - t - 1.5, [57, 60, 64, 71].map((m) => m + KEY), 0.6);
          sub(t + 0.3, dur - t - 0.3, 33 + KEY + 12, 0.8);
        },
      },
      nylon: {
        bpm: [88, 94], keys: [2, 7, 0], every: 2,
        prog: [[36, 55, 60, 64, 67], [40, 55, 59, 64, 67], [33, 55, 60, 64, 69], [41, 57, 60, 65, 69]], // C Em Am7 F
        title: [41, 57, 60, 65, 69], end: [36, 55, 60, 64, 67, 74],
        pent: [76, 79, 81, 84, 86], mark: [67, 72, 76, 79, 84],
        pad: (t, d, ch, g) => pad(t, d, ch.slice(1, 4), g * 0.45, { att: 1.5, bright: 0.03 }),
        bar(t, ch, E, k, card, B) {
          const up = ch.slice(1);
          const pat = [ch[0] + 12, up[1], up[2], up[3], ch[0] + 19, up[2], up[3], up[1]]; // p i m a, thumb on 1 and 3
          for (let j = 0; j < 8; j++) {
            const tn = t + j * B / 2, e = E(tn);
            if (e >= 1 && (j % 2 === 0 || e >= 2)) pluck(tn + 0.004 * j, pat[j], j % 4 === 0 ? 0.42 : 0.26, (j % 2 ? 0.2 : -0.15), { len: 1.8 });
            if (e >= 3 && !card && j % 2) shaker(tn, 0.22);
          }
          if (E(t) >= 2) strum('piano', t, up.map((m) => m + 12).slice(0, 3), 0.1, 0.1, 0.03, { cut: 4 * B });
          if (E(t) >= 3) play('piano', t + 3 * B, up[3] + 12, 0.14, 0.2, { cut: 2 * B });
        },
        blip: (t, m, g, pan) => pluck(t, m, g * 0.9, pan, { decay: 0.99, bright: 0.8, len: 0.5 }), tick: softTick,
        appear: (t, k) => { pluck(t, [72, 74][k % 2] + KEY, 0.3, -0.1, { len: 1.5 }); pluck(t + 0.02, [79, 81][k % 2] + KEY, 0.24, 0.1, { len: 1.5 }); },
        sting(t, dur, B) {
          [36, 43, 52, 55, 60, 64, 67].forEach((m, i) => pluck(t + 0.3 + i * 0.035, m + KEY, 0.34, (i - 3) * 0.1, { len: 3.2, decay: 0.998 }));
          strum('piano', t + 0.3 + B, [60, 64, 67, 74].map((m) => m + KEY), 0.16, 0, 0.04, { cut: 3 });
          pad(t + 0.3, dur - t - 1.5, [60, 64, 67].map((m) => m + KEY), 0.5);
        },
      },
    };
    const D = defs[name];
    const KEY = pick(D.keys, 1);
    const bpm = D.bpm[0] + ((h >>> 3) % (D.bpm[1] - D.bpm[0] + 1));
    const tr = (ch) => ch.map((m) => m + KEY);
    return {
      name, desc: PALETTES[name], bpm, key: KEY, every: D.every,
      prog: D.prog.map(tr), title: tr(D.title), end: tr(D.end), pent: D.pent.map((m) => m + KEY), mark: D.mark.map((m) => m + KEY),
      pad: D.pad, bar: D.bar, blip: D.blip, tick: D.tick, appear: D.appear, sting: D.sting, swell, sub,
    };
  }
  const API = { PALETTES, makePalette };
  if (typeof module !== 'undefined') module.exports = API; else window.PALETTES = API;
})();

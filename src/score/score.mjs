// The score: a music bed from a palette (or your own track, or none), UI sounds
// locked to the picture (a blip per click, a tick per key, a hit on each
// landing), and the voiceover ducked on top, mastered to -14 LUFS.
// Every random choice is seeded, so the same timeline gives the same audio.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT } from '../config.mjs';

const require = createRequire(import.meta.url);
const { makePalette, PALETTES } = require('./palettes.cjs');
export { PALETTES };

const SR = 44100;
function decode(file, ch = 1) { // any audio file -> Float32 channels at SR
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', String(ch), '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
  const n = (b.length >> 1) / ch, out = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) out[c][i] = b.readInt16LE((i * ch + c) * 2) / 32768;
  return out;
}

// T: the timeline; music: config.music; voDir: where <id>.wav live (when audio);
// returns the path of the mastered score.wav
export function renderScore({ T, outDir, voDir, audio, music = {}, seed = '' }) {
  const N = Math.round(T.duration * SR);
  const ML = new Float32Array(N), MR = new Float32Array(N), VO = new Float32Array(N);
  const SFX = music.sfx !== false;
  const paletteName = music.track ? null : music.palette || 'glass';
  if (paletteName && paletteName !== 'none' && !PALETTES[paletteName]) throw new Error(`music.palette "${paletteName}" is not one of ${Object.keys(PALETTES).join(', ')}, none`);

  let s32 = 0x6a11;
  const rnd = () => { s32 |= 0; s32 = (s32 + 0x6d2b79f5) | 0; let x = Math.imul(s32 ^ (s32 >>> 15), 1 | s32); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296 * 2 - 1; };
  function add(t0, dur, fn, gain = 1, pan = 0) {
    const s0 = Math.round(t0 * SR), n = Math.round(dur * SR);
    const gl = gain * Math.min(1, 1 - pan), gr = gain * Math.min(1, 1 + pan);
    for (let i = 0; i < n; i++) { const k = s0 + i; if (k < 0 || k >= N) continue; const v = fn(i / SR, i); ML[k] += v * gl; MR[k] += v * gr; }
  }
  const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const hsh = (n) => { const s = Math.sin(n * 91.3 + 7.1) * 43758.5453; return s - Math.floor(s); };

  // ---- the CC0 sample player (samples/, see samples/LICENSES) ----
  const SAMPLES = join(ROOT, 'samples');
  const LIB = JSON.parse(readFileSync(join(SAMPLES, 'index.json'), 'utf8')).instruments;
  const decoded = new Map();
  const sample = (f) => { if (!decoded.has(f)) decoded.set(f, decode(join(SAMPLES, f))[0]); return decoded.get(f); }; // FLAC decodes bit-exact
  function sustain(buf, secs) { // crossfade-loop the steady middle of a note out to `secs`
    const a = Math.floor(buf.length * 0.3), b = buf.length - Math.floor(0.45 * SR), xf = Math.floor(0.15 * SR), n = Math.ceil(secs * SR);
    if (n <= b || b - a < 2 * xf) return buf;
    const out = new Float32Array(n); out.set(buf.subarray(0, b));
    let w = b, k = 0;
    while (w < n) {
      for (let i = 0; i < b - a && w + i < n; i++) {
        const src = buf[a + i];
        if (i < xf) { const q = i / xf, tail = buf[b - xf + i] || 0; out[w - xf + i] = tail * Math.cos(q * Math.PI / 2) + src * Math.sin(q * Math.PI / 2); }
        else out[w - xf + i] = src;
      }
      w += b - a - xf; if (++k > 200) break;
    }
    return out;
  }
  let rr = 0;
  function play(inst, t0, m = 60, g = 1, pan = 0, { rate = 1, cut = Infinity, hold = 0, attack = 0 } = {}) {
    const I = LIB[inst];
    if (!I) throw new Error(`no instrument "${inst}" in the sample library (${Object.keys(LIB).join(', ')})`);
    let best = I.notes[0];
    if (I.pitched) for (const n of I.notes) if (Math.abs(n.midi - m) < Math.abs(best.midi - m)) best = n;
    const file = best.files[Math.floor(hsh(++rr * 1.37) * best.files.length)];
    const r = (I.pitched ? Math.pow(2, (m - best.midi) / 12) : 1) * rate;
    let buf = sample(file), rel = 0.04;
    if (hold > 0) { buf = sustain(buf, hold * r + 0.5); cut = Math.min(cut, hold); rel = 0.35; }
    const len = Math.min(buf.length / r, cut * SR) / SR;
    add(t0, len, (x, i) => {
      const p = i * r, j = Math.floor(p), u = p - j, v = (buf[j] || 0) + ((buf[j + 1] || 0) - (buf[j] || 0)) * u;
      return v * Math.min(1, (len - x) / rel) * (attack > 0 ? Math.min(1, x / attack) : 1);
    }, g, pan);
  }
  const strum = (inst, t0, notes, g = 1, pan = 0, spread = 0.03, o = {}) => notes.forEach((m, k) => play(inst, t0 + k * spread, m, g, pan, o));

  // the palette also voices the UI sounds, so even with no bed (or your own
  // track) the clicks and ticks have a timbre; "glass" is the quiet default
  const PAL = makePalette(paletteName && paletteName !== 'none' ? paletteName : 'glass', { add, play, strum, rnd, hsh, midi, SR }, seed);
  const B = 60 / PAL.bpm, BAR = 4 * B;
  const M = music;
  const turnEv = M.turn ? T.events.find((e) => e.label === M.turn) : null;
  if (M.turn && !turnEv) throw new Error(`music.turn "${M.turn}" is not an event label`);
  const TURN = turnEv ? turnEv.u : (T.beats.length ? T.beats[T.beats.length - 1].t0 : Infinity);

  if (paletteName && paletteName !== 'none') {
    // energy: thin at the start, the groove in the middle, full on the payoff,
    // and a drop (pad only) for two beats right before the turn
    const beatE = (i, n) => (M.energy && M.energy[T.beats[i].id] != null ? M.energy[T.beats[i].id] : n === 1 ? 2 : 1 + Math.round(i / (n - 1)));
    const E = (t) => {
      if (t < T.T0 - 0.3) return 1;
      if (t >= T.endStart - 0.1) return 2;
      if (t >= TURN - 2 * B && t < TURN) return 0;
      let i = 0; T.beats.forEach((b, k) => { if (t >= b.t0 - 0.1) i = k; });
      return T.beats.length ? Math.min(3, beatE(i, T.beats.length) + (t >= TURN ? 1 : 0)) : 2;
    };
    const grid = (t) => Math.round(t / (B / 2)) * (B / 2);
    const sections = [{ a: 0, card: true, ch: [PAL.title] }];
    T.beats.forEach((b, i) => sections.push({ a: Math.max(sections[sections.length - 1].a + B, grid(Math.max(T.T0 - 0.3, b.t0 - 0.1))), card: false, i }));
    if (!T.beats.length) sections.push({ a: grid(T.T0 - 0.3), card: false, i: 0 });
    sections.push({ a: grid(T.endStart - 0.1), card: true, end: true, ch: [PAL.end] });
    sections.forEach((s, si) => {
      const b = si + 1 < sections.length ? sections[si + 1].a : T.duration;
      if (b - s.a < 0.2) return;
      const spans = [];
      if (s.card) spans.push({ a: s.a, b, ch: s.ch[0] });
      else {
        const every = Number.isFinite(PAL.every) ? PAL.every * BAR : Infinity;
        for (let t = s.a, k = 0; t < b - 0.2; t += every, k++) spans.push({ a: t, b: Math.min(b, t + every), ch: PAL.prog[(s.i * 2 + k) % PAL.prog.length] });
      }
      for (const sp of spans) {
        PAL.pad(sp.a, sp.b - sp.a, sp.ch, s.end ? 0.7 : 0.95);
        for (let t = sp.a, k = 0; t < sp.b - 0.4; t += BAR, k++) PAL.bar(t, sp.ch, E, k, s.card, B);
      }
    });
    // the bed follows the energy with a smooth gain (ramps, never steps)
    const LV = [0.4, 0.55, 0.75, 1], hop = Math.round(0.01 * SR), nf = Math.ceil(N / hop) + 1, tg = new Float32Array(nf);
    for (let f = 0; f < nf; f++) tg[f] = LV[E((f * hop) / SR)];
    const w = 15, sm = new Float32Array(nf);
    for (let f = 0; f < nf; f++) { let a = 0, n = 0; for (let k = -w; k <= w; k++) { const q = f + k; if (q >= 0 && q < nf) { a += tg[q]; n++; } } sm[f] = a / n; }
    for (let i = 0; i < N; i++) { const f = i / hop, f0 = Math.floor(f), g = sm[f0] + (sm[Math.min(nf - 1, f0 + 1)] - sm[f0]) * (f - f0); ML[i] *= g; MR[i] *= g; }
    if (Number.isFinite(TURN) && TURN < T.endStart) { PAL.swell(TURN, 2 * B, 0.2); PAL.sub(TURN, 1.6, PAL.prog[0][0] + 12, 0.6); }
    PAL.sting(T.endStart, T.duration, B);
  } else if (music.track) {
    // your own track: from the start, faded in and out, at music.volume
    const [l, r] = decode(music.track, 2), vol = music.volume ?? 1;
    for (let i = 0; i < N && i < l.length; i++) {
      const g = vol * 0.5 * Math.min(1, i / (0.5 * SR), (N - i) / (1.8 * SR));
      ML[i] += l[i] * g; MR[i] += r[i] * g;
    }
  }

  // ---- UI sounds locked to the picture ----
  if (SFX) {
    PAL.mark.forEach((m, k) => PAL.blip(0.12 + k * 0.09, m, 0.12, (k - 2) * 0.2)); // the title arrives
    PAL.swell(T.T0 - 0.2, 0.7, 0.2);                                                 // the window arrives
    let ci = 0;
    for (const e of T.events) {
      if (e.type === 'click') { PAL.blip(e.u - 0.01, PAL.pent[ci++ % PAL.pent.length], 0.2, ((e.x / T.viewport.width) - 0.5) * 0.5); PAL.tick(e.u, 0.6); }
      if (e.type === 'select') { PAL.swell(e.u, Math.max(0.3, e.u - e.u0), 0.14); PAL.blip(e.u, PAL.pent[2], 0.14); }
      if (e.type === 'appear') PAL.appear(e.u + 0.02, ci++);
    }
    T.keys.forEach((t, k) => PAL.tick(t, 0.55 + 0.3 * hsh(k + 20)));
    PAL.mark.forEach((m, k) => PAL.blip(T.endStart + 0.15 + k * 0.09, m, 0.12, (k - 2) * 0.2)); // the end card
  }

  // ---- voice, ducking and the mix ----
  if (audio) for (const id of T.ORDER) {
    const f = join(voDir, id + '.wav');
    if (!existsSync(f)) continue;
    const v = decode(f)[0], s0 = Math.round(T.cue[id] * SR);
    for (let i = 0; i < v.length && s0 + i < N; i++) VO[s0 + i] += v[i];
  }
  let vp = 0; for (let i = 0; i < N; i++) vp = Math.max(vp, Math.abs(VO[i]));
  for (let i = 0; i < N; i++) VO[i] /= vp || 1;
  const env = new Float32Array(N);
  { const a = Math.exp(-1 / (0.05 * SR)), r = Math.exp(-1 / (0.35 * SR)); let e = 0; for (let i = 0; i < N; i++) { const x = Math.abs(VO[i]) > 0.02 ? 1 : 0; e = x > e ? a * e + (1 - a) * x : r * e + (1 - r) * x; env[i] = e; } }
  let mp = 0; for (let i = 0; i < N; i++) { ML[i] = Math.tanh(ML[i] * 1.1); MR[i] = Math.tanh(MR[i] * 1.1); mp = Math.max(mp, Math.abs(ML[i]), Math.abs(MR[i])); }
  // the music level: set so the voice sits about 15 dB over the ducked music in
  // the speech band (250 Hz to 4 kHz) while it talks, whatever the bed
  // (this filter reads about 3 dB under a typical speech-band meter, so 12 lands near 15)
  const VM_TARGET = 12;
  const bandpass = (get) => {
    const aH = Math.exp(-2 * Math.PI * 250 / SR), aL = 1 - Math.exp(-2 * Math.PI * 4000 / SR), out = new Float32Array(N);
    const h = [0, 0, 0], x1 = [0, 0, 0], l = [0, 0]; // three high-pass and two low-pass stages: steep enough that the sub stays out
    for (let i = 0; i < N; i++) {
      let x = get(i);
      for (let k = 0; k < 3; k++) { h[k] = aH * (h[k] + x - x1[k]); x1[k] = x; x = h[k]; }
      for (let k = 0; k < 2; k++) { l[k] += aL * (x - l[k]); x = l[k]; }
      out[i] = x;
    }
    return out;
  };
  const vmw = [];
  if (vp > 0) {
    const vb = bandpass((i) => VO[i] * 0.8), mb = bandpass((i) => (ML[i] + MR[i]) / 2 * (1 - 0.55 * env[i]));
    for (let s0 = 0; s0 + SR <= N; s0 += SR / 2) {
      let v = 0, m = 0, act = 0;
      for (let i = s0; i < s0 + SR; i++) { v += vb[i] * vb[i]; m += mb[i] * mb[i]; if (env[i] > 0.5) act++; }
      if (act > 0.5 * SR && m > 0) vmw.push(10 * Math.log10(v / m));
    }
    vmw.sort((a, b) => a - b);
  }
  const MUSIC = (vmw.length ? Math.pow(10, (vmw[vmw.length >> 1] - VM_TARGET) / 20) : 0.31 / (mp || 1)) * (paletteName && paletteName !== 'none' ? (music.volume ?? 1) : 1);
  const Lo = new Float32Array(N), Ro = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const duck = 1 - 0.55 * env[i], fade = Math.min(1, (N - i) / (0.6 * SR), i / (0.02 * SR));
    Lo[i] = (ML[i] * MUSIC * duck + VO[i] * 0.8) * fade; Ro[i] = (MR[i] * MUSIC * duck + VO[i] * 0.8) * fade;
  }
  let pk = 0; for (let i = 0; i < N; i++) pk = Math.max(pk, Math.abs(Lo[i]), Math.abs(Ro[i]));
  const buf = Buffer.alloc(44 + N * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
  const norm = pk > 1e-6 ? 0.89 / pk : 0;
  for (let i = 0; i < N; i++) { buf.writeInt16LE(Math.round(Lo[i] * norm * 32767), 44 + i * 4); buf.writeInt16LE(Math.round(Ro[i] * norm * 32767), 46 + i * 4); }
  const rawWav = join(outDir, 'score_raw.wav'), out = join(outDir, 'score.wav');
  writeFileSync(rawWav, buf);
  if (pk <= 1e-6) { execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', rawWav, '-c:a', 'pcm_s16le', out]); return out; } // silence: nothing to master
  // master: two-pass loudnorm to -14 LUFS, true peak -2 dBTP (measure, then apply linearly)
  const o = spawnSync('ffmpeg', ['-hide_banner', '-i', rawWav, '-af', 'loudnorm=I=-14:TP=-2:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' });
  const meas = JSON.parse(o.stderr.slice(o.stderr.lastIndexOf('{'), o.stderr.lastIndexOf('}') + 1));
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', rawWav, '-af',
    `loudnorm=I=-14:TP=-2:LRA=11:measured_I=${meas.input_i}:measured_TP=${meas.input_tp}:measured_LRA=${meas.input_lra}:measured_thresh=${meas.input_thresh}:offset=${meas.target_offset}:linear=true`,
    '-ar', '44100', '-fflags', '+bitexact', out]);
  return out;
}

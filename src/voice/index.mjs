// Voiceover: optional and pluggable. Each provider turns a narrative line into
// vo/<id>.wav (44.1 kHz mono, silence trimmed). Word timings for the captions
// come from faster-whisper when it is installed, else the words are spread
// evenly over the line (weighted by length, with a pause after punctuation).
//
//   none    no audio; captions still run, timed at a natural speaking pace
//   file    your own WAV or MP3 per line: "file" on the line, or <dir>/<id>.wav|mp3
//   gemini  Google Cloud Text-to-Speech (Gemini TTS) with your own gcloud login
//   say     macOS `say`, a free local fallback
//
// Lines are re-voiced only when their text, direction or voice settings change.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gemini } from './gemini.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { encoding: 'utf8', maxBuffer: 1 << 26, ...o });
const probe = (f) => +sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).trim();

// trim silence at both ends, apply the pace (pitch kept), leave a short tail
export function finishWav(src, dst, pace = 1) {
  const tempo = pace && pace !== 1 ? `,atempo=${pace}` : '';
  sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-af',
    `silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,apad=pad_dur=0.08,areverse${tempo},apad=pad_dur=0.1`,
    '-ar', '44100', '-ac', '1', '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-map_metadata', '-1', dst]);
}

// speaking-rate estimate for silent captions (provider "none"): about 2.7 words a second
export function estimateSecs(say) {
  const words = say.split(/\s+/).filter(Boolean);
  const pauses = (say.match(/[.,!?;:]/g) || []).length;
  return +(0.25 + words.length / 2.7 + pauses * 0.18).toFixed(3);
}

// words spread over [0, dur]: each word's share grows with its length, plus a
// small pause after punctuation; deterministic
export function evenWords(say, dur) {
  const ws = say.split(/\s+/).filter(Boolean);
  if (!ws.length) return [];
  const weight = (w) => 1.2 + w.replace(/[^\p{L}\p{N}]/gu, '').length * 0.32;
  const pause = (w) => (/[.!?]$/.test(w) ? 1.6 : /[,;:]$/.test(w) ? 0.8 : 0);
  const lead = 0.05, tail = 0.12, total = ws.reduce((a, w, i) => a + weight(w) + (i < ws.length - 1 ? pause(w) : 0), 0);
  const k = Math.max(0.01, dur - lead - tail) / total;
  const out = [];
  let t = lead;
  ws.forEach((w, i) => {
    const a = t, b = t + weight(w) * k;
    out.push([w, +a.toFixed(3), +b.toFixed(3)]);
    t = b + (i < ws.length - 1 ? pause(w) * k : 0);
  });
  return out;
}

export function findWhisperPython() {
  for (const py of [process.env.DEMOLOOM_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const r = spawnSync(py, ['-c', 'import faster_whisper'], { stdio: 'ignore' });
    if (r.status === 0) return py;
  }
  return null;
}

const DEFAULTS = {
  gemini: { voice: 'Sulafat', model: 'gemini-2.5-pro-tts', languageCode: 'en-US', pace: 1.04,
    direction: 'Voice: a calm, warm, conversational product-demo narrator. Relaxed and unhurried, like a friendly colleague showing you something neat on their screen. Light, easy emphasis: never pushing, never selling, never breathless. Let every line settle on a relaxed, falling finish. Natural, human pacing: take a real breath between sentences.' },
  say: { voice: 'Samantha', rate: 175, pace: 1 },
  file: { dir: 'vo', pace: 1 },
  none: {},
};

// lines: narrative.vo; cfg: the voice config; voDir: out/vo; flowDir: where relative files resolve
export async function voiceLines({ lines, cfg, voDir, flowDir, force = [], log = console.log }) {
  mkdirSync(voDir, { recursive: true });
  const provider = cfg.provider || 'none';
  const V = { ...DEFAULTS[provider], ...cfg };
  const durations = {}, words = {};
  if (!lines.length) return { durations, words, audio: false, provider };

  if (provider === 'none') {
    for (const l of lines) { durations[l.id] = estimateSecs(l.say); words[l.id] = evenWords(l.say, durations[l.id]); }
    return { durations, words, audio: false, provider, aligner: 'even' };
  }

  const fileFor = (l) => {
    if (provider !== 'file') return null;
    if (l.file) return resolve(flowDir, l.file);
    for (const ext of ['wav', 'mp3', 'm4a', 'aiff']) { const f = resolve(flowDir, V.dir, `${l.id}.${ext}`); if (existsSync(f)) return f; }
    return null;
  };
  const settings = JSON.stringify({ provider, voice: V.voice, model: V.model, direction: V.direction, pace: V.pace, rate: V.rate, languageCode: V.languageCode });
  const hash = (l) => {
    const f = fileFor(l);
    const fileStamp = f && existsSync(f) ? `${statSync(f).size}:${statSync(f).mtimeMs}` : '';
    return createHash('sha1').update(settings + '\n' + l.say + '\n' + (l.direct || '') + '\n' + fileStamp).digest('hex').slice(0, 12);
  };
  const hf = join(voDir, '.hashes.json');
  const cache = existsSync(hf) ? JSON.parse(readFileSync(hf, 'utf8')) : {};
  const todo = lines.filter((l) => force.includes(l.id) || cache[l.id]?.hash !== hash(l) || !existsSync(join(voDir, `${l.id}.wav`)));

  if (todo.length) {
    log(`voicing ${todo.map((l) => l.id).join(', ')} (${provider}${V.voice ? ', ' + V.voice : ''})...`);
    for (const l of todo) {
      const raw = join(voDir, `${l.id}.raw`), out = join(voDir, `${l.id}.wav`);
      if (provider === 'file') {
        const f = fileFor(l);
        if (!f || !existsSync(f)) throw new Error(`voice "file": no audio for line "${l.id}" (set "file" on the line, or add ${join(V.dir, l.id)}.wav or .mp3)`);
        finishWav(f, out, V.pace);
      } else if (provider === 'say') {
        if (process.platform !== 'darwin') throw new Error('voice "say" needs macOS');
        sh('say', ['-v', V.voice, '-r', String(V.rate), '-o', raw + '.aiff', l.say]);
        finishWav(raw + '.aiff', out, V.pace); rmSync(raw + '.aiff', { force: true });
      } else if (provider === 'gemini') {
        await gemini({ text: l.say, direction: [V.direction, l.direct].filter(Boolean).join(' '), voice: V.voice, model: V.model, languageCode: V.languageCode, project: V.project, outFile: raw + '.wav' });
        finishWav(raw + '.wav', out, V.pace); rmSync(raw + '.wav', { force: true });
      }
      cache[l.id] = { hash: hash(l), words: null };
    }
  }
  for (const l of lines) durations[l.id] = +probe(join(voDir, `${l.id}.wav`)).toFixed(3);

  // word timings: faster-whisper when available (and not turned off), else even
  const mode = V.align || 'auto';
  const py = mode === 'even' ? null : findWhisperPython();
  if (mode === 'whisper' && !py) throw new Error('voice.align is "whisper" but faster-whisper is not installed (pip install faster-whisper, or set DEMOLOOM_PYTHON)');
  const aligner = py ? 'whisper' : 'even';
  const stale = lines.filter((l) => !cache[l.id].words || cache[l.id].aligner !== aligner);
  if (stale.length && aligner === 'whisper') {
    log(`aligning words with faster-whisper: ${stale.map((l) => l.id).join(', ')}`);
    const res = JSON.parse(sh(py, [join(HERE, 'align.py'), ...stale.map((l) => join(voDir, `${l.id}.wav`))], { stdio: ['ignore', 'pipe', 'ignore'] }));
    stale.forEach((l, i) => { cache[l.id].words = res[i]; cache[l.id].aligner = 'whisper'; });
  } else for (const l of stale) { cache[l.id].words = evenWords(l.say, durations[l.id]); cache[l.id].aligner = 'even'; }
  for (const l of lines) words[l.id] = cache[l.id].words;
  writeFileSync(hf, JSON.stringify(cache, null, 1));
  return { durations, words, audio: true, provider, aligner };
}

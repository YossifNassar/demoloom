// `demoloom render <dir>`: raw.mp4 + events.json + demoloom.json -> the video.
//
// Every run decodes raw.mp4 to frames once (cached), voices any VO line whose
// text or settings changed, rebuilds the timeline, then does the mode:
//   (default) --video     <out>/<name>.mp4 (and <name>-vertical.mp4), with the score
//   --stills[=t1,t2,...]  PNG stills and a contact sheet, then the caption check
//   --verify              determinism: frames hashed forward, reversed and repeated
//                         must match; then the caption check; exit 1 on failure
//   --plan                print the plan: sped-up stretches, holds, VO cues, camera
//   --poster[=t]          one full-resolution PNG
//   --captions            only the caption check
// options: --shape=landscape|vertical|both, --out=<dir>, --preview=<file.mp4>,
//          --revoice=id,id, --fps=<n>, --voice=<provider>, --theme=<name|path>
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { join, resolve, basename, extname } from 'node:path';
import { plan } from './plan.mjs';
import { validateEvents } from './schema.mjs';
import { loadConfig, ROOT, BUNDLED_FONTS } from './config.mjs';
import { voiceLines } from './voice/index.mjs';
import { renderScore, PALETTES } from './score/score.mjs';

const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { encoding: 'utf8', maxBuffer: 1 << 28, ...o });
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.cjs': 'text/javascript', '.mjs': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json' };

export async function render(dir, opts = {}) {
  const FLOW = resolve(dir), NAME = basename(FLOW);
  const OUT = resolve(opts.out || join(FLOW, 'out'));
  mkdirSync(OUT, { recursive: true });
  for (const f of ['raw.mp4', 'events.json']) if (!existsSync(join(FLOW, f))) throw new Error(`missing ${join(FLOW, f)} (run "demoloom record" first)`);
  const flow = JSON.parse(readFileSync(join(FLOW, 'events.json'), 'utf8'));
  const errs = validateEvents(flow);
  if (errs.length) throw new Error('events.json:\n  ' + errs.join('\n  '));
  const { config: cfg, warnings } = loadConfig(FLOW, { theme: opts.theme, voice: opts.voice });
  for (const w of warnings) console.warn('demoloom.json: ' + w);
  const rawDur = +sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(FLOW, 'raw.mp4')]).trim();

  // ---------- frames: raw.mp4 decoded once to 30 fps JPEGs (frame i = time i/30) ----------
  const FR = join(OUT, 'frames');
  {
    const st = statSync(join(FLOW, 'raw.mp4')), stamp = `${st.size}:${st.mtimeMs}`, sf = join(FR, '.stamp');
    if (!existsSync(sf) || readFileSync(sf, 'utf8') !== stamp) {
      rmSync(FR, { recursive: true, force: true }); mkdirSync(FR, { recursive: true });
      process.stdout.write('decoding raw.mp4 to frames... ');
      sh('ffmpeg', ['-v', 'error', '-i', join(FLOW, 'raw.mp4'), '-vf', 'fps=30', '-q:v', '2', join(FR, '%05d.jpg')]);
      writeFileSync(sf, stamp);
      console.log('done');
    }
  }
  const nFrames = readdirSync(FR).filter((f) => f.endsWith('.jpg')).length;

  // ---------- voice ----------
  const lines = cfg.narrative.vo;
  const VOD = join(OUT, 'vo');
  const V = await voiceLines({ lines, cfg: cfg.voice, voDir: VOD, flowDir: FLOW, force: opts.revoice || [] });
  if (lines.length) console.log(`voice: ${V.provider}${V.audio ? '' : ' (silent captions)'}, word timing: ${V.aligner}`);

  // ---------- plan -> timeline.js ----------
  flow.events = [...flow.events, ...(cfg.extraEvents || [])].map((e) => {
    const o = cfg.events[e.label];
    return o && o.box ? { ...e, box: o.box } : e; // a tighter box for the camera and ring; the cursor keeps its point
  }).sort((a, b) => a.t - b.t);
  const fps = opts.fps || cfg.output.fps || 30;
  const P = plan({ flow, lines, speed: cfg.speed, titleSecs: cfg.narrative.titleSecs, vo: V.durations, words: V.words, rawDur, fps });
  P.nFrames = nFrames;
  // fonts and logo are served by the render server under /fonts/<i> and /logo
  const fontFiles = [];
  const faceFor = (family) => {
    const file = (cfg.theme.fonts.files || {})[family] || BUNDLED_FONTS[family];
    if (!file) return null;
    let i = fontFiles.indexOf(file); if (i < 0) { fontFiles.push(file); i = fontFiles.length - 1; }
    return { family, url: `/fonts/${i}${extname(file)}` };
  };
  const faces = [...new Set([cfg.theme.fonts.display, cfg.theme.fonts.ui])].map(faceFor).filter(Boolean);
  const urlText = cfg.window.url ?? (() => { try { const u = new URL(flow.url); return /^https?:$/.test(u.protocol) ? u.host : ''; } catch { return ''; } })();
  const TL = {
    ...P,
    theme: { ...cfg.theme, logo: undefined, logoUrl: cfg.theme.logo ? `/logo${extname(cfg.theme.logo)}` : null, fontFaces: faces },
    narrative: { title: cfg.narrative.title, subtitle: cfg.narrative.subtitle, beatTitles: cfg.narrative.beatTitles, captions: cfg.narrative.captions, steps: cfg.narrative.steps },
    view: { chrome: cfg.window.chrome !== false, urlBar: cfg.window.urlBar !== false && !!urlText, url: urlText },
    camera: cfg.camera, eventOpts: cfg.events,
  };
  writeFileSync(join(OUT, 'timeline.js'), `// generated by demoloom render: do not edit\n(function(){const TL=${JSON.stringify(TL)};if(typeof module!=='undefined')module.exports=TL;else window.TL=TL;})();\n`);
  if (P.captionProblems.length && cfg.narrative.captions !== false) console.warn('captions:\n  ' + P.captionProblems.join('\n  '));
  if (P.captionMismatches.length && V.aligner === 'whisper') console.warn('heard differently (script spelling shown; re-voice if the audio is wrong):\n  ' + P.captionMismatches.join('\n  '));
  const music = cfg.music.track ? `track ${basename(cfg.music.track)}` : `palette ${cfg.music.palette}${PALETTES[cfg.music.palette] ? ` (${PALETTES[cfg.music.palette]})` : ''}`;
  console.log(`plan: ${P.duration.toFixed(2)}s total (title ${P.T0.toFixed(2)}s, demo ${(P.endStart - P.T0).toFixed(2)}s from ${rawDur.toFixed(2)}s of recording, end card ${(P.duration - P.endStart).toFixed(2)}s), ${P.gaps.length} sped-up stretches, ${P.holds.length} holds for the voice, ${music}`);
  if (opts.plan) {
    for (const g of P.gaps) console.log(`  speed ${g.k.toFixed(2)}x  source ${g.a.toFixed(2)}-${g.b.toFixed(2)}s`);
    for (const h of P.holds) console.log(`  hold ${h.h.toFixed(2)}s at source ${h.s.toFixed(2)}s`);
    for (const id of P.ORDER) console.log(`  vo ${id.padEnd(10)} ${P.cue[id].toFixed(2)} - ${P.end[id].toFixed(2)}`);
    for (const e of P.events) console.log(`  ${e.type.padEnd(8)} ${e.u.toFixed(2)}s  ${e.label || ''}`);
  }

  // ---------- the page server ----------
  const server = createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let f = null;
    if (p.startsWith('/out/')) f = join(OUT, p.slice(5));
    else if (p.startsWith('/page/') || p.startsWith('/src/')) f = join(ROOT, p);
    else if (p.startsWith('/fonts/')) f = fontFiles[parseInt(p.slice(7), 10)];
    else if (p.startsWith('/logo')) f = cfg.theme.logo;
    const okRoot = f && (f.startsWith(OUT) || f.startsWith(ROOT) || fontFiles.includes(f) || f === cfg.theme.logo);
    if (!okRoot || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'max-age=3600' });
    createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;
  const browser = await chromium.launch();
  const close = async () => { await browser.close(); server.close(); };
  let failed = false;
  try {
    const shapes = opts.shape === 'both' ? ['landscape', 'vertical'] : [opts.shape === 'vertical' ? 'vertical' : 'landscape'];
    let scoreWav = null;
    for (const SHAPE of shapes) {
      const SUFFIX = SHAPE === 'vertical' ? '-vertical' : '';
      const W = SHAPE === 'vertical' ? 1080 : 1920, H = SHAPE === 'vertical' ? 1920 : 1080;
      const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      page.on('pageerror', (e) => { console.error('page error:', e.message); failed = true; });
      page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
      await page.goto(`http://127.0.0.1:${PORT}/page/index.html?shape=${SHAPE}`);
      await page.waitForFunction(() => window.ready);
      await page.evaluate(() => window.ready);
      const cdp = await page.context().newCDPSession(page);
      const frameAt = async (t, keep = false) => {
        await page.evaluate((tt) => window.seek(tt), t);
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: !keep, clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
        return Buffer.from(data, 'base64');
      };

      if (opts.plan) {
        const cam = await page.evaluate(() => ({ moves: STUDIO.MO.MOVES, shots: STUDIO.MO.GROUPS.map((g) => ({ z: g.z, a: g.a, labels: g.evs.map((e) => e.label) })) }));
        console.log(`camera (${SHAPE}): ${cam.moves.length} moves over ${cam.shots.length} shots`);
        for (const m of cam.moves) console.log(`  ${(m.kind || 'move').padEnd(7)} ${m.t.toFixed(2)}-${(m.t + (m.d || 0)).toFixed(2)}s  to ${m.z.toFixed(2)}x  ${m.to ? 'on "' + m.to + '"' : '(' + m.why + ')'}`);
        await page.close();
        continue;
      }
      const mode = opts.mode || 'video';
      if (mode === 'stills') {
        const times = opts.times || Array.from({ length: 21 }, (_, i) => +((i + 0.5) * P.duration / 21).toFixed(2));
        const sd = join(OUT, `stills${SUFFIX}`);
        rmSync(sd, { recursive: true, force: true }); mkdirSync(sd, { recursive: true });
        for (const [i, t] of times.entries()) writeFileSync(join(sd, `${String(i).padStart(2, '0')}_${t.toFixed(2)}.png`), await frameAt(t));
        const cols = SHAPE === 'vertical' ? 7 : 3, rows = Math.ceil(times.length / cols);
        sh('ffmpeg', ['-y', '-loglevel', 'error', '-pattern_type', 'glob', '-i', join(sd, '[0-9]*.png'), '-vf', `scale=${SHAPE === 'vertical' ? 360 : 640}:-1,tile=${cols}x${rows}:padding=6:color=white`, '-frames:v', '1', join(sd, 'contact.png')]);
        console.log(`wrote ${times.length} stills + contact sheet to ${sd}`);
        if (!(await captionCheck(page, P))) failed = true;
      } else if (mode === 'verify') {
        const times = Array.from({ length: 24 }, (_, i) => +((i + 0.37) * P.duration / 24).toFixed(3));
        const hash = async (t) => createHash('sha1').update(await frameAt(t)).digest('hex');
        const fwd = [];
        for (const t of times) fwd.push(await hash(t));
        const bad = [];
        for (const [i, t] of [...times.entries()].reverse()) if ((await hash(t)) !== fwd[i]) bad.push(t);
        for (const [i, t] of times.entries()) if ((await hash(t)) !== fwd[i]) bad.push(t);
        if (bad.length) { console.error(`${SHAPE}: non-deterministic at t = ${[...new Set(bad)].join(', ')}`); failed = true; }
        else console.log(`${SHAPE}: deterministic, ${times.length} frames x 3 orders match`);
        if (!(await captionCheck(page, P))) failed = true;
      } else if (mode === 'captions') {
        if (!(await captionCheck(page, P))) failed = true;
      } else if (mode === 'poster') {
        const t = opts.time ?? P.endStart + 1.5;
        const f = join(OUT, `${NAME}${SUFFIX}-poster.png`);
        writeFileSync(f, await frameAt(t, true));
        console.log(`wrote ${f} at t=${t}`);
      } else {
        if (!scoreWav) { scoreWav = renderScore({ T: P, outDir: OUT, voDir: VOD, audio: V.audio, music: cfg.music, seed: NAME }); console.log(`score: ${scoreWav}`); }
        const n = Math.round(P.duration * fps), out = join(OUT, `${NAME}${SUFFIX}.mp4`);
        const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-i', '-', '-i', scoreWav,
          '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
        const closed = new Promise((r) => ff.on('close', r));
        const t0 = Date.now();
        for (let i = 0; i < n; i++) {
          const buf = await frameAt(i / fps);
          if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
          if (i % fps === 0 && process.stdout.isTTY) process.stdout.write(`\r${SHAPE}: ${i}/${n} frames`);
        }
        ff.stdin.end();
        await closed;
        console.log(`${process.stdout.isTTY ? '\n' : ''}wrote ${out} (${n} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
        if (opts.preview) {
          const pv = shapes.length > 1 ? opts.preview.replace(/(\.\w+)?$/, `${SUFFIX}$1`) : opts.preview;
          for (const crf of [24, 27, 30, 33]) {
            sh('ffmpeg', ['-y', '-loglevel', 'error', '-i', out, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', pv]);
            const mb = statSync(pv).size / 1e6;
            if (mb < 30) { console.log(`preview: ${pv} (${mb.toFixed(1)} MB, crf ${crf})`); break; }
          }
        }
      }
      await page.close();
    }
  } finally { await close(); }
  return !failed;
}

// ---------- caption check: no art behind any caption ----------
// Each sampled frame is painted with and without captions; the pixels that
// differ are the caption's own, and their padded bounding box is the caption
// box. Inside it, the captionless frame is compared with the bare backdrop: a
// 4x4 block with 8 or more pixels off it by more than 18 is art. A frame fails
// when art fills more than 0.5% of the caption box, or the caption leaves its band.
async function captionCheck(page, P, step = 0.25) {
  if (!P.captions.length) return true;
  const times = [];
  for (let t = 0.05; t < P.duration - 0.02; t += step) times.push(+t.toFixed(3));
  const res = await page.evaluate(async ({ times, DIFF, PAD }) => {
    const { STATE, BG, L, W } = window.STUDIO;
    if (!STATE.captions) return [];
    const cv = document.getElementById('c'), c = cv.getContext('2d');
    const y0b = Math.max(0, L.cap.band[1] - 40), y1b = Math.min(cv.height, L.cap.band[3] + 40), HH = y1b - y0b;
    const G = BG.getContext('2d').getImageData(0, y0b, W, HH).data;
    const out = [];
    for (const t of times) {
      STATE.captions = true; await window.seek(t);
      const A = c.getImageData(0, y0b, W, HH).data;
      STATE.captions = false; await window.seek(t);
      const B = c.getImageData(0, y0b, W, HH).data;
      let x0 = W, y0 = HH, x1 = -1, y1 = -1;
      for (let y = 0; y < HH; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 30) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      if (x1 < 0) continue;
      const inBand = y0 + y0b >= L.cap.band[1] - 2 && y1 + y0b <= L.cap.band[3] + 2;
      x0 = Math.max(0, x0 - PAD); y0 = Math.max(0, y0 - PAD); x1 = Math.min(W - 1, x1 + PAD); y1 = Math.min(HH - 1, y1 + PAD);
      let art = 0, n = 0;
      for (let by = y0; by + 3 <= y1; by += 4) for (let bx = x0; bx + 3 <= x1; bx += 4) {
        let k = 0;
        for (let y = by; y < by + 4; y++) for (let x = bx; x < bx + 4; x++) {
          const i = (y * W + x) * 4;
          if (Math.max(Math.abs(B[i] - G[i]), Math.abs(B[i + 1] - G[i + 1]), Math.abs(B[i + 2] - G[i + 2])) > DIFF) k++;
        }
        n++; if (k >= 8) art++;
      }
      out.push({ t, pct: (100 * art) / Math.max(1, n), inBand, box: [x0, y0 + y0b, x1, y1 + y0b] });
    }
    STATE.captions = true;
    return out;
  }, { times, DIFF: 18, PAD: 14 });
  const bad = res.filter((r) => r.pct > 0.5 || !r.inBand);
  if (!bad.length) { console.log(`captions clear: ${res.length} captioned frames checked, worst ${res.reduce((m, r) => Math.max(m, r.pct), 0).toFixed(2)}% art in a caption box`); return true; }
  console.error(`caption check: ${bad.length} intrusions in ${res.length} captioned frames:`);
  for (const r of bad) console.error(`  t=${r.t.toFixed(2)}s  ${r.pct.toFixed(1)}% art${r.inBand ? '' : ', caption outside its band'}  box ${r.box.join(',')}`);
  return false;
}

// `demoloom record <flow.mjs>`: runs your Playwright flow through a small helper
// API and writes raw.mp4 + events.json next to it (or to --out).
//
// A flow module:
//
//   export default {
//     url: './app.html',                 // a path next to the flow (served on
//                                        // http://localhost:<port>/) or any URL
//     viewport: { width: 1440, height: 900 },   // optional; recorded at DPR 2
//     async setup(page) {},              // optional, runs before recording starts
//     async run(loom) {
//       const { page } = loom;
//       await loom.beat('add');
//       await loom.click(page.getByPlaceholder('New task'), { label: 'new task' });
//       await loom.type(page.getByPlaceholder('New task'), 'Ship it', { label: 'task text' });
//       await loom.appear(page.getByText('Ship it'), { label: 'task added' });
//     },
//   };
//
// Frames come off Chrome's screencast (CDP Page.startScreencast), which fires
// only on repaint, so each frame carries the time it was painted and ffmpeg's
// concat demuxer gets real per-frame durations. Event times are stamped in the
// page on the same wall clock. No real cursor is drawn: demoloom draws its own.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync, createReadStream, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => Math.round(x * 100) / 100;
const boxOf = (b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) });
const centre = (b) => [Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)];

// human-like pacing, in seconds (typeDelay in ms per key)
export const PACE = { beforeClick: 0.3, afterClick: 0.5, typeDelay: 75, afterType: 0.4, afterAppear: 0.9, afterSelect: 0.5, move: 0.35 };

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
function serveDir(dir, port) {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = join(dir, p);
    if (!f.startsWith(dir) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream' });
    createReadStream(f).pipe(res);
  });
  return new Promise((ok, fail) => {
    server.once('error', (e) => fail(e.code === 'EADDRINUSE' ? new Error(`port ${port} is busy: set "port" in the flow to another one`) : e));
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}

export async function record(flowFile, { out } = {}) {
  const file = resolve(flowFile);
  const mod = await import(pathToFileURL(file).href);
  const flow = mod.default || mod;
  if (typeof flow.run !== 'function') throw new Error(`${flowFile} must export default { url, run(loom) }`);
  const OUT = resolve(out || dirname(file));
  mkdirSync(OUT, { recursive: true });
  const viewport = { width: 1440, height: 900, ...(flow.viewport || {}) };
  const dpr = flow.dpr || 2;
  const pace = { ...PACE, ...(flow.pace || {}) };

  let server = null, url = flow.url;
  if (!url) throw new Error('the flow needs a url');
  if (!/^[a-z]+:/i.test(url)) { // a local file: serve its folder on a fixed port, so the address is stable
    const port = flow.port || 4173, base = dirname(file), rel = resolve(base, url).slice(base.length).replace(/\\/g, '/');
    server = await serveDir(base, port);
    url = `http://localhost:${port}${rel}`;
  }

  const browser = await chromium.launch({ args: ['--hide-scrollbars'] });
  const dir = mkdtempSync(join(tmpdir(), 'demoloom-rec-'));
  try {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    if (flow.setup) await flow.setup(page);
    await sleep(500);

    const frames = [];
    const cdp = await ctx.newCDPSession(page);
    cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
      const f = join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`);
      writeFileSync(f, Buffer.from(data, 'base64'));
      frames.push({ t: metadata.timestamp, file: f });
      try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch {}
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1, maxWidth: viewport.width * dpr, maxHeight: viewport.height * dpr });
    await page.evaluate(() => { document.documentElement.style.outline = '0px solid transparent'; }); // a first paint, so frame 0 exists
    await sleep(300);

    const wall = () => page.evaluate(() => (performance.timeOrigin + performance.now()) / 1000);
    const t0 = () => frames[0]?.t ?? 0;
    const events = [], beats = [];
    let open = null, seed = 7;
    const jitter = () => { seed = (seed * 16807) % 2147483647; return 0.7 + 0.6 * (seed / 2147483647); }; // deterministic
    const log = (e) => { events.push(e); return e; };
    const loc = (target) => (typeof target === 'string' ? page.locator(target).first() : target);
    const scrollY = () => page.evaluate(() => window.scrollY);
    // the box of an element, scrolling it into view first (logged as a scroll when the page moves)
    async function boxFor(target, label) {
      const l = loc(target);
      await l.waitFor({ state: 'visible' });
      const before = await scrollY();
      await l.scrollIntoViewIfNeeded();
      if ((await scrollY()) !== before) { await sleep(150); await loom.scrolled(label ? `to ${label}` : ''); }
      const b = await l.boundingBox();
      if (!b) throw new Error(`no box for ${label || target}`);
      return b;
    }

    const loom = {
      page,
      viewport,
      async now() { return (await wall()) - t0(); },
      // opens a story beat (and closes the one before)
      async beat(id, note = '') {
        const t = await loom.now();
        if (open) open.t1 = r2(t);
        open = { id, t0: r2(t), t1: null, note };
        beats.push(open);
      },
      async wait(s) { await sleep(s * 1000); },
      async click(target, { label = '', hover = pace.beforeClick, after = pace.afterClick } = {}) {
        const b = await boxFor(target, label);
        const [x, y] = centre(b);
        await page.mouse.move(x, y, { steps: 8 });
        await sleep(hover * 1000);
        const t = await loom.now();
        await page.mouse.down(); await sleep(70); await page.mouse.up();
        const e = log({ t: r2(t), type: 'click', x, y, box: boxOf(b), text: '', label });
        await sleep(after * 1000);
        return e;
      },
      async hover(target, { label = '', after = 0.4 } = {}) {
        const b = await boxFor(target, label);
        const [x, y] = centre(b);
        await page.mouse.move(x, y, { steps: 10 });
        const e = log({ t: r2(await loom.now()), type: 'hover', x, y, box: boxOf(b), text: '', label });
        await sleep(after * 1000);
        return e;
      },
      // types into a field; clicks it first unless it already has focus
      async type(target, text, { label = '', delay = pace.typeDelay, after = pace.afterType, click = 'auto' } = {}) {
        const l = loc(target);
        const focused = await l.evaluate((el) => el === document.activeElement).catch(() => false);
        if (click === true || (click === 'auto' && !focused)) await loom.click(l, { label: label ? `${label} field` : '' });
        const b = await boxFor(l, label);
        const [x, y] = centre(b);
        const t = await loom.now();
        for (const ch of text) { await page.keyboard.type(ch); await sleep(delay * jitter()); }
        const t1 = await loom.now();
        const e = log({ t: r2(t), t1: r2(t1), type: 'type', x, y, box: boxOf(b), text, label });
        await sleep(after * 1000);
        return e;
      },
      async press(key, { after = 0.3 } = {}) { await page.keyboard.press(key); await sleep(after * 1000); },
      // drag-selects text inside an element: from/to are page points (default: its first line, end to end)
      async select(target, { from, to, label = '', secs = 0.8, after = pace.afterSelect } = {}) {
        const b = await boxFor(target, label);
        const cy = b.y + Math.min(b.height / 2, 13);
        from = from || [b.x + 2, cy]; to = to || [b.x + b.width - 2, cy];
        await page.mouse.move(from[0], from[1], { steps: 6 });
        await sleep(150);
        const ta = await loom.now();
        await page.mouse.down();
        const n = Math.round(secs * 30);
        for (let i = 1; i <= n; i++) {
          const u = i / n, k = u * u * (3 - 2 * u);
          await page.mouse.move(from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k);
          await sleep((secs * 1000) / n);
        }
        await page.mouse.up();
        const text = await page.evaluate(() => String(window.getSelection() || ''));
        const e = log({ t: r2(await loom.now()), t0: r2(ta), type: 'select', x: Math.round(to[0]), y: Math.round(to[1]), from: [Math.round(from[0]), Math.round(from[1])], box: boxOf(b), text, label });
        await sleep(after * 1000);
        return e;
      },
      // waits for something to land on screen and logs it (the camera frames it, a ring marks it)
      async appear(target, { label = '', after = pace.afterAppear, timeout = 30000 } = {}) {
        const l = loc(target);
        await l.waitFor({ state: 'visible', timeout });
        const b = await boxFor(l, label);
        const [x, y] = centre(b);
        const e = log({ t: r2(await loom.now()), type: 'appear', x, y, box: boxOf(b), text: '', label });
        await sleep(after * 1000);
        return e;
      },
      // scrolls the page smoothly by dy pixels
      async scroll(dy, { label = '', secs = 0.8, after = 0.4 } = {}) {
        const n = Math.max(1, Math.round(secs * 30));
        await page.mouse.move(viewport.width / 2, viewport.height / 2);
        for (let i = 0; i < n; i++) { await page.mouse.wheel(0, dy / n); await sleep((secs * 1000) / n); }
        const e = await loom.scrolled(label);
        await sleep(after * 1000);
        return e;
      },
      async scrolled(label = '') {
        return log({ t: r2(await loom.now()), type: 'scroll', x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2), box: { x: 0, y: 0, w: viewport.width, h: viewport.height }, text: '', label });
      },
      async navigate(to, { label = '', after = 0.6 } = {}) {
        await page.goto(new URL(to, page.url()).href);
        const e = log({ t: r2(await loom.now()), type: 'navigate', x: 0, y: 0, box: { x: 0, y: 0, w: viewport.width, h: viewport.height }, text: '', label });
        await sleep(after * 1000);
        return e;
      },
    };

    await flow.run(loom);

    await sleep(600);
    const end = await wall();
    await cdp.send('Page.stopScreencast');
    await sleep(200);
    if (frames.length < 2) throw new Error('no frames captured');
    const secs = end - t0();
    if (open) open.t1 = r2(secs);
    const list = [];
    for (let i = 0; i < frames.length; i++) {
      const next = i + 1 < frames.length ? frames[i + 1].t : end;
      list.push(`file '${frames[i].file}'`, `duration ${Math.max(0.001, next - frames[i].t).toFixed(4)}`);
    }
    list.push(`file '${frames[frames.length - 1].file}'`);
    writeFileSync(join(dir, 'list.txt'), list.join('\n') + '\n');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'),
      '-vf', `fps=30,scale=${viewport.width * dpr}:${viewport.height * dpr},format=yuv420p`, '-t', secs.toFixed(3),
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-an', join(OUT, 'raw.mp4')]);
    const json = { viewport: { ...viewport, dpr }, url, events: events.sort((a, b) => a.t - b.t), beats };
    writeFileSync(join(OUT, 'events.json'), JSON.stringify(json, null, 1) + '\n');
    console.log(`raw.mp4: ${frames.length} painted frames, ${secs.toFixed(2)}s; events.json: ${events.length} events, ${beats.length} beats -> ${OUT}`);
    return json;
  } finally {
    await browser.close();
    if (server) server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

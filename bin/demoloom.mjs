#!/usr/bin/env node
// demoloom: scripted browser flow -> polished product demo video.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config.mjs';

const HELP = `demoloom: turn a scripted Playwright flow into a polished product demo video.

usage:
  demoloom init [dir]                        scaffold an example flow and demoloom.json
  demoloom record <flow.mjs> [--out dir]     run the flow, write raw.mp4 + events.json
  demoloom render <dir> [options]            make the video from <dir>

render options:
  --shape=landscape|vertical|both            16:9 (1920x1080), 9:16 (1080x1920) or both
  --stills[=t1,t2,...]                       stills and a contact sheet instead of a video
  --verify                                   check that frames are deterministic
  --plan                                     print the plan (speed-ups, VO cues, camera)
  --poster[=t]                               one full-resolution PNG
  --out=<dir>                                output folder (default <dir>/out)
  --preview=<file.mp4>                       also write a compressed copy under 30 MB
  --revoice=id,id                            re-voice these lines
  --fps=<n>                                  output frame rate (default 30)
  --voice=none|file|gemini|say               override voice.provider
  --theme=<name|path>                        override the theme (default, example-brand, or a file)

  demoloom --version | --help
`;

const argv = process.argv.slice(2);
const flag = (k) => { const i = argv.findIndex((x) => x === `--${k}` || x.startsWith(`--${k}=`)); if (i < 0) return undefined; const a = argv[i]; return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] === '--out'));
const cmd = positional[0];

async function main() {
  if (flag('version')) { console.log(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version); return 0; }
  if (!cmd || flag('help') || cmd === 'help') { console.log(HELP); return cmd ? 0 : 2; }
  const out = typeof flag('out') === 'string' ? flag('out') : (argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined);
  if (cmd === 'init') {
    const { init } = await import('../src/init.mjs');
    init(positional[1] || '.');
    return 0;
  }
  if (cmd === 'record') {
    if (!positional[1]) { console.error('usage: demoloom record <flow.mjs> [--out dir]'); return 2; }
    const { record } = await import('../src/record.mjs');
    await record(positional[1], { out });
    return 0;
  }
  if (cmd === 'render') {
    if (!positional[1]) { console.error('usage: demoloom render <dir> [--shape=landscape|vertical|both] [--stills|--verify|--plan]'); return 2; }
    const { render } = await import('../src/render.mjs');
    const shape = typeof flag('shape') === 'string' ? flag('shape') : 'landscape';
    if (!['landscape', 'vertical', 'both'].includes(shape)) { console.error('--shape must be landscape, vertical or both'); return 2; }
    const mode = ['verify', 'stills', 'poster', 'captions'].find((m) => flag(m) !== undefined) || 'video';
    const st = flag('stills'), po = flag('poster');
    const ok = await render(positional[1], {
      shape, mode, out, plan: !!flag('plan'),
      times: typeof st === 'string' ? st.split(',').map(Number) : undefined,
      time: typeof po === 'string' ? Number(po) : undefined,
      preview: typeof flag('preview') === 'string' ? flag('preview') : undefined,
      revoice: typeof flag('revoice') === 'string' ? flag('revoice').split(',') : [],
      fps: typeof flag('fps') === 'string' ? Number(flag('fps')) : undefined,
      voice: typeof flag('voice') === 'string' ? flag('voice') : undefined,
      theme: typeof flag('theme') === 'string' ? flag('theme') : undefined,
    });
    return ok ? 0 : 1;
  }
  console.error(`unknown command "${cmd}"\n\n${HELP}`);
  return 2;
}

main().then((code) => process.exit(code), (e) => { console.error(String(e && e.message ? e.message : e)); process.exit(1); });

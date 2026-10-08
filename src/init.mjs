// `demoloom init [dir]`: scaffolds a working example (a tiny local app, its flow
// and a demoloom.json) to edit into your own. Never overwrites a file.
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { ROOT } from './config.mjs';

export function init(dir = '.') {
  const to = resolve(dir);
  mkdirSync(to, { recursive: true });
  const made = [];
  for (const f of ['flow.mjs', 'demoloom.json', 'app.html']) {
    const dst = join(to, f);
    if (existsSync(dst)) { console.log(`kept ${relative(process.cwd(), dst) || f} (already there)`); continue; }
    copyFileSync(join(ROOT, 'examples/todo', f), dst);
    made.push(relative(process.cwd(), dst) || f);
  }
  if (made.length) console.log(`wrote ${made.join(', ')}`);
  const d = relative(process.cwd(), to) || '.';
  console.log(`\nnext:\n  demoloom record ${join(d, 'flow.mjs')}\n  demoloom render ${d} --stills\n  demoloom render ${d} --shape=both`);
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { plan, autoCaption, speedCurve } from '../src/plan.mjs';
import { evenWords, estimateSecs } from '../src/voice/index.mjs';

const flow = JSON.parse(readFileSync(new URL('./fixtures/events.json', import.meta.url), 'utf8'));
const lines = [
  { id: 'title', at: 'title', say: 'Here is a tiny board, start to finish.' },
  { id: 'add', beat: 'add', say: 'Type a task, and add it to the board.' },
  { id: 'outro', at: 'end', say: 'Make your own with demoloom.' },
];
const vo = Object.fromEntries(lines.map((l) => [l.id, estimateSecs(l.say)]));
const words = Object.fromEntries(lines.map((l) => [l.id, evenWords(l.say, vo[l.id])]));

test('the plan is a pure function of its inputs', () => {
  const a = plan({ flow, lines, vo, words, rawDur: 18.7 }), b = plan({ flow, lines, vo, words, rawDur: 18.7 });
  assert.deepEqual(a, b);
  assert.ok(a.duration > a.endStart && a.endStart > a.T0);
});

test('the time map is monotone and ends at the end of the recording', () => {
  const P = plan({ flow, lines, vo, words, rawDur: 18.7 });
  for (let i = 1; i < P.U.length; i++) { assert.ok(P.U[i] >= P.U[i - 1]); assert.ok(P.S[i] >= P.S[i - 1]); }
  assert.ok(Math.abs(P.S[P.S.length - 1] - 18.7) < 1e-6);
  assert.ok(P.U[P.U.length - 1] < 18.7, 'idle time is sped up');
});

test('events play at real time and idle time speeds up', () => {
  const c = speedCurve(flow.events, 18.7, {});
  for (const e of flow.events) assert.equal(c.v(e.t), 1);
  assert.ok(c.gaps.length > 0);
  for (const g of c.gaps) assert.ok(g.k >= 2 && g.k <= 4);
  const pinned = speedCurve(flow.events, 18.7, { ranges: [{ from: 0, to: 18.7, x: 1 }] });
  assert.equal(pinned.v(7), 1);
});

test('a long line holds the picture for the narrator', () => {
  const long = [{ id: 'add', beat: 'add', say: 'x' }];
  const P = plan({ flow, lines: long, vo: { add: 12 }, words: { add: [['x', 0, 12]] }, rawDur: 18.7 });
  assert.equal(P.holds.length, 1);
});

test('captions group 2 to 4 words and follow the words', () => {
  assert.equal(autoCaption('Type a task, and add it to the board.'), 'Type a task, | and add it | to the board.');
  const P = plan({ flow, lines, vo, words, rawDur: 18.7 });
  assert.deepEqual(P.captionProblems, []);
  for (const g of P.captions) for (let i = 1; i < g.tokens.length; i++) assert.ok(g.tokens[i].a >= g.tokens[i - 1].a);
});

test('even word timing covers the line in order', () => {
  const w = evenWords('One click moves it into progress.', 2.5);
  assert.equal(w.length, 6);
  assert.ok(w[0][1] >= 0 && w[5][2] <= 2.5);
  for (let i = 1; i < w.length; i++) assert.ok(w[i][1] >= w[i - 1][2] - 1e-9);
});

// The camera and cursor maths are pure functions of the timeline: same input,
// same output, in any order. These tests pin that down without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { plan } from '../src/plan.mjs';

const Motion = createRequire(import.meta.url)('../src/motion.cjs');
const flow = JSON.parse(readFileSync(new URL('./fixtures/events.json', import.meta.url), 'utf8'));
const lines = [
  { id: 'title', at: 'title', say: 'Here is a tiny board.' },
  { id: 'add', beat: 'add', say: 'Type a task, and add it.' },
  { id: 'outro', at: 'end', say: 'Make your own.' },
];
const vo = { title: 1.6, add: 2.2, outro: 1.2 };
const timeline = () => ({ ...plan({ flow, lines, vo, rawDur: 18.7 }), nFrames: 560, camera: {}, eventOpts: {} });

for (const shape of ['landscape', 'vertical']) {
  test(`camera and cursor are deterministic (${shape})`, () => {
    const a = Motion.create(timeline(), shape), b = Motion.create(timeline(), shape);
    assert.deepEqual(a.MOVES, b.MOVES);
    const TL = timeline();
    const times = Array.from({ length: 200 }, (_, i) => (i * TL.duration) / 199);
    const fwd = times.map((t) => [a.camAt(t), a.cursorAt(t)]);
    const rev = [...times].reverse().map((t) => [b.camAt(t), b.cursorAt(t)]).reverse();
    assert.deepEqual(fwd, rev);
    assert.deepEqual(times.map((t) => a.camAt(t)), times.map((t) => a.camAt(t)));
  });

  test(`camera stays inside the page and inside the zoom range (${shape})`, () => {
    const TL = timeline(), M = Motion.create(TL, shape);
    const VW = TL.viewport.width, VH = TL.viewport.height;
    for (let t = 0; t < TL.duration; t += 0.05) {
      const c = M.camAt(t), [vw, vh] = M.viewOf(c.z);
      assert.ok(c.z >= 1 - 1e-9 && c.z <= Math.max(M.ZR[1], M.CAM.small) + 1e-9, `zoom ${c.z} at ${t}`);
      if (vw < VW) assert.ok(c.x - vw / 2 >= -1e-6 && c.x + vw / 2 <= VW + 1e-6, `x out of page at ${t}`);
      if (vh < VH) assert.ok(c.y - vh / 2 >= -1e-6 && c.y + vh / 2 <= VH + 1e-6, `y out of page at ${t}`);
    }
  });
}

test('the cursor is on the click point when it clicks', () => {
  const TL = timeline(), M = Motion.create(TL, 'landscape');
  for (const e of TL.events.filter((q) => q.type === 'click')) {
    const c = M.cursorAt(e.u);
    assert.ok(c, `cursor visible at click ${e.label}`);
    assert.deepEqual(c.p, [e.x, e.y]);
    assert.ok(c.press > 0.9, 'pressed at the click');
  }
});

test('camera moves never overshoot: the zoom between two moves stays between their targets', () => {
  const TL = timeline(), M = Motion.create(TL, 'landscape');
  let prev = 1;
  for (const m of M.MOVES) {
    const lo = Math.min(prev, m.z), hi = Math.max(prev, m.z);
    for (let k = 0; k <= 20; k++) {
      const z = M.camAt(m.t + (m.d * k) / 20).z;
      assert.ok(z >= lo - 1e-6 && z <= hi + 1e-6, `zoom ${z} outside [${lo}, ${hi}]`);
    }
    prev = m.z;
  }
});

test('the critically damped spring never overshoots and settles', () => {
  const p = { w: 11, z: 1 };
  let last = 0;
  for (let t = 0; t <= 3; t += 0.01) {
    const v = Motion.spring(t, 0, p);
    assert.ok(v >= last - 1e-12 && v <= 1, `spring ${v} at ${t}`);
    last = v;
  }
  assert.ok(Motion.spring(3, 0, p) > 0.999);
  assert.equal(Motion.spring(-1, 0, p), 0);
});

test('minimum-jerk easing starts and ends at rest', () => {
  assert.equal(Motion.mjerk(0), 0);
  assert.equal(Motion.mjerk(1), 1);
  assert.ok(Math.abs(Motion.mjerk(0.5) - 0.5) < 1e-12);
  const d = (x) => (Motion.mjerk(x + 1e-5) - Motion.mjerk(x)) / 1e-5;
  assert.ok(d(0) < 1e-3 && d(1 - 1e-5) < 1e-3);
});

test('camera zoom range is configurable', () => {
  const TL = { ...timeline(), camera: { zoom: [1.1, 1.2], small: 1.2 } };
  const M = Motion.create(TL, 'landscape');
  for (const m of M.MOVES) assert.ok(m.z <= 1.2 + 1e-9, `zoom ${m.z}`);
  const off = Motion.create({ ...timeline(), camera: { enabled: false } }, 'landscape');
  assert.equal(off.MOVES.length, 0);
});

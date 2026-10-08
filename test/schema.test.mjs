import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateEvents } from '../src/schema.mjs';
import { normalizeConfig } from '../src/config.mjs';

const flow = JSON.parse(readFileSync(new URL('./fixtures/events.json', import.meta.url), 'utf8'));

test('a recorded events.json is valid', () => {
  assert.deepEqual(validateEvents(flow), []);
});

test('invalid events are reported', () => {
  const bad = structuredClone(flow);
  bad.viewport.width = -1;
  bad.events[0].type = 'tap';
  delete bad.events[1].box;
  bad.beats.push({ id: bad.beats[0].id, t0: 0 });
  const errs = validateEvents(bad);
  assert.ok(errs.some((e) => e.includes('viewport')));
  assert.ok(errs.some((e) => e.includes('events[0].type')));
  assert.ok(errs.some((e) => e.includes('events[1]') && e.includes('box')));
  assert.ok(errs.some((e) => e.includes('used twice')));
  assert.deepEqual(validateEvents(null), ['events.json must be an object']);
});

test('config: defaults, themes and extends', () => {
  const { config } = normalizeConfig({}, '.');
  assert.equal(config.voice.provider, 'none');
  assert.equal(config.theme.backdrop.style, 'gradient');
  const brand = normalizeConfig({ theme: 'example-brand' }, '.').config.theme;
  assert.equal(brand.accent, '#EA580C');
  assert.ok(brand.logo.endsWith('logo.svg'));
  assert.ok(brand.window.bar, 'a partial theme inherits the default theme');
  const ext = normalizeConfig({ theme: { extends: 'example-brand', accent: '#123456' } }, '.').config.theme;
  assert.equal(ext.accent, '#123456');
  assert.equal(ext.titleLayout, 'left');
});

test('config: problems are reported', () => {
  assert.throws(() => normalizeConfig({ voice: { provider: 'robot' } }, '.'), /voice.provider/);
  assert.throws(() => normalizeConfig({ camera: { zoom: [2, 1] } }, '.'), /camera.zoom/);
  assert.throws(() => normalizeConfig({ narrative: { vo: [{ id: 'a', say: 'hi' }] } }, '.'), /exactly one/);
  assert.throws(() => normalizeConfig({ theme: 'no-such-theme' }, '.'), /not a built-in theme/);
  const { warnings } = normalizeConfig({ colour: 'red' }, '.');
  assert.ok(warnings[0].includes('unknown key'));
});

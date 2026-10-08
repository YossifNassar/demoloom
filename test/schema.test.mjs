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

test('an appear with no position is a timing marker', () => {
  const j = structuredClone(flow);
  j.events.push({ t: 1, type: 'appear', label: 'request sent' });
  assert.deepEqual(validateEvents(j), []);
  j.events.push({ t: 2, type: 'appear', x: 10, label: 'half a position' });
  assert.ok(validateEvents(j).some((e) => e.includes('needs x and y')));
  const click = structuredClone(flow);
  click.events.push({ t: 1, type: 'click', label: 'no position' });
  assert.ok(validateEvents(click).some((e) => e.includes('(click) needs x and y')), 'only appear can be a marker');
});

test('config: a theme can set the voice, and the flow overrides it', () => {
  const theme = { voice: { provider: 'say', voice: 'Samantha', rate: 160 } };
  assert.deepEqual(normalizeConfig({ theme }, '.').config.voice, { provider: 'say', voice: 'Samantha', rate: 160 });
  const own = normalizeConfig({ theme, voice: { rate: 190 } }, '.').config.voice;
  assert.equal(own.provider, 'say');
  assert.equal(own.rate, 190);
  assert.equal(normalizeConfig({ theme, voice: { provider: 'none' } }, '.').config.voice.provider, 'none');
  assert.equal(normalizeConfig({}, '.').config.voice.provider, 'none', 'no theme voice keeps the default');
  assert.throws(() => normalizeConfig({ theme: { voice: 'Sulafat' } }, '.'), /theme.voice/);
});

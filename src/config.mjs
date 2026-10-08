// demoloom.json: everything about how a recording becomes a video. Every key is
// optional. See the README's config reference for the full list.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const THEMES_DIR = join(ROOT, 'themes');
const DEFAULT_THEME = join(THEMES_DIR, 'default', 'theme.json');

// fonts that ship with demoloom (SIL OFL, see assets/fonts/*-OFL.txt)
export const BUNDLED_FONTS = {
  'Bricolage Grotesque': join(ROOT, 'assets/fonts/BricolageGrotesque.ttf'),
  'DM Sans': join(ROOT, 'assets/fonts/DMSans.ttf'),
};

const TOP = ['$schema', 'theme', 'narrative', 'window', 'camera', 'speed', 'music', 'voice', 'events', 'extraEvents', 'output'];
const BACKDROPS = ['gradient', 'glow', 'dots', 'solid'];
const PROVIDERS = ['none', 'file', 'gemini', 'say'];

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function merge(a, b) {
  if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
}
const abs = (p, base) => (p == null ? p : isAbsolute(p) ? p : resolve(base, p));

// a theme is a built-in name, a path to a JSON file, or an object (which may
// "extends" another); paths inside it (logo, font files) resolve next to it
export function resolveTheme(spec, baseDir, seen = new Set()) {
  if (spec == null) spec = 'default';
  let obj, dir, file = null;
  if (typeof spec === 'string') {
    const builtin = join(THEMES_DIR, spec, 'theme.json');
    file = existsSync(builtin) ? builtin : abs(spec, baseDir);
    if (!existsSync(file)) throw new Error(`theme "${spec}" is not a built-in theme (${listThemes().join(', ')}) or a file`);
    if (seen.has(file)) throw new Error(`theme "${spec}" extends itself`);
    seen.add(file);
    obj = JSON.parse(readFileSync(file, 'utf8')); dir = dirname(file);
  } else if (isObj(spec)) { obj = spec; dir = baseDir; }
  else throw new Error('theme must be a name, a path or an object');
  const { extends: parent, description: _d, ...own } = obj;
  if (own.logo) own.logo = abs(own.logo, dir);
  if (own.fonts && own.fonts.files) own.fonts = { ...own.fonts, files: Object.fromEntries(Object.entries(own.fonts.files).map(([k, v]) => [k, abs(v, dir)])) };
  // every theme sits on top of the default theme, so a partial theme is complete
  if (file === DEFAULT_THEME) return own;
  return merge(resolveTheme(parent || 'default', dir, seen), own);
}
export function listThemes() {
  return readdirSync(THEMES_DIR).filter((n) => existsSync(join(THEMES_DIR, n, 'theme.json'))).sort();
}

export const DEFAULTS = {
  narrative: { title: '', subtitle: '', beatTitles: {}, captions: true, steps: true, titleSecs: 2.6, vo: [] },
  window: { chrome: true, urlBar: true, url: null },
  camera: {},
  speed: {},
  music: { palette: 'glass', track: null, volume: 1, sfx: true, energy: null, turn: null },
  voice: { provider: 'none' },
  events: {},
  extraEvents: [],
  output: { fps: 30 },
};

// returns { config, warnings }; throws on anything that would break a render
export function normalizeConfig(raw, baseDir) {
  const warnings = [];
  const errs = [];
  if (!isObj(raw)) throw new Error('demoloom.json must be a JSON object');
  for (const k of Object.keys(raw)) if (!TOP.includes(k)) warnings.push(`unknown key "${k}" (known: ${TOP.slice(1).join(', ')})`);
  const c = {};
  for (const k of Object.keys(DEFAULTS)) c[k] = merge(DEFAULTS[k], raw[k]);
  c.theme = resolveTheme(raw.theme, baseDir);
  // a theme may carry a house narrator; the flow's own "voice" settings win
  if (isObj(c.theme.voice)) c.voice = merge(merge(DEFAULTS.voice, c.theme.voice), raw.voice);

  // theme
  const th = c.theme;
  if (!BACKDROPS.includes(th.backdrop?.style)) errs.push(`theme.backdrop.style must be one of ${BACKDROPS.join(', ')}`);
  if (th.logo && !existsSync(th.logo)) errs.push(`theme.logo ${th.logo} does not exist`);
  if (th.voice !== undefined && th.voice !== null && !isObj(th.voice)) errs.push('theme.voice must be an object of voice settings');
  if (!['stack', 'left'].includes(th.titleLayout)) errs.push('theme.titleLayout must be "stack" or "left"');
  for (const [fam, file] of Object.entries(th.fonts?.files || {})) if (!existsSync(file)) errs.push(`font file for "${fam}" (${file}) does not exist`);

  // narrative
  const n = c.narrative;
  if (!Array.isArray(n.vo)) errs.push('narrative.vo must be an array');
  else {
    const ids = new Set();
    n.vo.forEach((l, i) => {
      if (!l.id || typeof l.id !== 'string') errs.push(`narrative.vo[${i}] needs an id`);
      else if (ids.has(l.id)) errs.push(`narrative.vo id "${l.id}" is used twice`); else ids.add(l.id);
      if (!l.say || typeof l.say !== 'string') errs.push(`narrative.vo[${i}] needs "say" (the spoken text)`);
      const places = [l.at === 'title', l.at === 'end', !!l.beat].filter(Boolean).length;
      if (places !== 1) errs.push(`narrative.vo "${l.id}" needs exactly one of "at": "title", "at": "end" or "beat"`);
    });
  }
  // camera
  const z = c.camera.zoom;
  const okRange = (r) => Array.isArray(r) && r.length === 2 && r.every((v) => typeof v === 'number' && v >= 1) && r[0] <= r[1];
  if (z !== undefined && !(okRange(z) || (isObj(z) && Object.values(z).every(okRange)))) errs.push('camera.zoom must be [min, max] (each >= 1) or {"landscape": [..], "vertical": [..]}');
  // speed
  if (c.speed.ranges && !(Array.isArray(c.speed.ranges) && c.speed.ranges.every((r) => typeof r.from === 'number' && typeof r.to === 'number' && typeof r.x === 'number' && r.x > 0))) errs.push('speed.ranges must be [{"from": s, "to": s, "x": factor}]');
  // voice
  if (!PROVIDERS.includes(c.voice.provider)) errs.push(`voice.provider must be one of ${PROVIDERS.join(', ')}`);
  // music
  if (c.music.track) { c.music.track = abs(c.music.track, baseDir); if (!existsSync(c.music.track)) errs.push(`music.track ${c.music.track} does not exist`); }
  if (errs.length) throw new Error('demoloom.json:\n  ' + errs.join('\n  '));
  return { config: c, warnings };
}

// overrides: { theme, voice } from the command line (--theme, --voice)
export function loadConfig(dir, overrides = {}) {
  const f = join(dir, 'demoloom.json');
  const raw = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  if (overrides.theme) raw.theme = isObj(raw.theme) ? { ...raw.theme, extends: overrides.theme } : overrides.theme;
  if (overrides.voice) raw.voice = { ...(raw.voice || {}), provider: overrides.voice };
  return normalizeConfig(raw, dir);
}

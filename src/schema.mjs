// events.json: the recording's action log. `demoloom record` writes it; anything
// else that writes the same shape works too.
//
// {
//   "viewport": {"width": 1440, "height": 900, "dpr": 2},
//   "url": "http://localhost:4173/app.html",            optional: the page's address
//   "events": [{"t": 1.2, "type": "click", "x": 812, "y": 440,
//               "box": {"x": 760, "y": 420, "w": 104, "h": 40}, "text": "", "label": ""}],
//   "beats": [{"id": "add", "t0": 0.0, "t1": 6.5, "note": ""}]
// }
//
// Times are seconds from the first frame of raw.mp4; positions are CSS px.
// Optional event extras: t0 on a select (drag start), from: [x, y] on a select
// (drag start point), t1 on a type (last key).

export const EVENT_TYPES = ['click', 'type', 'select', 'scroll', 'hover', 'navigate', 'appear'];

const num = (v) => typeof v === 'number' && Number.isFinite(v);

// returns a list of problems; empty means valid
export function validateEvents(j) {
  const errs = [];
  if (!j || typeof j !== 'object') return ['events.json must be an object'];
  const v = j.viewport;
  if (!v || !num(v.width) || !num(v.height) || v.width <= 0 || v.height <= 0) errs.push('viewport needs a positive width and height');
  if (v && v.dpr !== undefined && (!num(v.dpr) || v.dpr <= 0)) errs.push('viewport.dpr must be a positive number');
  if (j.url !== undefined && typeof j.url !== 'string') errs.push('url must be a string');
  if (!Array.isArray(j.events)) errs.push('events must be an array');
  else j.events.forEach((e, i) => {
    const at = `events[${i}]`;
    if (!e || typeof e !== 'object') { errs.push(`${at} must be an object`); return; }
    if (!num(e.t) || e.t < 0) errs.push(`${at}.t must be a number of seconds >= 0`);
    if (!EVENT_TYPES.includes(e.type)) errs.push(`${at}.type must be one of ${EVENT_TYPES.join(', ')}`);
    if (e.x !== undefined && !num(e.x)) errs.push(`${at}.x must be a number`);
    if (e.y !== undefined && !num(e.y)) errs.push(`${at}.y must be a number`);
    if (['click', 'type', 'select', 'hover', 'appear'].includes(e.type)) {
      if (!num(e.x) || !num(e.y)) errs.push(`${at} (${e.type}) needs x and y`);
      const b = e.box;
      if (!b || !num(b.x) || !num(b.y) || !num(b.w) || !num(b.h) || b.w < 0 || b.h < 0) errs.push(`${at} (${e.type}) needs a box {x, y, w, h}`);
    }
    if (e.label !== undefined && typeof e.label !== 'string') errs.push(`${at}.label must be a string`);
    if (e.text !== undefined && typeof e.text !== 'string') errs.push(`${at}.text must be a string`);
    if (e.t0 !== undefined && (!num(e.t0) || e.t0 > e.t)) errs.push(`${at}.t0 must be a number <= t`);
    if (e.t1 !== undefined && (!num(e.t1) || e.t1 < e.t)) errs.push(`${at}.t1 must be a number >= t`);
    if (e.from !== undefined && !(Array.isArray(e.from) && e.from.length === 2 && e.from.every(num))) errs.push(`${at}.from must be [x, y]`);
  });
  if (j.beats !== undefined) {
    if (!Array.isArray(j.beats)) errs.push('beats must be an array');
    else {
      const ids = new Set();
      j.beats.forEach((b, i) => {
        const at = `beats[${i}]`;
        if (!b || typeof b.id !== 'string' || !b.id) errs.push(`${at}.id must be a non-empty string`);
        else if (ids.has(b.id)) errs.push(`${at}.id "${b.id}" is used twice`); else ids.add(b.id);
        if (!num(b?.t0)) errs.push(`${at}.t0 must be a number`);
        if (b && b.t1 !== null && b.t1 !== undefined && (!num(b.t1) || b.t1 < b.t0)) errs.push(`${at}.t1 must be a number >= t0`);
        if (i > 0 && num(b?.t0) && num(j.beats[i - 1]?.t0) && b.t0 < j.beats[i - 1].t0) errs.push(`${at} starts before the beat above it`);
      });
    }
  }
  return errs;
}

// The planner. Turns events.json, demoloom.json and the voiced lines into one
// timeline that the compositor page and the score both read. Everything here is
// plain arithmetic on the inputs, so the same inputs always give the same plan.
//
// Clocks:
//   source time s   seconds into raw.mp4 (the clock of events.json)
//   demo time  u    seconds of demo in the output, after idle time is sped up
//                   and holds are added for the narration
//   output time t   seconds into the finished video: the title card runs
//                   [0, T0), the demo [T0, endStart), the end card after.
//   t = T0 + u, and the map [U[i], S[i]] turns u into s (piecewise linear).

// how much source time around an event plays at 1x: before (the cursor travels,
// the camera leans in) and after (the click lands, the result is read)
const PRE = { click: 0.9, select: 0.8, type: 0.5, appear: 0.4, hover: 0.7, scroll: 0.4, navigate: 0.3 };
const POST = { click: 0.6, select: 0.6, type: 0.5, appear: 1.2, hover: 0.4, scroll: 0.6, navigate: 0.6 };
const GAP = 0.75; // silence between VO lines
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

export const SPEED_DEFAULTS = { min: 2, max: 4, minGap: 0.9, per: 1.2, pad: 1 };
export const evStart = (e) => e.t0 ?? (e.type === 'select' ? e.t - 0.8 : e.t);
export const evEnd = (e) => e.t1 ?? (e.type === 'type' ? e.t + 0.07 * (e.text || '').length : e.t);

// ---- the speed curve: 1x around events, 2 to 4x across idle time ----
export function speedCurve(events, D, speed = {}) {
  const sp = { ...SPEED_DEFAULTS, ...speed };
  // pad scales the real-time margins around events (below 1 makes the demo brisker)
  const iv = events.map((e) => [Math.max(0, evStart(e) - sp.pad * (PRE[e.type] ?? 0.6)), Math.min(D, evEnd(e) + sp.pad * (POST[e.type] ?? 0.6))]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of iv) { const m = merged[merged.length - 1]; if (m && a <= m[1]) m[1] = Math.max(m[1], b); else merged.push([a, b]); }
  const gaps = [];
  let x = 0;
  for (const [a, b] of merged) { if (a > x) gaps.push([x, a]); x = Math.max(x, b); }
  if (x < D) gaps.push([x, D]);
  const fast = gaps.map(([a, b]) => {
    const L = b - a;
    return { a, b, k: L < sp.minGap ? 1 : clamp(L / sp.per, sp.min, sp.max), r: Math.min(0.3, L / 4) };
  }).filter((g) => g.k > 1);
  const ranges = sp.ranges || []; // [{from, to, x}] in source seconds; x = 1 keeps real time
  return {
    gaps: fast,
    v(s) {
      for (const R of ranges) if (s >= R.from && s < R.to) return R.x;
      for (const g of fast) if (s >= g.a && s < g.b) {
        // ramp in and out so a speed change never jolts (no ramp at the clip ends)
        const up = g.a <= 0 ? 1 : smooth((s - g.a) / g.r), down = g.b >= D ? 1 : smooth((g.b - s) / g.r);
        return 1 + (g.k - 1) * Math.min(up, down);
      }
      return 1;
    },
  };
}

// integrate du = ds / v(s), with holds (the picture waits for the narrator)
export function buildMap(D, curve, holds) {
  const ds = 0.001, N = Math.round(D / ds), U = [0], S = [0];
  const hs = [...holds].sort((a, b) => a.s - b.s);
  let u = 0, sPrev = 0, hi = 0, last = 0;
  for (let i = 1; i <= N; i++) {
    const s = i * ds;
    while (hi < hs.length && hs[hi].s <= s) { // a hold: a flat run where the picture waits
      const sh = Math.max(sPrev, hs[hi].s), uh = u + (sh - sPrev) / curve.v(sPrev);
      U.push(r4(uh)); S.push(r4(sh)); U.push(r4(uh + hs[hi].h)); S.push(r4(sh));
      u = uh + hs[hi].h; sPrev = sh; hi++;
    }
    u += (s - sPrev) / curve.v((s + sPrev) / 2); sPrev = s;
    if (s - last >= 0.01 - 1e-9 || i === N) { U.push(r4(u)); S.push(r4(s)); last = s; }
  }
  for (let i = 1; i < U.length; i++) if (U[i] < U[i - 1]) U[i] = U[i - 1]; // r4 rounding can make neighbours equal
  // forward map s -> u (the first u for a source time, before any hold there)
  const out = (s) => {
    if (s <= 0) return 0;
    let lo = 0, hi2 = S.length - 1;
    if (s >= S[hi2]) return U[hi2];
    while (hi2 - lo > 1) { const m = (lo + hi2) >> 1; if (S[m] < s) lo = m; else hi2 = m; }
    const f = (s - S[lo]) / Math.max(1e-9, S[hi2] - S[lo]);
    return U[lo] + (U[hi2] - U[lo]) * f;
  };
  return { U, S, out, demoDur: U[U.length - 1] };
}

// ---- word captions ----
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const spell = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ONES[n % 10] : ''));
export function norm(w) {
  const s = w.toLowerCase().replace(/%/g, 'percent').replace(/[^a-z0-9]/g, '');
  return /^\d{1,2}$/.test(s) ? spell(+s) : s;
}
// edit-distance alignment of the script's words to the heard words
function align(S, Wd) {
  const n = S.length, m = Wd.length, Dm = [];
  for (let i = 0; i <= n; i++) { Dm.push(new Array(m + 1).fill(0)); Dm[i][0] = i; }
  for (let j = 0; j <= m; j++) Dm[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) Dm[i][j] = Math.min(Dm[i - 1][j] + 1, Dm[i][j - 1] + 1, Dm[i - 1][j - 1] + (S[i - 1] === Wd[j - 1] ? 0 : 1));
  const map = new Array(n).fill(null);
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (Dm[i][j] === Dm[i - 1][j - 1] + (S[i - 1] === Wd[j - 1] ? 0 : 1)) { map[i - 1] = j - 1; i--; j--; }
    else if (Dm[i][j] === Dm[i - 1][j] + 1) i--;
    else j--;
  }
  return map;
}
// default display groups: break after punctuation, 2 to 4 words, at most 26 characters
export function autoCaption(say) {
  const words = say.split(/\s+/).filter(Boolean), groups = [];
  let g = [];
  const len = (a) => a.join(' ').length;
  words.forEach((w, i) => {
    const left = words.length - i - 1;
    if (g.length && (g.length >= 3 && left !== 0 || len([...g, w]) > 26)) { groups.push(g); g = []; }
    g.push(w);
    if (/[.,!?;:]$/.test(w) && g.length >= 2 && left >= 2) { groups.push(g); g = []; }
  });
  if (g.length) { if (g.length === 1 && groups.length && len([...groups[groups.length - 1], ...g]) <= 26 && groups[groups.length - 1].length < 4) groups[groups.length - 1].push(...g); else groups.push(g); }
  return groups.map((x) => x.join(' ')).join(' | ');
}
// the spoken words of a caption string, in order ("{a b=c}" speaks a and b, shows c)
export function captionTokens(src) {
  return src.split('|').map((g) => g.trim()).filter(Boolean)
    .map((g) => [...g.matchAll(/\{([^}=]+)=([^}]+)\}|\S+/g)].map((m) => ({ spoken: (m[1] || m[0]).split(/\s+/), text: m[2] || m[0] })));
}
function buildCaptions(lines, words, cue, dur, duration) {
  const groups = [], problems = [], mismatches = [];
  for (const l of lines) {
    const ws = words[l.id] || [];
    const toks = captionTokens(l.caption || autoCaption(l.say));
    const spoken = toks.flat().flatMap((k) => k.spoken.map(norm));
    const map = align(spoken, ws.map((w) => norm(w[0])));
    map.forEach((j, i) => { if (j === null || norm(ws[j][0]) !== spoken[i]) mismatches.push(`${l.id}: "${spoken[i]}" heard as "${j === null ? '(nothing)' : ws[j][0]}"`); });
    const tm = map.map((j) => (j === null ? null : [ws[j][1], ws[j][2]]));
    tm.forEach((v, i) => { if (!v) { const p = tm.slice(0, i).reverse().find(Boolean), q = tm.slice(i + 1).find(Boolean); tm[i] = [p ? p[1] : 0, q ? q[0] : dur[l.id]]; } });
    let k = 0;
    toks.forEach((g) => {
      groups.push({ cue: l.id, tokens: g.map((x) => {
        const a = tm[k][0], b = tm[k + x.spoken.length - 1][1]; k += x.spoken.length;
        return { text: x.text, a: r4(cue[l.id] + a), b: r4(cue[l.id] + b) };
      }) });
    });
  }
  groups.forEach((g, i) => {
    g.a = r4(g.tokens[0].a - 0.12);
    const lastB = g.tokens[g.tokens.length - 1].b, next = groups[i + 1];
    g.b = r4(!next ? Math.min(duration - 0.45, lastB + 1.2) : next.tokens[0].a - 0.12 - lastB > 1.2 ? lastB + 0.7 : next.tokens[0].a - 0.12);
  });
  groups.forEach((g) => {
    const s = g.tokens.map((w) => w.text).join(' '), n = g.tokens.length, on = g.b - g.a;
    if (n > 4 || (n < 2 && !/[.!?]$/.test(s))) problems.push(`group "${s}" has ${n} word${n === 1 ? '' : 's'} (2 to 4, or a one-word punchline)`);
    if (s.length > 26) problems.push(`group "${s}" is ${s.length} characters (max 26): split it`);
    if (on < 0.35) problems.push(`group "${s}" is on screen ${on.toFixed(2)}s (min 0.35s)`);
  });
  return { groups, problems, mismatches };
}

// ---- cursor stops: where the pointer must be, and when ----
function cursorStops(evs) {
  const stops = [];
  for (const e of evs) {
    if (e.type === 'click') stops.push({ kind: 'click', a: e.u - 0.15, d: e.u + 0.14, press: e.u, x: e.x, y: e.y, ev: e.i });
    // the I-beam parks toward the field's far end, so it never sits on the words being typed
    else if (e.type === 'type') stops.push({ kind: 'type', a: e.u - 0.15, d: e.u1 + 0.15, x: Math.round(e.box.x + e.box.w * 0.84), y: Math.round(e.box.y + e.box.h * 0.66), ev: e.i });
    else if (e.type === 'hover') stops.push({ kind: 'hover', a: e.u, d: e.u + 0.2, x: e.x, y: e.y, ev: e.i });
    else if (e.type === 'select') {
      const from = e.from || [e.box.x + 2, e.box.y + Math.min(e.box.h / 2, 13)];
      stops.push({ kind: 'select', a: e.u0 - 0.12, d: e.u + 0.12, press: e.u0, x: from[0], y: from[1], x1: e.x, y1: e.y, drag: [e.u0, e.u], ev: e.i });
    }
  }
  stops.sort((p, q) => p.a - q.a);
  return stops;
}

// flow: events.json; lines: narrative VO lines; vo: {id: seconds}; words: {id: [[word, a, b]]}
export function plan({ flow, lines = [], speed = {}, titleSecs = 2.6, vo = {}, words = {}, rawDur, fps = 30 }) {
  const D = rawDur;
  const evs0 = flow.events.map((e, i) => ({ ...e, i })).filter((e) => e.t <= D + 0.01);
  const curve = speedCurve(evs0, D, speed);
  const beats = flow.beats || [];
  const dur = Object.fromEntries(lines.map((l) => [l.id, vo[l.id] ?? 0]));

  // title card, then the demo
  const titleLine = lines.find((l) => l.at === 'title');
  const cue = {}, end = {};
  if (titleLine) { cue[titleLine.id] = 0.4; end[titleLine.id] = 0.4 + dur[titleLine.id]; }
  const T0 = r4(Math.max(titleSecs, titleLine ? end[titleLine.id] + 0.5 : 0));

  // place beat lines; a line that would spill into the next beat makes the
  // picture wait (a hold) at the calm end of its own beat
  const holds = [];
  let M = buildMap(D, curve, holds);
  let prevEnd = titleLine ? end[titleLine.id] : 0;
  const beatLines = lines.filter((l) => l.beat);
  for (const l of beatLines) {
    const bi = beats.findIndex((b) => b.id === l.beat);
    if (bi < 0) throw new Error(`VO line "${l.id}" names beat "${l.beat}", which events.json does not have`);
    const B = beats[bi], nextB = beats[bi + 1];
    const ev = l.event ? evs0.find((e) => e.label === l.event) : null;
    if (l.event && !ev) throw new Error(`VO line "${l.id}" names event "${l.event}", which events.json does not have`);
    cue[l.id] = r4(Math.max(T0 + M.out(ev ? ev.t : B.t0) + (l.offset ?? (ev ? 0 : 0.35)), prevEnd + GAP));
    end[l.id] = r4(cue[l.id] + dur[l.id]);
    const boundary = nextB ? T0 + M.out(nextB.t0) : null;
    const sameBeatNext = beatLines[beatLines.indexOf(l) + 1]?.beat === l.beat;
    if (!sameBeatNext && boundary !== null && end[l.id] + 0.35 > boundary) {
      const inBeat = evs0.filter((e) => e.t >= B.t0 && e.t < (B.t1 ?? nextB.t0));
      const calm = inBeat.length ? Math.max(...inBeat.map((e) => evEnd(e) + (POST[e.type] ?? 0.6))) : nextB.t0;
      holds.push({ s: r4(Math.min(nextB.t0, calm)), h: r4(end[l.id] + 0.35 - boundary) });
      M = buildMap(D, curve, holds);
    }
    prevEnd = end[l.id];
  }
  const demoEnd = T0 + M.demoDur;
  const endStart = r4(Math.max(demoEnd - 0.2, prevEnd + 0.6));
  const outro = lines.filter((l) => l.at === 'end');
  let x = endStart + 0.5;
  for (const l of outro) { cue[l.id] = r4(x); end[l.id] = r4(x + dur[l.id]); x = end[l.id] + GAP; }
  const lastEnd = outro.length ? end[outro[outro.length - 1].id] : endStart;
  const duration = r4(Math.max(endStart + 3.8, lastEnd + 2.2));
  const ORDER = lines.map((l) => l.id).sort((a, b) => cue[a] - cue[b]);

  // events in output time
  const at = (s) => r4(T0 + M.out(s));
  const evs = evs0.map((e) => ({ ...e, u: at(e.t), u0: at(evStart(e)), u1: at(evEnd(e)) }));
  const stops = cursorStops(evs);
  const keys = [];
  for (const e of evs.filter((q) => q.type === 'type')) {
    const n = Math.max(1, (e.text || '').length);
    for (let k = 0; k < n; k++) keys.push(r4(e.u0 + (e.u1 - e.u0) * (k / Math.max(1, n - 1))));
  }
  const beatsOut = beats.map((b, i) => ({ id: b.id, note: b.note || '', t0: at(b.t0), t1: at(b.t1 ?? beats[i + 1]?.t0 ?? D) }));
  const caps = buildCaptions(lines, words, cue, dur, duration);

  return {
    fps, duration, T0, endStart, demoEnd: r4(demoEnd), srcDur: D, srcFps: 30,
    viewport: flow.viewport, U: M.U, S: M.S, holds, gaps: curve.gaps.map((g) => ({ a: r4(g.a), b: r4(g.b), k: r4(g.k) })),
    ORDER, cue, end, lines: lines.map((l) => ({ id: l.id, beat: l.beat || null, at: l.at || null, event: l.event || null })),
    events: evs, stops, keys, beats: beatsOut,
    captions: caps.groups, captionProblems: caps.problems, captionMismatches: caps.mismatches,
  };
}

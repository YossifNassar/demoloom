/*
 * demoloom motion: the layout, the camera and the cursor, as pure functions of
 * the timeline. Shared by the compositor page (window.Motion) and by Node
 * (require / import), so the tests check exactly the maths the video uses.
 *
 *   const M = Motion.create(TL, shape);
 *   M.camAt(t)    -> { x, y, z }   camera centre (page CSS px) and zoom
 *   M.cursorAt(t) -> { p, alpha, kind, press } | null
 *   M.srcAt(t)    -> source seconds into raw.mp4
 *
 * Nothing here keeps state between calls, so any frame can be computed in any
 * order and gives the same answer.
 */
(function () {
  // ---------- small maths ----------
  const lerp = (a, b, p) => a + (b - a) * p;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const clamp01 = (x) => clamp(x, 0, 1);
  const seg = (t, a, b) => clamp01((t - a) / (b - a));
  const smooth = (x) => x * x * (3 - 2 * x);
  const eout = (x) => 1 - Math.pow(1 - x, 3);
  const mjerk = (x) => { x = clamp01(x); return x * x * x * (10 - 15 * x + 6 * x * x); }; // minimum-jerk reach

  // closed-form spring step response: critically damped when z = 1 (no overshoot),
  // under-damped below. A pure function of time, so it never accumulates.
  function spring(t, t0, p) {
    const x = t - t0;
    if (x <= 0) return 0;
    if (!Number.isFinite(x)) return 1;
    const { w, z } = p;
    if (z < 1) {
      const wd = w * Math.sqrt(1 - z * z);
      return 1 - Math.exp(-z * w * x) * (Math.cos(wd * x) + (z * w / wd) * Math.sin(wd * x));
    }
    return 1 - Math.exp(-w * x) * (1 + w * x);
  }

  // ---------- calm camera defaults ----------
  // One zoom in per beat, long holds, slow and shallow moves.
  const CAMERA_DEFAULTS = {
    zoom: [1.35, 1.6],   // the zoom range for ordinary targets
    small: 1.8,          // the zoom for small targets (a field, one line)
    hold: 3.0,           // seconds a shot holds before the next move
    holdMin: 1.5,        // the shortest hold, when the next action would be missed
    zoomSecs: 1.2,       // duration of a zoom in or out
    panSecs: [0.8, 1.2], // duration of a pan, by distance
    lead: 1.0,           // seconds the camera arrives before the action
    shortGap: 2.5,       // a new beat this soon after a shot keeps the zoom
    wideMin: 1.2,        // the shortest wide view between two zooms
    blur: true,          // motion blur on fast camera moves
  };

  // ---------- layout ----------
  // chrome: the window's title bar height (0 hides the bar)
  function layout(shape, viewport, { chrome: showChrome = true } = {}) {
    const VW = viewport.width, VH = viewport.height;
    if (shape === 'landscape') {
      const W = 1920, H = 1080;
      const chrome = showChrome ? 44 : 0, base = Math.min(1280 / VW, (800 + 44 - chrome) / VH), cw = Math.round(VW * base), ch = Math.round(VH * base);
      const x = Math.round((W - cw) / 2), y = 34;
      return {
        W, H, chrome, base, radius: 18,
        win: { x, y, w: cw, h: ch + chrome }, content: { x, y: y + chrome, w: cw, h: ch },
        cap: { band: [180, 912, 1740, 1070], y: 992, size: 64, maxW: 1420, oneLine: true },
        url: 17, dot: 6,
        title: { logoY: 330, logoS: 132, y: 520, size: 88, maxW: 1500, subGap: 92, sub: 38 },
        end: { logoY: 300, logoS: 150, y: 560, size: 112, urlY: 660, urlSize: 40, chipY: 780 },
      };
    }
    const W = 1080, H = 1920;
    const chrome = showChrome ? 50 : 0, cw = 1000, ch = 840 + 50 - chrome;
    const base = VW * (ch / VH) >= cw ? ch / VH : cw / VW;
    const x = 40, y = 560;
    return {
      W, H, chrome, base, radius: 18,
      win: { x, y, w: cw, h: ch + chrome }, content: { x, y: y + chrome, w: cw, h: ch },
      cap: { band: [60, 210, 1020, 520], y: 392, size: 96, maxW: 900, oneLine: false },
      url: 21, dot: 7, chipY: 1530,
      title: { logoY: 820, logoS: 150, y: 1060, size: 100, maxW: 920, subGap: 120, sub: 40 },
      end: { logoY: 780, logoS: 190, y: 1040, size: 104, urlY: 1150, urlSize: 44, chipY: 1290 },
    };
  }

  function create(TL, shape, opts = {}) {
    const L = opts.layout || layout(shape, TL.viewport, { chrome: TL.view ? TL.view.chrome !== false : true });
    const C = L.content;
    const VW = TL.viewport.width, VH = TL.viewport.height;
    const CAM = { ...CAMERA_DEFAULTS, ...(TL.camera || {}) };
    const zr = CAM.zoom;
    const ZR = Array.isArray(zr) ? zr : (zr && zr[shape]) || CAMERA_DEFAULTS.zoom;
    const eventOpts = TL.eventOpts || {};

    // ---------- the time map: output time -> source time ----------
    const U = TL.U, S = TL.S;
    function srcAt(t) {
      const u = t - TL.T0;
      if (u <= 0) return 0;
      if (u >= U[U.length - 1]) return S[S.length - 1];
      let lo = 0, hi = U.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (U[m] <= u) lo = m; else hi = m; }
      const f = (u - U[lo]) / Math.max(1e-9, U[hi] - U[lo]);
      return S[lo] + (S[hi] - S[lo]) * f;
    }
    const frameIdx = (t) => clamp(Math.round(srcAt(t) * TL.srcFps), 0, Math.max(0, (TL.nFrames || 1) - 1));

    // ---------- camera: a calm shot list ----------
    // Every focus event (click, select, type, appear) is a target. Targets merge
    // into one shot while their union still frames at the lower zoom bound, they
    // sit in the same beat (or the next beat starts within shortGap), and the
    // page has not scrolled or navigated in between. A shot made only of clicks
    // that would be on screen for less than `hold` is dropped: the camera stays
    // put. Between shots the camera pans and keeps its zoom; it goes wide only
    // when the page itself moves or a new beat starts a while later, and only
    // when there is time to hold the wide view. Moves follow a minimum-jerk
    // curve (no overshoot).
    const FOCUS = new Set(['click', 'select', 'type', 'appear']);
    const KEY = new Set(['select', 'type', 'appear']); // what a shot is for; clicks only ride along
    const SMALL_FIT = 2.4, PAD = 18;
    const HOLD_EV = { click: 0.75, select: 0.8, type: 0.6, appear: 1.5 };
    const opt = (e) => eventOpts[e.label] || eventOpts[String(e.i)] || {};
    const viewOf = (z) => [C.w / (L.base * z), C.h / (L.base * z)];
    function clampCam(x, y, z) {
      const [vw, vh] = viewOf(z);
      return [vw >= VW ? VW / 2 : clamp(x, vw / 2, VW - vw / 2), vh >= VH ? VH / 2 : clamp(y, vh / 2, VH - vh / 2)];
    }
    const fitZ = (b) => Math.min((C.w * 0.8) / (b.w * L.base), (C.h * 0.72) / (b.h * L.base));
    const union = (p, q) => { const x = Math.min(p.x, q.x), y = Math.min(p.y, q.y); return { x, y, w: Math.max(p.x + p.w, q.x + q.w) - x, h: Math.max(p.y + p.h, q.y + q.h) - y }; };
    const zoomFor = (box, evs) => {
      const o = evs.map(opt).find((q) => typeof q.zoom === 'number');
      if (o) return o.zoom;
      const f = fitZ(box);
      if (f >= SMALL_FIT) return CAM.small;
      if (f < 1.15) return 1; // a big box (a page landing) is shown whole
      return Math.min(f, ZR[1]) < ZR[0] ? f : clamp(f, ZR[0], ZR[1]);
    };
    const beatOf = (u) => { let id = null; for (const b of TL.beats) if (u >= b.t0 - 1e-6) id = b.id; return id; };
    const pageMoves = TL.events.filter((e) => e.type === 'scroll' || e.type === 'navigate');
    const pageMoveIn = (a, b) => pageMoves.find((e) => e.u > a && e.u < b);
    const enabled = CAM.enabled !== false;
    const TARGETS = !enabled ? [] : TL.events.filter((e) => e.box && (FOCUS.has(e.type) || opt(e).zoom) && opt(e).zoom !== false)
      .map((e) => ({ e, a: e.u0, b: e.u1 + (HOLD_EV[e.type] ?? 0.7), box: { x: e.box.x - PAD, y: e.box.y - PAD, w: e.box.w + 2 * PAD, h: e.box.h + 2 * PAD }, beat: beatOf(e.u) }))
      .sort((p, q) => p.a - q.a || p.e.i - q.e.i);
    function buildShots(ts) {
      const out = [];
      for (const f of ts) {
        const g = out[out.length - 1];
        if (g && (g.beat === f.beat || f.a - g.b < CAM.shortGap) && !pageMoveIn(g.last, f.a)) {
          const U2 = union(g.box, f.box);
          if (fitZ(U2) >= ZR[0] || fitZ(U2) >= Math.min(fitZ(g.box), fitZ(f.box))) { g.box = U2; g.b = Math.max(g.b, f.b); g.last = Math.max(g.last, f.e.u1); g.beat = f.beat; g.evs.push(f.e); continue; }
        }
        out.push({ a: f.a, b: f.b, last: f.e.u1, box: { ...f.box }, beat: f.beat, evs: [f.e] });
      }
      return out;
    }
    const GROUPS = (() => {
      let gs = buildShots(TARGETS);
      for (let k = 0; k < 4; k++) { // drop click-only shots that would not stay on screen for `hold`
        const drop = new Set();
        gs.forEach((g, i) => {
          const next = gs[i + 1] ? gs[i + 1].a : TL.endStart;
          if (!g.evs.some((e) => KEY.has(e.type)) && next - g.a < CAM.hold) g.evs.forEach((e) => drop.add(e));
        });
        if (!drop.size) break;
        gs = buildShots(TARGETS.filter((f) => !drop.has(f.e)));
      }
      for (const g of gs) {
        g.z = zoomFor(g.box, g.evs);
        [g.x, g.y] = clampCam(g.box.x + g.box.w / 2, g.box.y + g.box.h / 2, g.z);
        const keys = g.evs.filter((e) => KEY.has(e.type));
        g.key = keys.length ? Math.min(...keys.map((e) => e.u0)) : g.a;
        g.lead = Math.min(...g.evs.map((e) => opt(e).lead ?? CAM.lead));
        g.end = Math.max(...g.evs.map((e) => e.u1 + (e.type === 'appear' ? 1.2 : 0.4)));
      }
      return gs;
    })();
    const panDur = (p, q) => {
      const [vw, vh] = viewOf(Math.min(p.z, q.z));
      const d = Math.max(Math.abs(q.x - p.x) / vw, Math.abs(q.y - p.y) / vh);
      const zoomish = Math.abs(Math.log(q.z / p.z)) > 0.25;
      return zoomish ? CAM.zoomSecs : clamp(CAM.panSecs[0] + (CAM.panSecs[1] - CAM.panSecs[0]) * d, CAM.panSecs[0], CAM.panSecs[1]);
    };
    const MOVES = (() => {
      const mv = [];
      const g0 = GROUPS[0];
      const [x0, y0] = clampCam(g0 ? g0.x : VW / 2, g0 ? g0.y : VH / 2, 1);
      let cur = { x: x0, y: y0, z: 1, arrive: -Infinity };
      const push = (m, g) => { mv.push(m); cur = { x: m.x, y: m.y, z: m.z, arrive: m.t + m.d }; if (g) g.arrive = m.t + m.d * 0.85; };
      GROUPS.forEach((g, i) => {
        const p = GROUPS[i - 1];
        const ideal = g.a - g.lead, latest = Math.max(ideal, g.key - 0.6);
        g.arrive = cur.arrive;
        // one zoom in per beat: a later shot in the same beat keeps the zoom, and
        // needs no move at all when it is already in view
        if (p && g.beat === p.beat && cur.z > 1 && !pageMoveIn(p.last, g.a)) {
          if (g.z > cur.z) { g.z = cur.z; [g.x, g.y] = clampCam(g.box.x + g.box.w / 2, g.box.y + g.box.h / 2, g.z); }
          const [vw, vh] = viewOf(cur.z), [cx, cy] = clampCam(cur.x, cur.y, cur.z);
          if (g.z === cur.z && g.box.x >= cx - vw / 2 && g.box.x + g.box.w <= cx + vw / 2 && g.box.y >= cy - vh / 2 && g.box.y + g.box.h <= cy + vh / 2) {
            [g.x, g.y, g.z] = [cur.x, cur.y, cur.z];
            return;
          }
        }
        if (Math.abs(cur.x - g.x) < 1 && Math.abs(cur.y - g.y) < 1 && Math.abs(cur.z - g.z) < 0.01) return; // already framed
        if (cur.z === 1 && g.z > 1) { // from the wide view: one zoom in
          const t = Math.min(Math.max(ideal, cur.arrive + (mv.length ? CAM.wideMin : 0)), Math.max(latest, cur.arrive + 0.4));
          push({ t, d: CAM.zoomSecs, x: g.x, y: g.y, z: g.z, kind: 'in', to: g.evs[0].label }, g);
          return;
        }
        const pm = pageMoveIn(p.last, g.a);
        const newBeat = g.beat !== p.beat && g.a - p.end >= CAM.shortGap;
        const outT = Math.max(p.end, cur.arrive + CAM.hold);
        const inT = Math.max(ideal, outT + CAM.zoomSecs + CAM.wideMin);
        if ((pm || newBeat) && cur.z > 1 && g.z > 1 && inT <= latest + 1e-6) {
          const wide = union(p.box, g.box);
          const [wx, wy] = clampCam(wide.x + wide.w / 2, wide.y + wide.h / 2, 1);
          push({ t: outT, d: CAM.zoomSecs, x: wx, y: wy, z: 1, kind: 'out', why: pm ? `page ${pm.type}` : 'new beat' });
          push({ t: inT, d: CAM.zoomSecs, x: g.x, y: g.y, z: g.z, kind: 'in', to: g.evs[0].label }, g);
          return;
        }
        const t = Math.min(Math.max(ideal, cur.arrive + CAM.hold), Math.max(latest, cur.arrive + CAM.holdMin));
        push({ t, d: panDur(cur, g), x: g.x, y: g.y, z: g.z, kind: Math.abs(Math.log(g.z / cur.z)) > 0.05 ? 'reframe' : 'pan', to: g.evs[0].label }, g);
      });
      // a last zoom out only when the final shot would otherwise sit for a long time
      if (cur.z > 1 && TL.endStart - cur.arrive > CAM.hold + CAM.zoomSecs + 2) {
        const [x, y] = clampCam(cur.x, cur.y, 1);
        push({ t: Math.max(cur.arrive + CAM.hold, GROUPS[GROUPS.length - 1].end), d: CAM.zoomSecs, x, y, z: 1, kind: 'out', why: 'end' });
      }
      return mv.sort((p, q) => p.t - q.t);
    })();
    const CAM0 = (() => { const g = GROUPS[0]; const [x, y] = clampCam(g ? g.x : VW / 2, g ? g.y : VH / 2, 1); return { x, y, z: 1 }; })();
    function camAt(t) {
      let x = CAM0.x, y = CAM0.y, lz = 0, px = x, py = y, pz = 0;
      for (const m of MOVES) {
        if (m.t > t) break;
        const k = mjerk((t - m.t) / m.d);
        x += (m.x - px) * k; y += (m.y - py) * k; lz += (Math.log(m.z) - pz) * k; // zoom moves in log space
        px = m.x; py = m.y; pz = Math.log(m.z);
      }
      const z = Math.exp(lz);
      const [cx, cy] = clampCam(x, y, z);
      return { x: cx, y: cy, z };
    }
    // css point -> content-layer pixel, for a camera
    const toLayer = (cam, p) => [C.w / 2 + (p[0] - cam.x) * L.base * cam.z, C.h / 2 + (p[1] - cam.y) * L.base * cam.z];

    // motion blur: when the camera moves more than a few pixels a frame, the frame
    // is the average of sub-frames across a short shutter
    function blurTimes(t) {
      if (!CAM.blur) return [t];
      const dt = 1 / TL.fps, a = camAt(t - dt / 2), b = camAt(t + dt / 2);
      const s = L.base * Math.sqrt(a.z * b.z);
      const pan = Math.hypot(a.x - b.x, a.y - b.y) * s;
      const zoom = Math.abs(Math.log(a.z / b.z)) * Math.hypot(C.w, C.h) / 2;
      const SHUT = Math.min(0.25, 8 / Math.max(1e-6, pan + zoom)), px = (pan + zoom) * SHUT;
      if (px < 3) return [t];
      const n = Math.min(16, Math.ceil(px / 1.2) + 1);
      return Array.from({ length: n }, (_, i) => t + (i / (n - 1) - 0.5) * SHUT * dt);
    }

    // ---------- the cursor ----------
    // It travels between stops on a slightly bowed, minimum-jerk path, arrives
    // 0.15 s before a click, and fades out during long idles.
    const STOPS = TL.stops;
    const stopEnd = (s) => (s.kind === 'select' ? [s.x1, s.y1] : [s.x, s.y]);
    function bezPt(p0, p1, u) {
      const dx = p1[0] - p0[0], dy = p1[1] - p0[1], d = Math.hypot(dx, dy);
      if (d < 1) return p1.slice();
      let nx = -dy / d, ny = dx / d;
      if (ny > 0 || (ny === 0 && nx < 0)) { nx = -nx; ny = -ny; } // the arc bows up, like a wrist
      const bow = Math.min(0.14 * d, 80);
      const cx = (p0[0] + p1[0]) / 2 + nx * bow, cy = (p0[1] + p1[1]) / 2 + ny * bow;
      const e = mjerk(Math.pow(u, 0.88)), q = 1 - e;
      return [q * q * p0[0] + 2 * q * e * cx + e * e * p1[0], q * q * p0[1] + 2 * q * e * cy + e * e * p1[1]];
    }
    const travelSecs = (p0, p1) => clamp(0.3 + Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) * 0.00055, 0.38, 0.95);
    const IDLE = 2.2;
    const ibeamStop = (s) => s.kind === 'type' || s.kind === 'select';
    function cursorAt(t) {
      if (!STOPS.length || t < TL.T0 - 0.2 || t > TL.endStart + 0.2) return null;
      const first = STOPS[0];
      let i = -1;
      for (let k = 0; k < STOPS.length; k++) if (STOPS[k].a <= t) i = k;
      if (i < 0) { // entering: glide in from below right of the first stop
        const p1 = [first.x, first.y], p0 = [clamp(first.x + 160, 20, VW - 20), clamp(first.y + 210, 20, VH - 20)];
        const T = travelSecs(p0, p1), ts = first.a - T;
        const alpha = smooth(seg(t, ts - 0.35, ts - 0.05));
        if (alpha <= 0) return null;
        const u = seg(t, ts, first.a);
        return { p: bezPt(p0, p1, u), alpha, kind: ibeamStop(first) && u > 0.75 ? 'ibeam' : 'arrow', press: 0 };
      }
      const s = STOPS[i], n = STOPS[i + 1];
      if (t <= s.d) { // at a stop
        let p = [s.x, s.y], press = 0;
        if (s.kind === 'select') {
          const u = seg(t, s.drag[0], s.drag[1]), e = u * u * (3 - 2 * u);
          p = [lerp(s.x, s.x1, e), lerp(s.y, s.y1, e)];
          press = t >= s.drag[0] - 0.06 && t <= s.drag[1] + 0.08 ? 0.6 * smooth(seg(t, s.drag[0] - 0.06, s.drag[0])) * (1 - smooth(seg(t, s.drag[1], s.drag[1] + 0.08))) : 0;
        } else if (s.press !== undefined) {
          press = t < s.press ? smooth(seg(t, s.press - 0.06, s.press)) : 1 - smooth(seg(t, s.press, s.press + 0.16));
        }
        return { p, alpha: 1, kind: ibeamStop(s) ? 'ibeam' : 'arrow', press };
      }
      const p0 = stopEnd(s);
      if (!n) { const alpha = 1 - smooth(seg(t, s.d + 1.0, s.d + 1.3)); return alpha > 0 ? { p: p0, alpha, kind: 'arrow', press: 0 } : null; }
      const p1 = [n.x, n.y], T = Math.min(travelSecs(p0, p1), Math.max(0.05, n.a - s.d)), ts = n.a - T;
      let alpha = 1;
      if (ts - s.d > IDLE) alpha = Math.min(1 - smooth(seg(t, s.d + 0.9, s.d + 1.2)), 1) + smooth(seg(t, ts - 0.35, ts - 0.05));
      alpha = clamp01(alpha);
      if (alpha <= 0) return null;
      const u = seg(t, ts, n.a);
      const kind = (ibeamStop(n) && u > 0.75) || (ibeamStop(s) && t < s.d + 0.1) ? 'ibeam' : 'arrow';
      return { p: bezPt(p0, p1, u), alpha, kind, press: 0 };
    }
    const cursorScale = (z) => 1.45 * Math.pow(L.base * z, 0.7);

    // ---------- emphasis rings: things that land get a ring once the camera is there ----------
    const RINGS = TL.events.filter((e) => e.box && ((e.type === 'appear' && opt(e).emphasis !== false) || opt(e).emphasis === true)).map((e) => {
      const g = GROUPS.find((q) => q.evs.includes(e));
      return { e, t: Math.max(e.u, g ? g.arrive : e.u) };
    });
    const CLICKS = STOPS.filter((s) => s.kind === 'click');

    return { L, C, ZR, CAM, srcAt, frameIdx, GROUPS, MOVES, TARGETS, camAt, toLayer, blurTimes, cursorAt, cursorScale, viewOf, RINGS, CLICKS };
  }

  const API = { create, layout, spring, mjerk, lerp, clamp, clamp01, seg, smooth, eout, CAMERA_DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else window.Motion = API;
})();

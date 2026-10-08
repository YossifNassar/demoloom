/*
 * The compositor. One canvas, one pure function: seek(t) paints output time t
 * from the timeline (window.TL) and the decoded frames of raw.mp4. No state
 * carries between frames except an image cache, which only holds immutable
 * decoded JPEGs, so frames hash the same in any order (see `render --verify`).
 *
 * Layers, back to front: backdrop, window (shadow, title bar, the recording
 * under the camera, emphasis rings, click ripples, the cursor), step labels,
 * the title and end cards, word captions.
 */
const Q = new URLSearchParams(location.search);
const SHAPE = Q.get('shape') === 'vertical' ? 'vertical' : 'landscape';
const TL = window.TL;
const { spring, lerp, clamp01, seg, smooth, eout } = window.Motion;
const MO = window.Motion.create(TL, SHAPE);
const L = MO.L, C = L.content, W = L.W, H = L.H;
const cv = document.getElementById('c');
cv.width = W; cv.height = H;
const ctx = cv.getContext('2d');
const VW = TL.viewport.width, VH = TL.viewport.height, DPR = TL.viewport.dpr || 2;
const TH = TL.theme, NV = TL.narrative, VIEW = TL.view;
const DEF = { w: 17, z: 0.86 }, PLAY = { w: 22, z: 0.48 }, SNAPPY = { w: 30, z: 0.78 };

// ---------- colours and type ----------
const PROBE = document.createElement('canvas').getContext('2d');
function rgbOf(c) { // any CSS colour -> [r, g, b, a]
  PROBE.fillStyle = '#000'; PROBE.fillStyle = c;
  const s = PROBE.fillStyle;
  if (s[0] === '#') { const n = parseInt(s.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; }
  const m = s.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m[3] ?? 1];
}
const rgba = (c, a) => { const [r, g, b, a0] = rgbOf(c); return `rgba(${r},${g},${b},${a0 * a})`; };
const mix = (a, b, p) => { const A = rgbOf(a), B = rgbOf(b); return `rgba(${A.map((v, i) => (i < 3 ? Math.round(lerp(v, B[i], clamp01(p))) : lerp(v, B[i], clamp01(p)))).join(',')})`; };
const ACC = TH.accent, ACC_INK = TH.accentInk, INK = TH.ink, MUTED = TH.muted, HALO = TH.halo;
const fam = (f) => (/^(system-ui|sans-serif|serif|monospace|ui-\w+)$/.test(f) ? f : `'${f}'`);
const DISPLAY = `${fam(TH.fonts.display)}, system-ui, sans-serif`;
const UI = `${fam(TH.fonts.ui)}, system-ui, sans-serif`;
function rr(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2))); }
function wrapBalanced(c, str, font, maxW) {
  c.font = font;
  if (c.measureText(str).width <= maxW) return [str];
  const words = str.split(' ');
  let best = null;
  for (let k = 1; k < words.length; k++) {
    const Ls = [words.slice(0, k).join(' '), words.slice(k).join(' ')];
    const m = Math.max(...Ls.map((l) => c.measureText(l).width));
    if (m <= maxW && (!best || m < best[0])) best = [m, Ls];
  }
  return best ? best[1] : [str];
}

// ---------- frames ----------
const CACHE = new Map();
function load(i) {
  if (CACHE.has(i)) { const v = CACHE.get(i); CACHE.delete(i); CACHE.set(i, v); return v; }
  const p = new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => img.decode().then(() => res(img), () => res(img));
    img.onerror = () => rej(new Error('frame ' + i));
    img.src = `/out/frames/${String(i + 1).padStart(5, '0')}.jpg`;
  });
  CACHE.set(i, p);
  while (CACHE.size > 14) CACHE.delete(CACHE.keys().next().value);
  return p;
}
const LOGO = TH.logoUrl ? new Image() : null;

// ---------- backdrop (painted once) ----------
const BG = document.createElement('canvas'); BG.width = W; BG.height = H;
function paintBackdrop() {
  const b = BG.getContext('2d'), bd = TH.backdrop;
  const wx = L.win.x + L.win.w / 2, wy = L.win.y + L.win.h / 2;
  if (bd.style === 'solid') { b.fillStyle = bd.from; b.fillRect(0, 0, W, H); }
  else {
    const g = b.createLinearGradient(0, 0, W * (bd.style === 'gradient' ? 1 : 0.4), H);
    g.addColorStop(0, bd.from); g.addColorStop(1, bd.to);
    b.fillStyle = g; b.fillRect(0, 0, W, H);
    if (bd.glow) { // a soft glow behind the window
      const R = Math.max(L.win.w, L.win.h) * (bd.style === 'gradient' ? 0.95 : 0.85);
      const r = b.createRadialGradient(wx, wy, 0, wx, wy, R);
      const k = bd.style === 'gradient' ? 0.42 : 0.24;
      r.addColorStop(0, rgba(bd.glow, k)); r.addColorStop(0.55, rgba(bd.glow, k * 0.4)); r.addColorStop(1, rgba(bd.glow, 0));
      b.fillStyle = r; b.fillRect(0, 0, W, H);
    }
    const r2 = b.createRadialGradient(W * 0.08, 0, 0, W * 0.08, 0, Math.max(W, H) * 0.6); // a highlight from the top left
    r2.addColorStop(0, 'rgba(255,255,255,0.10)'); r2.addColorStop(1, 'rgba(255,255,255,0)');
    b.fillStyle = r2; b.fillRect(0, 0, W, H);
  }
  if (bd.style === 'dots') { // a soft dot grid, strongest around the window
    const step = SHAPE === 'landscape' ? 28 : 30, R = Math.max(W, H) * 0.75, dot = bd.glow || ACC;
    for (let y = step / 2; y < H; y += step) for (let x = step / 2; x < W; x += step) {
      const k = Math.max(0, 1 - Math.hypot(x - wx, y - wy) / R);
      if (k <= 0.02) continue;
      b.fillStyle = rgba(dot, 0.07 + 0.13 * k);
      b.beginPath(); b.arc(x, y, 1.6, 0, Math.PI * 2); b.fill();
    }
  }
  if (bd.grain !== false) { // a fine seeded grain so gradients never band after H.264
    let s = 11; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const img = b.getImageData(0, 0, W, H), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * 3; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    b.putImageData(img, 0, 0);
  }
}

// ---------- cursor, rings, ripples ----------
function drawCursor(c, x, y, sc, kind, alpha) {
  c.save(); c.globalAlpha *= alpha; c.translate(x, y); c.scale(sc, sc);
  c.shadowColor = 'rgba(0,0,0,0.32)'; c.shadowBlur = 5; c.shadowOffsetY = 1.5;
  c.lineJoin = 'round'; c.lineCap = 'round';
  if (kind === 'ibeam') {
    const path = () => { c.beginPath(); c.moveTo(-3.6, -9); c.quadraticCurveTo(0, -9, 0, -6.5); c.quadraticCurveTo(0, -9, 3.6, -9); c.moveTo(0, -6.5); c.lineTo(0, 6.5); c.moveTo(-3.6, 9); c.quadraticCurveTo(0, 9, 0, 6.5); c.quadraticCurveTo(0, 9, 3.6, 9); };
    path(); c.strokeStyle = '#FFFFFF'; c.lineWidth = 3.8; c.stroke();
    c.shadowColor = 'transparent'; path(); c.strokeStyle = '#111014'; c.lineWidth = 1.5; c.stroke();
  } else {
    const P = [[0, 0], [0, 16.6], [4.1, 12.7], [6.9, 19.1], [9.7, 17.9], [7, 11.6], [12.4, 11.6]];
    c.beginPath(); P.forEach(([px, py], k) => (k ? c.lineTo(px, py) : c.moveTo(px, py))); c.closePath();
    c.strokeStyle = '#FFFFFF'; c.lineWidth = 2.6; c.stroke();
    c.shadowColor = 'transparent'; c.fillStyle = '#111014'; c.fill();
  }
  c.restore();
}
function drawRing(c, cam, r, t) {
  const k = t - r.t;
  if (k < 0 || k > 2.1) return;
  const env = smooth(seg(k, 0, 0.2)) * (1 - smooth(seg(k, 1.65, 2.1)));
  const s = L.base * cam.z, pad = 7;
  const [x0, y0] = MO.toLayer(cam, [r.e.box.x - pad, r.e.box.y - pad]);
  const w = (r.e.box.w + 2 * pad) * s, h = (r.e.box.h + 2 * pad) * s, rad = Math.min(14, h / 2);
  c.save();
  c.globalAlpha = env * 0.1; c.fillStyle = ACC; rr(c, x0, y0, w, h, rad); c.fill();
  c.globalAlpha = env; c.shadowColor = rgba(ACC, 0.85); c.shadowBlur = 14;
  c.strokeStyle = ACC; c.lineWidth = 3.5; rr(c, x0, y0, w, h, rad); c.stroke();
  c.shadowColor = 'transparent';
  for (const d of [0.05, 0.6]) { // two soft pulses spreading out
    const q = seg(k, d, d + 0.9);
    if (q <= 0 || q >= 1) continue;
    const o = eout(q) * 16;
    c.globalAlpha = env * 0.55 * (1 - q); c.lineWidth = 2.5;
    rr(c, x0 - o, y0 - o, w + 2 * o, h + 2 * o, rad + o); c.stroke();
  }
  c.restore();
}
function drawRipples(c, cam, t) {
  for (const s of MO.CLICKS) {
    const k = t - s.press;
    if (k < 0 || k > 0.6) continue;
    const q = k / 0.6, [x, y] = MO.toLayer(cam, [s.x, s.y]), sc = MO.cursorScale(cam.z) / 1.6;
    c.save();
    c.globalAlpha = 0.32 * (1 - q); c.fillStyle = ACC;
    c.beginPath(); c.arc(x, y, lerp(6, 24, eout(q)) * sc, 0, 7); c.fill();
    c.globalAlpha = 1 - q; c.shadowColor = rgba(ACC, 0.9); c.shadowBlur = 10;
    c.strokeStyle = ACC; c.lineWidth = 4 * (1 - 0.5 * q);
    c.beginPath(); c.arc(x, y, lerp(8, 38, eout(q)) * sc, 0, 7); c.stroke();
    c.shadowColor = 'transparent'; c.globalAlpha = 0.9 * (1 - q); c.strokeStyle = '#FFFFFF'; c.lineWidth = 1.5 * (1 - 0.5 * q);
    c.beginPath(); c.arc(x, y, lerp(8, 38, eout(q)) * sc - 2.5, 0, 7); c.stroke();
    c.restore();
  }
}

// ---------- the content layer: the recording under the camera ----------
const CL = document.createElement('canvas'); CL.width = C.w; CL.height = C.h;
const cl = CL.getContext('2d');
const TMP = document.createElement('canvas'); TMP.width = C.w; TMP.height = C.h;
const tmp = TMP.getContext('2d');
function paintFrame(c, img, cam) {
  const [vw, vh] = MO.viewOf(cam.z);
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.drawImage(img, (cam.x - vw / 2) * DPR, (cam.y - vh / 2) * DPR, vw * DPR, vh * DPR, 0, 0, C.w, C.h);
}
async function paintContent(t) {
  const ts = MO.blurTimes(t);
  const img = await load(MO.frameIdx(t)); // camera blur only: the recording itself is never smeared
  cl.setTransform(1, 0, 0, 1, 0, 0); cl.globalAlpha = 1; cl.globalCompositeOperation = 'source-over';
  if (ts.length === 1) paintFrame(cl, img, MO.camAt(t));
  else {
    ts.forEach((x, i) => {
      tmp.setTransform(1, 0, 0, 1, 0, 0); paintFrame(tmp, img, MO.camAt(x));
      cl.globalAlpha = 1 / (i + 1); cl.drawImage(TMP, 0, 0);
    });
    cl.globalAlpha = 1;
  }
  const cam = MO.camAt(t);
  for (const r of MO.RINGS) drawRing(cl, cam, r, t);
  drawRipples(cl, cam, t);
  const cur = MO.cursorAt(t);
  if (cur) {
    const [x, y] = MO.toLayer(cam, cur.p);
    drawCursor(cl, x, y, MO.cursorScale(cam.z) * (1 - 0.2 * cur.press), cur.kind, cur.alpha);
  }
}

// ---------- the window ----------
const WT = TH.window;
function drawWindow(k) { // k: presence (entry and exit), drawn with a slight scale and lift
  if (k.a <= 0.001) return;
  const { x, y, w, h } = L.win, R = WT.radius ?? 18;
  ctx.save();
  ctx.globalAlpha = k.a;
  ctx.translate(x + w / 2, y + h / 2 + k.dy); ctx.scale(k.s, k.s); ctx.translate(-(x + w / 2), -(y + h / 2));
  ctx.save(); // a soft, large shadow plus a tight contact shadow
  ctx.shadowColor = WT.shadow; ctx.shadowBlur = 60; ctx.shadowOffsetY = 22;
  ctx.fillStyle = WT.bar; rr(ctx, x, y, w, h, R); ctx.fill();
  ctx.shadowColor = 'rgba(0,0,0,0.12)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 2;
  rr(ctx, x, y, w, h, R); ctx.fill();
  ctx.restore();
  const ch = L.chrome;
  if (ch > 0) {
    const cy = y + ch / 2;
    ctx.fillStyle = WT.bar; rr(ctx, x, y, w, ch + R, R); ctx.fill();
    [0, 1, 2].forEach((i) => { ctx.fillStyle = WT.dots; ctx.beginPath(); ctx.arc(x + 22 + i * (L.dot * 3), cy, L.dot, 0, 7); ctx.fill(); });
    if (VIEW.urlBar && VIEW.url) {
      ctx.font = `500 ${L.url}px ${UI}`;
      const tw = ctx.measureText(VIEW.url).width, pw = Math.min(w * 0.62, tw + 70), px = x + w / 2 - pw / 2, ph = ch * 0.62;
      ctx.fillStyle = WT.pill; rr(ctx, px, cy - ph / 2, pw, ph, ph / 2); ctx.fill();
      const lx = px + 22, ly = cy + 1, ls = L.url / 17; // a small padlock
      ctx.strokeStyle = WT.urlText; ctx.lineWidth = 1.6 * ls; ctx.beginPath(); ctx.arc(lx, ly - 3 * ls, 3.2 * ls, Math.PI, 0); ctx.stroke();
      ctx.fillStyle = WT.urlText; rr(ctx, lx - 4.6 * ls, ly - 3 * ls, 9.2 * ls, 7.4 * ls, 1.6 * ls); ctx.fill();
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(VIEW.url, lx + 12 * ls, cy + 1);
    }
  }
  ctx.save(); ctx.beginPath(); ctx.roundRect(C.x, C.y, C.w, C.h, ch > 0 ? [0, 0, R, R] : R); ctx.clip();
  ctx.drawImage(CL, C.x, C.y);
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.08)'; ctx.lineWidth = 1;
  if (ch > 0) { ctx.beginPath(); ctx.moveTo(x, C.y - 0.5); ctx.lineTo(x + w, C.y - 0.5); ctx.stroke(); }
  rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, R); ctx.stroke();
  ctx.restore();
}

// ---------- step labels ----------
const BEATS = TL.beats;
const beatTitle = (b) => NV.beatTitles[b.id] || b.id.charAt(0).toUpperCase() + b.id.slice(1).replace(/[-_]/g, ' ');
function beatIndexAt(t) { let i = -1; BEATS.forEach((b, k) => { if (t >= b.t0 - 0.25) i = k; }); return Math.max(0, i); }
function stepRail(t, a) { // landscape: the steps down the left margin
  if (a <= 0.001 || !BEATS.length) return;
  const cur = beatIndexAt(t), x = 64, y0 = L.win.y + L.win.h / 2 - (BEATS.length - 1) * 34, maxW = L.win.x - x - 32 - 22;
  ctx.save(); ctx.globalAlpha *= a;
  BEATS.forEach((b, i) => {
    const y = y0 + i * 68, k = spring(t, b.t0 - 0.25, DEF), on = i === cur ? k : i < cur ? 1 - spring(t, BEATS[i + 1].t0 - 0.25, DEF) : 0;
    const done = i < cur;
    ctx.beginPath(); ctx.arc(x, y, 17, 0, 7);
    ctx.fillStyle = on > 0.01 ? mix(rgba(ACC, 0.18), ACC, on) : done ? rgba(ACC, 0.22) : rgba(INK, 0.06);
    ctx.fill();
    if (!done && on < 0.5) { ctx.lineWidth = 1.5; ctx.strokeStyle = rgba(INK, 0.3); ctx.stroke(); }
    ctx.font = `700 17px ${UI}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = on > 0.5 ? ACC_INK : done ? INK : MUTED;
    ctx.fillText(done && on < 0.5 ? '✓' : String(i + 1), x, y + 1);
    let fs = 25;
    const label = beatTitle(b);
    ctx.font = `${on > 0.5 ? 700 : 600} ${fs}px ${UI}`;
    while (fs > 16 && ctx.measureText(label).width > maxW) { fs -= 1; ctx.font = `${on > 0.5 ? 700 : 600} ${fs}px ${UI}`; }
    ctx.textAlign = 'left'; ctx.fillStyle = on > 0.5 ? INK : MUTED;
    ctx.fillText(label, x + 32, y + 1);
  });
  ctx.restore();
}
function stepChip(t, a) { // vertical: the current step under the window
  if (a <= 0.001 || !BEATS.length) return;
  const cur = beatIndexAt(t);
  BEATS.forEach((b, i) => {
    const kin = spring(t, b.t0 - 0.25, DEF), kout = BEATS[i + 1] ? spring(t, BEATS[i + 1].t0 - 0.25, DEF) : 0;
    const al = a * clamp01(kin * 1.5) * (1 - clamp01(kout * 1.5));
    if (al <= 0.01 || (i !== cur && i !== cur - 1)) return;
    const y = L.chipY + 26 * (1 - kin) - 26 * kout;
    ctx.save(); ctx.globalAlpha *= al;
    const label = beatTitle(b), num = `${i + 1}/${BEATS.length}`;
    ctx.font = `700 40px ${UI}`; const lw = ctx.measureText(label).width;
    ctx.font = `700 26px ${UI}`; const nw = ctx.measureText(num).width;
    const w = lw + nw + 96, x = W / 2 - w / 2;
    ctx.fillStyle = rgba(INK, 0.08); rr(ctx, x, y - 36, w, 72, 36); ctx.fill();
    ctx.strokeStyle = rgba(INK, 0.18); ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = ACC; rr(ctx, x + 12, y - 24, nw + 28, 48, 24); ctx.fill();
    ctx.fillStyle = ACC_INK; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(num, x + 26, y + 1);
    ctx.font = `700 40px ${UI}`; ctx.fillStyle = INK; ctx.fillText(label, x + nw + 60, y + 2);
    ctx.restore();
  });
}

// ---------- title and end cards ----------
function logo(cx, cy, size, k) { // the theme's logo, fitted in a size x size square, scaled by k
  if (!LOGO || k <= 0.001) return;
  const r = LOGO.naturalWidth / LOGO.naturalHeight || 1, w = r >= 1 ? size : size * r, h = r >= 1 ? size / r : size;
  ctx.save(); ctx.globalAlpha *= clamp01(k * 1.5);
  ctx.translate(cx, cy); ctx.scale(k, k);
  ctx.drawImage(LOGO, -w / 2, -h / 2, w, h);
  ctx.restore();
}
function titleCard(t) {
  if (!NV.title && !LOGO) return;
  const T = L.title, out = spring(t, TL.T0 - 1.05, { w: 12, z: 1 });
  if (out >= 0.999) return;
  ctx.save(); ctx.globalAlpha *= 1 - clamp01(out * 1.4); ctx.translate(0, -90 * out);
  const left = TH.titleLayout === 'left', land = SHAPE === 'landscape';
  const x0 = land ? 250 : 90;
  const size = left && !land ? Math.round(T.size * 1.12) : T.size, maxW = left ? (land ? 1300 : 900) : T.maxW;
  const cx = left ? x0 : W / 2;
  const kl = spring(t, 0.12, SNAPPY);
  const lines = NV.title ? wrapBalanced(ctx, NV.title, `800 ${size}px ${DISPLAY}`, maxW) : [];
  const ty = (LOGO ? T.y : T.y - T.logoS * 0.45) + (left ? (land ? 10 : 30) : 0);
  const top = ty - (lines.length - 1) / 2 * size * 1.08 - size * 0.5;
  if (LOGO) { const ms = left ? T.logoS * 0.8 : T.logoS; if (left) logo(x0 + ms / 2, top - ms * 0.8, ms, kl); else logo(cx, T.logoY, T.logoS, kl); }
  const kt = spring(t, 0.42, DEF);
  ctx.save(); ctx.globalAlpha *= clamp01(kt * 2); ctx.translate(cx, ty); ctx.scale(lerp(0.92, 1, kt), lerp(0.92, 1, kt)); ctx.translate(-cx, -ty);
  ctx.font = `800 ${size}px ${DISPLAY}`; ctx.fillStyle = INK; ctx.textAlign = left ? 'left' : 'center'; ctx.textBaseline = 'alphabetic';
  const lineY = (i) => ty + (i - (lines.length - 1) / 2) * size * 1.08 + size * 0.34;
  lines.forEach((l, i) => ctx.fillText(l, cx, lineY(i)));
  ctx.restore();
  const lastY = lines.length ? lineY(lines.length - 1) : ty;
  if (left) { // an accent rule drawn under the title
    const kr = spring(t, 0.75, DEF);
    ctx.font = `800 ${size}px ${DISPLAY}`;
    const wMax = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
    ctx.save(); ctx.fillStyle = ACC; rr(ctx, x0, lastY + size * 0.32, Math.min(wMax, 260) * clamp01(kr), 10, 5); ctx.fill(); ctx.restore();
  }
  if (NV.subtitle) {
    const ks = spring(t, 0.7, DEF);
    ctx.globalAlpha *= clamp01(ks * 2);
    ctx.font = `500 ${T.sub}px ${UI}`; ctx.fillStyle = MUTED; ctx.textAlign = left ? 'left' : 'center'; ctx.textBaseline = 'alphabetic';
    const sy = left ? lastY + size * 0.32 + 10 + T.sub * 1.9 : lastY + T.subGap;
    ctx.fillText(NV.subtitle, cx, sy + 12 * (1 - ks));
  }
  ctx.restore();
}
function endCard(t) {
  const E = L.end, t0 = TL.endStart;
  if (t < t0) return;
  const EC = TH.endCard || {}, title = EC.title || NV.title, cx = W / 2;
  const up = LOGO ? 0 : E.logoS * 0.5;
  logo(cx, E.logoY, E.logoS, spring(t, t0 + 0.15, SNAPPY));
  if (title) {
    const ku = spring(t, t0 + 0.3, DEF), y = E.y - up;
    const lines = wrapBalanced(ctx, title, `800 ${E.size}px ${DISPLAY}`, W * 0.84);
    ctx.save(); ctx.globalAlpha *= clamp01(ku * 2); ctx.translate(cx, y - 40); ctx.scale(lerp(0.85, 1, ku), lerp(0.85, 1, ku)); ctx.translate(-cx, -(y - 40));
    ctx.font = `800 ${E.size}px ${DISPLAY}`; ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    lines.forEach((l, i) => ctx.fillText(l, cx, y - (lines.length - 1 - i) * E.size * 1.05));
    ctx.restore();
  }
  if (EC.url) {
    const kv = spring(t, t0 + 0.45, DEF);
    ctx.save(); ctx.globalAlpha *= clamp01(kv * 2);
    ctx.font = `600 ${E.urlSize}px ${UI}`; ctx.fillStyle = MUTED; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(EC.url, cx, E.urlY - up + 10 * (1 - kv));
    ctx.restore();
  }
  if (EC.cta) {
    const endLine = TL.lines.find((l) => l.at === 'end');
    const kc = spring(t, (endLine ? TL.cue[endLine.id] : t0 + 0.6) + 0.5, PLAY);
    if (kc > 0.001) {
      ctx.save(); ctx.globalAlpha *= clamp01(kc * 2); ctx.translate(cx, E.chipY - up); ctx.scale(lerp(0.7, 1, kc), lerp(0.7, 1, kc));
      ctx.font = `700 50px ${UI}`; const w = ctx.measureText(EC.cta).width + 80, h = 92;
      ctx.fillStyle = ACC; rr(ctx, -w / 2, -h / 2, w, h, h / 2); ctx.fill();
      ctx.fillStyle = ACC_INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(EC.cta, 0, 2);
      ctx.restore();
    }
  }
}

// ---------- word captions ----------
const CAP_POP = { w: 26, z: 0.82 }, CAP_SLIDE = { w: 34, z: 0.9 }, CAP_LIFT_PX = 4;
const CX = W / 2;
function capFit(g, size, maxW, minSize, oneLine) {
  for (let s = size; s >= minSize; s -= 4) {
    ctx.font = `800 ${s}px ${DISPLAY}`;
    const sp = s * 0.3, ws = g.tokens.map((k) => ctx.measureText(k.text).width);
    const total = ws.reduce((x, y) => x + y, 0) + sp * (ws.length - 1);
    let split = null;
    if (total > maxW) {
      if (oneLine) continue;
      let best = Infinity;
      for (let k = 1; k < ws.length; k++) {
        const l1 = ws.slice(0, k).reduce((x, y) => x + y, 0) + sp * (k - 1), l2 = total - l1 - sp;
        if (Math.max(l1, l2) <= maxW && Math.max(l1, l2) < best) { best = Math.max(l1, l2); split = k; }
      }
      if (split === null) continue;
    }
    const rows = split === null ? [[0, ws.length]] : [[0, split], [split, ws.length]];
    const boxes = [];
    rows.forEach(([i0, i1], r) => {
      const w = ws.slice(i0, i1).reduce((x, y) => x + y, 0) + sp * (i1 - i0 - 1);
      let x = CX - w / 2;
      for (let i = i0; i < i1; i++) { boxes.push({ x, w: ws[i], row: r }); x += ws[i] + sp; }
    });
    return { size: s, rows: rows.length, boxes };
  }
  return null;
}
function wordCaptions(t) {
  const { y, size, maxW, oneLine } = L.cap;
  for (const g of TL.captions) {
    if (t < g.a || t > g.b) continue;
    const Lc = capFit(g, size, maxW, size * 0.88, true) || capFit(g, size, maxW, oneLine ? size * 0.7 : 56, oneLine);
    if (!Lc) continue;
    const lh = Lc.size * 1.08, k = spring(t, g.a, CAP_POP);
    const alpha = clamp01(k * 2.5) * (1 - smooth(seg(t, g.b - 0.1, g.b)));
    if (alpha <= 0.001) continue;
    const y0 = y - ((Lc.rows - 1) * lh) / 2, base = (r) => y0 + r * lh + Lc.size * 0.34;
    ctx.save(); ctx.globalAlpha *= alpha;
    const sc = lerp(0.9, 1, k);
    ctx.translate(CX, y); ctx.scale(sc, sc); ctx.translate(-CX, -y);
    let ai = -1;
    g.tokens.forEach((w, i) => { if (t >= w.a - 0.04) ai = i; });
    if (ai >= 0) { // the highlight bar slides under the word being spoken
      const B = Lc.boxes, cur = B[ai], prev = B[Math.max(0, ai - 1)];
      const s = ai === 0 ? 1 : spring(t, g.tokens[ai].a - 0.04, CAP_SLIDE);
      const same = prev.row === cur.row;
      const x0 = same ? lerp(prev.x, cur.x, s) : cur.x, x1 = same ? lerp(prev.x + prev.w, cur.x + cur.w, s) : cur.x + cur.w;
      const grow = ai === 0 ? spring(t, g.tokens[0].a - 0.04, CAP_SLIDE) : 1;
      const uy = base(cur.row) + Lc.size * 0.12, xe = lerp(x0, x1, grow), bh = Math.max(6, Lc.size * 0.12);
      if (xe - x0 > 4) { ctx.fillStyle = ACC; rr(ctx, x0 - 4, uy, xe - x0 + 8, bh, bh / 2); ctx.fill(); }
    }
    ctx.font = `800 ${Lc.size}px ${DISPLAY}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round'; ctx.lineWidth = Lc.size * 0.16; ctx.strokeStyle = HALO;
    ctx.save(); ctx.globalAlpha *= 0.82;
    g.tokens.forEach((w, i) => ctx.strokeText(w.text, Lc.boxes[i].x, base(Lc.boxes[i].row)));
    ctx.restore();
    g.tokens.forEach((w, i) => {
      const b = Lc.boxes[i], lift = i === ai ? spring(t, w.a - 0.04, CAP_POP) : 0;
      ctx.save();
      const cx = b.x + b.w / 2, cy = base(b.row) - Lc.size * 0.35, ws = 1 + Math.min(0.05, (2 * CAP_LIFT_PX) / b.w) * lift;
      ctx.translate(cx, cy); ctx.scale(ws, ws); ctx.translate(-cx, -cy);
      ctx.fillStyle = INK; ctx.fillText(w.text, b.x, base(b.row));
      ctx.restore();
    });
    ctx.restore();
  }
}

// ---------- one frame ----------
const STATE = { captions: NV.captions !== false };
function presence(t) {
  const kin = spring(t, TL.T0 - 0.5, { w: 9, z: 1 }), kout = spring(t, TL.endStart, { w: 8, z: 1 });
  return { a: clamp01(kin * 1.6) * (1 - clamp01(kout * 1.3)), dy: 90 * (1 - kin) - 40 * kout, s: (0.94 + 0.06 * kin) * (1 - 0.05 * kout) };
}
async function seek(t) {
  const k = presence(t);
  if (k.a > 0.001) await paintContent(t);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(BG, 0, 0);
  drawWindow(k);
  if (NV.steps !== false) { if (SHAPE === 'landscape') stepRail(t, k.a); else stepChip(t, k.a); }
  titleCard(t);
  endCard(t);
  if (STATE.captions) wordCaptions(t);
}
window.seek = seek;
window.STUDIO = { STATE, BG, L, W, H, MO };
window.ready = (async () => {
  if (LOGO) await new Promise((res, rej) => { LOGO.onload = res; LOGO.onerror = () => rej(new Error('could not load the theme logo')); LOGO.src = TH.logoUrl; });
  for (const f of TH.fontFaces || []) { const ff = new FontFace(f.family, `url(${f.url})`, { weight: '100 1000' }); document.fonts.add(await ff.load()); }
  await document.fonts.ready;
  await Promise.all([`800 60px ${DISPLAY}`, `700 40px ${UI}`, `600 40px ${UI}`, `500 40px ${UI}`].map((f) => document.fonts.load(f, 'AaBb0123./')));
  paintBackdrop();
  await seek(0);
  return true;
})();

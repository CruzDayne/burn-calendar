/* Globe: canvas orthographic globe that plays the harmonized record as a monthly time-lapse.
   Needs d3-array + d3-geo + topojson-client + vendor/land.js. Talks to app.js through callbacks only. */
window.Globe = (() => {
  const PAL = ['#7a2a14', '#b0301a', '#d4551a', '#e5a03a', '#f3d98a', '#fff6dc'];   // night-side ramp: brighter = more hotspots
  const hexRGB = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const LUT = Array.from({ length: 64 }, (_, i) => {
    const t = i / 63, x = t * (PAL.length - 1), k = Math.min(PAL.length - 2, Math.floor(x)), f = x - k;
    const a = hexRGB(PAL[k]), b = hexRGB(PAL[k + 1]);
    return 'rgb(' + a.map((v, j) => Math.round(v + (b[j] - v) * f)).join(',') + ')';
  });
  const RAD = Math.PI / 180;
  let cv, ctx, off, octx, W = 0, dpr = 1, proj, path, pathOff, R0 = 300, R = 300, rot = [100, -30];
  let cells = [], NM = 0, regions = [], cap = 1, m = 0, playing = true, cb = {};
  let drag = null, fly = null, focused = -1, hover = -1, idleUntil = 0, visible = true, last = 0, lastM = -1, MPS = 12;
  let zt = 0, pts = new Map(), pinch = null;
  let ZMAX = 6000; const spin = () => R < R0 * 1.25;
  let land110, land50, grat, cacheKey = '', moving = true, reduced = false;
  const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const center = () => [-rot[0], -rot[1]];
  const vec = (lon, lat) => [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];

  function init(o) {
    cv = o.canvas; cells = o.cells; NM = o.NM; regions = o.regions; cb = o; reduced = !!o.reduced;
    m = o.startMonth || 0; playing = !reduced; ctx = cv.getContext('2d');
    off = document.createElement('canvas'); octx = off.getContext('2d');
    land110 = topojson.feature(window.__LAND110, window.__LAND110.objects.land);
    land50 = topojson.feature(window.__LAND50, window.__LAND50.objects.land);
    grat = d3.geoGraticule10();
    proj = d3.geoOrthographic().clipAngle(90).precision(0.6);
    path = d3.geoPath(proj, ctx); pathOff = d3.geoPath(proj, octx);
    cells.forEach((c) => { c.v3 = vec(c.lon, c.lat); });
    const sample = []; const stride = Math.max(1, Math.floor(cells.length * NM / 120000));
    let k = 0; cells.forEach((c) => { for (let i = 0; i < NM; i++) { if (++k % stride === 0) { const v = c.t.data[c.o + i]; if (v > 0) sample.push(v); } } });
    sample.sort((a, b) => a - b); cap = sample.length ? sample[Math.floor(sample.length * 0.995)] : 1;
    const r0 = regions[0]; if (r0) rot = [-(r0.bbox[1] + r0.bbox[3]) / 2 + 40, -(r0.bbox[0] + r0.bbox[2]) / 2 + 8];
    new ResizeObserver(resize).observe(cv.parentElement); resize();
    cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); pinch = null; drag = null; });
    cv.addEventListener('wheel', wheel, { passive: false });
    cv.addEventListener('pointerleave', () => { hover = -1; cv.style.cursor = 'grab'; cb.onHover && cb.onHover(-1); });
    new IntersectionObserver((e) => { visible = e[0].isIntersecting; if (visible) { last = 0; requestAnimationFrame(frame); } }).observe(cv);
    requestAnimationFrame(frame);
  }

  function resize() {
    const w = Math.round(cv.parentElement.clientWidth); if (!w) return;
    W = w; dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.style.width = W + 'px'; cv.style.height = W + 'px'; cv.width = cv.height = Math.round(W * dpr);
    off.width = off.height = cv.width;
    R0 = W * 0.46; ZMAX = R0 * 14; if (focused < 0) { R = R0; zt = 0; } cacheKey = '';
  }

  const pointToLL = (x, y) => { const p = proj.invert([x, y]); if (!p) return null; const c = center(); const a = vec(p[0], p[1]), b = vec(c[0], c[1]); return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) > 0.02 ? p : null; };
  function regionAt(x, y) {
    const p = pointToLL(x, y); if (!p) return -1;
    const mg = Math.max(0.4, 12 / (R * RAD));
    for (let i = 0; i < regions.length; i++) { const [S, Wd, N, E] = regions[i].bbox; if (p[1] >= S - mg && p[1] <= N + mg && p[0] >= Wd - mg && p[0] <= E + mg) return i; }
    return -1;
  }
  const xy = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  function zoomTo(r) { zt = Math.max(R0 * 0.55, Math.min(ZMAX, r)); fly = null; idleUntil = performance.now() + 6000; }
  function zoom(f) { zoomTo((zt || R) * f); }
  function down(e) {
    const [x, y] = xy(e); pts.set(e.pointerId, [x, y]); cv.setPointerCapture(e.pointerId); fly = null;
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, r0: R }; drag = null; return; }
    drag = { x, y, rot0: rot.slice(), moved: false }; cv.style.cursor = 'grabbing';
  }
  function move(e) {
    const [x, y] = xy(e);
    if (pts.has(e.pointerId)) pts.set(e.pointerId, [x, y]);
    if (pinch && pts.size >= 2) { const [a, b] = [...pts.values()]; zoomTo(pinch.r0 * (Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d0)); R = zt; return; }
    if (drag) {
      const dx = x - drag.x, dy = y - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) { const k = 1 / (R * RAD); rot = [drag.rot0[0] + dx * k, Math.max(-85, Math.min(85, drag.rot0[1] - dy * k))]; idleUntil = performance.now() + 6000; }
    } else {
      const h = regionAt(x, y); if (h !== hover) { hover = h; cv.style.cursor = h >= 0 ? 'pointer' : 'grab'; cb.onHover && cb.onHover(h, x, y); }
    }
  }
  function up(e) {
    pts.delete(e.pointerId); if (pinch) { if (pts.size < 2) pinch = null; drag = null; cv.style.cursor = 'grab'; return; }
    if (!drag) return; const moved = drag.moved; const [x, y] = xy(e); drag = null; cv.style.cursor = 'grab';
    if (!moved) { const h = regionAt(x, y); if (h >= 0) cb.onPick && cb.onPick(h); }
  }
  function wheel(e) { e.preventDefault(); const dy = e.deltaY * (e.deltaMode === 1 ? 16 : 1); zoom(Math.exp(-dy * (e.ctrlKey ? 0.008 : 0.001))); }

  function focus(i, instant) {
    if (!regions[i]) return; const [S, Wd, N, E] = regions[i].bbox;
    const span = Math.max(N - S, (E - Wd) * Math.cos(((S + N) / 2) * RAD)) * 1.35;
    const toR = Math.min(9000, Math.max(R0, 0.62 * W / (span * RAD)));
    startFly([-(Wd + E) / 2, -(S + N) / 2], toR, instant); focused = i;
  }
  function unfocus() { focused = -1; startFly(rot.slice(), R0); }
  function startFly(toRot, toR, instant) {
    let dl = toRot[0] - rot[0]; dl = ((dl + 540) % 360) - 180; toRot = [rot[0] + dl, toRot[1]];
    zt = 0;
    if (instant || reduced) { rot = toRot; R = toR; fly = null; return; }
    fly = { t0: performance.now(), dur: 1500, r0: rot.slice(), r1: toRot, s0: R, s1: toR };
  }

  function drawBase(c2, p2, useFine) {
    c2.beginPath(); p2({ type: 'Sphere' }); c2.fillStyle = '#15120e'; c2.fill();
    c2.beginPath(); p2(grat); c2.strokeStyle = 'rgba(239,232,216,.07)'; c2.lineWidth = .6; c2.stroke();
    c2.beginPath(); p2(useFine ? land50 : land110); c2.fillStyle = '#2b261f'; c2.fill(); c2.strokeStyle = 'rgba(239,232,216,.3)'; c2.lineWidth = useFine ? .7 : .5; c2.stroke();
  }

  function frame(t) {
    if (!visible) return; requestAnimationFrame(frame);
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0; last = t;
    if (fly) { const p = Math.min(1, (t - fly.t0) / fly.dur), e = ease(p); rot = [fly.r0[0] + (fly.r1[0] - fly.r0[0]) * e, fly.r0[1] + (fly.r1[1] - fly.r0[1]) * e]; R = Math.exp(Math.log(fly.s0) + (Math.log(fly.s1) - Math.log(fly.s0)) * e); if (p >= 1) { fly = null; } }
    else if (zt && Math.abs(Math.log(zt / R)) > 0.0008) { R *= Math.pow(zt / R, Math.min(1, dt * 10)); }
    if (!fly && !drag && !pinch && spin() && !reduced && t > idleUntil) rot = [rot[0] - 4 * dt, rot[1]];
    if (playing) { m = (m + MPS * dt) % NM; }
    const mi = Math.floor(m); if (mi !== lastM) { lastM = mi; cb.onMonth && cb.onMonth(mi); }
    moving = !!(fly || drag || pinch || (zt && Math.abs(Math.log(zt / R)) > 0.0008) || (spin() && !reduced && t > idleUntil));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, W);
    proj.rotate(rot).scale(R).translate([W / 2, W / 2]);
    const key = rot[0].toFixed(3) + rot[1].toFixed(3) + R.toFixed(1) + W;
    if (moving) { drawBase(ctx, path, false); cacheKey = ''; }
    else {
      if (key !== cacheKey) { octx.setTransform(dpr, 0, 0, dpr, 0, 0); octx.clearRect(0, 0, W, W); drawBase(octx, pathOff, true); cacheKey = key; }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(off, 0, 0); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    // fires
    const c = center(), cv3 = vec(c[0], c[1]);
    const px = Math.max(1.8, R * 0.25 * RAD * 1.2);
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i], v3 = cell.v3;
      if (v3[0] * cv3[0] + v3[1] * cv3[1] + v3[2] * cv3[2] < 0.04) continue;
      const v = cell.t.data[cell.o + mi]; if (v < 0.05) continue;
      const tt = Math.min(1, Math.sqrt(v / cap)), p = proj([cell.lon, cell.lat]); if (!p) continue;
      const s = px * (0.75 + 0.6 * tt);
      ctx.fillStyle = LUT[Math.round(tt * 63)]; ctx.fillRect(p[0] - s / 2, p[1] - s / 2, s, s);
    }
    // region boxes + names
    ctx.font = '600 10.5px "IBM Plex Mono", ui-monospace, monospace'; ctx.textBaseline = 'bottom';
    regions.forEach((r, i) => {
      const [S, Wd, N, E] = r.bbox, on = i === hover || i === focused;
      ctx.beginPath(); path({ type: 'LineString', coordinates: [[Wd, S], [E, S], [E, N], [Wd, N], [Wd, S]] });
      ctx.strokeStyle = on ? '#d9972b' : 'rgba(239,232,216,.8)'; ctx.lineWidth = on ? 2.2 : 1.2; ctx.setLineDash(on ? [] : [5, 3]); ctx.stroke(); ctx.setLineDash([]);
      const rv = vec((Wd + E) / 2, N), d = rv[0] * cv3[0] + rv[1] * cv3[1] + rv[2] * cv3[2];
      if (d > 0.25) { const p = proj([(Wd + E) / 2, N]); if (p) { const label = r.name.toUpperCase(), w = ctx.measureText(label).width + 10; ctx.fillStyle = on ? '#d9972b' : '#efe8d8'; ctx.fillRect(p[0] - w / 2, p[1] - 19, w, 16); ctx.fillStyle = '#15120e'; ctx.textAlign = 'center'; ctx.fillText(label, p[0], p[1] - 5); } }
    });
  }

  return {
    init, focus, unfocus, zoom,
    reset() { focused = -1; zt = 0; startFly(rot.slice(), R0); },
    setMonth(v) { m = v; lastM = -1; },
    play(on) { playing = on; }, get playing() { return playing; },
    get month() { return Math.floor(m); },
  };
})();

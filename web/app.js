/* Burn Calendar — static web app. Reads data/meta.json + data/tiles/*.bin produced by pipeline/harmonize.py */
(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MFULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const ymOf = (i) => { const t = i + 10; return [2000 + Math.floor(t / 12), t % 12 + 1]; };
const idxOf = (y, m) => (y - 2000) * 12 + (m - 1) - 10;
const dim = (y, m) => new Date(y, m, 0).getDate();
const mkey = (i) => { const [y, m] = ymOf(i); return `${y}-${String(m).padStart(2, '0')}`; };
const keyIdx = (s) => { const [y, m] = s.split('-').map(Number); return idxOf(y, m); };
const ord = (n) => { n = Math.round(n); const v = n % 100, t = ['th', 'st', 'nd', 'rd']; return n + (t[(v - 20) % 10] || t[v] || t[0]); };
function fmt(n) {
  if (!isFinite(n)) return '–';
  const a = Math.abs(n);
  return a >= 10 ? Math.round(n).toLocaleString('en-US') : (Math.round(n * 10) / 10).toString();
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- tokens (mirror style.css) ---------- */
const C = { paper: '#efe8d8', paper2: '#e6dec9', paper3: '#d6cdb3', ink: '#15120e', ink2: '#4b453a', ink3: '#6f6859', fire: '#b8321a', ember: '#d9972b', cold: '#2b6a94', band: '#cdbf9c' };
// sequential: newsprint -> straw -> amber -> vermilion -> oxblood -> near-black. Lightness falls steadily with count.
const SEQ = ['#f3ecdc', '#ecd9a8', '#e5b457', '#dc8a2f', '#cf5a22', '#b0301a', '#7a1d12', '#3d0f0b'];
const DIV = { lo: C.cold, mid: '#e9e2d0', hi: C.fire };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => { const A = hex(a), B = hex(b); return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
function ramp(stops, t) { t = Math.max(0, Math.min(1, t)); const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)); return mix(stops[i], stops[i + 1], x - i); }
const seq = (t) => ramp(SEQ, t);
function div(t) { t = Math.max(-1, Math.min(1, t)); return t < 0 ? mix(DIV.mid, DIV.lo, -t) : mix(DIV.mid, DIV.hi, t); }

/* ---------- stats helpers ---------- */
const quant = (s, q) => { if (!s.length) return NaN; const p = (s.length - 1) * q, i = Math.floor(p); return s[i] + (s[Math.min(s.length - 1, i + 1)] - s[i]) * (p - i); };
const pctRank = (s, v) => { if (!s.length) return null; let lt = 0, eq = 0; for (const x of s) { if (x < v) lt++; else if (x === v) eq++; } return (lt + eq / 2) / s.length * 100; };
const lower = (s, v) => { let lo = 0, hi = s.length; while (lo < hi) { const m = (lo + hi) >> 1; if (s[m] < v) lo = m + 1; else hi = m; } return lo; };

function makeScale(kind, vals) {
  const pos = vals.filter((v) => v > 0).sort((a, b) => a - b);
  if (!pos.length) return { f: () => 0, inv: () => 0, max: 0 };
  const cap = pos[Math.min(pos.length - 1, Math.floor(pos.length * 0.99))];
  if (kind === 'linear') return { f: (v) => Math.min(1, v / cap), inv: (t) => t * cap, max: cap };
  if (kind === 'quantile') return { f: (v) => v <= 0 ? 0 : (lower(pos, v) + 1) / pos.length, inv: (t) => pos[Math.max(0, Math.min(pos.length - 1, Math.round(t * pos.length) - 1))], max: pos[pos.length - 1] };
  return { f: (v) => Math.min(1, Math.sqrt(Math.max(0, v) / cap)), inv: (t) => t * t * cap, max: cap };
}

/* ---------- state ---------- */
let META, NM, RES, TC;
const tileCache = new Map();
const st = { bbox: null, preset: 0, from: 0, to: 0, metric: 'count', scale: 'sqrt', vals: false, baseFrom: 2001, baseTo: 2025, sel: null, focusYear: null, hover: null, more: false };
let AOI = null, map, cellLayer, aoiRect, drawing = false;

const isPartial = (i) => META.partial_last_month && i === NM - 1;
const fracOf = (i) => { if (!isPartial(i)) return 1; const [y, m] = ymOf(i); return META.days_covered / dim(y, m); };
const sourceOf = (i) => i >= META.viirs_start_idx ? 'VIIRS observed' : 'MODIS, calibrated to VIIRS';
const areaName = () => st.preset != null ? META.regions[st.preset].name : 'Selected area';

/* ---------- data loading ---------- */
async function gunzip(buf) {
  const u = new Uint8Array(buf);
  if (u[0] === 0x1f && u[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    return await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
  }
  return buf;
}
const b64 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
function getTile(key) {
  if (tileCache.has(key)) return tileCache.get(key);
  const p = (async () => {
    if (!META.tiles[key]) return null;
    let buf = window.__EMBED && window.__EMBED.tiles[key] ? b64(window.__EMBED.tiles[key])
      : await (await fetch(`data/tiles/${key}.bin`)).arrayBuffer();
    buf = await gunzip(buf);
    const n = new DataView(buf).getUint32(0, true);
    const idx = new Uint16Array(buf, 4, n);
    const off = (4 + 2 * n + 3) & ~3;
    return { n, idx, data: new Float32Array(buf, off, n * NM) };
  })();
  tileCache.set(key, p);
  return p;
}

async function computeAOI(bbox) {
  const [S, W, N, E] = bbox;
  const r0 = Math.floor((S + 90) / RES / TC), r1 = Math.floor((N + 90 - 1e-9) / RES / TC);
  const c0 = Math.floor((W + 180) / RES / TC), c1 = Math.floor((E + 180 - 1e-9) / RES / TC);
  const keys = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) keys.push([r, c]);
  if (keys.length > 120) throw new Error('Area too large: pick a smaller box (max about 120 tiles of 5°).');
  const series = new Float64Array(NM), cells = [], qual = [];
  const tiles = await Promise.all(keys.map(([r, c]) => getTile(`${r}_${c}`)));
  tiles.forEach((t, k) => {
    if (!t) return;
    const [tr, tc] = keys[k]; let used = 0;
    for (let i = 0; i < t.n; i++) {
      const loc = t.idx[i], row = tr * TC + Math.floor(loc / TC), col = tc * TC + (loc % TC);
      const lat = -90 + (row + 0.5) * RES, lon = -180 + (col + 0.5) * RES;
      if (lat < S || lat > N || lon < W || lon > E) continue;
      const o = i * NM; used++;
      for (let m = 0; m < NM; m++) series[m] += t.data[o + m];
      cells.push({ lat, lon, t, o });
    }
    if (used) qual.push({ w: used, q: META.tiles[`${tr}_${tc}`].q });
  });
  const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  let cov = 0;
  for (const rg of META.regions) {
    const b = rg.bbox, I = [Math.max(S, b[0]), Math.max(W, b[1]), Math.min(N, b[2]), Math.min(E, b[3])];
    cov += area(I);
  }
  return { series, cells, qual, coverage: Math.min(1, cov / Math.max(1e-9, area(bbox))) };
}

/* ---------- baseline ---------- */
function baseList(c) {
  const out = [];
  for (let y = st.baseFrom; y <= st.baseTo; y++) { const i = idxOf(y, c + 1); if (i >= 0 && i < NM && !isPartial(i)) out.push({ y, v: AOI.series[i] }); }
  return out;
}
const baseVals = (c, exY) => baseList(c).filter((o) => o.y !== exY).map((o) => o.v).sort((a, b) => a - b);
function metricsFor(m) {
  const [y, mo] = ymOf(m), f = fracOf(m), v = AOI.series[m];
  const arr = baseVals(mo - 1, y).map((x) => x * f);
  const med = quant(arr, 0.5);
  return { v, med, ratio: (v + 1) / ((isFinite(med) ? med : 0) + 1), pct: pctRank(arr, v), n: arr.length, partial: isPartial(m), f, y, mo };
}
const yearComplete = (y) => { const a = idxOf(y, 1), b = idxOf(y, 12); return a >= st.from && b <= st.to && b < NM; };

/* ---------- readout bar (replaces floating tooltips) ---------- */
function readoutHTML(m) {
  const k = metricsFor(m), [y, mo] = ymOf(m);
  let s = `<b>${MN[mo - 1].toUpperCase()} ${y}</b> &nbsp;${sourceOf(m)} &nbsp;·&nbsp; ${fmt(k.v)} hotspots${k.partial ? ` so far (${META.days_covered} of ${dim(y, mo)} days)` : ''}`;
  if (k.n >= 3) {
    const ch = (k.ratio - 1) * 100;
    s += ` &nbsp;·&nbsp; <b>${ch >= 0 ? '+' : ''}${Math.round(ch)}%</b> vs. ${k.partial ? 'pro-rated ' : ''}normal ${fmt(k.med)} &nbsp;·&nbsp; above ${Math.round(k.pct)}% of ${k.n} ${MFULL[mo - 1]}s`;
  }
  return s;
}
function setReadout() {
  const m = st.hover != null ? st.hover : st.sel;
  const ro = $('#readout'); ro.classList.toggle('idle', m == null);
  ro.innerHTML = m == null ? 'Hover or tap a month for its numbers' : readoutHTML(m);
  document.querySelectorAll('#calendar .ax.hot').forEach((e) => e.classList.remove('hot'));
  if (st.hover != null) {
    const [y, mo] = ymOf(st.hover);
    document.querySelectorAll(`#calendar .ax[data-year="${y}"], #calendar .ax[data-mo="${mo}"]`).forEach((e) => e.classList.add('hot'));
  }
}

/* ---------- calendar ---------- */
function calendar() {
  const [fy] = ymOf(st.from), [ty] = ymOf(st.to);
  const years = []; for (let y = fy; y <= ty; y++) years.push(y);
  const more = st.more, W = 780, L = 56, R = more ? 140 : 14, top = 24, rh = more ? 17 : 19, gap = 2, cw = (W - L - R) / 12;
  const medRow = st.metric === 'count' && more;
  const H = top + years.length * rh + (medRow ? rh + 10 : 0) + 6;
  const vals = []; for (let m = st.from; m <= st.to; m++) vals.push(AOI.series[m]);
  const medians = [...Array(12).keys()].map((c) => quant(baseVals(c, -1), 0.5));
  if (medRow) medians.forEach((x) => isFinite(x) && vals.push(x));
  const sc = makeScale(st.scale, vals);
  const colorFor = (m) => {
    if (st.metric === 'count') return seq(sc.f(AOI.series[m]));
    const k = metricsFor(m);
    if (st.metric === 'anomaly') return k.n < 3 ? null : div(Math.log2(k.ratio) / 2);
    return k.pct == null ? null : div((k.pct - 50) / 50);
  };
  const yt = {}; let maxT = 0;
  years.forEach((y) => { let s = 0; for (let mo = 1; mo <= 12; mo++) { const i = idxOf(y, mo); if (i >= st.from && i <= st.to && i < NM) s += AOI.series[i]; } yt[y] = s; maxT = Math.max(maxT, s); });
  const faint = 'rgba(21,18,14,.14)';
  let g = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Calendar of monthly hotspot activity: one row per year, one column per month"><defs><pattern id="nod" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="${C.ink3}" stroke-width="1" opacity=".5"/></pattern></defs>`;
  MN.forEach((n, c) => { g += `<text class="ax" data-mo="${c + 1}" x="${L + c * cw + cw / 2}" y="${top - 9}" text-anchor="middle">${n.toUpperCase()}</text>`; });
  if (more) g += `<text class="mut" x="${W - R + 12}" y="${top - 9}">TOTAL</text>`;
  years.forEach((y, r) => {
    const yy = top + r * rh;
    g += `<text class="ax yl" data-year="${y}" x="${L - 8}" y="${yy + rh / 2 + 3.5}" text-anchor="end">${y}</text>`;
    for (let mo = 1; mo <= 12; mo++) {
      const m = idxOf(y, mo), x = L + (mo - 1) * cw;
      const inRange = m >= st.from && m <= st.to;
      if (m < 0 || m >= NM || !inRange) { g += `<rect x="${x + 1}" y="${yy + 1}" width="${cw - gap}" height="${rh - gap}" fill="url(#nod)"/>`; continue; }
      const col = colorFor(m);
      const sel = st.sel === m ? ' sel' : '';
      g += `<rect class="cell${sel}" data-m="${m}" x="${x + 1}" y="${yy + 1}" width="${cw - gap}" height="${rh - gap}" fill="${col || C.paper3}" stroke="${faint}" stroke-width="1"${isPartial(m) ? ` stroke="${C.ink}" stroke-dasharray="3 2"` : ''}/>`;
      if (st.vals && st.metric === 'count') {
        const v = AOI.series[m], t = sc.f(v);
        g += `<text x="${x + cw / 2}" y="${yy + rh / 2 + 3}" text-anchor="middle" font-size="8.5" pointer-events="none" style="fill:${t > 0.5 ? C.paper : C.ink}">${fmt(v)}</text>`;
      }
    }
    if (more) { const barMax = R - 62, w = maxT ? Math.max(0, yt[y] / maxT * barMax) : 0;
    g += `<rect x="${W - R + 12}" y="${yy + 4}" width="${w}" height="${rh - 8}" fill="${C.ink}"/>`;
    g += `<text class="mut" x="${W - R + 12 + w + 5}" y="${yy + rh / 2 + 3.5}" font-size="9.5">${fmt(yt[y])}</text>`; }
  });
  if (medRow) {
    const yy = top + years.length * rh + 10;
    g += `<line x1="${L}" x2="${L + 12 * cw}" y1="${yy - 5}" y2="${yy - 5}" stroke="${C.ink}"/><text class="big" x="${L - 8}" y="${yy + rh / 2 + 3.5}" text-anchor="end" font-weight="600">NORMAL</text>`;
    medians.forEach((x, c) => { g += `<rect x="${L + c * cw + 1}" y="${yy + 1}" width="${cw - gap}" height="${rh - gap}" fill="${isFinite(x) ? seq(sc.f(x)) : C.paper3}" stroke="${faint}"><title>Normal ${MN[c]}: ${fmt(x)}</title></rect>`; });
  }
  const vs = META.viirs_start_idx, [vy, vm] = ymOf(vs);
  if (more && vy >= fy && vy <= ty && vs > st.from && vs <= st.to) {
    const r = vy - fy, yT = top + r * rh, yB = yT + rh, xv = L + (vm - 1) * cw;
    g += `<path d="M${L} ${yB} H${xv} V${yT} H${L + 12 * cw}" fill="none" stroke="${C.ink}" stroke-width="2.2" stroke-dasharray="6 3"/>`;
  }
  g += '</svg>';
  $('#calendar').innerHTML = g;
  $('#calSub').textContent = st.metric === 'count' ? 'hotspots per month · VIIRS-375 m equivalent' : st.metric === 'anomaly' ? 'each month against the normal for that calendar month' : 'where each month ranks among the same month in other years';
  legend(sc); tableView(years);
}

function legend(sc) {
  const W = 780, x0 = 56, w = 330, y0 = 4, h = 12, n = 48;
  let g = `<svg viewBox="0 0 ${W} 54" role="img" aria-label="Colour key">`;
  for (let i = 0; i < n; i++) { const t = i / (n - 1); g += `<rect x="${x0 + (w / n) * i}" y="${y0}" width="${w / n + .6}" height="${h}" fill="${st.metric === 'count' ? seq(t) : div(t * 2 - 1)}"/>`; }
  g += `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="none" stroke="${C.ink}"/>`;
  let ticks;
  if (st.metric === 'count') ticks = [0, .25, .5, .75, 1].map((t) => [t, (t === 0 ? '0' : fmt(sc.inv(t))) + (t === 1 && st.scale !== 'quantile' ? '+' : '')]);
  else if (st.metric === 'anomaly') ticks = [[0, '¼× or less'], [.25, '½×'], [.5, 'normal'], [.75, '2×'], [1, '4× or more']];
  else ticks = [[0, '0th'], [.25, '25th'], [.5, '50th'], [.75, '75th'], [1, '100th']];
  ticks.forEach(([t, s], i) => { g += `<line x1="${x0 + w * t}" x2="${x0 + w * t}" y1="${y0 + h}" y2="${y0 + h + 5}" stroke="${C.ink}"/><text x="${x0 + w * t}" y="${y0 + h + 17}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}" font-size="10">${s}</text>`; });
  const k1 = st.metric === 'count' ? (st.scale === 'sqrt' ? 'Square-root scale, top 1% clipped.' : st.scale === 'quantile' ? 'Colour = rank among months.' : 'Linear scale, top 1% clipped.') : 'The month’s own year is left out of its normal.';
  if (st.more) {
    g += `<text class="mut" x="${x0 + w + 24}" y="${y0 + 9}" font-size="10">${k1}</text>`;
    g += `<text class="mut" x="${x0 + w + 24}" y="${y0 + 23}" font-size="10">Heavy dashed line = MODIS above, VIIRS below.</text>`;
    g += `<text class="mut" x="${x0 + w + 24}" y="${y0 + 37}" font-size="10">Thin dashed = month in progress. Hatched = outside period.</text>`;
  }
  g += '</svg>';
  $('#legend').innerHTML = g;
}

function tableView(years) {
  let h = '<div class="tw"><table class="nums"><thead><tr><th>Year</th>' + MN.map((m) => `<th>${m}</th>`).join('') + '<th>Total</th></tr></thead><tbody>';
  years.forEach((y) => { let s = 0; h += `<tr><td>${y}</td>`; for (let mo = 1; mo <= 12; mo++) { const i = idxOf(y, mo); if (i >= st.from && i <= st.to && i < NM) { s += AOI.series[i]; h += `<td>${fmt(AOI.series[i])}</td>`; } else h += '<td></td>'; } h += `<td>${fmt(s)}</td></tr>`; });
  $('#tableView').innerHTML = h + '</tbody></table></div>';
}

/* ---------- masthead: barcode, figures, auto-written reading ---------- */
function summary() {
  const meds = [...Array(12).keys()].map((c) => quant(baseVals(c, -1), 0.5));
  let pk = 0; meds.forEach((x, c) => { if (isFinite(x) && x > (meds[pk] || 0)) pk = c; });
  let total = 0, bestM = -1, [fy] = ymOf(st.from), [ty] = ymOf(st.to), bestY = null, bestYv = -1;
  for (let m = st.from; m <= st.to; m++) { total += AOI.series[m]; if (!isPartial(m) && (bestM < 0 || AOI.series[m] > AOI.series[bestM])) bestM = m; }
  for (let y = fy; y <= ty; y++) if (yearComplete(y)) { let s = 0; for (let mo = 1; mo <= 12; mo++) s += AOI.series[idxOf(y, mo)]; if (s > bestYv) { bestYv = s; bestY = y; } }
  return { meds, pk, total, bestM, bestY, bestYv };
}

function masthead() {
  const S = summary();
  $('#facts').innerHTML = [['Fire season peaks in', isFinite(S.meds[S.pk]) ? MFULL[S.pk] : '–'], ['Heaviest full year', S.bestY ?? '–'], ['Heaviest month', S.bestM >= 0 ? MN[ymOf(S.bestM)[1] - 1] + ' ' + ymOf(S.bestM)[0] : '–'], ['Hotspots in range', fmt(S.total)]].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  const m = NM - 1, k = metricsFor(m), [y, mo] = ymOf(m);
  let line1;
  if (k.n >= 3) {
    const ch = (k.ratio - 1) * 100, rel = ch >= 25 ? 'running well above' : ch <= -20 ? 'running below' : 'tracking close to';
    line1 = `${MFULL[mo - 1]} ${y}${k.partial ? ` (${META.days_covered} days in)` : ''} is ${rel} normal: <b>${ch >= 0 ? '+' : ''}${Math.round(ch)}%</b>, ${ord(k.pct)} percentile of the ${k.n} ${MFULL[mo - 1]}s on record.`;
  } else line1 = 'Not enough baseline years to say how the latest month compares.';
  $('#reading').innerHTML = `<span class="who">Reading for ${esc(areaName())}</span>${line1}`;
}

/* ---------- selected month (right rail) ---------- */
function nowCard() {
  const m = st.sel != null ? st.sel : NM - 1, k = metricsFor(m), [y, mo] = ymOf(m);
  let verdict = '', rtxt = '–';
  if (k.n >= 3) {
    const ch = (k.ratio - 1) * 100; rtxt = (ch >= 0 ? '+' : '') + Math.round(ch) + '%';
    verdict = k.ratio > 1.25 ? '<span class="verdict hi">Above normal</span>' : k.ratio < 0.8 ? '<span class="verdict lo">Below normal</span>' : '<span class="verdict">Near normal</span>';
  }
  const arr = baseVals(mo - 1, y).map((x) => x * k.f);
  const W = 320, hgt = 58, L = 6, Rr = 6, max = Math.max(...arr, k.v, 1), X = (v) => L + (v / max) * (W - L - Rr);
  let s = `<svg viewBox="0 0 ${W} ${hgt}" role="img" aria-label="Strip plot of this month against the same month in other years"><line x1="${L}" x2="${W - Rr}" y1="34" y2="34" stroke="${C.ink}"/>`;
  arr.forEach((v, i) => { s += `<circle cx="${X(v)}" cy="${34 + (i % 2 ? 6 : -6)}" r="3.5" fill="${C.ink3}" opacity=".6"/>`; });
  if (isFinite(k.med)) s += `<line x1="${X(k.med)}" x2="${X(k.med)}" y1="16" y2="52" stroke="${C.ink}" stroke-width="2.5"/><text class="big" x="${Math.min(W - 40, Math.max(40, X(k.med)))}" y="11" text-anchor="middle" font-size="9.5">NORMAL ${fmt(k.med)}</text>`;
  s += `<rect x="${X(k.v) - 7}" y="27" width="14" height="14" fill="${C.fire}" stroke="${C.ink}" stroke-width="1.5"/></svg>`;
  $('#nowCard').innerHTML = `<div class="when">${MFULL[mo - 1]} ${y}${m === NM - 1 ? ' · latest' : ' · picked'}</div>
  <div class="num">${fmt(k.v)}</div><div class="unit">hotspots${k.partial ? ` so far, ${META.days_covered} of ${dim(y, mo)} days` : ''}</div>
  <dl><dt>${k.partial ? 'Pro-rated normal' : 'Normal'} for ${MFULL[mo - 1]}</dt><dd>${isFinite(k.med) ? fmt(k.med) : '–'}</dd>
  <dt>Against normal</dt><dd>${rtxt}</dd><dt>Percentile</dt><dd>${k.pct == null ? '–' : ord(k.pct) + ' of ' + k.n + ' yrs'}</dd><dt>Source</dt><dd>${m >= META.viirs_start_idx ? 'VIIRS' : 'MODIS, calibrated'}</dd></dl>
  ${verdict}<div style="margin-top:12px">${s}</div>
  <p class="hint">Each dot is the same calendar month in another year. Click a calendar cell to look at a different month; click it again to go back to the latest.</p>`;
}

/* ---------- season + ledger ---------- */
function season() {
  const W = 780, H = 250, L = 52, R = 14, T = 32, B = 26, pw = W - L - R, ph = H - T - B;
  const cols = [...Array(12).keys()].map((c) => baseVals(c, -1));
  const stat = cols.map((a) => ({ min: a[0], q1: quant(a, .25), med: quant(a, .5), q3: quant(a, .75), max: a[a.length - 1] }));
  const fy = st.focusYear, focus = [...Array(12).keys()].map((c) => { const i = idxOf(fy, c + 1); return i >= 0 && i < NM ? AOI.series[i] : null; });
  const maxY = Math.max(1, ...stat.map((s) => s.max || 0), ...focus.map((v) => v || 0));
  const nice = (() => { const e = Math.pow(10, Math.floor(Math.log10(maxY))), f = maxY / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; })();
  const X = (c) => L + (c + .5) * pw / 12, Y = (v) => T + ph - (v / nice) * ph;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Normal monthly hotspot counts with interquartile range and extremes, and one highlighted year">`;
  for (let i = 0; i <= 4; i++) { const v = nice * i / 4; s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${i ? 'rgba(21,18,14,.16)' : C.ink}"/><text x="${L - 8}" y="${Y(v) + 3.5}" text-anchor="end" font-size="10">${fmt(v)}</text>`; }
  const poly = (f, g) => stat.map((o, c) => `${X(c)},${Y(f(o))}`).join(' ') + ' ' + stat.map((o, c) => `${X(11 - c)},${Y(g(stat[11 - c]))}`).join(' ');
  s += `<polygon points="${poly((o) => o.max, (o) => o.min)}" fill="${C.paper3}"/>`;
  s += `<polygon points="${poly((o) => o.q3, (o) => o.q1)}" fill="${C.band}"/>`;
  s += `<polyline fill="none" stroke="${C.ink}" stroke-width="2" points="${stat.map((o, c) => `${X(c)},${Y(o.med)}`).join(' ')}"/>`;
  const pts = focus.map((v, c) => v == null ? null : [X(c), Y(v)]);
  let path = ''; pts.forEach((p, i) => { if (p) path += (i && pts[i - 1] ? 'L' : 'M') + p[0] + ' ' + p[1]; });
  s += `<path d="${path}" fill="none" stroke="${C.fire}" stroke-width="3" stroke-linejoin="miter"/>`;
  pts.forEach((p) => { if (p) s += `<rect x="${p[0] - 4.5}" y="${p[1] - 4.5}" width="9" height="9" fill="${C.fire}" stroke="${C.paper}" stroke-width="1.5"/>`; });
  MN.forEach((n, c) => { s += `<text x="${X(c)}" y="${H - 8}" text-anchor="middle" font-size="10">${n.toUpperCase()}</text>`; s += `<rect class="sh" data-c="${c}" x="${X(c) - pw / 24}" y="${T}" width="${pw / 12}" height="${ph}" fill="transparent"/>`; });
  const lg = [[C.fire, `${fy}`, 'line'], [C.ink, 'Median', 'line'], [C.band, 'Middle half of years', 'box'], [C.paper3, 'Lowest to highest', 'box']];
  let lx = L; lg.forEach(([c, t, k]) => { s += k === 'line' ? `<line x1="${lx}" x2="${lx + 18}" y1="14" y2="14" stroke="${c}" stroke-width="3"/>` : `<rect x="${lx}" y="8" width="18" height="12" fill="${c}" stroke="${C.ink}" stroke-width=".6"/>`; s += `<text class="big" x="${lx + 24}" y="18" font-size="10.5">${t}</text>`; lx += 40 + t.length * 6.4; });
  $('#season').innerHTML = s + '</svg>';
  $('#season').onmousemove = (e) => {
    const r = e.target.closest('.sh'); if (!r) return;
    const c = +r.dataset.c, o = stat[c], v = focus[c];
    $('#readout').innerHTML = `<b>${MFULL[c].toUpperCase()}</b> &nbsp;${fy}: ${v == null ? 'no data' : fmt(v)} &nbsp;·&nbsp; median ${fmt(o.med)} &nbsp;·&nbsp; middle half ${fmt(o.q1)}–${fmt(o.q3)} &nbsp;·&nbsp; range ${fmt(o.min)}–${fmt(o.max)}`;
  };
  $('#season').onmouseleave = setReadout;
}

function ledger() {
  const rows = [];
  for (let m = st.from; m <= st.to; m++) if (!isPartial(m)) rows.push([m, AOI.series[m]]);
  rows.sort((a, b) => b[1] - a[1]);
  const top = rows.slice(0, 10), max = top.length ? top[0][1] : 1;
  let h = '<table class="ledgertab"><thead><tr><th></th><th>Month</th><th></th><th style="text-align:right">Hotspots</th><th style="text-align:right">× normal</th><th>Src</th></tr></thead><tbody>';
  top.forEach(([m, v], i) => {
    const k = metricsFor(m), [y, mo] = ymOf(m);
    h += `<tr data-m="${m}" tabindex="0" class="${st.sel === m ? 'sel' : ''}"><td class="rk">${i + 1}</td><td>${MN[mo - 1]} ${y}</td><td style="width:34%"><span class="bar" style="width:${max ? v / max * 100 : 0}%"></span></td><td style="text-align:right">${fmt(v)}</td><td style="text-align:right">${k.med > 0 ? '×' + (v / k.med).toFixed(1) : '–'}</td><td class="src">${m >= META.viirs_start_idx ? 'V' : 'M'}</td></tr>`;
  });
  $('#ledger').innerHTML = h + '</tbody></table><p class="hint">V = VIIRS observed, M = MODIS calibrated. × normal is the month against the median of that calendar month in other years.</p>';
}

/* ---------- margin note ---------- */
function marginNote() {
  const agg = (mode) => {
    let w = 0, ra = 0, wp = 0;
    AOI.qual.forEach(({ q }) => { const o = q[mode]; if (!o || o.w <= 0) return; w += o.w; if (o.r_anom != null) ra += o.r_anom * o.w; if (o.wape != null) wp += o.wape * o.w; });
    return w ? { ra: ra / w, wp: wp / w } : null;
  };
  const a = agg('Terra+Aqua'), b = agg('Terra');
  const row = (name, o) => o ? `<div class="stat"><span>${name}</span><b>r ${o.ra.toFixed(2)}</b><b>miss ${Math.round(o.wp * 100)}%</b></div>` : '';
  $('#marginNote').innerHTML = a || b
    ? `<p>Before you lean on the early years: we hid each overlap year in turn, predicted its VIIRS counts from MODIS, and scored the miss. For the tiles in ${esc(areaName().toLowerCase())}:</p>${row('Terra + Aqua, 2002–2012', a)}${row('Terra alone, 2000–2002', b)}<p style="margin-top:8px"><b>r</b> is how well year-to-year swings are reproduced. <b>miss</b> is total error over total hotspots. Fires both sensors missed aren’t in either number.${META.dataset.synthetic ? ' On this sample data the scores only show the code works.' : ''}</p>`
    : '<p>No calibration scores for the tiles in this area.</p>';
}

/* ---------- map ---------- */
function initMap() {
  map = L.map('map', { zoomControl: true }).setView([20, 0], 2);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 12, attribution: '© OpenStreetMap contributors' }).addTo(map).on('tileerror', () => {});
  cellLayer = L.layerGroup().addTo(map);
  META.regions.forEach((r) => L.rectangle([[r.bbox[0], r.bbox[1]], [r.bbox[2], r.bbox[3]]], { color: C.ink3, weight: 1, dashArray: '2 4', fill: false, interactive: false }).addTo(map));
  let start = null, tmp = null;
  map.on('mousedown', (e) => { if (!drawing) return; start = e.latlng; tmp = L.rectangle([start, start], { color: C.fire, weight: 2 }).addTo(map); });
  map.on('mousemove', (e) => { if (drawing && start) tmp.setBounds([start, e.latlng]); });
  map.on('mouseup', (e) => {
    if (!drawing || !start) return;
    const b = L.latLngBounds(start, e.latlng); map.removeLayer(tmp); start = null; setDrawing(false);
    if (b.getNorth() - b.getSouth() < 0.25 || b.getEast() - b.getWest() < 0.25) return;
    setBbox([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((x) => Math.round(x * 100) / 100), true);
  });
}
function setDrawing(on) {
  if (!map) return;
  drawing = on; $('#drawBtn').classList.toggle('active', on);
  $('#drawBtn span').textContent = on ? 'Drag across the map… (click to cancel)' : 'Draw a box on the map';
  map.dragging[on ? 'disable' : 'enable'](); map.getContainer().style.cursor = on ? 'crosshair' : '';
}
function drawMap(fit) {
  if (!map) return;
  const [S, W, N, E] = st.bbox;
  if (aoiRect) map.removeLayer(aoiRect);
  aoiRect = L.rectangle([[S, W], [N, E]], { color: C.fire, weight: 2.5, fill: false, dashArray: '7 4' }).addTo(map);
  if (fit) map.fitBounds(aoiRect.getBounds(), { padding: [16, 16] });
  cellLayer.clearLayers();
  const month = st.sel;
  const vals = AOI.cells.map((c) => { if (month != null) return c.t.data[c.o + month]; let s = 0; for (let m = st.from; m <= st.to; m++) s += c.t.data[c.o + m]; return s; });
  const sc = makeScale('sqrt', vals), rend = L.canvas({ padding: 0.5 });
  AOI.cells.forEach((c, i) => {
    const v = vals[i]; if (v <= 0) return;
    L.rectangle([[c.lat - RES / 2, c.lon - RES / 2], [c.lat + RES / 2, c.lon + RES / 2]], { renderer: rend, stroke: false, fillColor: seq(0.15 + 0.85 * sc.f(v)), fillOpacity: 0.92 })
      .bindTooltip(() => `${fmt(v)} hotspots<br>${c.lat.toFixed(3)}°, ${c.lon.toFixed(3)}°`, { sticky: true }).addTo(cellLayer);
  });
  const label = month != null ? `${MN[ymOf(month)[1] - 1]} ${ymOf(month)[0]}` : `${mkey(st.from)} to ${mkey(st.to)}`;
  $('#mapTitle').textContent = 'Where it burned · ' + label;
  $('#mapReset').hidden = month == null;
  $('#mapLegend').innerHTML = `<span>0</span><span style="display:block;height:10px;width:150px;border:1px solid ${C.ink};background:linear-gradient(90deg,${[...Array(9).keys()].map((i) => seq(0.15 + 0.85 * i / 8)).join(',')})"></span><span>${fmt(sc.max)}${sc.max ? '+' : ''} per 0.25° cell</span>`;
}

/* ---------- area controls ---------- */
const latR = (S, N) => { const h = (v) => (v < 0 ? 'S' : 'N'); return (S < 0) === (N < 0) ? `${Math.abs(S)}–${Math.abs(N)}°${h(N)}` : `${Math.abs(S)}°${h(S)}–${Math.abs(N)}°${h(N)}`; };
function regionList() {
  const h = META.regions.map((r, i) => `<button type="button" data-i="${i}">${esc(r.name)}</button>`).join('') + `<button type="button" data-i="custom">Custom box</button>`;
  $('#chips').innerHTML = h; $('#chipsHero').innerHTML = META.regions.map((r, i) => `<button type="button" data-i="${i}">${esc(r.name)}</button>`).join('');
  markRegion();
}
function markRegion() {
  document.querySelectorAll('#chips button, #chipsHero button').forEach((b) => b.classList.toggle('on', st.preset == null ? b.dataset.i === 'custom' : b.dataset.i !== 'custom' && +b.dataset.i === st.preset));
  const n = areaName(); $('#ctaName').textContent = n; $('#chapTitle').textContent = n;
}
function selectRegion(i, fromGlobe) {
  st.preset = i; st.sel = null; setBbox(META.regions[i].bbox.slice(), false);
  if (window.Globe && globeReady) Globe.focus(i);
  if (fromGlobe) openChapter();
}
function openChapter() { $('#calendarChapter').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); }
let globeReady = false;
function openPanel(id) {
  const tabs = document.querySelectorAll('#tabs button'); let was = false;
  tabs.forEach((b) => { const on = b.dataset.p === id; if (on && b.getAttribute('aria-selected') === 'true') was = true; });
  tabs.forEach((b) => b.setAttribute('aria-selected', String(!was && b.dataset.p === id)));
  document.querySelectorAll('#panels > section').forEach((p) => { p.hidden = was || p.id !== 'p-' + id; });
  if (!was && id === 'map') { if (!map) { initMap(); } map.invalidateSize(); drawMap(true); }
  if (!was) $('#p-' + id).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function setBbox(b, custom) {
  st.bbox = b; ['S', 'W', 'N', 'E'].forEach((k, i) => { $('#b' + k).value = b[i]; });
  if (custom) st.preset = null; markRegion();
  refresh(true);
}
function setSeg(id, v) { document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute('aria-checked', String(b.dataset.v === v))); }

async function refresh(fit) {
  try { $('#coverNote').textContent = 'Loading…'; AOI = await computeAOI(st.bbox); }
  catch (e) { $('#coverNote').textContent = e.message; return; }
  const cov = AOI.coverage;
  $('#coverNote').textContent = AOI.cells.length
    ? (cov < 0.98 ? `Only ${Math.round(cov * 100)}% of this box is inside the dataset (dashed outlines on the map). The rest is “no data”, not “no fire”.` : 'Grey dashed outlines on the map mark where the dataset has coverage.')
    : cov < 0.02 ? 'This box is outside the dataset (dashed outlines). Pick a region or draw inside one.' : 'No hotspots in this area across the whole record.';
  render(fit);
}

function render(fit) {
  if (!AOI) return;
  if (st.sel != null && (st.sel < st.from || st.sel > st.to)) st.sel = null;
  const [fy] = ymOf(st.from), [ty] = ymOf(st.to);
  const sel = $('#focusYear'); sel.innerHTML = '';
  for (let y = ty; y >= fy; y--) { const o = document.createElement('option'); o.value = y; o.textContent = y; sel.appendChild(o); }
  if (st.focusYear == null || st.focusYear < fy || st.focusYear > ty) st.focusYear = ty;
  sel.value = st.focusYear;
  calendar(); masthead(); nowCard(); season(); ledger(); marginNote(); drawMap(fit); setReadout();
}

function readControls() {
  st.from = keyIdx($('#from').value); st.to = keyIdx($('#to').value);
  if (isNaN(st.from) || st.from < 0) st.from = 0;
  if (isNaN(st.to) || st.to >= NM) st.to = NM - 1;
  if (st.from > st.to) [st.from, st.to] = [st.to, st.from];
  st.vals = $('#showVals').checked;
  st.baseFrom = +$('#baseFrom').value || 2001; st.baseTo = +$('#baseTo').value || 2025;
}

/* ---------- CSV ---------- */
const csvEsc = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
function download(name, rows) {
  const text = rows.map((r) => r.map(csvEsc).join(',')).join('\n') + '\n';
  if (window.self !== window.top) return csvDialog(name, text);   // sandboxed frames block downloads: offer copy instead
  const blob = new Blob([text], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function csvDialog(name, text) {
  const d = document.createElement('div'); d.className = 'dlg';
  d.innerHTML = `<div><h3>${esc(name)}</h3><p class="hint">Downloads are blocked in this view. Copy the CSV and paste it into a file or spreadsheet.</p><textarea readonly></textarea><div class="row"><button class="btn primary" data-a="copy">Copy CSV</button><button class="btn" data-a="close">Close</button><span class="mono" data-a="msg"></span></div></div>`;
  const ta = d.querySelector('textarea'); ta.value = text;
  d.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'close' || e.target === d) d.remove();
    if (a === 'copy') { try { await navigator.clipboard.writeText(text); d.querySelector('[data-a=msg]').textContent = 'Copied'; } catch (_) { ta.select(); d.querySelector('[data-a=msg]').textContent = 'Press Ctrl/Cmd+C'; } }
  };
  document.body.appendChild(d);
}
const tag = () => `${st.bbox.join('_')}_${mkey(st.from)}_${mkey(st.to)}`;
function dlMonth() {
  const rows = [['year', 'month', 'hotspots_harmonized', 'source', 'partial_month', 'baseline_median', 'change_vs_median_pct', 'percentile_in_history']];
  for (let m = st.from; m <= st.to; m++) {
    const k = metricsFor(m), [y, mo] = ymOf(m);
    rows.push([y, mo, +k.v.toFixed(2), m >= META.viirs_start_idx ? 'VIIRS' : 'MODIS_calibrated', k.partial ? 'yes' : 'no',
      isFinite(k.med) ? +k.med.toFixed(2) : '', k.n >= 3 ? +((k.ratio - 1) * 100).toFixed(1) : '', k.pct == null ? '' : +k.pct.toFixed(1)]);
  }
  download(`burn-calendar_monthly_${tag()}.csv`, rows);
}
function dlMatrix() {
  const [fy] = ymOf(st.from), [ty] = ymOf(st.to), rows = [['year', ...MN, 'total']];
  for (let y = fy; y <= ty; y++) { let s = 0; const r = [y]; for (let mo = 1; mo <= 12; mo++) { const i = idxOf(y, mo); if (i >= st.from && i <= st.to && i < NM) { r.push(+AOI.series[i].toFixed(2)); s += AOI.series[i]; } else r.push(''); } r.push(+s.toFixed(2)); rows.push(r); }
  download(`burn-calendar_matrix_${tag()}.csv`, rows);
}
function dlCells() {
  const rows = [['cell_center_lat', 'cell_center_lon', 'year', 'month', 'hotspots_harmonized', 'source']];
  AOI.cells.forEach((c) => { for (let m = st.from; m <= st.to; m++) { const v = c.t.data[c.o + m]; if (v > 0) { const [y, mo] = ymOf(m); rows.push([c.lat, c.lon, y, mo, +v.toFixed(2), m >= META.viirs_start_idx ? 'VIIRS' : 'MODIS_calibrated']); } } });
  download(`burn-calendar_cells_${tag()}.csv`, rows);
}


/* ---------- globe ---------- */
async function startGlobe() {
  const keys = Object.keys(META.tiles), cells = [];
  const tiles = await Promise.all(keys.map(getTile));
  tiles.forEach((t, k) => {
    if (!t) return; const [tr, tc] = keys[k].split('_').map(Number);
    for (let i = 0; i < t.n; i++) { const loc = t.idx[i]; cells.push({ lat: -90 + (tr * TC + Math.floor(loc / TC) + 0.5) * RES, lon: -180 + (tc * TC + (loc % TC) + 0.5) * RES, t, o: i * NM }); }
  });
  const scrub = $('#gScrub'), date = $('#gDate'), tip = $('#gTip'), play = $('#gPlay');
  scrub.max = NM - 1;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const label = (mi) => { const [y, m] = ymOf(mi); return MN[m - 1] + ' ' + y; };
  Globe.init({
    canvas: $('#globe'), cells, NM, regions: META.regions, startMonth: Math.min(NM - 1, idxOf(2018, 7)), reduced,
    onMonth: (mi) => { date.textContent = label(mi); scrub.value = mi; },
    onPick: (i) => selectRegion(i, true),
    onHover: (i, x, y) => { if (i < 0) { tip.hidden = true; return; } tip.hidden = false; tip.textContent = META.regions[i].name + ' · click to open'; },
  });
  globeReady = true;
  const setPlay = (on) => { Globe.play(on); play.textContent = on ? 'Pause' : 'Play'; play.setAttribute('aria-label', on ? 'Pause the time-lapse' : 'Play the time-lapse'); };
  setPlay(!reduced);
  $('#gZin').onclick = () => Globe.zoom(1.6); $('#gZout').onclick = () => Globe.zoom(1 / 1.6); $('#gReset').onclick = () => Globe.reset();
  play.onclick = () => setPlay(!Globe.playing);
  scrub.oninput = () => { setPlay(false); Globe.setMonth(+scrub.value); };
  $('#gTip').hidden = true;
}

/* ---------- boot ---------- */
async function boot() {
  META = window.__EMBED ? window.__EMBED.meta : await (await fetch('data/meta.json')).json();
  NM = META.n_months; RES = META.grid_res; TC = META.tile_cells;
  const [ly] = ymOf(NM - 1);
  if (META.dataset.synthetic) { const b = $('#notice'); b.hidden = false; b.innerHTML = '<b>Sample data.</b> These detections are simulated to test the pipeline and this interface. They are not observations of real fires. Run <code>pipeline/harmonize.py</code> on FIRMS downloads to replace them.'; }
  $('#from').min = $('#to').min = META.start; $('#from').max = $('#to').max = mkey(NM - 1);
  $('#from').value = META.start; $('#to').value = mkey(NM - 1);
  st.from = 0; st.to = NM - 1;
  st.baseFrom = ymOf(0)[0] + 1; st.baseTo = isPartial(NM - 1) ? ly - 1 : ly;
  $('#baseFrom').value = st.baseFrom; $('#baseTo').value = st.baseTo;
  regionList();
  $('#chips').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.i === 'custom') { const t = $('#tabs button[data-p=map]'); if (t.getAttribute('aria-selected') !== 'true') openPanel('map'); $('#bN').focus(); return; } selectRegion(+b.dataset.i, false); };
  $('#chipsHero').onclick = (e) => { const b = e.target.closest('button'); if (b) selectRegion(+b.dataset.i, true); };
  $('#ctaOpen').onclick = openChapter;
  $('#helpBtn').onclick = () => { const b = $('#helpBox'); b.hidden = !b.hidden; $('#helpBtn').setAttribute('aria-expanded', String(!b.hidden)); };
  $('#moreBtn').onclick = () => { st.more = !st.more; $('#moreBtn').setAttribute('aria-pressed', String(st.more)); $('#moreBtn').textContent = st.more ? 'Show less detail' : 'Show more detail'; if (AOI) { calendar(); setReadout(); } };
  $('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) openPanel(b.dataset.p); };
  $('#backGlobe').onclick = () => { window.scrollTo({ top: 0, behavior: 'smooth' }); if (globeReady) Globe.unfocus(); };
  ['S', 'W', 'N', 'E'].forEach((k) => { $('#b' + k).onchange = () => setBbox(['S', 'W', 'N', 'E'].map((q) => +$('#b' + q).value), true); });
  $('#drawBtn').onclick = () => setDrawing(!drawing);
  ['from', 'to', 'showVals', 'baseFrom', 'baseTo'].forEach((id) => { $('#' + id).onchange = () => { readControls(); render(false); }; });
  $('#metricSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.metric = b.dataset.v; setSeg('metricSeg', st.metric); render(false); };
  $('#scaleSeg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; st.scale = b.dataset.v; setSeg('scaleSeg', st.scale); render(false); };
  setSeg('metricSeg', st.metric); setSeg('scaleSeg', st.scale);
  $('#focusYear').onchange = (e) => { st.focusYear = +e.target.value; season(); };
  $('#dlMonth').onclick = dlMonth; $('#dlMatrix').onclick = dlMatrix; $('#dlCells').onclick = dlCells;
  $('#mapReset').onclick = () => { st.sel = null; render(false); };
  const cal = $('#calendar');
  cal.onmousemove = (e) => { const r = e.target.closest('.cell'); const m = r ? +r.dataset.m : null; if (m !== st.hover) { st.hover = m; setReadout(); } };
  cal.onmouseleave = () => { st.hover = null; setReadout(); };
  cal.onclick = (e) => {
    const r = e.target.closest('.cell'), yl = e.target.closest('.yl');
    if (r) { const m = +r.dataset.m; st.sel = st.sel === m ? null : m; render(false); }
    else if (yl) { st.focusYear = +yl.dataset.year; $('#focusYear').value = st.focusYear; season(); }
  };
  const pick = (tr) => { const m = +tr.dataset.m; st.sel = st.sel === m ? null : m; render(false); };
  $('#ledger').onclick = (e) => { const tr = e.target.closest('tr[data-m]'); if (tr) pick(tr); };
  $('#ledger').onkeydown = (e) => { if (e.key === 'Enter') { const tr = e.target.closest('tr[data-m]'); if (tr) pick(tr); } };
  st.preset = 0; st.bbox = META.regions[0].bbox.slice();
  ['S', 'W', 'N', 'E'].forEach((k, i) => { $('#b' + k).value = st.bbox[i]; });
  markRegion();
  await refresh(true);
  startGlobe();
  window.__app = { openPanel, selectRegion, st, get AOI() { return AOI; }, META, refresh, render };
}
boot().catch((e) => { document.body.insertAdjacentHTML('afterbegin', `<pre style="padding:20px;color:#b00">Could not start: ${esc(e.message)}\nServe this folder over HTTP (python3 -m http.server) and make sure data/meta.json exists.</pre>`); console.error(e); });
})();

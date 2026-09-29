import * as over from './over.js';
import { METRICS, eligible, pointChange, logTrend, indexTo, within } from './stats.js';
import { createBrush } from './brush.js';
import { createParcelLayer } from './parcels.js';
import { esc } from './util.js';

const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777'];
const STORE_KEY = 'nadlan-area-compare:v1';
const THIS_YEAR = new Date().getFullYear();
const DEFAULT_NATURE = 'דירה בבית קומות';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const fmt = (v, d = 0) => (v == null || !Number.isFinite(Number(v)) ? '—'
  : Number(v).toLocaleString('he-IL', { maximumFractionDigits: d, minimumFractionDigits: d }));
const yr = (y) => `<span class="num">${y}</span>`;
function pct(v, d = 1, suffix = '%') {
  if (v == null || !Number.isFinite(v)) return '—';
  const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  return `<span class="num ${cls}">${v > 0 ? '+' : ''}${fmt(v, d)}${suffix}</span>`;
}
const widthFromSlider = (v) => Math.round(5 * Math.pow(400, v / 100)); // 5 m … 2 km, log scale

const state = {
  areas: [],
  activeId: null,
  refId: null,
  filters: {
    natures: [DEFAULT_NATURE],
    yearMin: 2008,
    yearMax: THIS_YEAR,
    cmpFrom: THIS_YEAR - 7,
    cmpTo: THIS_YEAR - 1,
    minDeals: 10,
    metric: 'med_pp',
  },
  natureList: [],
  register: null,
  tab: 'compare',
  rawAreaId: null,
  busy: false,
};
const charts = {};

// ── persistence (per-viewer convenience only) ──────────────────────────────
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      areas: state.areas.map(({ id, name, color, geom }) => ({ id, name, color, geom })),
      activeId: state.activeId,
      refId: state.refId,
      filters: state.filters,
    }));
  } catch { /* storage unavailable: the page still works, it just forgets */ }
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!s) return;
    const f = s.filters || {};
    for (const k of ['yearMin', 'yearMax', 'cmpFrom', 'cmpTo', 'minDeals']) {
      if (Number.isInteger(f[k])) state.filters[k] = f[k];
    }
    if (f.metric in METRICS) state.filters.metric = f.metric;
    if (Array.isArray(f.natures) && f.natures.every((n) => typeof n === 'string')) state.filters.natures = f.natures;
    for (const a of Array.isArray(s.areas) ? s.areas : []) {
      const okGeom = a?.geom?.type === 'Feature' && ['Polygon', 'MultiPolygon'].includes(a.geom.geometry?.type);
      try {
        addArea({
          id: /^[a-z0-9]{1,40}$/.test(a?.id) ? a.id : undefined,
          name: typeof a?.name === 'string' ? a.name.slice(0, 40) : undefined,
          color: /^#[0-9a-f]{6}$/i.test(a?.color) ? a.color : undefined,
          geom: okGeom ? a.geom : null,
        }, false);
      } catch { /* one bad area must not lose the others */ }
    }
    state.activeId = s.activeId && getArea(s.activeId) ? s.activeId : state.areas[0]?.id ?? null;
    state.refId = s.refId && getArea(s.refId) ? s.refId : null;
  } catch { /* corrupt or blocked storage: start clean */ }
}

// ── map ────────────────────────────────────────────────────────────────────
const map = L.map('map', { zoomControl: true }).setView([32.08, 34.8], 13);
const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, attribution: '© OpenStreetMap contributors',
}).addTo(map);
const imagery = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, attribution: 'Imagery © Esri',
});
L.control.layers({ 'מפת רחובות': osm, 'תצלום אוויר': imagery }, null, { position: 'topleft' }).addTo(map);
L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
map.attributionControl.setPrefix(false);

const parcels = createParcelLayer(map, (msg) => { $('#parcel-status').textContent = msg; });
let highlight = null;

const brush = createBrush(map, {
  getWidth: () => widthFromSlider(Number($('#width').value)),
  getColor: () => getArea(state.activeId)?.color || COLORS[state.areas.length % COLORS.length],
  onStroke,
});

// ── areas ──────────────────────────────────────────────────────────────────
function getArea(id) {
  return state.areas.find((a) => a.id === id);
}

function addArea(init = {}, activate = true) {
  const used = new Set(state.areas.map((a) => a.color));
  const n = state.areas.length + 1;
  const a = {
    id: init.id || `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: init.name || `אזור ${n}`,
    color: init.color || COLORS.find((c) => !used.has(c)) || COLORS[n % COLORS.length],
    geom: init.geom || null,
    res: null,
    layer: null,
  };
  a.layer = L.geoJSON(null, { interactive: false, style: { color: a.color, weight: 2, fillOpacity: 0.22 } });
  if (a.geom) a.layer.addData(a.geom);
  a.layer.addTo(map);
  state.areas.push(a);
  if (activate) state.activeId = a.id;
  return a;
}

function redrawArea(a) {
  a.layer.clearLayers();
  if (a.geom) a.layer.addData(a.geom);
}

function removeArea(id) {
  const a = getArea(id);
  if (!a) return;
  if (a.geom && !confirm(`למחוק את "${a.name}"?`)) return;
  map.removeLayer(a.layer);
  state.areas = state.areas.filter((x) => x.id !== id);
  if (state.activeId === id) state.activeId = state.areas[0]?.id ?? null;
  if (state.refId === id) state.refId = null;
  if (state.rawAreaId === id) state.rawAreaId = null;
  save();
  renderAreas();
  renderResults();
}

function onStroke(poly, mode) {
  if (mode !== 'paint' && mode !== 'erase') return;
  let a = getArea(state.activeId);
  if (!a) {
    if (mode === 'erase') return;
    a = addArea();
  }
  try {
    if (mode === 'paint') {
      a.geom = a.geom ? turf.union(turf.featureCollection([a.geom, poly])) : poly;
    } else if (a.geom) {
      a.geom = turf.difference(turf.featureCollection([a.geom, poly]));
    }
  } catch (e) {
    console.error(e);
    setStatus('לא ניתן היה למזג את המשיכה: ' + e.message);
    return;
  }
  a.res = null;
  redrawArea(a);
  save();
  renderAreas();
  renderResults();
  markStale();
}

function areaSize(geom) {
  if (!geom) return 'ריק — צבעו במברשת';
  const m2 = turf.area(geom);
  return m2 >= 1e6 ? `${fmt(m2 / 1e6, 2)} קמ"ר` : `${fmt(m2 / 1000, 1)} דונם`;
}

function renderAreas() {
  const ul = $('#areas');
  ul.innerHTML = '';
  if (!state.areas.length) {
    ul.innerHTML = '<li class="muted small">אין עדיין אזורים. בחרו "מברשת" וצבעו על המפה.</li>';
    return;
  }
  for (const a of state.areas) {
    const li = document.createElement('li');
    li.className = a.id === state.activeId ? 'active' : '';
    li.style.color = a.color;
    const deals = a.res && !a.res.error ? ` · ${fmt(a.res.deals_total)} עסקאות` : '';
    li.innerHTML = `
      <button type="button" class="swatch" style="background:${a.color}" title="הפוך לאזור הפעיל" aria-label="בחר ${esc(a.name)}"></button>
      <input type="text" value="${esc(a.name)}" aria-label="שם האזור" maxlength="40">
      <span class="acts">
        <button type="button" data-act="zoom" title="התמקד">🔍</button>
        <button type="button" data-act="clear" title="נקה את הסימון">↺</button>
        <button type="button" data-act="del" title="מחק אזור">✖</button>
      </span>
      <span class="meta">${areaSize(a.geom)}${deals}</span>`;
    $('.swatch', li).onclick = () => { state.activeId = a.id; save(); renderAreas(); };
    const input = $('input', li);
    input.onfocus = () => {
      if (state.activeId === a.id) return;
      state.activeId = a.id; // no re-render here: it would take the focus away from this field
      save();
      $$('li', ul).forEach((x) => x.classList.toggle('active', x === li));
    };
    input.onchange = () => { a.name = input.value.trim() || a.name; save(); renderResults(); };
    $('[data-act=zoom]', li).onclick = () => { if (a.geom) map.fitBounds(a.layer.getBounds(), { padding: [30, 30] }); };
    $('[data-act=clear]', li).onclick = () => { a.geom = null; a.res = null; redrawArea(a); save(); renderAreas(); renderResults(); markStale(); };
    $('[data-act=del]', li).onclick = () => removeArea(a.id);
    ul.appendChild(li);
  }
}

// ── controls ───────────────────────────────────────────────────────────────
function setMode(m) {
  brush.setMode(m);
  $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  if (m !== 'pan' && !state.areas.length) {
    addArea();
    save();
    renderAreas();
  }
}
$$('.seg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.key === 'Escape') setMode('pan');
  else if (e.key === 'b' || e.key === 'נ') setMode('paint');
  else if (e.key === 'e' || e.key === 'ק') setMode('erase');
});

function showWidth() {
  const w = widthFromSlider(Number($('#width').value));
  $('#width-out').textContent = w >= 1000 ? `${fmt(w / 1000, 1)} ק"מ` : `${w} מ'`;
}
$('#width').oninput = showWidth;
showWidth();

$('#show-parcels').onchange = (e) => parcels.setEnabled(e.target.checked);
$('#add-area').onclick = () => { addArea(); save(); renderAreas(); if (brush.mode === 'pan') setMode('paint'); };

function readFilters() {
  const f = state.filters;
  const num = (id, fallback) => {
    const v = parseInt($(id).value, 10);
    return Number.isFinite(v) ? v : fallback;
  };
  f.yearMin = Math.max(1998, num('#year-min', f.yearMin));
  f.yearMax = Math.min(THIS_YEAR, Math.max(f.yearMin, num('#year-max', f.yearMax)));
  f.cmpFrom = num('#cmp-from', f.cmpFrom);
  f.cmpTo = num('#cmp-to', f.cmpTo);
  f.minDeals = Math.max(1, num('#min-deals', f.minDeals));
  f.metric = $('#metric').value in METRICS ? $('#metric').value : 'med_pp';
  // Only once the list has loaded — an empty list must not read as "no filter".
  if ($$('#natures input').length) f.natures = $$('#natures input:checked').map((i) => i.value);
}
function writeFilters() {
  const f = state.filters;
  $('#year-min').value = f.yearMin;
  $('#year-max').value = f.yearMax;
  $('#cmp-from').value = f.cmpFrom;
  $('#cmp-to').value = f.cmpTo;
  $('#min-deals').value = f.minDeals;
  $('#metric').value = f.metric;
}

// Inputs that only change how existing numbers are read re-render at once;
// inputs that change the SQL mark the results stale.
for (const id of ['#cmp-from', '#cmp-to', '#min-deals', '#metric']) {
  $(id).addEventListener('change', () => { readFilters(); save(); renderResults(); });
}
for (const id of ['#year-min', '#year-max']) {
  $(id).addEventListener('change', () => { readFilters(); save(); renderResults(); markStale(); });
}

function renderNatures() {
  const box = $('#natures');
  box.innerHTML = state.natureList.slice(0, 25).map((n) => `
    <label><input type="checkbox" value="${esc(n.nature)}" ${state.filters.natures.includes(n.nature) ? 'checked' : ''}>
      ${esc(n.nature)} <span class="cnt num">${fmt(n.deals)}</span></label>`).join('');
  box.onchange = () => { readFilters(); save(); renderNatureNotes(); renderResults(); markStale(); };
  renderNatureNotes();
}
function renderNatureNotes() {
  const notes = state.natureList.filter((n) => state.filters.natures.includes(n.nature) && n.note);
  let html = notes.map((n) => `<p>${esc(n.note)}</p>`).join('');
  if (!state.filters.natures.length) {
    html = '<p>לא נבחרה מהות — החישוב יערבב דירות, מגרשים וקרקע, ושינוי בתמהיל ייראה כשינוי מחיר.</p>' + html;
  } else if (state.filters.natures.length > 1) {
    html += '<p>נבחרו כמה סוגי עסקאות — שינוי בתמהיל ביניהם לאורך השנים ישפיע על החציון.</p>';
  }
  $('#nature-notes').innerHTML = html;
}

function setStatus(msg) {
  $('#compute-status').textContent = msg;
}
function markStale() {
  if (state.areas.some((a) => a.geom)) setStatus('הסינון או האזורים השתנו — לחצו "חשב והשווה" לעדכון.');
}

// ── search ─────────────────────────────────────────────────────────────────
function showHighlight(geojson) {
  highlight?.remove();
  highlight = L.geoJSON(geojson, { interactive: false, style: { color: '#111827', weight: 3, dashArray: '6 4', fill: false } }).addTo(map);
  map.fitBounds(highlight.getBounds(), { padding: [40, 40], maxZoom: 18 });
}

$('#search-form').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('#search').value.trim();
  const out = $('#search-results');
  if (!q) return;
  out.innerHTML = '<li class="muted">מחפש…</li>';
  try {
    const gp = q.match(/^\s*(?:גוש\s*)?(\d{1,6})\s*(?:[/\\\-,:. ]|\s*חלקה\s*)\s*(\d{1,5})\s*$/);
    const g = q.match(/^\s*(?:גוש\s*)?(\d{3,6})\s*$/);
    if (gp) {
      const r = await over.parcelGeometry(gp[1], gp[2]);
      showHighlight(r.geometry);
      out.innerHTML = `<li class="muted">גוש ${esc(r.gush)} חלקה ${esc(r.helka)} · ${esc(r.status_text || '')} · ${fmt(r.legal_area)} מ"ר רשום</li>`;
    } else if (g) {
      const r = await over.gushExtent(g[1]);
      if (!r) throw new Error(`גוש ${g[1]} לא נמצא בשכבת החלקות`);
      showHighlight(r.box);
      out.innerHTML = `<li class="muted">גוש ${esc(g[1])} · ${fmt(r.parcels)} חלקות</li>`;
    } else {
      const res = await over.geocode(q);
      if (!res.length) throw new Error('לא נמצאו תוצאות');
      out.innerHTML = '';
      for (const r of res) {
        const li = document.createElement('li');
        li.textContent = r.display_name;
        li.onclick = () => {
          const [s, n, w, e2] = r.boundingbox.map(Number);
          map.fitBounds([[s, w], [n, e2]], { maxZoom: 17 });
        };
        out.appendChild(li);
      }
      if (res.length === 1) out.firstChild.click();
    }
  } catch (err) {
    out.innerHTML = `<li class="err">${esc(err.message)}</li>`;
  }
};

// ── compute ────────────────────────────────────────────────────────────────
// The geometry sent to OVER: simplified to ~0.5 m and 6 decimals, so a long
// brush session does not become a megabyte of SQL.
function queryGeometry(geom) {
  let tol = 0.000005;
  let g = geom;
  for (let i = 0; i < 6; i++) {
    g = turf.truncate(turf.simplify(geom, { tolerance: tol, highQuality: true }), { precision: 6 });
    if (turf.coordAll(g).length <= 4000) break;
    tol *= 3;
  }
  return g.geometry;
}

async function compute() {
  if (state.busy) return;
  readFilters();
  save();
  const areas = state.areas.filter((a) => a.geom);
  if (!areas.length) {
    setStatus('אין אזור מסומן. בחרו "מברשת" וצבעו על המפה.');
    return;
  }
  state.busy = true;
  $('#compute').disabled = true;
  const f = state.filters;
  const sqlFilters = { natures: [...f.natures], yearMin: f.yearMin, yearMax: f.yearMax };
  let failed = 0;
  try {
    for (const [i, a] of areas.entries()) {
      const g0 = a.geom;
      let sql = '';
      try {
        const geometry = queryGeometry(g0);
        const sig = JSON.stringify([geometry, sqlFilters]);
        if (a.res && !a.res.error && a.res.sig === sig) continue;
        setStatus(`מחשב ${i + 1}/${areas.length}: ${a.name}…`);
        sql = over.aggregateSql(geometry, sqlFilters);
        const r = await over.runSql(sql);
        // Edited, cleared or deleted while the query ran: the answer is for a shape that no longer exists.
        if (a.geom !== g0 || !state.areas.includes(a)) continue;
        const row = r.rows[0];
        const years = typeof row.years === 'string' ? JSON.parse(row.years) : row.years;
        a.res = {
          sig, sql, geometry, filters: sqlFilters,
          parcels_in_area: Number(row.parcels_in_area),
          parcels_with_deals: Number(row.parcels_with_deals),
          deals_total: Number(row.deals_total),
          years,
          raw: null,
        };
      } catch (e) {
        if (a.geom !== g0 || !state.areas.includes(a)) continue;
        failed += 1;
        const hint = /timeout|canceling statement/i.test(e.message)
          ? ' — האזור גדול מדי לשאילתה אחת (תקרת זמן ב-OVER). נסו אזור קטן יותר.' : '';
        a.res = { sig: null, sql, filters: sqlFilters, error: e.message + hint };
      }
    }
    setStatus(failed ? `הושלם, ${failed} אזורים נכשלו — ראו פירוט בטבלה.` : 'הושלם.');
  } finally {
    state.busy = false;
    $('#compute').disabled = false;
  }
  renderAreas();
  renderResults();
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#compute').onclick = compute;

// ── analysis ───────────────────────────────────────────────────────────────
function analyse(a) {
  const f = state.filters;
  const points = eligible(a.res.years, f.metric, f.minDeals);
  const win = within(points, f.cmpFrom, f.cmpTo);
  return {
    points,
    win,
    change: pointChange(points, f.cmpFrom, f.cmpTo),
    trend: logTrend(win),
    index: indexTo(points, f.cmpFrom),
    at: (y) => points.find((p) => p.yr === y) || null,
  };
}

function computed() {
  return state.areas.filter((a) => a.res && a.geom);
}

// The filters the shown numbers were actually computed with (every area of a
// compute shares them), which can differ from the inputs once the user edits.
function queried(list) {
  return list.find((a) => a.res?.filters)?.res.filters || state.filters;
}
function queriedDiffers(list) {
  const q = queried(list);
  const f = state.filters;
  return q.yearMin !== f.yearMin || q.yearMax !== f.yearMax
    || JSON.stringify([...q.natures].sort()) !== JSON.stringify([...f.natures].sort());
}

function reference(list) {
  const ok = list.filter((a) => !a.res.error);
  return ok.find((a) => a.id === state.refId) || ok[0] || null;
}

// ── rendering ──────────────────────────────────────────────────────────────
function renderResults() {
  const list = computed();
  $('#results').hidden = !list.length;
  if (!list.length) return;
  renderCompare(list);
  renderRaw(list);
  renderMethod(list);
  if (state.tab === 'charts') renderCharts(list);
}

$$('.tabs button').forEach((b) => {
  b.onclick = () => {
    state.tab = b.dataset.tab;
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.pane').forEach((p) => { p.hidden = p.dataset.pane !== state.tab; });
    if (state.tab === 'charts') renderCharts(computed());
  };
});

function dot(a) {
  return `<span class="dot" style="background:${a.color}"></span>${esc(a.name)}`;
}

function renderCompare(list) {
  const f = state.filters;
  const M = METRICS[f.metric];
  const ref = reference(list);
  const refA = ref ? analyse(ref) : null;
  const q = queried(list);
  const partial = f.cmpTo >= THIS_YEAR || q.yearMax >= THIS_YEAR;
  let html = `<p class="muted small">מדד: <b>${M.label}</b> · השוואה בין ${yr(f.cmpFrom)} ל-${yr(f.cmpTo)} ·
    שנים עם פחות מ-${fmt(f.minDeals)} עסקאות אינן נכנסות לחישוב · מהות: ${esc(q.natures.join(', ') || 'הכל')} ·
    שנים ${yr(q.yearMin)}–${yr(q.yearMax)}</p>`;
  if (queriedDiffers(list)) html += '<p class="note">הסינון (מהות או טווח שנים) השתנה מאז החישוב — המספרים כאן עדיין לפי הסינון שמוצג למעלה. לחצו "חשב והשווה" לעדכון.</p>';
  if (f.cmpFrom < q.yearMin || f.cmpTo > q.yearMax) {
    html += `<p class="note">שנות ההשוואה (${yr(f.cmpFrom)}, ${yr(f.cmpTo)}) חורגות מטווח השנים שנשלף (${yr(q.yearMin)}–${yr(q.yearMax)}) — הרחיבו את הטווח וחשבו מחדש.</p>`;
  }
  if (partial) html += `<p class="note">שנת ${THIS_YEAR} עדיין לא הסתיימה, והמאגר מתעדכן באיחור — נתוני השנה הנוכחית חלקיים.</p>`;
  if (f.cmpTo <= f.cmpFrom) html += '<p class="note">שנת ההשוואה צריכה להיות מאוחרת משנת הבסיס.</p>';

  html += `<div class="tbl-wrap"><table><thead><tr>
    <th>ייחוס</th><th>אזור</th><th>חלקות באזור</th><th>חלקות עם עסקאות</th><th>עסקאות בטווח</th>
    <th>${M.label}<br>${yr(f.cmpFrom)} (n)</th><th>${M.label}<br>${yr(f.cmpTo)} (n)</th>
    <th>שינוי ${yr(f.cmpFrom)}→${yr(f.cmpTo)}</th><th>שינוי שנתי ממוצע (CAGR)</th>
    <th>מגמה שנתית (רגרסיה)</th><th>R²</th><th>רמת מחיר ביחס לייחוס (${yr(f.cmpTo)})</th><th>פער מגמה מול הייחוס</th>
  </tr></thead><tbody>`;
  for (const a of list) {
    if (a.res.error) {
      html += `<tr><td></td><td>${dot(a)}</td><td colspan="11" class="neg">${esc(a.res.error)}</td></tr>`;
      continue;
    }
    const x = analyse(a);
    const from = x.at(f.cmpFrom);
    const to = x.at(f.cmpTo);
    const refTo = refA?.at(f.cmpTo);
    const isRef = ref && a.id === ref.id;
    const ratio = to && refTo ? (to.m / refTo.m) * 100 : null;
    const gap = x.trend && refA?.trend && !isRef ? x.trend.annualPct - refA.trend.annualPct : null;
    html += `<tr>
      <td><input type="radio" name="ref" value="${a.id}" ${isRef ? 'checked' : ''} aria-label="אזור ייחוס"></td>
      <td>${dot(a)}</td>
      <td class="n">${fmt(a.res.parcels_in_area)}</td>
      <td class="n">${fmt(a.res.parcels_with_deals)}</td>
      <td class="n">${fmt(a.res.deals_total)}</td>
      <td class="n">${from ? `${fmt(from.m)} (${fmt(from.n)})` : '<span class="muted">אין מספיק עסקאות</span>'}</td>
      <td class="n">${to ? `${fmt(to.m)} (${fmt(to.n)})` : '<span class="muted">אין מספיק עסקאות</span>'}</td>
      <td class="n">${pct(x.change?.pct)}</td>
      <td class="n">${pct(x.change?.cagr, 2)}</td>
      <td class="n">${x.trend ? pct(x.trend.annualPct, 2) + ` <span class="muted">(${x.trend.n} שנים)</span>` : '—'}</td>
      <td class="n">${x.trend ? fmt(x.trend.r2, 2) : '—'}</td>
      <td class="n">${isRef ? '100 (ייחוס)' : ratio != null ? fmt(ratio, 1) : '—'}</td>
      <td class="n">${isRef ? '—' : gap != null ? pct(gap, 2, ' נ"א') : '—'}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';

  html += summarySentences(list, ref);
  html += overlapNote(list);
  html += `<p class="muted small">n = מספר העסקאות שמאחורי החציון. "נ"א" = נקודות אחוז. הנוסחאות המלאות, עם המספרים שהוצבו בהן, בלשונית "נוסחאות ושיטה"; השורות עצמן בלשונית "חומר גלם".</p>`;
  const pane = $('[data-pane=compare]');
  pane.innerHTML = html;
  $$('input[name=ref]', pane).forEach((r) => {
    r.onchange = () => { state.refId = r.value; save(); renderResults(); };
  });
}

function summarySentences(list, ref) {
  const f = state.filters;
  const lines = [];
  for (const a of list) {
    if (a.res.error) continue;
    const x = analyse(a);
    if (!x.change) {
      lines.push(`<li>${dot(a)}: אין מספיק עסקאות באחת משנות ההשוואה (${yr(f.cmpFrom)} או ${yr(f.cmpTo)}) כדי לחשב שינוי.</li>`);
      continue;
    }
    lines.push(`<li>${dot(a)}: ${METRICS[f.metric].label} השתנה ב-${pct(x.change.pct)} בין ${yr(f.cmpFrom)} ל-${yr(f.cmpTo)}
      (${pct(x.change.cagr, 2)} בממוצע לשנה)${x.trend ? `; קו המגמה על ${x.trend.n} שנים: ${pct(x.trend.annualPct, 2)} לשנה` : ''}.</li>`);
  }
  if (!lines.length) return '';
  return `<h3 style="margin-top:1rem">בקצרה</h3><ul>${lines.join('')}</ul>${ref ? `<p class="muted small">אזור הייחוס: ${dot(ref)}.</p>` : ''}`;
}

function overlapNote(list) {
  const ok = list.filter((a) => !a.res.error && a.geom);
  const pairs = [];
  for (let i = 0; i < ok.length; i++) {
    for (let j = i + 1; j < ok.length; j++) {
      try {
        if (turf.booleanIntersects(ok[i].geom, ok[j].geom)) pairs.push(`${esc(ok[i].name)} ו-${esc(ok[j].name)}`);
      } catch { /* malformed geometry: skip the note rather than the table */ }
    }
  }
  if (!pairs.length) return '';
  return `<p class="note">אזורים חופפים: ${pairs.join('; ')}. עסקאות בחלקות שבחפיפה נספרות בכל אחד מהאזורים — ההשוואה היא בין אזורים, לא בין קבוצות זרות של עסקאות.</p>`;
}

function renderCharts(list) {
  const f = state.filters;
  const M = METRICS[f.metric];
  const ok = list.filter((a) => !a.res.error);
  $('#chart-level-title').textContent = `${M.label} (${M.unit}) לפי שנה — רק שנים עם ${f.minDeals}+ עסקאות`;
  $('#chart-index-title').textContent = `מדד: ${f.cmpFrom} = 100`;
  const q = queried(list);
  const years = [];
  for (let y = q.yearMin; y <= q.yearMax; y++) years.push(y);
  const common = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { rtl: true, textDirection: 'rtl' }, tooltip: { rtl: true, textDirection: 'rtl' } },
  };
  const datasets = (fn) => ok.map((a) => {
    const values = fn(a);
    return {
      label: a.name,
      data: years.map((y) => values.get(y) ?? null),
      borderColor: a.color,
      backgroundColor: a.color,
      spanGaps: true,
      tension: 0.15,
    };
  });
  const make = (id, type, data, extra = {}) => {
    charts[id]?.destroy();
    $(`#${id}`).parentElement.style.height = '340px';
    charts[id] = new Chart($(`#${id}`), { type, data, options: { ...common, ...extra } });
  };
  make('chart-level', 'line', {
    labels: years,
    datasets: datasets((a) => new Map(analyse(a).points.map((p) => [p.yr, Math.round(p.m)]))),
  });
  make('chart-index', 'line', {
    labels: years,
    datasets: datasets((a) => new Map((analyse(a).index || []).map((p) => [p.yr, Math.round(p.v * 10) / 10]))),
  });
  make('chart-deals', 'bar', {
    labels: years,
    datasets: datasets((a) => new Map(a.res.years.map((r) => [Number(r.yr), Number(r.deals)]))),
  });
}

// ── raw material ───────────────────────────────────────────────────────────
function csv(rows, cols) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const RAW_COLS = [
  ['settlement', 'יישוב'], ['gush', 'גוש'], ['chelka', 'חלקה'], ['sub_chelka', 'תת-חלקה'], ['deal_date', 'תאריך'],
  ['deal_nature', 'מהות'], ['deal_amount', 'שווי מכירה'], ['declared_amount', 'שווי מוצהר'], ['portion', 'חלק נמכר'],
  ['asset_area', 'שטח (מ"ר)'], ['room_num', 'חדרים'], ['year_built', 'שנת בנייה'], ['ppsqm_normalized', 'מחיר למ"ר מנורמל'],
];
const YEAR_COLS = ['yr', 'deals', 'n_amt', 'med_amt', 'n_pp', 'med_pp'];

function renderRaw(list) {
  const pane = $('[data-pane=raw]');
  if (!list.find((a) => a.id === state.rawAreaId)) state.rawAreaId = list[0].id;
  const a = getArea(state.rawAreaId);
  const f = state.filters;
  let html = `<div class="row" style="flex-wrap:wrap;margin-bottom:.6rem">${list.map((x) =>
    `<button type="button" data-area="${x.id}" class="${x.id === a.id ? 'primary' : ''}" style="width:auto;margin:0">${dot(x)}</button>`).join('')}</div>`;
  if (a.res.error) {
    html += `<p class="neg">${esc(a.res.error)}</p>`;
  } else {
    const used = new Set(analyse(a).points.map((p) => p.yr));
    html += `<h3>הסיכום השנתי — הקלט הישיר לנוסחאות</h3>
      <p class="muted small">שורה אחת לכל שנה, כפי שהוחזרה מ-OVER. שורות באפור לא נכנסו לחישוב (פחות מ-${fmt(f.minDeals)} עסקאות במדד הנבחר).</p>
      <div class="tbl-wrap"><table><thead><tr><th>שנה</th><th>עסקאות</th><th>עסקאות עם שווי</th><th>חציון שווי עסקה</th><th>עסקאות עם שטח וחלק נמכר</th><th>חציון מחיר למ"ר מנורמל</th><th>בשימוש</th></tr></thead><tbody>
      ${a.res.years.map((r) => `<tr class="${used.has(Number(r.yr)) ? '' : 'thin'}">
        <td class="n">${r.yr}${Number(r.yr) === THIS_YEAR ? ' (חלקית)' : ''}</td><td class="n">${fmt(r.deals)}</td><td class="n">${fmt(r.n_amt)}</td><td class="n">${fmt(r.med_amt)}</td>
        <td class="n">${fmt(r.n_pp)}</td><td class="n">${fmt(r.med_pp)}</td><td>${used.has(Number(r.yr)) ? '✓' : '—'}</td></tr>`).join('')}
      </tbody></table></div>
      <p><button type="button" id="dl-years">הורד סיכום שנתי (CSV)</button></p>
      <h3>העסקאות עצמן</h3>`;
    const raw = a.res.raw;
    if (!raw) {
      html += `<p class="muted small">באזור ${fmt(a.res.deals_total)} עסקאות. OVER מחזיר עד ${fmt(over.SQL_ROW_CAP)} שורות לשאילתה, לכן הן נטענות בדפים.</p>
        <button type="button" id="load-raw">${a.res.deals_total > over.SQL_ROW_CAP ? `טען את ${fmt(over.SQL_ROW_CAP)} העסקאות האחרונות` : `טען את ${fmt(a.res.deals_total)} העסקאות`}</button>`;
    } else {
      html += `<p class="muted small">נטענו ${fmt(raw.rows.length)} מתוך ${fmt(a.res.deals_total)} עסקאות, מהחדשה לישנה.</p>
        <div class="row" style="margin-bottom:.5rem">
          ${raw.rows.length < a.res.deals_total ? `<button type="button" id="load-raw">טען ${fmt(over.SQL_ROW_CAP)} נוספות</button>` : ''}
          <button type="button" id="dl-raw">הורד את השורות שנטענו (CSV)</button>
        </div>
        <div class="tbl-wrap"><table><thead><tr>${RAW_COLS.map(([, h]) => `<th>${h}</th>`).join('')}</tr></thead><tbody>
        ${raw.rows.map((r) => `<tr>${RAW_COLS.map(([k]) => `<td class="${/amount|area|ppsqm|portion/.test(k) ? 'n' : ''}">${esc(/amount|ppsqm/.test(k) ? fmt(r[k]) : r[k])}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div>`;
    }
    if (raw?.error) html += `<p class="neg">${esc(raw.error)}</p>`;
    html += sqlBlock('השאילתה שהפיקה את הסיכום השנתי', a.res.sql);
    html += sqlBlock('השאילתה שמחזירה את העסקאות', over.rawRowsSql(a.res.geometry, a.res.filters, 0));
  }
  pane.innerHTML = html;
  $$('[data-area]', pane).forEach((b) => { b.onclick = () => { state.rawAreaId = b.dataset.area; renderRaw(computed()); }; });
  const dlYears = $('#dl-years', pane);
  if (dlYears) dlYears.onclick = () => download(`${a.name}-years.csv`, csv(a.res.years, YEAR_COLS));
  const loadBtn = $('#load-raw', pane);
  if (loadBtn) {
    loadBtn.disabled = !!a.res.rawLoading;
    loadBtn.onclick = () => loadRaw(a, loadBtn);
  }
  const dlRaw = $('#dl-raw', pane);
  if (dlRaw) dlRaw.onclick = () => download(`${a.name}-deals.csv`, csv(a.res.raw.rows, RAW_COLS.map(([k]) => k)));
}

async function loadRaw(a, btn) {
  const res = a.res;
  if (res.rawLoading) return; // a re-render may have shown an enabled button again
  res.rawLoading = true;
  btn.disabled = true;
  btn.textContent = 'טוען…';
  const raw = res.raw || { rows: [] };
  try {
    const r = await over.runSql(over.rawRowsSql(res.geometry, res.filters, raw.rows.length));
    raw.rows.push(...r.rows);
    raw.error = null;
  } catch (e) {
    raw.error = e.message;
  }
  res.rawLoading = false;
  if (a.res === res) res.raw = raw; // ignore if the area was recomputed meanwhile
  renderRaw(computed());
}

function sqlBlock(title, sql) {
  const url = over.consoleUrl(sql);
  const link = url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener">פתח בקונסולת ה-SQL של OVER</a> <span class="muted">(ההרצה שם דורשת התחברות)</span>`
    : `<span class="muted">השאילתה ארוכה מכדי להעביר בקישור (האזור מפורט) — העתיקו אותה לקונסולה של OVER ב-<a href="${over.OVER}/data" target="_blank" rel="noopener">over.org.il/data</a>.</span>`;
  return `<details><summary>${esc(title)}</summary>
    <pre class="sql">${esc(sql)}</pre>
    <p class="small">${link}</p></details>`;
}

// ── method ─────────────────────────────────────────────────────────────────
function renderMethod(list) {
  const f = state.filters;
  const M = METRICS[f.metric];
  let html = `
  <h3>1. מאזור מצויר לעסקאות</h3>
  <p>משיכת מברשת היא קו שמורחב לשני צדדיו בחצי מעובי המברשת (buffer), והאזור הוא איחוד כל המשיכות (פחות משיכות המחק).
  המאגר של רשות המסים אינו כולל קואורדינטות — רק גוש וחלקה. לכן האזור מתורגם לחלקות: נכללת כל חלקה ש<b>נקודה פנימית שלה</b> (ST_PointOnSurface)
  נמצאת בתוך האזור, כדי שחלקה גדולה שהמברשת רק נגעה בשוליה לא תכניס את העסקאות שלה. העסקאות מחוברות לחלקות לפי גוש + חלקה.</p>
  <p>סינון: מהות העסקה (${esc(queried(list).natures.join(', ') || 'ללא סינון')}), שנים ${yr(queried(list).yearMin)}–${yr(queried(list).yearMax)} לפי תאריך העסקה.</p>

  <h3>2. המדד</h3>
  <p>המחיר למ"ר <b>מנורמל</b>: השטח במאגר הוא שטח הנכס כולו, והשווי משולם רק על החלק שנמכר, ולכן:</p>
  <span class="formula">P = deal_amount / (asset_area × portion)</span>
  <p>עסקה בלי שטח, בלי חלק נמכר (0) או בלי שווי לא נכנסת למדד הזה (אך נספרת בסך העסקאות). לכל שנה t מחושב <b>החציון</b>:</p>
  <span class="formula">M<sub>t</sub> = median{ P<sub>i</sub> : year(i) = t }</span>
  <p>חציון ולא ממוצע: שורה אחת במאגר יכולה להיות דירה אחת או בניין שלם, ושורה כזו מזיזה ממוצע במיליונים.
  המדד החלופי, "חציון שווי עסקה", הוא חציון deal_amount בלי חלוקה בשטח.</p>

  <h3>3. שנים דלות</h3>
  <p>שנה נכנסת לחישוב רק אם יש מאחורי החציון שלה לפחות ${fmt(f.minDeals)} עסקאות (n<sub>t</sub> ≥ ${fmt(f.minDeals)}). חציון של עסקאות בודדות זז בעשרות אחוזים מרעש בלבד.</p>

  <h3>4. שינוי בין שתי שנים</h3>
  <span class="formula">Δ% = (M<sub>B</sub> / M<sub>A</sub> − 1) × 100</span>
  <span class="formula">CAGR = ((M<sub>B</sub> / M<sub>A</sub>)<sup>1/(B−A)</sup> − 1) × 100</span>
  <p>A = שנת הבסיס (${yr(f.cmpFrom)}), B = שנת ההשוואה (${yr(f.cmpTo)}). CAGR הוא השינוי השנתי הקבוע שהיה מביא מ-M<sub>A</sub> ל-M<sub>B</sub>.</p>

  <h3>5. שינוי המגמה — רגרסיה לוגריתמית משוקללת</h3>
  <p>שתי נקודות רגישות לשנה חריגה בכל אחד מהקצוות. לכן מחושב גם קו מגמה על <b>כל</b> השנים הכשירות בין A ל-B:
  רגרסיה של ln(M<sub>t</sub>) על השנה, במשקל מספר העסקאות n<sub>t</sub>, כך ששנה דלה מושכת את הקו פחות משנה עם אלפי עסקאות.</p>
  <span class="formula">t̄ = Σ n<sub>t</sub>·t / Σ n<sub>t</sub> ,  ȳ = Σ n<sub>t</sub>·ln M<sub>t</sub> / Σ n<sub>t</sub></span>
  <span class="formula">b = Σ n<sub>t</sub>(t − t̄)(ln M<sub>t</sub> − ȳ) / Σ n<sub>t</sub>(t − t̄)²</span>
  <span class="formula">T = (e<sup>b</sup> − 1) × 100</span>
  <span class="formula">R² = 1 − Σ n<sub>t</sub>(ln M<sub>t</sub> − a − b·t)² / Σ n<sub>t</sub>(ln M<sub>t</sub> − ȳ)² ,  a = ȳ − b·t̄</span>
  <p>T היא המגמה השנתית באחוזים. R² קרוב ל-1: המחירים נעו בקצב קבוע למדי; קרוב ל-0: קו ישר לא מתאר את התנועה, והמגמה פחות משמעותית. נדרשות לפחות 3 שנים כשירות.</p>

  <h3>6. השוואה בין אזורים</h3>
  <span class="formula">L = 100 × M<sub>B</sub>(area) / M<sub>B</sub>(ref)</span>
  <span class="formula">G = T(area) − T(ref)</span>
  <span class="formula">I<sub>t</sub> = 100 × M<sub>t</sub> / M<sub>A</sub></span>
  <p>L — רמת המחיר של האזור ביחס לאזור הייחוס בשנת ההשוואה (100 = זהה). G — פער המגמה בנקודות אחוז (נ"א). I — המדד (הגרף השני), שמציב את כל האזורים על אותו ציר למרות רמות מחיר שונות: כל אזור מתחיל ב-100 בשנת הבסיס.</p>

  <h3>הצבה — המספרים של כל אזור (${esc(M.label)})</h3>`;

  const ref = reference(list);
  const refA = ref ? analyse(ref) : null;
  for (const a of list) {
    html += `<div class="area-block"><h3>${dot(a)}</h3>`;
    if (a.res.error) {
      html += `<p class="neg">${esc(a.res.error)}</p></div>`;
      continue;
    }
    const x = analyse(a);
    const c = x.change;
    if (c) {
      html += `<span class="formula">Δ% = (${fmt(c.to.m)} / ${fmt(c.from.m)} − 1) × 100 = ${c.pct.toFixed(2)}%</span>
        <span class="formula">CAGR = ((${fmt(c.to.m)} / ${fmt(c.from.m)})<sup>1/${c.years}</sup> − 1) × 100 = ${c.cagr.toFixed(2)}%</span>`;
    } else {
      html += `<p class="muted">לא ניתן לחשב Δ%: ${yr(f.cmpFrom)} או ${yr(f.cmpTo)} אינה שנה כשירה באזור זה.</p>`;
    }
    const t = x.trend;
    if (t) {
      html += `<span class="formula">t̄ = ${t.tBar.toFixed(3)} ,  ȳ = ${t.yBar.toFixed(4)} ,  b = ${t.b.toFixed(5)} ,  a = ${t.a.toFixed(3)}</span>
        <span class="formula">T = (e<sup>${t.b.toFixed(5)}</sup> − 1) × 100 = ${t.annualPct.toFixed(2)}% ,  R² = ${t.r2.toFixed(3)}</span>`;
      if (refA?.trend && ref.id !== a.id) {
        html += `<span class="formula">G = ${t.annualPct.toFixed(2)} − (${refA.trend.annualPct.toFixed(2)}) = ${(t.annualPct - refA.trend.annualPct).toFixed(2)} pp</span>`;
      }
      html += `<details><summary>הנקודות שנכנסו לרגרסיה (${t.n})</summary><table><thead><tr><th>t</th><th>n<sub>t</sub></th><th>M<sub>t</sub></th><th>ln M<sub>t</sub></th><th>קו המגמה</th></tr></thead><tbody>
        ${x.win.map((p) => `<tr><td class="n">${p.yr}</td><td class="n">${fmt(p.n)}</td><td class="n">${fmt(p.m)}</td><td class="n">${fmt(Math.log(p.m), 4)}</td><td class="n">${fmt(Math.exp(t.a + t.b * p.yr))}</td></tr>`).join('')}
        </tbody></table></details>`;
    } else {
      html += `<p class="muted">לא ניתן לחשב מגמה: פחות מ-3 שנים כשירות בין ${yr(f.cmpFrom)} ל-${yr(f.cmpTo)}.</p>`;
    }
    html += '</div>';
  }

  html += `<h3 style="margin-top:1.2rem">הסתייגויות</h3><ul class="small">
    <li>המקור הוא שורות רשות המסים כפי שפורסמו ב-<a href="https://www.over.org.il/projects/deals" target="_blank" rel="noopener">גרסאות לעם</a>: הן לא עובדו, לא תוקנו ולא הושלמו.${state.register ? ` המאגר כולל ${fmt(state.register.deals)} עסקאות, ${esc(state.register.first_deal)} עד ${esc(state.register.last_deal)}.` : ''}</li>
    <li>המאגר אינו מפרסם תת-גוש. חלקות שחולקות מספר גוש+חלקה עם תת-גוש שונה עלולות לקבל את אותן עסקאות.</li>
    <li>שטח הנכס הוא שטח הנכס כולו; חלק נמכר קטן מאוד (למשל 0.001) מעוגל לשלוש ספרות, ולכן המחיר המנורמל שלו לא מדויק.</li>
    <li>חציון של שנה משקף גם את <b>תמהיל</b> הנכסים שנמכרו באותה שנה (גודל, גיל, מיקום בתוך האזור), לא רק שינוי מחיר של אותם נכסים.</li>
    <li>אזורים חופפים חולקים עסקאות; אזור בתוך אזור משווה חלק לשלם, לא שתי קבוצות זרות.</li>
  </ul>`;
  $('[data-pane=method]').innerHTML = html;
}

// ── boot ───────────────────────────────────────────────────────────────────
load();
writeFilters();
renderAreas();
const withGeom = state.areas.filter((a) => a.geom);
if (withGeom.length) map.fitBounds(L.featureGroup(withGeom.map((a) => a.layer)).getBounds(), { padding: [30, 30] });

over.registerStats().then((s) => {
  state.register = s;
  $('#register').innerHTML = `${fmt(s.deals)} עסקאות · <span class="num">${esc(s.first_deal)}</span> עד <span class="num">${esc(s.last_deal)}</span><br>
    ${/^https?:\/\//.test(s.source_url || '') ? `<a href="${esc(s.source_url)}" target="_blank" rel="noopener">מקור: רשות המסים</a>` : ''}`;
}).catch((e) => { $('#register').textContent = 'OVER לא זמין: ' + e.message; });

over.natures().then((list) => {
  state.natureList = list;
  renderNatures();
}).catch((e) => {
  $('#natures').innerHTML = `<p class="neg small">טעינת סוגי העסקאות נכשלה: ${esc(e.message)}</p>`;
});

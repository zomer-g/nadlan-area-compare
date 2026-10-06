import * as over from './over.js?v=0ca9b3f253';
import { METRICS, eligible, pointChange, logTrend, indexTo, within } from './stats.js?v=0ca9b3f253';
import {
  markDuplicates,
  SIZE_GROUPS, AGE_GROUPS, OUTLIER_METHODS, SIGMA_K, SIGMA_ROUNDS, SIGMA_MIN_N, PRESCREEN_K, SIGMA_REF_N, REFERENCE_STEPS, FIXED_RANGE, MIN_AMOUNT,
  MIN_YEAR_BUILT, MAX_YEARS_AHEAD, enrich, markOutliers, select, yearly, turnover,
} from './analysis.js?v=0ca9b3f253';
import { loadExternal } from './external.js?v=0ca9b3f253';
import { createBrush } from './brush.js?v=0ca9b3f253';
import { createParcelLayer } from './parcels.js?v=0ca9b3f253';
import { buildStatTables, AREA_COLS, SETTLEMENT_COLS } from './statexport.js?v=0ca9b3f253';
import { createOverlays, OUTLINES, THEMES } from './layers.js?v=0ca9b3f253';
import { esc } from './util.js?v=0ca9b3f253';

const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#ca8a04', '#db2777'];
const STORE_KEY = 'nadlan-area-compare:v2';
const THIS_YEAR = new Date().getFullYear();
const DEFAULT_TYPE = 'מגורים רווי';
const OFF_BY_DEFAULT = new Set(['לא רלבנטי', 'סחר נדל"ן']);
const UNMAPPED = 'לא ממופה';
const LOW_QUALITY = 0.5; // below this share of deals in use, an area is flagged
const PAGE = 200;

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
const share = (v) => (v == null ? '—' : `${fmt(v * 100, 0)}%`);
const widthFromSlider = (v) => Math.round(5 * Math.pow(400, v / 100)); // 5 m … 2 km, log scale
const sizeLabel = (k) => SIZE_GROUPS.find((g) => g.key === k)?.label ?? k;
const ageLabel = (k) => AGE_GROUPS.find((g) => g.key === k)?.label ?? k;
const DROP_LABEL = { invalid: 'חסר נתון (שווי/שטח/חלק)', nosize: 'ללא גודל', outlier: 'חריג' };
const DUP_LABEL = 'כפולה (לא נספרת)';
const ymd = (n) => `${String(n % 100).padStart(2, '0')}/${String(Math.floor(n / 100) % 100).padStart(2, '0')}/${Math.floor(n / 10000)}`;

const state = {
  areas: [],
  activeId: null,
  refId: null,
  mode: 'pan',
  filters: {
    types: [DEFAULT_TYPE],
    yearMin: 2008,
    yearMax: THIS_YEAR,
    cmpFrom: THIS_YEAR - 7,
    cmpTo: THIS_YEAR - 1,
    minDeals: 10,
    metric: 'mean_pp',
    size: 'all',
    ages: AGE_GROUPS.map((g) => g.key),
    outlier: 'sigma',
  },
  natureList: [],
  ext: null,
  register: null,
  tab: 'compare',
  rawAreaId: null,
  rawPage: 0,
  busy: false,
};
const charts = {};

// ── persistence (per-viewer convenience only) ──────────────────────────────
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      areas: state.areas.map(({ id, name, color, geom, origin, picks }) => ({ id, name, color, geom, origin, picks })),
      activeId: state.activeId,
      refId: state.refId,
      filters: state.filters,
    }));
  } catch { /* storage unavailable: the page still works, it just forgets */ }
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || localStorage.getItem('nadlan-area-compare:v1') || 'null');
    if (s) restore(s);
  } catch { /* corrupt or blocked storage: start clean */ }
}

// Rebuild areas and filters from a saved snapshot (local storage or a saved
// analysis). Everything in it is validated: a shared link is someone else's data.
function restore(s) {
  {
    const f = s.filters || {};
    const F = state.filters;
    for (const k of ['yearMin', 'yearMax', 'cmpFrom', 'cmpTo', 'minDeals']) if (Number.isInteger(f[k])) F[k] = f[k];
    if (f.metric in METRICS) F.metric = f.metric;
    if (f.outlier in OUTLIER_METHODS) F.outlier = f.outlier;
    if (f.size === 'all' || SIZE_GROUPS.some((g) => g.key === f.size && g.key !== 's0')) F.size = f.size;
    const strings = (x) => Array.isArray(x) && x.every((v) => typeof v === 'string');
    if (strings(f.types)) F.types = f.types;
    if (strings(f.ages)) F.ages = f.ages.filter((k) => AGE_GROUPS.some((g) => g.key === k));
    for (const a of Array.isArray(s.areas) ? s.areas : []) {
      const okGeom = a?.geom?.type === 'Feature' && ['Polygon', 'MultiPolygon'].includes(a.geom.geometry?.type);
      try {
        addArea({
          id: /^[a-z0-9]{1,40}$/.test(a?.id) ? a.id : undefined,
          name: typeof a?.name === 'string' ? a.name.slice(0, 60) : undefined,
          color: /^#[0-9a-f]{6}$/i.test(a?.color) ? a.color : undefined,
          geom: okGeom ? a.geom : null,
          origin: typeof a?.origin === 'string' ? a.origin.slice(0, 300) : null,
          picks: Array.isArray(a?.picks) ? a.picks.filter((n) => typeof n === 'string').map((n) => n.slice(0, 80)).slice(0, 200) : [],
        }, false);
      } catch { /* one bad area must not lose the others */ }
    }
    state.activeId = s.activeId && getArea(s.activeId) ? s.activeId : state.areas[0]?.id ?? null;
    state.refId = s.refId && getArea(s.refId) ? s.refId : null;
  }
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

const parcels = createParcelLayer(map, (msg) => { $('#parcel-status').textContent = msg; }, {
  picking: () => state.mode === 'pick-parcel',
  onPick: (name, geometry, shuma) => addPicked('parcel', name, geometry,
    shuma ? 'שכבת חלקות השומה — לא סטטוטורית (מ-OVER)' : 'שכבת החלקות הסטטוטורית (מ-OVER, בזמן אמת)'),
});

// Data layers, in a control right under the base-map switcher.
const overlays = createOverlays(map, {
  onStatus: (msg) => { const el = $('#layers-status'); if (el) el.textContent = msg; },
  onPick: (kind, name, geometry, source) => addPicked(kind, name, geometry, source),
});
const layersCtl = L.control({ position: 'topleft' });
layersCtl.onAdd = () => {
  const div = L.DomUtil.create('div', 'leaflet-bar layers-box');
  div.innerHTML = `<b>שכבות נתונים (OVER)</b>
    ${Object.entries(OUTLINES).map(([k, d]) => `<label><input type="checkbox" data-outline="${k}"> ${esc(d.label)}</label>`).join('')}
    <label>מפה נושאית
      <select id="theme"><option value="">ללא</option>${Object.entries(THEMES).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('')}</select>
    </label>
    <div class="dl-box"><b>הורדת נתוני א"ס (CSV)</b>
      <button type="button" data-dl="areas" title="כל אזור סטטיסטי שחותך כל אחד מאזורי הניתוח, עם החלק שבתוך האזור">לאזורי הניתוח</button>
      <button type="button" data-dl="settlements" title="כל האזורים הסטטיסטיים של הרשויות המקומיות שאזורי הניתוח נמצאים בהן">לרשויות המקומיות שלהם</button>
    </div>
    <div id="layers-status" class="muted"></div>`;
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);
  $$('[data-outline]', div).forEach((c) => { c.onchange = () => overlays.setOutline(c.dataset.outline, c.checked); });
  $('#theme', div).onchange = (e) => overlays.setTheme(e.target.value);
  $$('[data-dl]', div).forEach((b) => { b.onclick = () => downloadStats(b.dataset.dl, b); });
  return div;
};
layersCtl.addTo(map);
// Statistical-area tables of every theme, for the analysis areas or for the
// local authorities they fall in (js/statexport.js).
async function downloadStats(kind, btn) {
  const say = (m) => { $('#layers-status').textContent = m; };
  const areas = state.areas.filter((a) => a.geom).map((a) => ({ name: a.name, geom: a.geom }));
  if (!areas.length) {
    say('אין אזורי ניתוח — סמנו אזור או בחרו שכונה קודם.');
    return;
  }
  btn.disabled = true;
  try {
    const t = await buildStatTables(areas, say);
    const day = new Date().toISOString().slice(0, 10);
    if (kind === 'areas') {
      download(`אזורים-סטטיסטיים_אזורי-ניתוח_${day}.csv`, csv(t.areaRows, AREA_COLS));
      say(`הורד: ${fmt(t.areaRows.length)} שורות (א"ס × אזור ניתוח).`);
    } else {
      download(`אזורים-סטטיסטיים_רשויות_${day}.csv`, csv(t.settlementRows, SETTLEMENT_COLS));
      say(`הורד: ${fmt(t.settlementRows.length)} אזורים סטטיסטיים ב-${fmt(t.settlements)} רשויות.`);
    }
  } catch (e) {
    say(`ההורדה נכשלה: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

function syncOutlineBoxes() {
  for (const [k, o] of Object.entries(overlays.outlines)) {
    const c = $(`[data-outline="${k}"]`);
    if (c) c.checked = o.on;
  }
}
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

function areaStyle(a) {
  const q = a.res && !a.res.error ? quality(a) : null;
  const weak = q != null && q < LOW_QUALITY;
  return { color: a.color, weight: weak ? 3 : 2, dashArray: weak ? '6 5' : null, fillOpacity: 0.22 };
}

function addArea(init = {}, activate = true) {
  const used = new Set(state.areas.map((a) => a.color));
  const n = state.areas.length + 1;
  const a = {
    id: init.id || `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: init.name || `אזור ${n}`,
    color: init.color || COLORS.find((c) => !used.has(c)) || COLORS[n % COLORS.length],
    geom: init.geom || null,
    origin: init.origin || null, // where a picked shape came from; null when drawn
    picks: init.picks || [], // names of the neighbourhoods / statistical areas it is made of
    res: null,
    layer: null,
  };
  a.layer = L.geoJSON(null, { interactive: false, style: () => areaStyle(a) });
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

function geometryChanged(a) {
  a.res = null;
  redrawArea(a);
  save();
  renderAreas();
  renderResults();
  markStale();
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
  const EDITED = ' (נערך במברשת)';
  if (a.origin && !a.origin.endsWith(EDITED)) a.origin += EDITED;
  geometryChanged(a);
}

function areaSize(geom) {
  if (!geom) return 'ריק — צבעו במברשת או בחרו שכונה';
  const m2 = turf.area(geom);
  return m2 >= 1e6 ? `${fmt(m2 / 1e6, 2)} קמ"ר` : `${fmt(m2 / 1000, 1)} דונם`;
}

function renderAreas() {
  const ul = $('#areas');
  ul.innerHTML = '';
  if (!state.areas.length) {
    ul.innerHTML = '<li class="muted small">אין עדיין אזורים. צבעו במברשת, או בחרו שכונה / אזור סטטיסטי בלחיצה על המפה.</li>';
    return;
  }
  for (const a of state.areas) {
    const li = document.createElement('li');
    li.className = a.id === state.activeId ? 'active' : '';
    li.style.color = a.color;
    let meta = areaSize(a.geom);
    if (a.res && !a.res.error) {
      const q = quality(a);
      meta += ` · ${fmt(a.res.counted.length)} עסקאות · ${share(q)} בשימוש${q != null && q < LOW_QUALITY ? ' ⚠' : ''}`;
    }
    li.innerHTML = `
      <button type="button" class="swatch" style="background:${a.color}" title="הפוך לאזור הפעיל" aria-label="בחר ${esc(a.name)}"></button>
      <input type="text" value="${esc(a.name)}" aria-label="שם האזור" maxlength="60">
      <span class="acts">
        <button type="button" data-act="zoom" title="התמקד">🔍</button>
        <button type="button" data-act="clear" title="נקה את הסימון">↺</button>
        <button type="button" data-act="del" title="מחק אזור">✖</button>
      </span>
      <span class="meta">${esc(meta)}${a.picks?.length > 1 ? `<br>${a.picks.length} פוליגונים: ${esc(a.picks.join(' · '))}` : ''}${a.origin ? `<br>${esc(a.origin)}` : ''}</span>`;
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
    $('[data-act=clear]', li).onclick = () => { a.geom = null; a.origin = null; a.picks = []; geometryChanged(a); };
    $('[data-act=del]', li).onclick = () => removeArea(a.id);
    ul.appendChild(li);
  }
}

// ── modes: pan / paint / erase / pick a neighbourhood or statistical area ──
function setMode(m) {
  state.mode = m;
  brush.setMode(m === 'paint' || m === 'erase' ? m : 'pan');
  map.getContainer().classList.toggle('picking', m.startsWith('pick'));
  // A double-click fires two clicks: in pick mode it would add the polygon twice.
  if (m.startsWith('pick')) map.doubleClickZoom.disable();
  else if (m === 'pan') map.doubleClickZoom.enable();
  $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  if ((m === 'paint' || m === 'erase') && !state.areas.length) {
    addArea();
    save();
    renderAreas();
  }
  $('#pick-hint').hidden = !m.startsWith('pick');
  overlays.setPick({ 'pick-nbr': 'neighborhood', 'pick-stat': 'stat', 'pick-gush': 'gush' }[m] || null);
  if (m === 'pick-parcel' && !$('#show-parcels').checked) { $('#show-parcels').checked = true; parcels.setEnabled(true); }
  if (m === 'pick-parcel' && map.getZoom() < 16) setStatus('החלקות מוצגות מזום 16 — התקרבו כדי לבחור חלקות.');
  syncOutlineBoxes();
}

// A polygon clicked in pick mode either joins the active area (default), so
// several neighbourhoods or statistical areas are analysed as one, or becomes
// a new area of its own. Clicking a polygon the active area already holds
// takes it out again.
function pickTarget() {
  return $('input[name=pick-target]:checked')?.value === 'new' ? 'new' : 'active';
}

function pickedName(picks) {
  const full = picks.join(' + ');
  return full.length <= 60 ? full : `${picks[0]} ועוד ${picks.length - 1}`;
}

const PICK_LABEL = { neighborhood: 'שכונה', stat: 'אזור סטטיסטי', gush: 'גוש', parcel: 'חלקה' };

function addPicked(kind, name, geometry, source) {
  const label = PICK_LABEL[kind];
  // Parcels are small and exact: never simplified. The rest to ~2 m.
  const f = turf.feature(geometry);
  const poly = turf.truncate(kind === 'parcel' ? f : turf.simplify(f, { tolerance: 0.00002, highQuality: true }), { precision: 6 });
  const originOf = (a) => [...new Set([...(a.origin ? [a.origin] : []), `${label} — ${source}`])].join(' · ').slice(0, 300);

  if (pickTarget() === 'new') {
    const dup = state.areas.find((a) => a.picks?.length === 1 && a.picks[0] === name);
    if (dup) {
      state.activeId = dup.id;
      renderAreas();
      setStatus(`"${name}" כבר ברשימת האזורים.`);
      return;
    }
    const a = addArea({ name, geom: poly, picks: [name] });
    a.origin = originOf(a);
    save();
    renderAreas();
    setStatus(`נוסף אזור חדש: ${name} — לחצו "חשב והשווה" כשתסיימו לבחור.`);
    return;
  }

  let a = getArea(state.activeId);
  if (!a) a = addArea({ picks: [] });
  a.picks = a.picks || [];
  const autoName = !a.geom || a.name === pickedName(a.picks) || /^אזור \d+$/.test(a.name);
  let msg;
  try {
    if (a.picks.includes(name)) {
      a.geom = turf.difference(turf.featureCollection([a.geom, poly]));
      a.picks = a.picks.filter((n) => n !== name);
      msg = `הוסר מ"${a.name}": ${name}`;
    } else {
      a.geom = a.geom ? turf.union(turf.featureCollection([a.geom, poly])) : poly;
      a.picks.push(name);
      a.origin = originOf(a);
      msg = `נוסף ל"${a.name}": ${name} (${a.picks.length} באזור)`;
    }
  } catch (e) {
    setStatus('לא ניתן היה למזג את הפוליגון: ' + e.message);
    return;
  }
  if (autoName && a.picks.length) a.name = pickedName(a.picks);
  if (!a.geom) a.origin = null;
  geometryChanged(a);
  setStatus(`${msg} — לחצו "חשב והשווה" כשתסיימו לבחור.`);
}
$$('.seg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.key === 'Escape') setMode('pan');
  else if (e.key === 'b' || e.key === 'נ') setMode('paint');
  else if (e.key === 'e' || e.key === 'ק') setMode('erase');
});

let picking = false;
map.on('click', async (e) => {
  // Fallback for neighbourhoods / statistical areas when zoomed out past their
  // outline layer: ask OVER for the polygon under the click.
  if (!['pick-nbr', 'pick-stat'].includes(state.mode) || picking) return;
  const kind0 = state.mode === 'pick-nbr' ? 'neighborhood' : 'stat';
  if (map.getZoom() >= OUTLINES[kind0].minZoom) return; // the polygon itself handles the click
  picking = true;
  const kind = state.mode === 'pick-nbr' ? 'neighborhood' : 'stat';
  const L0 = over.PICK_LAYERS[kind];
  setStatus(`מאתר ${L0.label}…`);
  try {
    const hit = await over.polygonAt(kind, e.latlng.lat, e.latlng.lng);
    if (!hit) {
      setStatus(`אין ${L0.label} בנקודה הזאת.`);
      return;
    }
    addPicked(kind, hit.name, hit.geometry, L0.source);

  } catch (err) {
    setStatus(`שגיאה באיתור ${L0.label}: ${err.message}`);
  } finally {
    picking = false;
  }
});

function showWidth() {
  const w = widthFromSlider(Number($('#width').value));
  $('#width-out').textContent = w >= 1000 ? `${fmt(w / 1000, 1)} ק"מ` : `${w} מ'`;
}
$('#width').oninput = showWidth;
showWidth();

$('#show-parcels').onchange = (e) => parcels.setEnabled(e.target.checked);
$('#add-area').onclick = () => { addArea(); save(); renderAreas(); if (state.mode === 'pan') setMode('paint'); };

// ── filters ────────────────────────────────────────────────────────────────
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
  f.metric = $('#metric').value in METRICS ? $('#metric').value : 'mean_pp';
  f.outlier = $('#outlier').value in OUTLIER_METHODS ? $('#outlier').value : 'sigma';
  f.size = $('#size').value;
  f.ages = $$('#ages input:checked').map((i) => i.value);
  // Only once the list has loaded — an empty list must not read as "no filter".
  if ($$('#types input').length) f.types = $$('#types input:checked').map((i) => i.value);
}
function writeFilters() {
  const f = state.filters;
  $('#year-min').value = f.yearMin;
  $('#year-max').value = f.yearMax;
  $('#cmp-from').value = f.cmpFrom;
  $('#cmp-to').value = f.cmpTo;
  $('#min-deals').value = f.minDeals;
  $('#metric').value = f.metric;
  $('#outlier').value = f.outlier;
  $('#size').innerHTML = `<option value="all">כל הגדלים</option>${SIZE_GROUPS.filter((g) => g.key !== 's0')
    .map((g) => `<option value="${g.key}">${esc(g.label)}</option>`).join('')}`;
  $('#size').value = f.size;
  $('#ages').innerHTML = AGE_GROUPS.map((g) => `<label><input type="checkbox" value="${g.key}" ${f.ages.includes(g.key) ? 'checked' : ''}> ${esc(g.label)}</label>`).join('');
}

// Inputs that only change how the loaded deals are read re-render at once;
// inputs that change what is fetched mark the results stale.
for (const id of ['#cmp-from', '#cmp-to', '#min-deals', '#metric', '#outlier', '#size']) {
  $(id).addEventListener('change', () => { readFilters(); save(); renderAreas(); restyleAreas(); renderResults(); });
}
$('#ages').addEventListener('change', () => { readFilters(); save(); renderResults(); });
for (const id of ['#year-min', '#year-max']) {
  $(id).addEventListener('change', () => { readFilters(); save(); renderResults(); markStale(); });
}

function typeOf(nature) {
  return state.ext?.natureType.get(nature) || UNMAPPED;
}

function renderTypes() {
  const byType = new Map();
  for (const n of state.natureList) {
    const t = typeOf(n.nature);
    if (!byType.has(t)) byType.set(t, { deals: 0, natures: [] });
    byType.get(t).deals += n.deals;
    byType.get(t).natures.push(n.nature);
  }
  const list = [...byType.entries()].sort((a, b) => b[1].deals - a[1].deals);
  $('#types').innerHTML = list.map(([t, v]) => `
    <label title="${esc(v.natures.join(' · '))}"><input type="checkbox" value="${esc(t)}" ${state.filters.types.includes(t) ? 'checked' : ''}>
      ${esc(t)}${OFF_BY_DEFAULT.has(t) ? ' <span class="muted">(מחוץ לניתוח המגורים)</span>' : ''} <span class="cnt num">${fmt(v.deals)}</span></label>`).join('');
  $('#types-detail').innerHTML = list.map(([t, v]) => `<li><b>${esc(t)}:</b> ${esc(v.natures.join(' · '))}</li>`).join('');
  $('#types').onchange = () => { readFilters(); save(); renderTypeNotes(); renderResults(); markStale(); };
  renderTypeNotes();
}
function selectedNatures(types = state.filters.types) {
  return state.natureList.filter((n) => types.includes(typeOf(n.nature))).map((n) => n.nature);
}
function renderTypeNotes() {
  const natures = new Set(selectedNatures());
  const notes = state.natureList.filter((n) => natures.has(n.nature) && n.note);
  let html = notes.map((n) => `<p>${esc(n.note)}</p>`).join('');
  if (!state.filters.types.length) html = '<p>לא נבחר סוג נכס.</p>';
  else if (state.filters.types.length > 1) html += '<p>נבחרו כמה סוגי נכס — שינוי בתמהיל ביניהם לאורך השנים ישפיע על הממוצע.</p>';
  $('#type-notes').innerHTML = html;
}

function setStatus(msg) {
  $('#compute-status').textContent = msg;
}
function markStale() {
  if (state.areas.some((a) => a.geom && !a.res)) setStatus('יש אזורים שלא חושבו או שהשתנו — לחצו "חשב והשווה".');
  else if (state.areas.some((a) => a.res) && queriedDiffers(computed())) setStatus('הסינון השתנה — לחצו "חשב והשווה" לעדכון.');
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
      const nbr = state.ext?.neighborhoodOf(Number(g[1]));
      out.innerHTML = r.shuma
        ? `<li class="muted">גוש שומה ${esc(g[1])} — לא סטטוטורי (אין לו חלקות בשכבה הסטטוטורית)</li>`
        : `<li class="muted">גוש ${esc(g[1])} · ${fmt(r.parcels)} חלקות${nbr ? ` · שכונה לפי טבלת העזר: ${esc(nbr)}` : ''}</li>`;
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

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function compute() {
  if (state.busy) return;
  readFilters();
  save();
  const areas = state.areas.filter((a) => a.geom);
  if (!areas.length) {
    setStatus('אין אזור מסומן. צבעו במברשת או בחרו שכונה.');
    return;
  }
  if (!state.natureList.length || !state.ext) {
    setStatus(state.typesError
      ? `אי אפשר לחשב: ${state.typesError}`
      : 'רשימת סוגי העסקאות עדיין נטענת מ-OVER — נסו שוב בעוד רגע.');
    return;
  }
  const f = state.filters;
  const natures = selectedNatures();
  if (!natures.length) {
    setStatus('לא נבחר סוג נכס.');
    return;
  }
  state.busy = true;
  $('#compute').disabled = true;
  const sqlFilters = { types: [...f.types], natures, yearMin: f.yearMin, yearMax: f.yearMax };
  let failed = 0;
  try {
    for (const [i, a] of areas.entries()) {
      const g0 = a.geom;
      let sql = '';
      try {
        const geometry = queryGeometry(g0);
        const sig = JSON.stringify([geometry, natures, f.yearMin, f.yearMax]);
        if (a.res && !a.res.error && a.res.sig === sig) continue;
        setStatus(`מחשב ${i + 1}/${areas.length}: ${a.name}…`);
        sql = over.dealsSql(geometry, sqlFilters);
        const r = await over.runSql(sql);
        // Edited, cleared or deleted while the query ran: the answer is for a shape that no longer exists.
        if (a.geom !== g0 || !state.areas.includes(a)) continue;
        const row = r.rows[0];
        const raw = parseJson(row.deals);
        if (raw == null && Number(row.deals_total) > 0) {
          throw new Error(`באזור ${fmt(row.deals_total)} עסקאות — יותר מ-${fmt(over.MAX_DEALS)} שהדפדפן יכול לעבד. צמצמו את האזור, את טווח השנים או את סוגי הנכס.`);
        }
        a.res = {
          sig, sql, geometry, filters: sqlFilters,
          parcels_in_area: Number(row.parcels_in_area),
          shuma_parcels: Number(row.shuma_parcels || 0),
          shuma_deals: Number(row.shuma_deals || 0),
          parcels_area: row.parcels_area == null ? null : Number(row.parcels_area),
          parcels_with_deals_area: row.parcels_with_deals_area == null ? null : Number(row.parcels_with_deals_area),
          parcels_area_measured: Number(row.parcels_area_measured || 0),
          parcels_with_deals: Number(row.parcels_with_deals),
          deals_total: Number(row.deals_total),
          households: row.households == null ? null : Number(row.households),
          stat_areas: Number(row.stat_areas),
          stat_areas_no_hh: Number(row.stat_areas_no_hh),
          settlements: parseJson(row.settlements) || {},
          deals: (raw || []).map((d) => enrich(d, state.ext.natureType)),
          outlierMethod: null,
          outlierReport: null,
        };
        // Duplicates are marked once and counted nowhere: `counted` is what
        // every statistic, count and the quality share are built on.
        a.res.duplicates = markDuplicates(a.res.deals);
        a.res.counted = a.res.deals.filter((d) => !d.dup);
      } catch (e) {
        if (a.geom !== g0 || !state.areas.includes(a)) continue;
        failed += 1;
        const hint = /timeout|canceling statement/i.test(e.message)
          ? ' — האזור גדול מדי לשאילתה אחת (תקרת זמן ב-OVER). נסו אזור קטן יותר.' : '';
        a.res = { sig: null, sql, filters: sqlFilters, error: e.message + hint };
      }
    }
    setStatus(failed ? `הושלם, ${failed} אזורים נכשלו — ראו פירוט בטבלה.` : 'הושלם.');
    markStale(); // an area added or edited while this ran is still pending
  } finally {
    state.busy = false;
    $('#compute').disabled = false;
  }
  renderAreas();
  restyleAreas();
  renderResults();
  $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
$('#compute').onclick = compute;

// ── analysis ───────────────────────────────────────────────────────────────
// The outlier filter depends only on the method, so it is re-run only when the
// method changes; everything downstream is cheap.
function prepared(a) {
  const m = state.filters.outlier;
  if (a.res.outlierMethod !== m) {
    a.res.outlierReport = markOutliers(a.res.counted, m);
    a.res.outlierMethod = m;
  }
  return a.res.counted;
}

function selection(a, { size = state.filters.size, ages = state.filters.ages } = {}) {
  return select(prepared(a), {
    sizes: size === 'all' ? null : new Set([size]),
    ages: ages.length === AGE_GROUPS.length ? null : new Set(ages),
  });
}

function analyse(a, opts) {
  const f = state.filters;
  const M = METRICS[f.metric];
  const rows = yearly(selection(a, opts), M.measure);
  const points = eligible(rows, f.metric, f.minDeals);
  const win = within(points, f.cmpFrom, f.cmpTo);
  return {
    rows,
    points,
    win,
    change: pointChange(points, f.cmpFrom, f.cmpTo),
    trend: logTrend(win),
    index: indexTo(points, f.cmpFrom),
    at: (y) => points.find((p) => p.yr === y) || null,
    row: (y) => rows.find((r) => r.yr === y) || null,
  };
}

// Share of the area's deals that make it into the price statistics.
function quality(a) {
  const ds = prepared(a);
  return ds.length ? ds.filter((d) => d.drop == null).length / ds.length : null;
}

// Turnover over the full years of the comparison window that were actually
// fetched; all fetched deals of the chosen asset types, regardless of the size
// and age selection (the household count is not split by size either).
function turnoverOf(a, q) {
  const f = state.filters;
  const from = Math.max(f.cmpFrom, q.yearMin);
  const to = Math.min(f.cmpTo, q.yearMax, THIS_YEAR - 1);
  return turnover(a.res.counted, a.res.households, from, to);
}

function restyleAreas() {
  for (const a of state.areas) a.layer.setStyle(() => areaStyle(a));
}

function computed() {
  return state.areas.filter((a) => a.res && a.geom);
}

// The filters the shown numbers were fetched with (every area of a compute
// shares them), which can differ from the inputs once the user edits.
function queried(list) {
  return list.find((a) => a.res?.filters)?.res.filters || state.filters;
}
function queriedDiffers(list) {
  const q = queried(list);
  const f = state.filters;
  return q.yearMin !== f.yearMin || q.yearMax !== f.yearMax
    || JSON.stringify([...(q.types || [])].sort()) !== JSON.stringify([...f.types].sort());
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
  renderSegments(list);
  renderRaw(list);
  renderMethod(list);
  if (state.tab === 'compare') renderCompareChart(list);
  if (state.tab === 'charts') renderCharts(list);
}

$$('.tabs button').forEach((b) => {
  b.onclick = () => {
    state.tab = b.dataset.tab;
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.pane').forEach((p) => { p.hidden = p.dataset.pane !== state.tab; });
    if (state.tab === 'charts') renderCharts(computed());
    if (state.tab === 'compare') renderCompareChart(computed());
  };
});

function dot(a) {
  return `<span class="dot" style="background:${a.color}"></span>${esc(a.name)}`;
}

function viewLabel() {
  const f = state.filters;
  const ages = f.ages.length === AGE_GROUPS.length ? 'כל הגילים' : f.ages.map(ageLabel).join(', ');
  return `${METRICS[f.metric].label} · ${f.size === 'all' ? 'כל הגדלים' : sizeLabel(f.size)} · ${ages} · סינון חריגים: ${OUTLIER_METHODS[f.outlier].label}`;
}

function renderCompare(list) {
  const f = state.filters;
  const M = METRICS[f.metric];
  const other = M.stat === 'mean' ? 'median' : 'mean';
  const ref = reference(list);
  const refA = ref ? analyse(ref) : null;
  const q = queried(list);
  let html = `<p class="muted small"><b>${esc(viewLabel())}</b><br>
    השוואה בין ${yr(f.cmpFrom)} ל-${yr(f.cmpTo)} · שנים עם פחות מ-${fmt(f.minDeals)} עסקאות בשימוש אינן נכנסות לחישוב ·
    סוג נכס: ${esc((q.types || []).join(', '))} · שנים ${yr(q.yearMin)}–${yr(q.yearMax)}</p>`;
  if (queriedDiffers(list)) html += '<p class="note">סוג הנכס או טווח השנים השתנו מאז החישוב — המספרים כאן לפי הסינון שמוצג למעלה. לחצו "חשב והשווה" לעדכון.</p>';
  if (f.cmpFrom < q.yearMin || f.cmpTo > q.yearMax) {
    html += `<p class="note">שנות ההשוואה (${yr(f.cmpFrom)}, ${yr(f.cmpTo)}) חורגות מטווח השנים שנשלף (${yr(q.yearMin)}–${yr(q.yearMax)}) — הרחיבו את הטווח וחשבו מחדש.</p>`;
  }
  if (f.cmpTo >= THIS_YEAR) html += `<p class="note">שנת ${THIS_YEAR} עדיין לא הסתיימה והמאגר מתעדכן באיחור — הנתונים שלה חלקיים ואין לקרוא אותם כירידה בשוק.</p>`;
  if (f.cmpTo <= f.cmpFrom) html += '<p class="note">שנת ההשוואה צריכה להיות מאוחרת משנת הבסיס.</p>';

  html += `<div class="chart-box"><h3 id="chart-compare-title"></h3><canvas id="chart-compare"></canvas></div>`;

  html += `<div class="tbl-wrap"><table><thead><tr>
    <th>ייחוס</th><th>אזור</th><th>חלקות באזור / עם עסקאות</th><th>שטח החלקות (דונם): כולן / עם עסקאות</th><th>עסקאות שנשלפו</th><th>בשימוש לחישוב</th>
    <th>${M.short} ${yr(f.cmpFrom)} (n)</th><th>${M.short} ${yr(f.cmpTo)} (n)</th><th>${METRICS[f.metric.replace(M.stat, other)].short} ${yr(f.cmpTo)} · ס"ת</th>
    <th>שינוי ${yr(f.cmpFrom)}→${yr(f.cmpTo)}</th><th>שינוי שנתי ממוצע (CAGR)</th>
    <th>מגמה שנתית (רגרסיה)</th><th>R²</th><th>רמת מחיר ביחס לייחוס</th><th>פער מגמה מול הייחוס</th>
    <th>עסקאות לשנה ל-1,000 משקי בית</th>
  </tr></thead><tbody>`;
  for (const a of list) {
    if (a.res.error) {
      html += `<tr><td></td><td>${dot(a)}</td><td colspan="14" class="neg">${esc(a.res.error)}</td></tr>`;
      continue;
    }
    const x = analyse(a);
    const from = x.at(f.cmpFrom);
    const to = x.at(f.cmpTo);
    const toRow = x.row(f.cmpTo);
    const refTo = refA?.at(f.cmpTo);
    const isRef = ref && a.id === ref.id;
    const ratio = to && refTo ? (to.m / refTo.m) * 100 : null;
    const gap = x.trend && refA?.trend && !isRef ? x.trend.annualPct - refA.trend.annualPct : null;
    const q2 = quality(a);
    const turn = turnoverOf(a, q);
    html += `<tr>
      <td><input type="radio" name="ref" value="${a.id}" ${isRef ? 'checked' : ''} aria-label="אזור ייחוס"></td>
      <td>${dot(a)}</td>
      <td class="n">${fmt(a.res.parcels_in_area)} / ${fmt(a.res.parcels_with_deals)}${a.res.shuma_parcels ? `<br><span class="muted small" title="חלקות שאינן בשכבה הסטטוטורית ואותרו לפי שכבת חלקות השומה">כולל ${fmt(a.res.shuma_parcels)} חלקות שומה · ${fmt(a.res.shuma_deals)} עסקאות</span>` : ''}</td>
      <td class="n">${fmt(a.res.parcels_area / 1000, 1)} / ${fmt(a.res.parcels_with_deals_area / 1000, 1)}${a.res.parcels_area_measured ? `<br><span class="muted small" title="לחלקות האלה אין שטח רשום בשכבה; השטח שלהן מחושב מהפוליגון">${fmt(a.res.parcels_area_measured)} חלקות בשטח מחושב</span>` : ''}</td>
      <td class="n">${fmt(a.res.counted.length)}${a.res.duplicates ? `<br><span class="muted small" title="עסקאות 100% שזהות בכל השדות פרט ליישוב — נספרו פעם אחת">${fmt(a.res.duplicates)} כפולות לא נספרו</span>` : ''}</td>
      <td class="n ${q2 != null && q2 < LOW_QUALITY ? 'neg' : ''}">${share(q2)}</td>
      <td class="n">${from ? `${fmt(from.m)} (${fmt(from.n)})` : '<span class="muted">אין מספיק</span>'}</td>
      <td class="n">${to ? `${fmt(to.m)} (${fmt(to.n)})` : '<span class="muted">אין מספיק</span>'}</td>
      <td class="n">${toRow ? `${fmt(toRow[other])} · ${fmt(toRow.sd)}` : '—'}</td>
      <td class="n">${pct(x.change?.pct)}</td>
      <td class="n">${pct(x.change?.cagr, 2)}</td>
      <td class="n">${x.trend ? pct(x.trend.annualPct, 2) + ` <span class="muted">(${x.trend.n} שנים)</span>` : '—'}</td>
      <td class="n">${x.trend ? fmt(x.trend.r2, 2) : '—'}</td>
      <td class="n">${isRef ? '100 (ייחוס)' : ratio != null ? fmt(ratio, 1) : '—'}</td>
      <td class="n">${isRef ? '—' : gap != null ? pct(gap, 2, ' נ"א') : '—'}</td>
      <td class="n">${turn ? `${fmt(turn.per1000, 1)} <span class="muted">(${fmt(a.res.households)} מ"ב${a.res.stat_areas_no_hh ? `; ל-${fmt(a.res.stat_areas_no_hh)} א"ס אין נתון ⚠` : ''})</span>` : '—'}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';

  html += summarySentences(list, ref);
  html += overlapNote(list);
  html += `<p class="muted small">n = מספר העסקאות שמאחורי הסטטיסטיקה, אחרי סינון החריגים. ס"ת = סטיית תקן. "בשימוש לחישוב" = חלק העסקאות שנשלפו שנכנסו לחישוב המחיר (לא חסר בהן נתון, יש להן גודל ואינן חריגות); אזור מתחת ל-${share(LOW_QUALITY)} מסומן ⚠ ובקו מקווקו על המפה.
    משקי בית: מפקד 2022, לפי החלק של כל אזור סטטיסטי שבתוך האזור — קירוב למלאי הדירות המאוכלסות, לא לכל המלאי. הפירוט לפי קבוצות גודל וגיל בלשונית "פילוח".</p>`;
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

// One table per area: the same trend read separately for each size group
// (and each age group), because small and large flats trade at systematically
// different prices per m² and a pooled number hides that.
function renderSegments(list) {
  const f = state.filters;
  const M = METRICS[f.metric];
  let html = `<p class="muted small"><b>${esc(M.label)}</b> · השוואה ${yr(f.cmpFrom)}→${yr(f.cmpTo)} · הסינון לפי קבוצת גודל וגיל שבחרתם בצד חל על הגרפים וההשוואה; כאן כל קבוצה מוצגת בנפרד.</p>
    <p class="note">"—" בתא = באותה שנה היו בקבוצה פחות מ-${fmt(f.minDeals)} עסקאות בשימוש, ולכן אין ממנה מספר (מגמה דורשת 3 שנים כאלה). פילוח מחלק את העסקאות לקבוצות קטנות — באזור קטן כדאי להגדיל את האזור או להוריד את "מינימום עסקאות לשנה".</p>`;
  const segTable = (a, groups, optsFor) => {
    let t = `<div class="tbl-wrap"><table><thead><tr><th>קבוצה</th><th>עסקאות בשימוש (סה"כ)</th>
      <th>${M.short} ${yr(f.cmpFrom)} (n)</th><th>${M.short} ${yr(f.cmpTo)} (n)</th><th>ממוצע · חציון · ס"ת ${yr(f.cmpTo)}</th>
      <th>שינוי</th><th>CAGR</th><th>מגמה שנתית</th><th>R²</th></tr></thead><tbody>`;
    for (const g of groups) {
      const x = analyse(a, optsFor(g));
      const used = x.rows.reduce((s, r) => s + r.used, 0);
      const from = x.at(f.cmpFrom);
      const to = x.at(f.cmpTo);
      const r = x.row(f.cmpTo);
      t += `<tr><td>${esc(g.label)}</td><td class="n">${fmt(used)}</td>
        <td class="n">${from ? `${fmt(from.m)} (${fmt(from.n)})` : '—'}</td>
        <td class="n">${to ? `${fmt(to.m)} (${fmt(to.n)})` : '—'}</td>
        <td class="n">${r ? `${fmt(r.mean)} · ${fmt(r.median)} · ${fmt(r.sd)}` : '—'}</td>
        <td class="n">${pct(x.change?.pct)}</td><td class="n">${pct(x.change?.cagr, 2)}</td>
        <td class="n">${x.trend ? pct(x.trend.annualPct, 2) : '—'}</td><td class="n">${x.trend ? fmt(x.trend.r2, 2) : '—'}</td></tr>`;
    }
    return t + '</tbody></table></div>';
  };
  for (const a of list) {
    html += `<div class="area-block"><h3>${dot(a)}</h3>`;
    if (a.res.error) {
      html += `<p class="neg">${esc(a.res.error)}</p></div>`;
      continue;
    }
    html += `<h4>לפי קבוצת גודל <span class="muted small">(גיל: ${f.ages.length === AGE_GROUPS.length ? 'כל הגילים' : esc(f.ages.map(ageLabel).join(', '))})</span></h4>`;
    html += segTable(a, SIZE_GROUPS.filter((g) => g.key !== 's0'), (g) => ({ size: g.key }));
    html += `<h4>לפי גיל הבניין במועד העסקה <span class="muted small">(גודל: ${f.size === 'all' ? 'כל הגדלים' : esc(sizeLabel(f.size))})</span></h4>`;
    html += segTable(a, AGE_GROUPS, (g) => ({ ages: [g.key] }));
    html += '</div>';
  }
  $('[data-pane=segments]').innerHTML = html;
}

// ── charts ─────────────────────────────────────────────────────────────────
function chartYears(list) {
  const q = queried(list);
  const years = [];
  for (let y = q.yearMin; y <= q.yearMax; y++) years.push(y);
  return years;
}

// The current year is partial: dashed into it, hollow point on it.
function lineDataset(a, years, values) {
  const partial = (i) => years[i] === THIS_YEAR;
  return {
    label: a.name,
    data: years.map((y) => values.get(y) ?? null),
    borderColor: a.color,
    backgroundColor: a.color,
    spanGaps: true,
    tension: 0.15,
    segment: { borderDash: (ctx) => (partial(ctx.p1DataIndex) ? [5, 4] : undefined) },
    pointBackgroundColor: years.map((y) => (y === THIS_YEAR ? 'transparent' : a.color)),
    pointRadius: years.map((y) => (y === THIS_YEAR ? 5 : 3)),
  };
}

function drawChart(id, type, data, extra = {}) {
  charts[id]?.destroy();
  const canvas = $(`#${id}`);
  if (!canvas) return;
  canvas.parentElement.style.height = '340px';
  charts[id] = new Chart(canvas, {
    type,
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { rtl: true, textDirection: 'rtl' }, tooltip: { rtl: true, textDirection: 'rtl' } },
      ...extra,
    },
  });
}

function levelData(list) {
  const years = chartYears(list);
  return {
    labels: years.map((y) => (y === THIS_YEAR ? `${y} (חלקית)` : y)),
    datasets: list.filter((a) => !a.res.error).map((a) =>
      lineDataset(a, years, new Map(analyse(a).points.map((p) => [p.yr, Math.round(p.m)])))),
  };
}

function renderCompareChart(list) {
  const f = state.filters;
  const t = $('#chart-compare-title');
  if (!t) return;
  t.textContent = `${viewLabel()} — לאורך השנים (רק שנים עם ${f.minDeals}+ עסקאות בשימוש)`;
  drawChart('chart-compare', 'line', levelData(list));
}

function renderCharts(list) {
  const f = state.filters;
  const M = METRICS[f.metric];
  $('#chart-level-title').textContent = `${viewLabel()} (${M.unit})`;
  $('#chart-index-title').textContent = `מדד: ${f.cmpFrom} = 100`;
  drawChart('chart-level', 'line', levelData(list));
  const years = chartYears(list);
  const ok = list.filter((a) => !a.res.error);
  drawChart('chart-index', 'line', {
    labels: years,
    datasets: ok.map((a) => lineDataset(a, years, new Map((analyse(a).index || []).map((p) => [p.yr, Math.round(p.v * 10) / 10])))),
  });
  drawChart('chart-deals', 'bar', {
    labels: years,
    datasets: ok.flatMap((a) => {
      const rows = new Map(analyse(a).rows.map((r) => [r.yr, r]));
      return [
        { label: `${a.name} — בשימוש`, data: years.map((y) => rows.get(y)?.used ?? 0), backgroundColor: a.color, stack: a.id },
        { label: `${a.name} — סוננו`, data: years.map((y) => (rows.get(y) ? rows.get(y).total - rows.get(y).used : 0)), backgroundColor: `${a.color}55`, stack: a.id },
      ];
    }),
  }, { scales: { x: { stacked: true }, y: { stacked: true } } });
}

// ── raw material ───────────────────────────────────────────────────────────
function csv(rows, cols) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = `'${s}`; // no formulas in a spreadsheet
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [cols.map(([, h]) => h).join(','), ...rows.map((r) => cols.map(([k]) => cell(r[k])).join(','))].join('\n');
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function dealRow(a, d) {
  return {
    date: ymd(d.date),
    settlement: a.res.settlements[d.scode] ?? '',
    gush: d.gush, chelka: d.chelka, sub: d.sub,
    nbr: state.ext?.neighborhoodOf(d.gush) || '',
    nature: d.nature, type: d.type,
    amt: d.amt, decl: d.decl, sqm: d.sqm, por: d.por, rooms: d.rooms, yb: d.yb,
    age: d.age ?? '', ageGroup: ageLabel(d.ageGroup), size: sizeLabel(d.size),
    pp: d.pp == null ? '' : Math.round(d.pp),
    status: d.dup ? DUP_LABEL : d.drop ? DROP_LABEL[d.drop] : 'בשימוש',
    loc: d.shuma ? 'חלקת שומה' : 'סטטוטורי',
    parcelArea: d.parcelArea == null ? '' : d.parcelArea,
    parcelAreaSrc: d.parcelArea == null ? '' : d.parcelAreaMeasured ? 'מחושב מהפוליגון' : 'רשום',
  };
}
const DEAL_COLS = [
  ['date', 'תאריך'], ['settlement', 'יישוב'], ['gush', 'גוש'], ['chelka', 'חלקה'], ['sub', 'תת-חלקה'],
  ['parcelArea', 'שטח החלקה (מ"ר)'], ['parcelAreaSrc', 'מקור שטח החלקה'],
  ['nbr', 'שכונה (טבלת עזר)'], ['nature', 'מהות'], ['type', 'סוג נכס'], ['amt', 'שווי עסקה'], ['decl', 'שווי מוצהר'],
  ['sqm', 'שטח'], ['por', 'חלק נמכר'], ['rooms', 'חדרים'], ['yb', 'שנת בנייה'], ['age', 'גיל'], ['ageGroup', 'קבוצת גיל'],
  ['size', 'קבוצת גודל'], ['pp', 'מחיר למ"ר מנורמל'], ['status', 'סטטוס בחישוב'], ['loc', 'מיקום לפי'],
];
const YEAR_COLS = [['yr', 'שנה'], ['total', 'עסקאות'], ['valid', 'עם נתונים מלאים וגודל'], ['used', 'בשימוש'],
  ['mean', 'ממוצע'], ['median', 'חציון'], ['sd', 'סטיית תקן']];

function renderRaw(list) {
  const pane = $('[data-pane=raw]');
  if (!list.find((a) => a.id === state.rawAreaId)) { state.rawAreaId = list[0].id; state.rawPage = 0; }
  const a = getArea(state.rawAreaId);
  const f = state.filters;
  const M = METRICS[f.metric];
  let html = `<div class="row" style="flex-wrap:wrap;margin-bottom:.6rem">${list.map((x) =>
    `<button type="button" data-area="${x.id}" class="${x.id === a.id ? 'primary' : ''}" style="width:auto;margin:0">${dot(x)}</button>`).join('')}</div>`;
  if (a.res.error) {
    pane.innerHTML = html + `<p class="neg">${esc(a.res.error)}</p>` + sqlBlock('השאילתה', a.res.sql);
    bindRaw(pane, a);
    return;
  }
  const x = analyse(a);
  const used = new Set(x.points.map((p) => p.yr));
  html += `<h3>הסיכום השנתי — הקלט הישיר לנוסחאות</h3>
    <p class="muted small">${esc(viewLabel())}. שורות באפור לא נכנסו לחישוב (פחות מ-${fmt(f.minDeals)} עסקאות בשימוש).</p>
    <div class="tbl-wrap"><table><thead><tr><th>שנה</th><th>עסקאות</th><th>עם נתונים מלאים וגודל</th><th>בשימוש</th><th>סוננו</th>
      <th>ממוצע</th><th>חציון</th><th>ס"ת</th><th>בשימוש לנוסחה</th></tr></thead><tbody>
    ${x.rows.map((r) => `<tr class="${used.has(r.yr) ? '' : 'thin'}">
      <td class="n">${r.yr}${r.yr === THIS_YEAR ? ' (חלקית)' : ''}</td><td class="n">${fmt(r.total)}</td><td class="n">${fmt(r.valid)}</td>
      <td class="n">${fmt(r.used)}</td><td class="n">${share(r.total ? 1 - r.used / r.total : null)}</td>
      <td class="n">${fmt(r.mean)}</td><td class="n">${fmt(r.median)}</td><td class="n">${fmt(r.sd)}</td>
      <td>${used.has(r.yr) ? '✓' : '—'}</td></tr>`).join('')}
    </tbody></table></div>
    <p><button type="button" id="dl-years">הורד סיכום שנתי (CSV)</button></p>`;

  // What the outlier filter did, cell by cell.
  const rep = a.res.outlierReport || [];
  const dropped = rep.reduce((s, c) => s + (c.n0 - c.kept), 0);
  html += `<details><summary>סינון החריגים לפי תא (סוג נכס × גודל × שנה): ${fmt(dropped)} עסקאות סוננו ב-${fmt(rep.length)} תאים</summary>
    <div class="tbl-wrap"><table><thead><tr><th>שנה</th><th>סוג נכס</th><th>קבוצת גודל</th><th>עסקאות בתא</th><th>קבוצת ייחוס (n)</th><th>סבבים על קבוצת הייחוס: e<sup>μ ± ${SIGMA_K}σ</sup> של ln המחיר → גבולות ₪/מ"ר (הוסרו מהייחוס)</th><th>סוננו מהתא</th><th>נשארו</th></tr></thead><tbody>
    ${rep.map((c) => `<tr><td class="n">${c.yr}</td><td>${esc(c.type)}</td><td>${esc(sizeLabel(c.size))}</td><td class="n">${fmt(c.n0)}</td>
      <td>${c.ref ? `${esc(c.ref)} (${fmt(c.refN)})` : '—'}</td>
      <td class="n">${c.rounds.length ? c.rounds.map((r) => (r.mean != null
        ? `${r.robust ? 'ניקוי גס: חציון' : 'μ'}=${r.mean.toFixed(3)}, ${r.robust ? 'σ חסין' : 'σ'}=${r.sd.toFixed(3)} → [${fmt(r.lo)}, ${fmt(r.hi)}] (${fmt(r.dropped)})`
        : `[${fmt(r.lo)}, ${fmt(r.hi)}] (${fmt(r.dropped)})`)).join('<br>') : (f.outlier === 'sigma' ? `פחות מ-${SIGMA_MIN_N} עסקאות גם בקבוצה הרחבה — לא סונן` : '—')}</td>
      <td class="n">${fmt(c.n0 - c.kept)}</td><td class="n">${fmt(c.kept)}</td></tr>`).join('')}
    </tbody></table></div></details>`;

  // Settlements the deals belong to, with the CBS attributes from the external table.
  const counts = new Map();
  for (const d of a.res.counted) counts.set(d.scode, (counts.get(d.scode) || 0) + 1);
  html += `<details><summary>יישובים באזור (${fmt(counts.size)})</summary><div class="tbl-wrap"><table><thead><tr>
    <th>יישוב</th><th>סמל</th><th>עסקאות</th><th>מחוז</th><th>נפה</th><th>אזור טבעי</th><th>מטרופולין</th><th>צורת יישוב</th><th>אשכול רשויות</th></tr></thead><tbody>
    ${[...counts.entries()].sort((p, q2) => q2[1] - p[1]).map(([code, n]) => {
      const info = state.ext?.settlementInfo.get(Number(code)) || {};
      return `<tr><td>${esc(a.res.settlements[code] ?? (code == null ? 'ללא סמל יישוב במקור' : ''))}</td><td class="n">${esc(code ?? '')}</td><td class="n">${fmt(n)}</td>
        <td>${esc(info.district ?? '')}</td><td>${esc(info.subdistrict ?? '')}</td><td>${esc(info.natural_region ?? '')}</td>
        <td>${esc(info.metropolin ?? '')}</td><td>${esc(info.settlement_type ?? '')}</td><td>${esc(info.authority_cluster ?? '')}</td></tr>`;
    }).join('')}</tbody></table></div>
    <p class="muted small">מאפייני היישוב: טבלת עזר חיצונית (למ"ס, מקובץ המשתמש). יישוב שאינו תואם את מיקום האזור מעיד בדרך כלל על שגיאת רישום במקור.</p></details>`;

  // The deals themselves.
  const deals = a.res.deals;
  const pages = Math.max(1, Math.ceil(deals.length / PAGE));
  state.rawPage = Math.min(state.rawPage, pages - 1);
  const slice = deals.slice(state.rawPage * PAGE, (state.rawPage + 1) * PAGE);
  html += `<h3>העסקאות עצמן</h3>
    <p class="muted small">כל ${fmt(deals.length)} העסקאות שנשלפו, מהחדשה לישנה, עם העמודות המחושבות. "${esc(M.label)}" מחושב רק מהעסקאות בסטטוס "בשימוש".</p>
    <div class="row" style="margin-bottom:.5rem;flex-wrap:wrap;align-items:center">
      <button type="button" id="dl-raw">הורד את כל העסקאות (CSV)</button>
      <button type="button" data-page="-1" ${state.rawPage === 0 ? 'disabled' : ''}>הקודם</button>
      <span class="small">עמוד ${fmt(state.rawPage + 1)} מתוך ${fmt(pages)}</span>
      <button type="button" data-page="1" ${state.rawPage >= pages - 1 ? 'disabled' : ''}>הבא</button>
    </div>
    <div class="tbl-wrap"><table><thead><tr>${DEAL_COLS.map(([, h]) => `<th>${h}</th>`).join('')}</tr></thead><tbody>
    ${slice.map((d) => {
      const r = dealRow(a, d);
      return `<tr class="${d.drop ? 'thin' : ''}">${DEAL_COLS.map(([k]) => `<td class="${/amt|decl|sqm|por|pp|rooms|yb|age$|gush|chelka|sub/.test(k) ? 'n' : ''}">${esc(/amt|decl|pp/.test(k) ? fmt(r[k]) : r[k])}</td>`).join('')}</tr>`;
    }).join('')}
    </tbody></table></div>`;
  html += sqlBlock('השאילתה שמחזירה את העסקאות, החלקות ומשקי הבית', a.res.sql);
  pane.innerHTML = html;
  bindRaw(pane, a, x);
}

function bindRaw(pane, a, x) {
  $$('[data-area]', pane).forEach((b) => { b.onclick = () => { state.rawAreaId = b.dataset.area; state.rawPage = 0; renderRaw(computed()); }; });
  $$('[data-page]', pane).forEach((b) => { b.onclick = () => { state.rawPage += Number(b.dataset.page); renderRaw(computed()); }; });
  const dlYears = $('#dl-years', pane);
  if (dlYears && x) dlYears.onclick = () => download(`${a.name}-years.csv`, csv(x.rows, YEAR_COLS));
  const dlRaw = $('#dl-raw', pane);
  if (dlRaw) dlRaw.onclick = () => download(`${a.name}-deals.csv`, csv(a.res.deals.map((d) => dealRow(a, d)), DEAL_COLS));
}

function sqlBlock(title, sql) {
  if (!sql) return '';
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
  const q = queried(list);
  const src = state.ext?.source;
  let html = `
  <h3>1. מאזור לעסקאות</h3>
  <p>אזור הוא ציור במברשת (קו שמורחב לשני צדדיו בחצי מעובי המברשת, איחוד המשיכות פחות משיכות המחק), או שכונה / אזור סטטיסטי שנבחרו בלחיצה על המפה.
  המאגר של רשות המסים אינו כולל קואורדינטות — רק גוש וחלקה — ולכן נכללת כל חלקה ש<b>נקודה פנימית שלה</b> (ST_PointOnSurface) בתוך האזור, והעסקאות מחוברות לחלקות לפי גוש + חלקה.
  נשלפים סוגי הנכס ${esc((q.types || []).join(', '))} והשנים ${yr(q.yearMin)}–${yr(q.yearMax)}; כל השאר מחושב בדפדפן מהעסקאות עצמן.</p>

  <p><b>שכבת החלקות:</b> קודם השכבה הסטטוטורית (חלקות, המרכז למיפוי ישראל). רק גוש+חלקה שאינם בה כלל מאותרים לפי <b>שכבת חלקות השומה</b>, שהיא פחות מדויקת, והעסקאות שלהם מסומנות "חלקת שומה" בחומר הגלם ובטבלת ההשוואה.
  <b>מגבלה:</b> כ-17% מעסקאות המאגר רשומות על מספר חלקה שאינו קיים היום באף שכבה, בעיקר מספרים היסטוריים מלפני פרצלציה (28% מהעסקאות ב-1998–2004, 11% ב-2019–2026). עסקאות כאלה לא נמצאות באף אזור, ולכן בשנים המוקדמות נספרות פחות עסקאות.</p>

  <p><b>שטח החלקות:</b> לכל חלקה נלקח השטח הרשום שלה בשכבה (LEGAL_AREA). כשאין שטח רשום, השטח מחושב מהפוליגון ומסומן "מחושב מהפוליגון". בטבלת ההשוואה מוצג סך שטח כל החלקות באזור, וסך שטח החלקות שיש בהן עסקאות מהסוגים והשנים שנבחרו. זה שטח החלקה כולה, לא שטח הנכס שנמכר.</p>
  <p><b>עסקאות כפולות:</b> במאגר מופיעות מכירות רבות של 100% מהנכס פעמיים, זהות בכל השדות פרט ליישוב (באחת יש סמל יישוב ובשנייה לא). עסקאות 100% שזהות בתאריך, בשווי, בשווי המוצהר, בשטח, בחלק הנמכר, בשנת הבנייה, בחדרים, במהות ובגוש/חלקה/תת-חלקה נחשבות עסקה אחת. נשמרת השורה עם סמל היישוב, והשאר מסומנות "כפולה" בחומר הגלם ולא נספרות בשום מקום: לא בסה"כ, לא בסטטיסטיקה ולא בתחלופה. בכל המאגר אלה 373,746 שורות, 14% מעסקאות ה-100%. מכירות חלקיות לא מאוחדות, כי שתי מכירות של חצי יכולות להיות זהות באמת.</p>

  <h3>2. סיווג הנכס</h3>
  <p>כל מהות עסקה של רשות המסים ממופה לסוג נכס (קטגוריות מפ"י) לפי טבלת עזר חיצונית${src ? ` — "${esc(src.title)}"` : ''}. מהויות שאינן בטבלה מסווגות "${UNMAPPED}". "לא רלבנטי" ו"סחר נדל"ן" אינם בניתוח המגורים כברירת מחדל. הרשימה המלאה בפאנל הסינון.</p>

  <h3>3. עסקה שמספיקה לחישוב, והמחיר למ"ר</h3>
  <span class="formula">valid ⇔ deal_amount ≥ ${MIN_AMOUNT} ∧ asset_area &gt; 0 ∧ portion &gt; 0</span>
  <span class="formula">P = deal_amount / (asset_area × portion)</span>
  <p>השטח במאגר הוא שטח הנכס כולו והשווי משולם רק על החלק שנמכר, ולכן החלוקה בחלק הנמכר. בקובץ של משתמש האתר המחיר מחושב מהשווי המוצהר כשהוא שווה לשווי העסקה, ומשווי העסקה אחרת — כלומר תמיד משווי העסקה, בדיוק כמו כאן.</p>

  <h3>4. קבוצות גודל</h3>
  <p>${SIZE_GROUPS.map((g) => `${esc(g.label)}: <span class="num">${g.lo} ≤ שטח &lt; ${g.hi === Infinity ? '∞' : g.hi}</span>`).join(' · ')}.
  הגבולות משחזרים את מה שה-VLOOKUP בקובץ העזר עושה בפועל (התוויות שם, "1-54", "54-80"…, רחוקות ביחידה מהגבולות האמיתיים). "ללא גודל" לא נכנס לחישוב מחיר, כי אין לו שטח שאפשר לחלק בו.</p>

  <h3>5. סינון חריגים — ${esc(OUTLIER_METHODS[f.outlier].label)}</h3>
  <p>הסינון נעשה בתוך כל <b>תא</b> — אזור × סוג נכס × קבוצת גודל × שנה — ולא על כל המאגר: מחיר רגיל לעיר יכול להיות חריג לרחוב, וחנות אינה חריגה של דירות. השטח מעוגל למ"ר שלם לפני השיוך לקבוצת גודל.</p>
  <span class="formula">round r: μ<sub>r</sub> = mean(ln P), σ<sub>r</sub> = sd(ln P) over the kept deals;  drop P ∉ [e<sup>μ<sub>r</sub> − ${SIGMA_K}σ<sub>r</sub></sup>, e<sup>μ<sub>r</sub> + ${SIGMA_K}σ<sub>r</sub></sup>]</span>
  <p><b>ניקוי גס לפני הסבבים:</b> חציון ± ${PRESCREEN_K} סטיות תקן חסינות (1.4826 × MAD) של ln המחיר. בתא מלוכלך מאוד (הרבה עסקאות בחלק נמכר זעיר) גם סטיית התקן של ln המחיר מתנפחת, והחריגים מסתירים זה את זה; החציון וה-MAD לא מושפעים מהם. בנתונים נקיים השלב הזה כמעט לא מסיר דבר, ואחריו רצים שני הסבבים של 2 סטיות תקן כפי שביקש משתמש האתר.</p>
  <p><b>למה על ln המחיר:</b> מחירים מתפלגים בקירוב לוג-נורמלית. בסולם רגיל, כמה עסקאות עם חלק נמכר זעיר (מחיר מנורמל של מיליון ₪ למ"ר) מנפחות יחד את סטיית התקן ו"מסתירות" זו את זו — בדיקה על הצפון הישן ב-2016 השאירה כך ממוצע של 55,714 מול חציון של 48,033. בסולם לוגריתמי הן רחוקות כ-10 סטיות תקן ונתפסות כבר בסבב הראשון, והזנב הימני הטבעי של נכסי פרימיום נחתך פחות.
  שני סבבים (הסבב השני מחושב מחדש על מה שנשאר). סטיית התקן היא של מדגם (חלוקה ב-n−1).
  <b>תא קטן:</b> במדגם של n עסקאות ציון התקן הגבוה ביותר האפשרי הוא (n−1)/√n, פחות מ-2 כש-n ≤ 5 — כלל של 2 סטיות תקן לא יכול לתפוס שום חריג בתא כזה. לכן הגבולות מחושבים על <b>קבוצת ייחוס</b> של לפחות ${SIGMA_REF_N} עסקאות, שמתרחבת בהדרגה מהתא עצמו: ${REFERENCE_STEPS.map((r) => esc(r.label)).join(' ← ')}, ומוחלים על עסקאות התא. אם גם הקבוצה הרחבה ביותר קטנה מ-${SIGMA_MIN_N}, התא אינו מסונן. קבוצת הייחוס של כל תא מוצגת בלשונית "חומר גלם".
  החלופה: טווח קבוע <span class="num">${fmt(FIXED_RANGE[0])}–${fmt(FIXED_RANGE[1])}</span> ₪ למ"ר, כמו בקובץ של משתמש האתר. שימו לב: סינון לפי סטיות תקן מניח התפלגות קרובה לנורמלית ועלול לקצץ זנב ימני אמיתי (נכסי פרימיום); מה שסונן בכל תא מוצג בלשונית "חומר גלם".</p>

  <h3>6. הסטטיסטיקה השנתית</h3>
  <span class="formula">mean<sub>t</sub> = Σ P<sub>i</sub> / n<sub>t</sub> ,  median<sub>t</sub> ,  sd<sub>t</sub> = √(Σ(P<sub>i</sub> − mean<sub>t</sub>)² / (n<sub>t</sub> − 1))</span>
  <p>מעל העסקאות שבשימוש בשנה t. גם המדדים של <b>שווי עסקה</b> מחושבים על אותן עסקאות (אחרי סינון החריגים לפי המחיר למ"ר, ורק עם שטח וחלק נמכר), והשווי הוא של החלק שנמכר — מכירת חצי דירה נספרת בחצי מחירה. המדד הנוכחי: <b>${esc(M.label)}</b>. הממוצע ברירת המחדל רק משום שקודם מופרדים הגדלים ומסוננים החריגים; החציון מוצג לצדו, ופער גדול ביניהם מעיד על חריגים שנשארו. שנה נכנסת לנוסחאות רק אם n<sub>t</sub> ≥ ${fmt(f.minDeals)}.</p>

  <h3>7. גיל הבניין</h3>
  <span class="formula">age = deal_year − year_built ,  valid ⇔ ${MIN_YEAR_BUILT} ≤ year_built ≤ deal_year + ${MAX_YEARS_AHEAD}</span>
  <p>מכירה "על הנייר" (שנת בנייה אחרי שנת העסקה) נחשבת גיל 0. שנת בנייה 0, 1 או רחוקה בעתיד = "גיל לא ידוע", ואינה נכנסת לחישוב הגיל. קבוצות: ${AGE_GROUPS.map((g) => esc(g.label)).join(' · ')}. בשלב זה הגיל הוא פילוח ולא משתנה ברגרסיה — פילוח שקוף קל יותר לבדוק מול הנתונים.</p>

  <h3>8. שינוי בין שתי שנים</h3>
  <span class="formula">Δ% = (M<sub>B</sub> / M<sub>A</sub> − 1) × 100 ,  CAGR = ((M<sub>B</sub> / M<sub>A</sub>)<sup>1/(B−A)</sup> − 1) × 100</span>

  <h3>9. מגמה — רגרסיה לוגריתמית משוקללת</h3>
  <span class="formula">b = Σ n<sub>t</sub>(t − t̄)(ln M<sub>t</sub> − ȳ) / Σ n<sub>t</sub>(t − t̄)² ,  T = (e<sup>b</sup> − 1) × 100</span>
  <span class="formula">R² = 1 − Σ n<sub>t</sub>(ln M<sub>t</sub> − a − b·t)² / Σ n<sub>t</sub>(ln M<sub>t</sub> − ȳ)² ,  a = ȳ − b·t̄</span>
  <p>על השנים הכשירות בין A ל-B, במשקל מספר העסקאות. בלשונית "השוואה" — על קבוצת הגודל שנבחרה בצד (ברירת המחדל: כל הגדלים יחד); בלשונית "פילוח" — בנפרד לכל קבוצת גודל ולכל קבוצת גיל.</p>

  <h3>10. השוואה בין אזורים</h3>
  <span class="formula">L = 100 × M<sub>B</sub>(area) / M<sub>B</sub>(ref) ,  G = T(area) − T(ref) ,  I<sub>t</sub> = 100 × M<sub>t</sub> / M<sub>A</sub></span>

  <h3>11. איכות הנתונים</h3>
  <span class="formula">share used = |{ valid ∧ size ≠ none ∧ not outlier }| / |{ fetched }|</span>
  <p>לכל אזור ושנה מוצגים: כל העסקאות, אלה עם נתונים מלאים וגודל, ואלה שנשארו אחרי הסינון. אזור שפחות מ-${share(LOW_QUALITY)} מהעסקאות שלו בשימוש מסומן ⚠ ובקו מקווקו על המפה.</p>

  <h3>12. תחלופה ביחס למשקי הבית</h3>
  <span class="formula">turnover = (deals in A..B′ / (B′ − A + 1)) / H × 1000 ,  H = Σ<sub>s</sub> hh<sub>s</sub> × area(s ∩ area) / area(s)</span>
  <p>החלון: השנים המלאות מ-A עד B שנשלפו בפועל (B′ ≤ ${THIS_YEAR - 1}). נספרות כל העסקאות של סוגי הנכס שנבחרו, בלי סינון גודל או גיל, כי גם מספר משקי הבית אינו מפולח לפיהם. hh<sub>s</sub> = משקי הבית באזור הסטטיסטי s במפקד 2022 (שכבת הלמ"ס ב-OVER), מחולקים לפי החלק מהשטח שבתוך האזור. זה <b>קירוב</b>: משקי בית ≈ דירות מאוכלסות, בלי דירות ריקות, ואזורים סטטיסטיים קטנים לא מפרסמים מספר (אז הם נספרים כאפס). OVER אינו מחזיק במלאי יחידות הדיור; כלי ה-ArcGIS של מפ"י שצורף לפידבק אינו נגיש כמקור נתונים.</p>

  <h3>הצבה — המספרים של כל אזור (${esc(viewLabel())})</h3>`;

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
    const turn = turnoverOf(a, queried(list));
    if (turn) {
      html += `<span class="formula">turnover = (${fmt(turn.deals)} / ${turn.years}) / ${fmt(a.res.households)} × 1000 = ${turn.per1000.toFixed(2)}</span>
        <p class="muted small">${fmt(a.res.stat_areas)} אזורים סטטיסטיים חותכים את האזור${a.res.stat_areas_no_hh ? `; ל-${fmt(a.res.stat_areas_no_hh)} מהם אין מספר משקי בית במפקד` : ''}.</p>`;
    }
    html += '</div>';
  }

  html += `<h3 style="margin-top:1.2rem">מקורות</h3><ul class="small">
    <li><b>OVER (גרסאות לעם)</b> — מאגר העסקאות של רשות המסים${state.register ? ` (${fmt(state.register.deals)} עסקאות, <span class="num">${esc(state.register.first_deal)}</span> עד <span class="num">${esc(state.register.last_deal)}</span>)` : ''}, שכבת החלקות, שכבת השכונות של מפ"י, והאזורים הסטטיסטיים 2022 עם נתוני מפקד 2022 של הלמ"ס. שורות המקור לא עובדו, לא תוקנו ולא הושלמו.</li>
    ${src ? `<li><b>מקור חוץ: ${esc(src.title)}</b> (התקבל ${esc(src.received)}) — ${esc(src.note)} בשימוש: סיווג מהות לסוג נכס, מיפוי גוש לשכונה (עמודה בחומר הגלם), מאפייני יישובים של הלמ"ס. <a href="https://github.com/zomer-g/nadlan-area-compare/tree/master/public/data/external" target="_blank" rel="noopener">הטבלאות והבדיקה שלהן</a>.</li>` : ''}
  </ul>
  <h3>הסתייגויות</h3><ul class="small">
    <li>המאגר אינו מפרסם תת-גוש. חלקות שחולקות מספר גוש+חלקה עם תת-גוש שונה עלולות לקבל את אותן עסקאות.</li>
    <li>חלק נמכר קטן מאוד (למשל 0.001) מעוגל לשלוש ספרות, ולכן המחיר המנורמל שלו לא מדויק — סינון החריגים תופס את רובם.</li>
    <li>גם בתוך קבוצת גודל, ממוצע שנתי משקף את תמהיל הנכסים שנמכרו באותה שנה (גיל, מיקום בתוך האזור), לא רק שינוי מחיר של אותם נכסים.</li>
    <li>מיפוי גוש לשכונה בטבלת העזר הוא קירוב: גוש אינו תמיד חופף לשכונה, ושלושה גושים בה משויכים לשתי שכונות. לבחירת שכונה כאזור משמשת שכבת השכונות של מפ"י (חיבור מרחבי), לא הטבלה.</li>
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

// The type list is needed before anything can be computed, and OVER
// occasionally answers one request with an error (seen 2026-10-01 as a CORS
// failure on a momentary error page), so it is retried, then offered by hand.
async function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      // A timeout already waited long enough: report it rather than wait 4x.
      if (i >= tries - 1 || e instanceof over.OverTimeout) throw e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}
function loadTypes() {
  $('#types').innerHTML = '<p class="muted small">טוען…</p>';
  state.typesError = null;
  Promise.all([retry(() => over.natures()), retry(() => loadExternal())]).then(([list, ext]) => {
    state.typesError = null;
    state.natureList = list;
    state.ext = ext;
    renderTypes();
    if (state.computeWhenReady) { state.computeWhenReady = false; compute(); }
  }).catch((e) => {
    state.typesError = e.message;
    $('#types').innerHTML = `<p class="neg small">טעינת סוגי העסקאות נכשלה: ${esc(e.message)}</p>
      <button type="button" id="types-retry" class="small-btn">נסו שוב</button>`;
    $('#types-retry').onclick = loadTypes;
  });
}
loadTypes();

// ── saved analyses and shared links ─────────────────────────────────────────
// The site needs no sign-in. Favourites are kept in this browser
// (localStorage), and a shared link carries the analysis itself, compressed,
// after the "#" — the part of a URL that browsers never send to a server. So
// nothing about the viewer is stored anywhere but their own browser.
// Analyses saved to an account before the site was opened still open by their
// ?analysis=<id> link, and their owner sees them here after signing in.

const SAVED_KEY = 'nadlan-area-compare:saved:v1';
const LINK_PREFIX = '#s=';

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function snapshot() {
  const c = map.getCenter();
  return {
    v: 1,
    areas: state.areas.map(({ id, name, color, geom, origin, picks }) => ({ id, name, color, geom, origin, picks })),
    activeId: state.activeId,
    refId: state.refId,
    filters: state.filters,
    view: { lat: c.lat, lng: c.lng, zoom: map.getZoom() },
    summary: {
      areas: state.areas.map((a) => a.name),
      deals: state.areas.reduce((s, a) => s + (a.res && !a.res.error ? a.res.counted.length : 0), 0),
    },
  };
}

function applySnapshot(s) {
  for (const a of state.areas) map.removeLayer(a.layer);
  state.areas = [];
  state.activeId = null;
  state.refId = null;
  restore(s);
  writeFilters();
  if (state.natureList.length) renderTypes();
  renderAreas();
  renderResults();
  save();
  const v = s.view;
  if (v && Number.isFinite(v.lat) && Number.isFinite(v.lng) && Number.isFinite(v.zoom)) map.setView([v.lat, v.lng], v.zoom);
  else {
    const g = state.areas.filter((a) => a.geom);
    if (g.length) map.fitBounds(L.featureGroup(g.map((a) => a.layer)).getBounds(), { padding: [30, 30] });
  }
  // Compute as soon as the type list is in.
  if (state.natureList.length && state.ext) compute();
  else state.computeWhenReady = true;
}

// Favourites in this browser. Writing can throw (storage full, or blocked in
// a private window); the caller says so.
function readSaved() {
  try {
    const v = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string' && x.state) : [];
  } catch {
    return [];
  }
}
const writeSaved = (list) => localStorage.setItem(SAVED_KEY, JSON.stringify(list));

// A shared link: {t: title, s: snapshot} as JSON, deflated, base64url.
// Coordinates are rounded to 5 decimals (~1 m) to keep the link short.
const round5 = (c) => (typeof c[0] === 'number' ? c.map((v) => Math.round(v * 1e5) / 1e5) : c.map(round5));
function toBase64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const fromBase64url = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

async function packLink(title, s) {
  const slim = {
    ...s,
    summary: undefined,
    areas: s.areas.map((a) => (a.geom
      ? { ...a, geom: { type: 'Feature', properties: {}, geometry: { type: a.geom.geometry.type, coordinates: round5(a.geom.geometry.coordinates) } } }
      : a)),
  };
  const stream = new Blob([JSON.stringify({ t: title, s: slim })]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return `${location.origin}${location.pathname}${LINK_PREFIX}${toBase64url(new Uint8Array(await new Response(stream).arrayBuffer()))}`;
}
async function unpackLink(hash) {
  const stream = new Blob([fromBase64url(hash.slice(LINK_PREFIX.length))]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const v = JSON.parse(await new Response(stream).text());
  if (!v || typeof v.s !== 'object') throw new Error('קישור לא תקין');
  return { title: typeof v.t === 'string' ? v.t.slice(0, 120) : 'ניתוח משותף', state: v.s };
}

async function copyText(url, note) {
  try {
    await navigator.clipboard.writeText(url);
    setStatus(note);
  } catch {
    prompt('העתיקו את הקישור:', url);
  }
}
async function copyLink(title, s) {
  try {
    const url = await packLink(title, s);
    const long = url.length > 8000 ? ` הקישור ארוך (${fmt(url.length)} תווים) כי הוא מכיל את גבולות האזורים.` : '';
    await copyText(url, `הקישור הועתק. הוא נפתח לכל אחד, בלי כניסה, ומכיל את האזורים והסינון עצמם.${long}`);
  } catch (e) {
    setStatus(`לא ניתן ליצור קישור: ${e.message}`);
  }
}

function showCurrent() {
  const c = state.current;
  const label = !c ? '<span class="muted">הניתוח הנוכחי לא נשמר.</span>'
    : `ניתוח פתוח: <b>${esc(c.title)}</b>${c.kind === 'link' ? ' <span class="muted">(מקישור ששותף איתך)</span>' : ''}`;
  $('#current-analysis').innerHTML = `${label}
    <button type="button" class="small-btn" data-copy-current title="קישור לניתוח כפי שהוא עכשיו על המסך">🔗 העתק קישור</button>`;
}

const savedItem = (a, kind) => `<li>
  <button type="button" class="link" data-open="${esc(a.id)}" data-kind="${kind}" title="${esc((a.summary?.areas || a.state?.summary?.areas || []).join(' · '))}">${esc(a.title)}</button>
  <span class="muted small">${new Date(a.updated_at).toLocaleDateString('he-IL')}</span>
  <span class="acts">
    <button type="button" data-copy="${esc(a.id)}" data-kind="${kind}" title="העתק קישור לשיתוף">🔗</button>
    <button type="button" data-del="${esc(a.id)}" data-kind="${kind}" title="מחק">✖</button>
  </span></li>`;

async function renderSaved() {
  const local = readSaved().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  let html = local.length ? local.map((a) => savedItem(a, 'local')).join('') : '<li class="muted small">עוד לא שמרת ניתוחים בדפדפן הזה.</li>';
  if (state.me?.signed_in) {
    try {
      const acct = await api('GET', '/api/analyses');
      if (acct.length) html += `<li class="muted small saved-head">שמורים בחשבון (מלפני שהאתר נפתח לכולם):</li>${acct.map((a) => savedItem(a, 'account')).join('')}`;
    } catch (e) {
      html += `<li class="neg small">${esc(e.message)}</li>`;
    }
  }
  $('#saved').innerHTML = html;
}

function openLocal(id) {
  const a = readSaved().find((x) => x.id === id);
  if (!a) return;
  state.current = { kind: 'local', id: a.id, title: a.title };
  applySnapshot(a.state);
  history.replaceState(null, '', location.pathname);
  showCurrent();
  setStatus(`נפתח: ${a.title}`);
}

async function openAccount(id) {
  try {
    const a = await api('GET', `/api/analyses/${encodeURIComponent(id)}`);
    state.current = { kind: 'account', id: a.id, title: a.title, mine: a.mine };
    applySnapshot(a.state);
    history.replaceState(null, '', `?analysis=${encodeURIComponent(a.id)}`);
    showCurrent();
    setStatus(`נפתח: ${a.title}`);
  } catch (e) {
    setStatus(`לא ניתן לפתוח את הניתוח: ${e.message}`);
  }
}

function saveAnalysis(asNew) {
  const c = state.current;
  const title = prompt('שם לניתוח:', c && !asNew ? c.title : state.areas.map((a) => a.name).join(' מול ').slice(0, 100));
  if (title == null) return;
  const clean = title.trim().slice(0, 120) || 'ניתוח ללא שם';
  const list = readSaved();
  const now = new Date().toISOString();
  let entry = c?.kind === 'local' && !asNew ? list.find((x) => x.id === c.id) : null;
  if (entry) Object.assign(entry, { title: clean, state: snapshot(), updated_at: now });
  else {
    entry = { id: crypto.randomUUID(), title: clean, state: snapshot(), created_at: now, updated_at: now };
    list.push(entry);
  }
  try {
    writeSaved(list);
  } catch {
    setStatus('הדפדפן לא שמר את הניתוח (האחסון מלא, או חסום בחלון פרטי).');
    return;
  }
  state.current = { kind: 'local', id: entry.id, title: clean };
  showCurrent();
  renderSaved();
  setStatus(`נשמר בדפדפן הזה: ${clean}`);
}

async function onSavedClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  const { kind } = t.dataset;
  if (t.dataset.copyCurrent !== undefined) {
    copyLink(state.current?.title || state.areas.map((a) => a.name).join(' מול ').slice(0, 100), snapshot());
  } else if (t.dataset.open) {
    if (kind === 'local') openLocal(t.dataset.open);
    else openAccount(t.dataset.open);
  } else if (t.dataset.copy) {
    if (kind === 'local') {
      const a = readSaved().find((x) => x.id === t.dataset.copy);
      if (a) copyLink(a.title, a.state);
    } else {
      copyText(`${location.origin}/?analysis=${encodeURIComponent(t.dataset.copy)}`, 'הקישור הועתק. הוא נפתח לכל אחד, בלי כניסה.');
    }
  } else if (t.dataset.del) {
    const id = t.dataset.del;
    if (kind === 'local') {
      if (!confirm('למחוק את הניתוח מהרשימה בדפדפן הזה? קישורים ששלחת ימשיכו לעבוד, כי הם מכילים את הניתוח עצמו.')) return;
      try { writeSaved(readSaved().filter((x) => x.id !== id)); } catch { /* storage blocked: nothing to delete */ }
    } else {
      if (!confirm('למחוק את הניתוח מהחשבון? מי שקיבל קישור אליו לא יוכל לפתוח אותו.')) return;
      try { await api('DELETE', `/api/analyses/${encodeURIComponent(id)}`); } catch (err) { setStatus(err.message); return; }
    }
    if (state.current?.id === id) { state.current = null; history.replaceState(null, '', location.pathname); showCurrent(); }
    renderSaved();
  }
}

async function initSaved() {
  $('#saved-panel').hidden = false;
  $('#save-analysis').onclick = () => saveAnalysis(false);
  $('#save-new').onclick = () => saveAnalysis(true);
  $('#saved-panel').addEventListener('click', onSavedClick);
  showCurrent();
  renderSaved();

  // A shared link (#s=…) or an analysis saved to an account (?analysis=<id>).
  if (location.hash.startsWith(LINK_PREFIX)) {
    try {
      const { title, state: s } = await unpackLink(location.hash);
      state.current = { kind: 'link', title };
      applySnapshot(s);
      showCurrent();
      setStatus(`נפתח מקישור: ${title}. כדי לשמור אותו אצלך, לחצו "שמור".`);
    } catch {
      setStatus('הקישור פגום או חלקי — ייתכן שהוא נחתך בהעתקה.');
    }
    history.replaceState(null, '', location.pathname);
  } else {
    const id = new URLSearchParams(location.search).get('analysis');
    if (id) openAccount(id);
  }

  // Sign-in is optional: for admins, and for analyses saved to an account.
  try {
    state.me = await api('GET', '/api/me');
  } catch {
    return; // no server (a plain static preview)
  }
  const me = state.me;
  $('#userbar').innerHTML = me.signed_in
    ? `${esc(me.email)}${me.role === 'admin' ? ' · <a href="/admin">ניהול משתמשים</a>' : ''} · <a href="${esc(me.logout)}">התנתקות</a>`
    : ''; // no sign-in link: admins go to /admin directly
  if (me.signed_in) renderSaved();
}

// Last: it reads the constants above.
initSaved();

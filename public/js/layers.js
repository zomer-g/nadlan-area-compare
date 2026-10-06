// Map overlays: neighbourhoods, CBS statistical areas, and choropleths of
// statistical-area data.
//
// The polygons come from OVER, but not live: scripts/build_layers.mjs pulls
// them once, simplifies them (~4 m; ~30 m for very large rural areas) and cuts
// them into a grid of 0.1° tiles under data/layers/, served by this site. The
// map fetches only the tiles that cover the view, each tile once, and every
// thematic map of a layer reads the same tiles — switching themes loads
// nothing. (Live, OVER returned full-resolution polygons: ~10 MB for one
// Tel Aviv view.)

import { esc } from './util.js?v=0ca9b3f253';

const BASE = 'data/layers';

export const OUTLINES = {
  gush: {
    label: 'גושים (מפ"י)',
    layer: 'gush',
    minZoom: 13,
    name: (p) => `${p.name}${p.locality ? ` · ${p.locality}` : ''}`,
    color: '#b45309',
    // Tax-assessment blocks missing from the gush map are drawn dashed.
    dashed: (p) => Boolean(p.shuma),
    source: 'שכבת הגושים ושכבת גושי השומה של המרכז למיפוי ישראל (מ-OVER)',
  },
  neighborhood: {
    label: 'שכונות (מפ"י)',
    layer: 'nbr',
    minZoom: 11,
    name: (p) => `${p.name}${p.setl ? ` · ${p.setl}` : ''}`,
    color: '#0f766e',
    source: 'שכבת השכונות של המרכז למיפוי ישראל (מ-OVER)',
  },
  stat: {
    label: 'אזורים סטטיסטיים 2022 (למ"ס)',
    layer: 'stat22',
    minZoom: 12,
    name: (p) => p.name,
    color: '#7c3aed',
    source: 'שכבת האזורים הסטטיסטיים 2022 של הלמ"ס (מ-OVER)',
  },
};

const n0 = (v) => Math.round(v).toLocaleString('he-IL');

// Thematic layers. `fixed` classes mean the same colour everywhere; otherwise
// the classes are sevenths of the areas in view, and the legend says so.
export const THEMES = {
  socio: {
    label: 'מדד חברתי-כלכלי 2021 (אשכול 1–10)', layer: 'stat11', field: 'socio',
    fixed: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], fmt: (v) => `אשכול ${v}`,
    note: 'הלמ"ס, מדד 2021 על חלוקת האזורים הסטטיסטיים של 2011 (1 = הנמוך ביותר).',
  },
  pop: { label: 'אוכלוסייה 2024', layer: 'stat22', field: 'pop', fmt: (v) => `${n0(v)} תושבים`, note: 'הלמ"ס, אומדן אוכלוסייה 2024 לפי אזור סטטיסטי 2022.' },
  density: {
    label: 'צפיפות אוכלוסייה 2024 (נפש לקמ"ר)', layer: 'stat22', field: 'density_calc', fmt: (v) => `${n0(v)} לקמ"ר`,
    note: 'מחושב: אומדן אוכלוסייה 2024 ÷ שטח הא"ס. (הלמ"ס פרסמה צפיפות ל-1,042 מתוך 3,857 אזורים בלבד, ולאף אזור בתל אביב.)',
  },
  hh: { label: 'משקי בית 2022', layer: 'stat22', field: 'hh', fmt: (v) => `${n0(v)} משקי בית`, note: 'מפקד 2022, מעוגל.' },
  age: { label: 'גיל חציוני 2022', layer: 'stat22', field: 'age', fmt: (v) => `גיל חציוני ${v}`, note: 'מפקד 2022.' },
  own: { label: '% משקי בית בדירה בבעלות 2022', layer: 'stat22', field: 'own', fmt: (v) => `${v}% בבעלות`, note: 'מפקד 2022.' },
  acad: { label: '% בעלי תעודה אקדמית 2022', layer: 'stat22', field: 'acad', fmt: (v) => `${v}% אקדמאים`, note: 'מפקד 2022.' },
  wage: { label: 'שכר שנתי חציוני לשכירים 2022', layer: 'stat22', field: 'wage', fmt: (v) => `${n0(v)} ₪ בשנה`, note: 'מפקד 2022.' },
};
const THEME_MIN_ZOOM = 11;

const RAMP = ['#fff7bc', '#fee391', '#fec44f', '#fe9929', '#ec7014', '#cc4c02', '#8c2d04'];
const RAMP10 = ['#a50026', '#d73027', '#f46d43', '#fdae61', '#fee08b', '#d9ef8b', '#a6d96a', '#66bd63', '#1a9850', '#006837'];

export function quantileBreaks(values, k = RAMP.length) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [];
  const out = [];
  for (let i = 1; i < k; i++) out.push(v[Math.min(v.length - 1, Math.floor((i * v.length) / k))]);
  return [...new Set(out)];
}

function classOf(v, breaks) {
  let i = 0;
  while (i < breaks.length && v >= breaks[i]) i += 1;
  return i;
}

// ── the tile store: one per data layer, shared by every map layer reading it ──
let manifestP = null;
function manifest() {
  manifestP ??= fetch(`${BASE}/manifest.json`, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`manifest HTTP ${r.status}`);
    return r.json();
  });
  return manifestP;
}

const stores = {};
function store(layer) {
  stores[layer] ??= { features: new Map(), loaded: new Set(), pending: new Map(), listeners: new Set() };
  return stores[layer];
}

const boxHits = (b, w, s, e, n) => b[0] <= e && b[2] >= w && b[1] <= n && b[3] >= s;

// Inverse of scripts/build_layers.mjs encode(): integer 1e-5° deltas → GeoJSON.
export function decodeRing(a) {
  const ring = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i += 2) {
    x += a[i];
    y += a[i + 1];
    ring.push([x / 1e5, y / 1e5]);
  }
  return ring;
}
export function decode(g) {
  return g.t === 'P'
    ? { type: 'Polygon', coordinates: g.c.map(decodeRing) }
    : { type: 'MultiPolygon', coordinates: g.c.map((poly) => poly.map(decodeRing)) };
}

// Fetch the given files of a layer (tile keys, or "_big/<id>"), each once.
// Resolves with the number of features newly added; listeners are told.
async function ensureFiles(layer, files) {
  const m = await manifest();
  const st = store(layer);
  const jobs = files.filter((k) => !st.loaded.has(k)).map((k) => {
    if (!st.pending.has(k)) {
      st.pending.set(k, fetch(`${BASE}/${layer}/${k}.json?v=${m.built}`)
        .then((r) => { if (!r.ok) throw new Error(`tile ${k}: HTTP ${r.status}`); return r.json(); })
        .then((fs) => {
          const fresh = [];
          for (const f of fs) {
            if (st.features.has(f.id)) continue;
            const feat = { type: 'Feature', id: f.id, properties: f.p, geometry: decode(f.g), bbox: f.b };
            if (f.p.pop != null) {
              const km2 = turf.area(feat) / 1e6;
              if (km2 > 0) feat.properties.density_calc = Math.round(Number(f.p.pop) / km2);
            }
            st.features.set(f.id, feat);
            fresh.push(feat);
          }
          st.loaded.add(k);
          st.pending.delete(k);
          for (const fn of st.listeners) fn(fresh);
          return fresh.length;
        })
        .catch((err) => { st.pending.delete(k); throw err; }));
    }
    return st.pending.get(k);
  });
  const counts = await Promise.all(jobs);
  return counts.reduce((a, b) => a + b, 0);
}

// Every tile of `layer` that covers the box [w, s, e, n], plus the big
// polygons (each in its own file) whose box it touches.
export async function ensureBox(layer, [w, s, e, n]) {
  const m = await manifest();
  const meta = m.layers[layer];
  const T = m.tile_deg;
  const have = new Set(meta.tiles);
  const files = [];
  for (let ix = Math.floor(w / T); ix <= Math.floor(e / T); ix++) {
    for (let iy = Math.floor(s / T); iy <= Math.floor(n / T); iy++) {
      const k = `${ix}_${iy}`;
      if (have.has(k)) files.push(k);
    }
  }
  for (const [id, b] of Object.entries(meta.big || {})) if (boxHits(b, w, s, e, n)) files.push(`_big/${id}`);
  return ensureFiles(layer, files);
}

// Every statistical area of the given settlements (CBS codes), wherever they are.
export async function ensureSettlements(layer, codes) {
  const m = await manifest();
  const idx = m.layers[layer].by_settlement || {};
  return ensureFiles(layer, [...new Set(codes.flatMap((c) => idx[c] || []))]);
}

export function loadedFeatures(layer) {
  return [...store(layer).features.values()];
}

const ensure = (layer, b) => ensureBox(layer, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);

// A map layer over a tile store. Features are added as their tiles arrive and
// kept (a tile is never fetched twice); `inView()` lists those in the view.
function tiledLayer(map, { layer, minZoom, pane, style, onEach, onStatus, onChange }) {
  const renderer = L.canvas({ pane, padding: 0.2 });
  const geo = L.geoJSON(null, { renderer, pane, style, onEachFeature: onEach });
  const st = store(layer);
  let on = false;
  let timer = null;
  const listener = (fresh) => { if (on && fresh.length) { geo.addData(fresh); onChange?.(); } };

  async function load() {
    if (!on) return;
    if (map.getZoom() < minZoom) {
      map.removeLayer(geo);
      onStatus?.(`מוצג מזום ${minZoom} ומעלה — התקרבו`);
      return;
    }
    if (!map.hasLayer(geo)) geo.addTo(map);
    const missing = !st.loaded.size;
    if (missing) onStatus?.('טוען…');
    try {
      await ensure(layer, map.getBounds().pad(0.25));
      if (!on) return;
      onChange?.();
      onStatus?.(`${inView().length.toLocaleString('he-IL')} פוליגונים בתצוגה`);
    } catch (e) {
      onStatus?.(`שגיאה: ${e.message}`);
    }
  }
  function inView() {
    const b = map.getBounds();
    const w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
    return [...st.features.values()].filter((f) => boxHits(f.bbox, w, s, e, n));
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(load, 200); };
  map.on('moveend', schedule);
  return {
    get on() { return on; },
    set(v) {
      if (v === on) return;
      on = v;
      if (v) {
        geo.clearLayers();
        geo.addData([...st.features.values()]);
        st.listeners.add(listener);
        schedule();
      } else {
        st.listeners.delete(listener);
        map.removeLayer(geo);
      }
    },
    refresh() { geo.setStyle(style); },
    closeTooltips() { geo.eachLayer((l) => l.closeTooltip()); },
    inView,
    dispose() { this.set(false); map.off('moveend', schedule); clearTimeout(timer); },
  };
}

export function createOverlays(map, { onPick, onStatus }) {
  map.createPane('themes').style.zIndex = 350; // under the areas (overlayPane, 400)
  const outPane = map.createPane('outlines');
  outPane.style.zIndex = 450; // above the parcels, so a pick click reaches the polygon
  outPane.style.pointerEvents = 'none';
  let pickKind = null;

  const outlines = {};
  for (const [kind, def] of Object.entries(OUTLINES)) {
    outlines[kind] = tiledLayer(map, {
      layer: def.layer,
      minZoom: def.minZoom,
      pane: 'outlines',
      onStatus: (m) => onStatus(`${def.label}: ${m}`),
      style: (f) => ({
        color: def.color, weight: pickKind === kind ? 2 : 1.3, fillColor: def.color, fillOpacity: pickKind === kind ? 0.06 : 0, opacity: 0.9,
        dashArray: def.dashed?.(f.properties) ? '5 4' : null,
      }),
      onEach: (f, l) => {
        l.bindTooltip(esc(def.name(f.properties)), { sticky: true, direction: 'top' });
        l.on('mouseover', () => { if (pickKind === kind) l.setStyle({ fillOpacity: 0.3, weight: 3 }); });
        l.on('mouseout', () => { if (pickKind === kind) l.setStyle({ fillOpacity: 0.06, weight: 2 }); });
        l.on('click', (e) => {
          if (pickKind !== kind) return;
          L.DomEvent.stop(e);
          onPick(kind, def.name(f.properties), f.geometry, def.source);
        });
      },
    });
  }

  let theme = null;
  let breaks = [];
  let themeLayer = null;
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => L.DomUtil.create('div', 'legend');
  legend.addTo(map);
  const legendEl = legend.getContainer();
  legendEl.hidden = true;

  const valueOf = (p) => (p[theme.field] == null ? NaN : Number(p[theme.field]));
  const colorOf = (v) => {
    if (!Number.isFinite(v)) return 'transparent';
    if (theme.fixed) return RAMP10[Math.max(0, Math.min(9, Math.round(v) - 1))];
    return RAMP[classOf(v, breaks)];
  };

  function drawLegend() {
    if (!theme) { legendEl.hidden = true; return; }
    legendEl.hidden = false;
    const f = (x) => Number(x).toLocaleString('he-IL', { maximumFractionDigits: 1 });
    const rows = theme.fixed
      ? theme.fixed.map((v, i) => `<div><i style="background:${RAMP10[i]}"></i>${v}</div>`).join('')
      : RAMP.slice(0, breaks.length + 1).map((c, i) => {
        const lo = i === 0 ? null : breaks[i - 1];
        const hi = i < breaks.length ? breaks[i] : null;
        return `<div><i style="background:${c}"></i><span class="num">${lo == null ? `< ${f(hi)}` : hi == null ? `≥ ${f(lo)}` : `${f(lo)}–${f(hi)}`}</span></div>`;
      }).join('');
    legendEl.innerHTML = `<b>${esc(theme.label)}</b>${rows}<div class="muted">אין נתון: שקוף</div>
      <div class="muted">${esc(theme.note)}${theme.fixed ? '' : ' המדרגות: שביעונים של האזורים שבתצוגה.'}</div>`;
  }

  function recolor() {
    if (!theme || !themeLayer) return;
    if (!theme.fixed) breaks = quantileBreaks(themeLayer.inView().map((f) => valueOf(f.properties)));
    themeLayer.refresh();
    drawLegend();
  }
  map.on('moveend', () => { if (theme && !theme.fixed) recolor(); });

  function setTheme(key) {
    themeLayer?.dispose();
    themeLayer = null;
    theme = THEMES[key] || null;
    if (theme) {
      const t = theme;
      themeLayer = tiledLayer(map, {
        layer: t.layer,
        minZoom: THEME_MIN_ZOOM,
        pane: 'themes',
        onStatus: (m) => onStatus(`${t.label}: ${m}`),
        style: (f) => ({ color: '#555', weight: 0.4, fillColor: colorOf(valueOf(f.properties)), fillOpacity: 0.55 }),
        onEach: (f, l) => {
          const v = Number(f.properties[t.field]);
          l.bindTooltip(`${esc(f.properties.name)}<br>${f.properties[t.field] != null && Number.isFinite(v) ? esc(t.fmt(v)) : 'אין נתון (אזור קטן או חסוי)'}`, { sticky: true });
        },
        onChange: recolor,
      });
      themeLayer.set(true);
    }
    drawLegend();
  }

  return {
    outlines,
    setOutline(kind, on) { outlines[kind].set(on); },
    setTheme,
    // Pick mode shows the matching outline layer and makes it clickable.
    setPick(kind) {
      pickKind = kind;
      // Outlines take clicks only while picking; otherwise they would sit on
      // top of the parcel tooltips.
      map.getPane('outlines').style.pointerEvents = kind ? 'auto' : 'none';
      // Leaving pick mode turns the pane's pointer events off, so no mouseout
      // would ever close a tooltip left open: close them here.
      for (const o of Object.values(outlines)) { o.refresh(); if (!kind) o.closeTooltips(); }
      if (kind && !outlines[kind].on) outlines[kind].set(true);
      return outlines;
    },
  };
}

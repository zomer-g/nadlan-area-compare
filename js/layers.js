// Map overlays drawn from OVER's spatial tables: the neighbourhood layer, the
// CBS statistical areas, and choropleths of statistical-area data.
//
// Every layer is fetched for the viewport (padded) through OVER's features
// endpoint, and not refetched while the view stays inside what was loaded —
// the same pattern, and the same 30-requests-a-minute budget, as the parcels.

import { tableFeatures } from './over.js?v=a8360f29a3';
import { esc } from './util.js?v=a8360f29a3';

export const OUTLINES = {
  neighborhood: {
    label: 'שכונות (מפ"י)',
    table: 'govmap_22_bd519a1c_f6a7046f',
    columns: 'fname,setl_name',
    minZoom: 12,
    name: (p) => `${p.fname}${p.setl_name ? ` · ${p.setl_name}` : ''}`,
    color: '#0f766e',
    source: 'שכבת השכונות של המרכז למיפוי ישראל (דרך OVER)',
  },
  stat: {
    label: 'אזורים סטטיסטיים 2022 (למ"ס)',
    table: 'append_cbs_pub_file_7a4d3897_38170565',
    columns: 'STAT_2022,SHEM_YISHUV_HEB',
    minZoom: 14, // OVER serves full-resolution polygons: at 13 a city is ~10 MB
    name: (p) => `א"ס ${String(p.STAT_2022 || '').replace(/\.0$/, '')} · ${p.SHEM_YISHUV_HEB || ''}`,
    color: '#7c3aed',
    source: 'שכבת האזורים הסטטיסטיים 2022 של הלמ"ס (דרך OVER)',
  },
};

const CENSUS = 'append_cbs_pub_file_7a4d3897_38170565';
const censusName = (p) => `א"ס ${String(p.STAT_2022 || '').replace(/\.0$/, '')} · ${p.SHEM_YISHUV_HEB || ''}`;
const CENSUS_COLS = 'STAT_2022,SHEM_YISHUV_HEB';

// Thematic layers. `breaks: 'fixed'` uses the given classes everywhere, so a
// colour means the same thing in every city; otherwise the classes are
// quantiles of what is loaded, and the legend says so.
export const THEMES = {
  socio: {
    label: 'מדד חברתי-כלכלי 2021 (אשכול 1–10)',
    table: 'append_cbs_pub_file_afb48290_5fa5cab4',
    field: 'eshkol_madad2021',
    columns: 'STAT11,SHEM_YISHUV,eshkol_madad2021',
    name: (p) => `א"ס ${String(p.STAT11 || '').replace(/\.0$/, '')} · ${p.SHEM_YISHUV || ''}`,
    fixed: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    fmt: (v) => `אשכול ${v}`,
    note: 'הלמ"ס, מדד 2021 על חלוקת האזורים הסטטיסטיים של 2011 (1 = הנמוך ביותר).',
  },
  pop: {
    label: 'אוכלוסייה 2024',
    table: 'append_cbs_pub_file_a74ad779_a13c151c',
    field: 'Pop_Total',
    columns: 'STAT22,SHEM_YISHUV,Pop_Total',
    name: (p) => `א"ס ${String(p.STAT22 || '').replace(/\.0$/, '')} · ${p.SHEM_YISHUV || ''}`,
    fmt: (v) => `${Math.round(v).toLocaleString('he-IL')} תושבים`,
    note: 'הלמ"ס, אומדן אוכלוסייה 2024 לפי אזור סטטיסטי 2022.',
  },
  density: {
    label: 'צפיפות אוכלוסייה 2022 (נפש לקמ"ר)', table: CENSUS, field: 'pop_density', columns: `${CENSUS_COLS},pop_density`,
    name: censusName, fmt: (v) => `${Math.round(v).toLocaleString('he-IL')} לקמ"ר`, note: 'מפקד 2022.',
  },
  hh: {
    label: 'משקי בית 2022', table: CENSUS, field: 'hh_total_approx', columns: `${CENSUS_COLS},hh_total_approx`,
    name: censusName, fmt: (v) => `${Math.round(v).toLocaleString('he-IL')} משקי בית`, note: 'מפקד 2022, מעוגל.',
  },
  age: {
    label: 'גיל חציוני 2022', table: CENSUS, field: 'age_median', columns: `${CENSUS_COLS},age_median`,
    name: censusName, fmt: (v) => `גיל חציוני ${v}`, note: 'מפקד 2022.',
  },
  own: {
    label: '% משקי בית בדירה בבעלות 2022', table: CENSUS, field: 'own_pcnt', columns: `${CENSUS_COLS},own_pcnt`,
    name: censusName, fmt: (v) => `${v}% בבעלות`, note: 'מפקד 2022.',
  },
  acad: {
    label: '% בעלי תעודה אקדמית 2022', table: CENSUS, field: 'AcadmCert_pcnt', columns: `${CENSUS_COLS},AcadmCert_pcnt`,
    name: censusName, fmt: (v) => `${v}% אקדמאים`, note: 'מפקד 2022.',
  },
  wage: {
    label: 'שכר שנתי חציוני לשכירים 2022', table: CENSUS, field: 'employeesAnnual_medWage', columns: `${CENSUS_COLS},employeesAnnual_medWage`,
    name: censusName, fmt: (v) => `${Math.round(v).toLocaleString('he-IL')} ₪ בשנה`, note: 'מפקד 2022.',
  },
};

// Seven sequential classes, light to dark, readable on both base maps.
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

// A viewport-loaded GeoJSON layer. `pick` makes features clickable.
function viewportLayer(map, { table, columns, minZoom, style, onEach, pane, onStatus, onData }) {
  const layer = L.geoJSON(null, { pane, style, onEachFeature: onEach });
  let box = null;
  let ctrl = null;
  let timer = null;
  let on = false;

  async function load() {
    if (!on) return;
    if (map.getZoom() < minZoom) {
      ctrl?.abort();
      layer.clearLayers();
      box = null;
      onStatus?.(`מוצג מזום ${minZoom} ומעלה — התקרבו`);
      return;
    }
    const view = map.getBounds();
    if (box && box.contains(view)) return;
    const b = view.pad(0.3);
    ctrl?.abort();
    ctrl = new AbortController();
    onStatus?.('טוען…');
    try {
      const fc = await tableFeatures(table, [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => x.toFixed(5)), columns, ctrl.signal);
      if (!on) return;
      layer.clearLayers();
      layer.addData(fc.features);
      box = fc.exceededTransferLimit ? null : b;
      onData?.(fc.features);
      onStatus?.(`${fc.features.length.toLocaleString('he-IL')} פוליגונים${fc.exceededTransferLimit ? ' (חלקי — התקרבו)' : ''}`);
    } catch (e) {
      if (e.name !== 'AbortError') onStatus?.(`שגיאה: ${e.message}`);
    }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(load, 450); };
  map.on('moveend', schedule);
  const dispose = () => { map.off('moveend', schedule); ctrl?.abort(); clearTimeout(timer); map.removeLayer(layer); on = false; };
  return {
    layer,
    get on() { return on; },
    set(v) {
      on = v;
      if (v) { layer.addTo(map); schedule(); } else { ctrl?.abort(); map.removeLayer(layer); }
    },
    refresh() { layer.setStyle(style); },
    dispose,
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
    outlines[kind] = viewportLayer(map, {
      table: def.table,
      columns: def.columns,
      minZoom: def.minZoom,
      pane: 'outlines',
      onStatus: (m) => onStatus(`${def.label}: ${m}`),
      style: () => ({ color: def.color, weight: pickKind === kind ? 2 : 1.3, fillOpacity: pickKind === kind ? 0.06 : 0, opacity: 0.9 }),
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
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => L.DomUtil.create('div', 'legend');
  legend.addTo(map);
  const legendEl = legend.getContainer();
  legendEl.hidden = true;

  const colorOf = (v) => {
    if (!Number.isFinite(v)) return 'transparent';
    if (theme.fixed) return RAMP10[Math.max(0, Math.min(9, Math.round(v) - 1))];
    return RAMP[classOf(v, breaks)];
  };
  const valueOf = (p) => {
    const v = p[theme.field];
    return v === '' || v == null ? NaN : Number(v);
  };
  const themeLayer = { current: null };

  function drawLegend() {
    if (!theme) { legendEl.hidden = true; return; }
    legendEl.hidden = false;
    const rows = theme.fixed
      ? theme.fixed.map((v, i) => `<div><i style="background:${RAMP10[i]}"></i>${v}</div>`).join('')
      : RAMP.slice(0, breaks.length + 1).map((c, i) => {
        const lo = i === 0 ? null : breaks[i - 1];
        const hi = i < breaks.length ? breaks[i] : null;
        const f = (x) => Number(x).toLocaleString('he-IL', { maximumFractionDigits: 1 });
        return `<div><i style="background:${c}"></i><span class="num">${lo == null ? `< ${f(hi)}` : hi == null ? `≥ ${f(lo)}` : `${f(lo)}–${f(hi)}`}</span></div>`;
      }).join('');
    legendEl.innerHTML = `<b>${esc(theme.label)}</b>${rows}<div class="muted">אין נתון: שקוף</div>
      <div class="muted">${esc(theme.note)}${theme.fixed ? '' : ' המדרגות: שביעונים של האזורים שמוצגים כרגע במסך.'}</div>`;
  }

  function setTheme(key) {
    themeLayer.current?.dispose();
    themeLayer.current = null;
    theme = THEMES[key] || null;
    if (theme) {
      const t = theme;
      const vl = viewportLayer(map, {
        table: t.table,
        columns: t.columns,
        minZoom: 13,
        pane: 'themes',
        onStatus: (m) => onStatus(`${t.label}: ${m}`),
        style: (f) => ({ color: '#555', weight: 0.4, fillColor: colorOf(valueOf(f.properties)), fillOpacity: 0.55 }),
        onEach: (f, l) => {
          const v = valueOf(f.properties);
          l.bindTooltip(`${esc(t.name(f.properties))}<br>${Number.isFinite(v) ? esc(t.fmt(v)) : 'אין נתון (אזור קטן או חסוי)'}`, { sticky: true });
        },
        onData: (features) => {
          if (!t.fixed) breaks = quantileBreaks(features.map((f) => valueOf(f.properties)));
          vl.refresh();
          drawLegend();
        },
      });
      themeLayer.current = vl;
      vl.set(true);
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
      for (const [k, o] of Object.entries(outlines)) o.refresh?.();
      if (kind && !outlines[kind].on) outlines[kind].set(true);
      return outlines;
    },
  };
}

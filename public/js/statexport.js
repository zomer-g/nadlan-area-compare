// Statistical-area tables for download: every CBS 2022 statistical area that
// meets the analysis areas, and every statistical area of the local
// authorities those belong to, with all the thematic values.
//
// Built from the same static tiles as the map (data/layers, snapshotted from
// OVER), so it costs no OVER queries. The socio-economic index is published
// on the 2011 geography; each 2022 area takes the index of the 2011 area that
// contains a point inside it, and the table names that 2011 area.

import { ensureBox, ensureSettlements, loadedFeatures } from './layers.js?v=edffb44336';

const setlOf = (id) => Math.floor(Number(id) / 10000);
const statOf = (id) => Number(id) % 10000;
const setlName = (name) => String(name || '').split(' · ').slice(1).join(' · ');
const r1 = (v) => (v == null || !Number.isFinite(v) ? '' : Math.round(v * 10) / 10);
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v));
// A statistical area counts as meeting an analysis area only above this share
// of its surface: below it is a border sliver left by polygon simplification.
export const MIN_SHARE = 0.01;

export const STAT_COLS = [
  ['setl_code', 'סמל יישוב'],
  ['setl', 'יישוב / רשות'],
  ['stat', 'מספר א"ס 2022'],
  ['stat_code', 'קוד א"ס מלא (יישוב+א"ס)'],
  ['dunam', 'שטח הא"ס (דונם)'],
  ['pop', 'אוכלוסייה 2024'],
  ['hh', 'משקי בית 2022'],
  ['density_calc', 'צפיפות 2024 מחושבת (אוכלוסייה 2024 ÷ שטח, נפש לקמ"ר)'],
  ['density', 'צפיפות 2022 כפי שפרסמה הלמ"ס (חסרה ברוב הערים)'],
  ['age', 'גיל חציוני 2022'],
  ['own', '% משקי בית בדירה בבעלות 2022'],
  ['acad', '% בעלי תעודה אקדמית 2022'],
  ['wage', 'שכר שנתי חציוני לשכירים 2022 (₪)'],
  ['socio', 'מדד חברתי-כלכלי 2021 (אשכול 1–10)'],
  ['socio_stat11', 'א"ס 2011 שממנו נלקח המדד'],
];
export const AREA_COLS = [['area', 'אזור ניתוח'], ['share', '% משטח הא"ס בתוך האזור'], ...STAT_COLS];
export const SETTLEMENT_COLS = [...STAT_COLS, ['in_areas', 'חותך את אזורי הניתוח']];

function baseRow(f, socioOf) {
  const p = f.properties;
  const s = socioOf(f);
  const km2 = turf.area(f) / 1e6;
  return {
    setl_code: setlOf(f.id),
    setl: setlName(p.name),
    stat: statOf(f.id),
    stat_code: f.id,
    dunam: Math.round(km2 * 1000),
    pop: num(p.pop), hh: num(p.hh),
    density_calc: num(p.pop) !== '' && km2 > 0 ? Math.round(Number(p.pop) / km2) : '',
    density: num(p.density), age: num(p.age),
    own: num(p.own), acad: num(p.acad), wage: num(p.wage),
    socio: num(s?.properties.socio),
    socio_stat11: s ? statOf(s.id) : '',
  };
}

// The 2011 area containing a point inside the 2022 one (same settlement first).
function socioMatcher() {
  const by = new Map();
  for (const f of loadedFeatures('stat11')) {
    const c = setlOf(f.id);
    if (!by.has(c)) by.set(c, []);
    by.get(c).push(f);
  }
  return (f) => {
    const pt = turf.pointOnFeature(f);
    const [x, y] = pt.geometry.coordinates;
    const hit = (g) => g.bbox[0] <= x && g.bbox[2] >= x && g.bbox[1] <= y && g.bbox[3] >= y && turf.booleanPointInPolygon(pt, g);
    return (by.get(setlOf(f.id)) || []).find(hit) || loadedFeatures('stat11').find(hit) || null;
  };
}

// areas: [{ name, geom (GeoJSON Feature) }]. Returns { areaRows, settlementRows, settlements }.
export async function buildStatTables(areas, onProgress = () => {}) {
  onProgress('טוען אזורים סטטיסטיים…');
  for (const a of areas) {
    const bb = turf.bbox(a.geom);
    await Promise.all([ensureBox('stat22', bb), ensureBox('stat11', bb)]);
  }
  const meets = [];
  for (const a of areas) {
    const [w, s, e, n] = turf.bbox(a.geom);
    for (const f of loadedFeatures('stat22')) {
      const b = f.bbox;
      if (b[0] > e || b[2] < w || b[1] > n || b[3] < s) continue;
      if (!turf.booleanIntersects(f, a.geom)) continue;
      let share = null;
      try {
        const x = turf.intersect(turf.featureCollection([f, a.geom]));
        share = x ? turf.area(x) / turf.area(f) : 0;
      } catch { /* invalid ring: leave the share empty rather than fail the file */ }
      if (share != null && share < MIN_SHARE) continue; // a border sliver, not a real overlap
      meets.push({ a, f, share });
    }
  }
  const codes = [...new Set(meets.map((m) => setlOf(m.f.id)))];
  onProgress(`טוען את כל האזורים הסטטיסטיים של ${codes.length} רשויות…`);
  await Promise.all([ensureSettlements('stat22', codes), ensureSettlements('stat11', codes)]);
  const socioOf = socioMatcher();

  const areaRows = meets.map(({ a, f, share }) => ({ area: a.name, share: share == null ? '' : r1(share * 100), ...baseRow(f, socioOf) }));
  const inAreas = new Map();
  for (const { a, f } of meets) {
    if (!inAreas.has(f.id)) inAreas.set(f.id, new Set());
    inAreas.get(f.id).add(a.name);
  }
  const codeSet = new Set(codes);
  const settlementRows = loadedFeatures('stat22')
    .filter((f) => codeSet.has(setlOf(f.id)))
    .map((f) => ({ ...baseRow(f, socioOf), in_areas: [...(inAreas.get(f.id) || [])].join(' · ') }))
    .sort((x, y) => x.setl_code - y.setl_code || x.stat - y.stat);
  areaRows.sort((x, y) => x.area.localeCompare(y.area) || x.setl_code - y.setl_code || x.stat - y.stat);
  return { areaRows, settlementRows, settlements: codes.length };
}

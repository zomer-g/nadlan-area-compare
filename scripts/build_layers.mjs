// Builds the map's data layers as static, tiled, simplified GeoJSON in
// data/layers/, from OVER — so the browser never pulls full-resolution
// polygons for a whole viewport (a Tel Aviv view at zoom 13 was ~10 MB).
//
//   node scripts/build_layers.mjs
//
// For each layer: page through OVER's read-only SQL endpoint (respecting its
// 20-queries-a-minute limit), simplify on the server, then cut into a grid of
// TILE° × TILE° cells. A polygon is written to every cell its bounding box
// touches; the client de-duplicates by id. These are census snapshots that do
// not move, so the layers are rebuilt by hand when CBS publishes new data.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SQL = 'https://www.over.org.il/api/append/fd06f5ae-8a4f-4120-b275-8a514ad23499/sql';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'layers');
export const TILE = 0.1; // degrees, ~11 km × 9 km
const SIMPLIFY = 0.00004; // degrees, ~4 m
// Large polygons (rural statistical areas, some hundreds of km²) are simplified
// harder: 4 m precision on a desert polygon is weight with no use.
const BIG_AREA = 0.0005; // degrees² ≈ 5 km²
const SIMPLIFY_BIG = 0.0003; // ~30 m
// A polygon spanning more than this many tiles gets a file of its own
// (_big/<id>.json, fetched when the view touches its box) instead of being
// copied into every tile it touches.
const SHARED_SPAN = 4;
const PAGE = 600;
const PAUSE_MS = 3500; // 20 queries a minute

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const geo = `extensions.ST_AsGeoJSON(extensions.ST_SimplifyPreserveTopology(extensions.ST_MakeValid(geom),
  CASE WHEN extensions.ST_Area(geom) > ${BIG_AREA} THEN ${SIMPLIFY_BIG} ELSE ${SIMPLIFY} END), 5)`;
// Guarded numeric cast of a text column expression (missing values are '').
const num = (e) => `CASE WHEN ${e} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${e}::numeric END`;

const LAYERS = {
  nbr: {
    title: 'שכונות — המרכז למיפוי ישראל',
    over_table: 'idx.govmap_22_bd519a1c_f6a7046f',
    sql: `SELECT "objectId" AS id, fname, setl_name, ${geo} AS g FROM idx.govmap_22_bd519a1c_f6a7046f WHERE geom IS NOT NULL`,
    props: (r) => ({ name: r.fname, setl: r.setl_name }),
  },
  stat22: {
    title: 'אזורים סטטיסטיים 2022 — מפקד 2022 (למ"ס), עם אומדן אוכלוסייה 2024',
    over_table: 'append_cbs_pub_file_7a4d3897_38170565 + append_cbs_pub_file_a74ad779_a13c151c',
    // Census 2022 polygons, joined to the 2024 population estimate on the
    // locality+area code (same 2022 geography in both files).
    // (Census columns are left unqualified: OVER's endpoint auto-corrects the
    // casing of quoted names and mangles an alias-qualified one.)
    sql: `SELECT "YISHUV_STAT_2022" AS id, "STAT_2022" AS stat, "SHEM_YISHUV_HEB" AS setl,
        ${num('pop_density')} AS density,
        ${num('hh_total_approx')} AS hh,
        ${num('age_median')} AS age,
        ${num('own_pcnt')} AS own,
        ${num('"AcadmCert_pcnt"')} AS acad,
        ${num('"employeesAnnual_medWage"')} AS wage,
        ${num('pop24.pt')} AS pop,
        ${geo} AS g
      FROM append_cbs_pub_file_7a4d3897_38170565
      LEFT JOIN (SELECT "YISHUV_STAT22" AS k, max("Pop_Total") AS pt
                 FROM append_cbs_pub_file_a74ad779_a13c151c GROUP BY 1) pop24 ON pop24.k = "YISHUV_STAT_2022"
      WHERE geom IS NOT NULL`,
    props: (r) => ({
      name: `א"ס ${String(r.stat || '').replace(/\.0$/, '')} · ${r.setl || ''}`,
      density: r.density, hh: r.hh, age: r.age, own: r.own, acad: r.acad, wage: r.wage, pop: r.pop,
    }),
  },
  stat11: {
    title: 'אזורים סטטיסטיים 2011 — מדד חברתי-כלכלי 2021 (למ"ס)',
    over_table: 'append_cbs_pub_file_afb48290_5fa5cab4',
    sql: `SELECT "YISHUV_STAT11" AS id, "STAT11" AS stat, "SHEM_YISHUV" AS setl, ${num('"eshkol_madad2021"')} AS socio, ${geo} AS g
      FROM append_cbs_pub_file_afb48290_5fa5cab4 WHERE geom IS NOT NULL`,
    props: (r) => ({ name: `א"ס ${String(r.stat || '').replace(/\.0$/, '')} · ${r.setl || ''}`, socio: r.socio }),
  },
};

async function run(sql) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(SQL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }) });
    if (res.status === 429) { await sleep(15000); continue; }
    const body = await res.json();
    if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body.detail)}`);
    return body.rows;
  }
  throw new Error('rate limited');
}

function bbox(geometry) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0];
      if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1];
    } else c.forEach(walk);
  };
  walk(geometry.coordinates);
  return [x0, y0, x1, y1];
}

export const tileKey = (ix, iy) => `${ix}_${iy}`;
export const tileIndex = (deg) => Math.floor(deg / TILE + 1e-9);

async function build(key, def) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await run(`SELECT * FROM (${def.sql}) q ORDER BY id LIMIT ${PAGE} OFFSET ${offset}`);
    rows.push(...page);
    process.stdout.write(`\r${key}: ${rows.length}`);
    await sleep(PAUSE_MS);
    if (page.length < PAGE) break;
  }
  console.log();
  const tiles = new Map();
  const shared = [];
  let n = 0;
  for (const r of rows) {
    if (!r.g) continue;
    const g = JSON.parse(r.g);
    if (!['Polygon', 'MultiPolygon'].includes(g.type)) continue;
    const [x0, y0, x1, y1] = bbox(g);
    const f = { id: String(r.id), p: def.props(r), b: [x0, y0, x1, y1].map((v) => Math.round(v * 1e5) / 1e5), g };
    const span = (tileIndex(x1) - tileIndex(x0) + 1) * (tileIndex(y1) - tileIndex(y0) + 1);
    n += 1;
    if (span > SHARED_SPAN) { shared.push(f); continue; }
    for (let ix = tileIndex(x0); ix <= tileIndex(x1); ix++) {
      for (let iy = tileIndex(y0); iy <= tileIndex(y1); iy++) {
        const k = tileKey(ix, iy);
        if (!tiles.has(k)) tiles.set(k, []);
        tiles.get(k).push(f);
      }
    }
  }
  const dir = join(OUT, key);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const [k, fs] of tiles) {
    const s = JSON.stringify(fs);
    bytes += s.length;
    writeFileSync(join(dir, `${k}.json`), s);
  }
  mkdirSync(join(dir, '_big'), { recursive: true });
  let bigBytes = 0;
  for (const f of shared) {
    const s = JSON.stringify([f]);
    bigBytes += s.length;
    writeFileSync(join(dir, '_big', `${f.id}.json`), s);
  }
  console.log(`${key}: ${n} polygons in ${tiles.size} tiles, ${(bytes / 1e6).toFixed(1)} MB; ${shared.length} big ones in own files, ${(bigBytes / 1e6).toFixed(2)} MB`);
  return {
    title: def.title, over_table: def.over_table, polygons: n, tiles: [...tiles.keys()].sort(), bytes,
    // id → box, so the client fetches a big polygon only when the view touches it.
    big: Object.fromEntries(shared.map((f) => [f.id, f.b])), big_bytes: bigBytes,
  };
}

const only = process.argv[2];
const manifest = { built: new Date().toISOString().slice(0, 10), source: 'OVER (over.org.il)', tile_deg: TILE, simplify_deg: SIMPLIFY, simplify_big_deg: SIMPLIFY_BIG, big_area_deg2: BIG_AREA, shared_span: SHARED_SPAN, layers: {} };
for (const [k, def] of Object.entries(LAYERS)) {
  if (only && k !== only) continue;
  manifest.layers[k] = await build(k, def);
}
if (!only) writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));

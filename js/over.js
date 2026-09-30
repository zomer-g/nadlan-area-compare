// Everything that talks to OVER (over.org.il) — the only data source.
//
// Two OVER tables are joined here, both queried through OVER's public,
// read-only SQL endpoint:
//   * the parcel polygons (חלקות, PostGIS `geom`, WGS84)
//   * the tax-authority deal register (עסקאות מיסוי מקרקעין) — every column text
// The register has no coordinates, only גוש + חלקה, so a drawn area reaches
// deals through the parcels whose interior point falls inside it.

export const OVER = 'https://www.over.org.il';
export const DEALS_DATASET = 'fd06f5ae-8a4f-4120-b275-8a514ad23499';
export const PARCELS_TABLE = 'append_shape_ff3176b1';
// The register's physical table name carries a dataset id and has changed
// before; /api/deals/stats reports the live one, this is only the fallback.
let dealsTable = 'append_taxes_nadlan_full_f41fb496_fd06f5ae';


export function getDealsTable() {
  return dealsTable;
}

async function getJson(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('אין תקשורת עם OVER: ' + e.message);
  }
  if (res.status === 429) {
    throw new Error('OVER הגביל את קצב הבקשות (עד 20 שאילתות בדקה). המתינו דקה ונסו שוב.');
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`OVER החזיר תשובה לא תקינה (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body);
    throw new Error(`OVER: ${detail}`);
  }
  return body;
}

export async function registerStats() {
  const s = await getJson(`${OVER}/api/deals/stats`);
  const t = String(s?.table || '').replace(/^public\./, '');
  if (/^[a-z0-9_]+$/.test(t)) dealsTable = t; // goes into SQL unquoted
  return s;
}

export async function natures() {
  const r = await getJson(`${OVER}/api/deals/natures`);
  return r.data || [];
}

export async function runSql(sql) {
  return getJson(`${OVER}/api/append/${DEALS_DATASET}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
  });
}

// A /data deep link that opens the same SQL in OVER's console (base64 in ?q=,
// the format the console reads).
// null when the query is too long for a URL (a detailed area easily is).
export const CONSOLE_URL_MAX_SQL = 6000;
export function consoleUrl(sql) {
  if (sql.length > CONSOLE_URL_MAX_SQL) return null;
  const bytes = new TextEncoder().encode(sql);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x2000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return `${OVER}/data?q=${encodeURIComponent(btoa(bin))}`;
}

export function lit(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// ── SQL builders ────────────────────────────────────────────────────────────
// Kept as plain strings so the page can show the user the exact query that
// produced every number.

function areaCte(geometry) {
  return `area AS (
  SELECT extensions.ST_MakeValid(extensions.ST_SetSRID(
    extensions.ST_GeomFromGeoJSON(${lit(JSON.stringify(geometry))}), 4326)) AS g
)`;
}

// Parcels whose interior point lies inside the area. ST_Intersects first lets
// the GiST index do the cut; the point-on-surface test keeps a large parcel the
// brush only grazed from dragging its deals in.
const PARCELS_CTE = `parcels AS (
  SELECT DISTINCT p."GUSH_NUM" AS gush, p."PARCEL" AS chelka
  FROM ${PARCELS_TABLE} p, area
  WHERE extensions.ST_Intersects(p.geom, area.g)
    AND extensions.ST_Within(extensions.ST_PointOnSurface(p.geom), area.g)
)`;

function dealsCte(f) {
  const where = [
    `d.deal_date ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$'`,
    // Compared as text: Postgres does not promise to run the regex before a cast.
    `substr(d.deal_date, 7, 4) BETWEEN '${Number(f.yearMin)}' AND '${Number(f.yearMax)}'`,
  ];
  if (f.natures?.length) where.push(`d.deal_nature IN (${f.natures.map(lit).join(', ')})`);
  return `deals AS (
  SELECT d.*
  FROM ${getDealsTable()} d
  JOIN parcels USING (gush, chelka)
  WHERE ${where.join('\n    AND ')}
)`;
}

// Households in the area, from the CBS 2022 statistical areas (census 2022),
// apportioned by the share of each statistical area's surface the drawn area
// covers. Households approximate OCCUPIED dwellings; OVER holds no count of
// the whole housing stock.
export const STAT_AREAS_TABLE = 'append_cbs_pub_file_7a4d3897_38170565';
const HOUSEHOLDS_CTE = `households AS (
  SELECT
    sum(NULLIF(s.hh_total_approx, '')::numeric
        * extensions.ST_Area(extensions.ST_Intersection(extensions.ST_MakeValid(s.geom), area.g))
        / NULLIF(extensions.ST_Area(extensions.ST_MakeValid(s.geom)), 0)) AS hh,
    count(*) AS stat_areas,
    count(*) FILTER (WHERE NULLIF(s.hh_total_approx, '') IS NULL) AS stat_areas_no_hh
  FROM ${STAT_AREAS_TABLE} s, area
  WHERE extensions.ST_Intersects(s.geom, area.g)
)`;

// The deals come back as ONE row holding a JSON array of compact arrays
// (OVER caps an answer at 1,000 rows, not at its size), so every statistic is
// computed in the browser from the deals themselves:
//   [yyyymmdd, amount, declared|null, area, portion, year_built, rooms, nature, gush, chelka, sub, settlement_code]
// declared is null when it equals the amount (95%+ of rows), to halve the payload.
export const MAX_DEALS = 150000;
export function dealsSql(geometry, f) {
  // A guarded cast: one stray non-numeric value in a re-scraped register must
  // not fail the whole area's query. (A 12% sample found none today.)
  const n = (c) => `CASE WHEN ${c} ~ '^[0-9]+(\\.[0-9]+)?$' THEN ${c}::numeric END`;
  return `WITH ${areaCte(geometry)},
${PARCELS_CTE},
${dealsCte(f)},
${HOUSEHOLDS_CTE}
SELECT
  (SELECT count(*) FROM parcels) AS parcels_in_area,
  (SELECT count(DISTINCT (gush, chelka)) FROM deals) AS parcels_with_deals,
  (SELECT count(*) FROM deals) AS deals_total,
  (SELECT hh FROM households) AS households,
  (SELECT stat_areas FROM households) AS stat_areas,
  (SELECT stat_areas_no_hh FROM households) AS stat_areas_no_hh,
  (SELECT json_object_agg(code, name) FROM (
     SELECT DISTINCT settlement_code::int AS code, settlement AS name FROM deals
     WHERE settlement_code ~ '^[0-9]+$') s) AS settlements,
  CASE WHEN (SELECT count(*) FROM deals) > ${MAX_DEALS} THEN NULL ELSE (
    SELECT json_agg(json_build_array(
      (substr(deal_date, 7, 4) || substr(deal_date, 4, 2) || substr(deal_date, 1, 2))::int,
      ${n('deal_amount')},
      CASE WHEN declared_amount = deal_amount THEN NULL ELSE ${n('declared_amount')} END,
      ${n('asset_area')}, ${n('portion')}, ${n('year_built')}, ${n('room_num')},
      deal_nature, ${n('gush')}, ${n('chelka')}, ${n('sub_chelka')}, ${n('settlement_code')})
      ORDER BY substr(deal_date, 7, 4) || substr(deal_date, 4, 2) || substr(deal_date, 1, 2) DESC, row_hash)
    FROM deals) END AS deals`;
}

// Click-to-select layers: the polygon under a point, simplified to ~2 m.
export const PICK_LAYERS = {
  neighborhood: {
    table: 'idx.govmap_22_bd519a1c_f6a7046f',
    label: 'שכונה',
    name: `fname || CASE WHEN coalesce(setl_name, '') <> '' THEN ' · ' || setl_name ELSE '' END`,
    source: 'שכבת השכונות של המרכז למיפוי ישראל (דרך OVER)',
  },
  stat: {
    table: STAT_AREAS_TABLE,
    label: 'אזור סטטיסטי',
    name: `'א"ס ' || replace("STAT_2022", '.0', '') || ' · ' || "SHEM_YISHUV_HEB"`,
    source: 'שכבת האזורים הסטטיסטיים 2022 של הלמ"ס (דרך OVER)',
  },
};
export async function polygonAt(kind, lat, lon) {
  const L = PICK_LAYERS[kind];
  const sql = `SELECT ${L.name} AS name,
  extensions.ST_AsGeoJSON(extensions.ST_SimplifyPreserveTopology(extensions.ST_MakeValid(geom), 0.00002), 6) AS geojson
FROM ${L.table}
WHERE extensions.ST_Intersects(geom, extensions.ST_SetSRID(extensions.ST_MakePoint(${Number(lon)}, ${Number(lat)}), 4326))
LIMIT 1`;
  const r = await runSql(sql);
  const row = r.rows?.[0];
  if (!row) return null;
  return { name: row.name, geometry: JSON.parse(row.geojson) };
}

// ── Map helpers ─────────────────────────────────────────────────────────────

export async function parcelFeatures(bbox, signal) {
  const q = new URLSearchParams({
    bbox: bbox.join(','),
    columns: 'GUSH_NUM,GUSH_SUFFI,PARCEL,LEGAL_AREA,LOCALITY_N',
    limit: '5000',
  });
  return getJson(`${OVER}/api/tables/${PARCELS_TABLE}/features?${q}`, { signal });
}

export async function parcelGeometry(gush, helka) {
  const r = await getJson(`${OVER}/api/nadlan/parcel/${gush}/${helka}/geometry`);
  return { ...r, geometry: JSON.parse(r.geojson) };
}

export async function gushExtent(gush) {
  const sql = `SELECT extensions.ST_AsGeoJSON(extensions.ST_Extent(geom)) AS box, count(*) AS parcels
FROM ${PARCELS_TABLE} WHERE "GUSH_NUM" = ${lit(String(Number(gush)))}`;
  const r = await runSql(sql);
  const row = r.rows?.[0];
  if (!row?.box) return null;
  return { box: JSON.parse(row.box), parcels: row.parcels };
}

// Free-text places go to OpenStreetMap's geocoder: OVER's address index covers
// only the big cities and does not resolve a bare place name.
export async function geocode(q) {
  const u = new URLSearchParams({ q, format: 'jsonv2', countrycodes: 'il', limit: '6', 'accept-language': 'he' });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${u}`);
  if (!res.ok) throw new Error(`שגיאת חיפוש כתובת (HTTP ${res.status})`);
  return res.json();
}

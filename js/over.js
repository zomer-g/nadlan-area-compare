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

export const SQL_ROW_CAP = 1000; // OVER caps every SQL answer at 1,000 rows

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
  SELECT d.*,
    substr(d.deal_date, 7, 4)::int AS yr,
    NULLIF(d.deal_amount, '')::numeric AS amt,
    NULLIF(d.asset_area, '')::numeric AS sqm,
    NULLIF(d.portion, '')::numeric AS por
  FROM ${getDealsTable()} d
  JOIN parcels USING (gush, chelka)
  WHERE ${where.join('\n    AND ')}
)`;
}

// Normalized price per m²: the amount pays for `portion` of the asset, so the
// area actually bought is asset_area × portion.
const PPSQM = `CASE WHEN amt > 0 AND sqm > 0 AND por > 0 THEN amt / (sqm * por) END`;

export function aggregateSql(geometry, f) {
  return `WITH ${areaCte(geometry)},
${PARCELS_CTE},
${dealsCte(f)},
years AS (
  SELECT yr,
    count(*) AS deals,
    count(NULLIF(amt, 0)) AS n_amt,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY NULLIF(amt, 0)) AS med_amt,
    count(${PPSQM}) AS n_pp,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY ${PPSQM}) AS med_pp
  FROM deals
  GROUP BY yr
)
SELECT
  (SELECT count(*) FROM parcels) AS parcels_in_area,
  (SELECT count(DISTINCT (gush, chelka)) FROM deals) AS parcels_with_deals,
  (SELECT count(*) FROM deals) AS deals_total,
  (SELECT coalesce(json_agg(y ORDER BY y.yr), '[]'::json) FROM years y) AS years`;
}

export function rawRowsSql(geometry, f, offset = 0) {
  return `WITH ${areaCte(geometry)},
${PARCELS_CTE},
${dealsCte(f)}
SELECT settlement, gush, chelka, sub_chelka, deal_date, yr,
  deal_amount, declared_amount, deal_nature, portion, asset_area, room_num, year_built,
  round(${PPSQM}) AS ppsqm_normalized
FROM deals
ORDER BY substr(deal_date, 7, 4) || substr(deal_date, 4, 2) || substr(deal_date, 1, 2) DESC,
  gush, chelka, sub_chelka, row_hash
LIMIT ${SQL_ROW_CAP} OFFSET ${Number(offset)}`;
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

// The external source: lookup tables a site user compiled by hand and sent
// with their feedback (data/external, described in sources.json). They are
// kept in this project only; everything else comes from OVER.

export const EXTERNAL_SOURCE = 'user_feedback_2026_09';

// Minimal RFC-4180 CSV: quoted fields, doubled quotes, commas and newlines
// inside quotes. The files are written by scripts/extract_external.py.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0] !== '');
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

async function csv(name) {
  const res = await fetch(`data/external/${name}.csv`);
  if (!res.ok) throw new Error(`טבלת העזר ${name} לא נטענה (HTTP ${res.status})`);
  return parseCsv((await res.text()).replace(/^﻿/, ''));
}

export async function loadExternal() {
  const [manifest, natures, gushes, settlements] = await Promise.all([
    fetch('data/external/sources.json').then((r) => r.json()),
    csv('nature_asset_type'),
    csv('gush_neighborhood'),
    csv('settlements_cbs'),
  ]);
  const natureType = new Map(natures.map((r) => [r.deal_nature, r.asset_type]));
  const gushNbr = new Map();
  for (const r of gushes) {
    const g = Number(r.gush);
    if (!gushNbr.has(g)) gushNbr.set(g, []);
    gushNbr.get(g).push(r.neighborhood);
  }
  const settlementInfo = new Map(settlements.map((r) => [Number(r.code), r]));
  return {
    manifest,
    source: manifest.sources[EXTERNAL_SOURCE],
    natureType,
    gushNbr,
    settlementInfo,
    neighborhoodOf: (gush) => (gushNbr.get(gush) || []).join(' / '),
  };
}

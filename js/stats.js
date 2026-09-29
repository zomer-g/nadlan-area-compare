// Trend math. Pure functions only — no DOM, no network — so the numbers the
// page shows can be checked in isolation (tests/stats.test.mjs).
//
// Input everywhere is the per-year series the SQL returns:
//   { yr, deals, n_amt, med_amt, n_pp, med_pp }
// where med_pp is the median of the NORMALIZED price per m²
// (deal_amount / (asset_area × portion)) and n_pp the number of deals it
// was computed over.

export const METRICS = {
  med_pp: { label: 'חציון מחיר למ"ר (מנורמל)', unit: '₪/מ"ר', count: 'n_pp' },
  med_amt: { label: 'חציון שווי עסקה', unit: '₪', count: 'n_amt' },
};

// Years that carry enough deals to be read. A median over a handful of sales
// swings by tens of percent on noise alone, so thin years are shown but kept
// out of every calculation.
export function eligible(series, metric, minDeals) {
  const countKey = METRICS[metric].count;
  return series
    .filter((r) => Number(r[countKey]) >= minDeals && Number(r[metric]) > 0)
    .map((r) => ({ yr: Number(r.yr), m: Number(r[metric]), n: Number(r[countKey]) }));
}

// Change between two years: simple percent and its annualized (CAGR) form.
// Returns null when either year is missing from the eligible points.
export function pointChange(points, yFrom, yTo) {
  const a = points.find((p) => p.yr === yFrom);
  const b = points.find((p) => p.yr === yTo);
  if (!a || !b || yTo <= yFrom) return null;
  const ratio = b.m / a.m;
  return {
    from: a,
    to: b,
    years: yTo - yFrom,
    pct: (ratio - 1) * 100,
    cagr: (Math.pow(ratio, 1 / (yTo - yFrom)) - 1) * 100,
  };
}

// Weighted least squares of ln(M_t) on t, weights = deals behind each median.
//   b = Σw(t−t̄)(y−ȳ) / Σw(t−t̄)²,   annual trend = e^b − 1
// A log fit reads as a constant yearly rate, and weighting keeps a thin year
// from pulling the line as hard as a year with thousands of sales.
export function logTrend(points) {
  if (points.length < 3) return null;
  const W = points.reduce((s, p) => s + p.n, 0);
  const tBar = points.reduce((s, p) => s + p.n * p.yr, 0) / W;
  const yBar = points.reduce((s, p) => s + p.n * Math.log(p.m), 0) / W;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += p.n * (p.yr - tBar) * (Math.log(p.m) - yBar);
    sxx += p.n * (p.yr - tBar) ** 2;
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  const a = yBar - b * tBar;
  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    const y = Math.log(p.m);
    ssRes += p.n * (y - (a + b * p.yr)) ** 2;
    ssTot += p.n * (y - yBar) ** 2;
  }
  return {
    a,
    b,
    annualPct: (Math.exp(b) - 1) * 100,
    r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot,
    n: points.length,
    tBar,
    yBar,
    fromYr: points[0].yr,
    toYr: points[points.length - 1].yr,
  };
}

// Index each series to its own base year (= 100) so areas at different price
// levels can be read on one axis. null where the base year is not eligible.
export function indexTo(points, baseYr) {
  const base = points.find((p) => p.yr === baseYr);
  if (!base) return null;
  return points.map((p) => ({ yr: p.yr, v: (p.m / base.m) * 100 }));
}

// Restrict points to an inclusive year window.
export function within(points, yFrom, yTo) {
  return points.filter((p) => p.yr >= yFrom && p.yr <= yTo);
}

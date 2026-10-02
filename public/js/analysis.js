// Deal-level analysis: classification, size and age groups, the outlier
// filter, and per-year statistics. Pure functions — no DOM, no network — so
// every number the page shows can be checked in tests/analysis.test.mjs.
//
// A deal arrives from OVER as a compact array (see over.dealsSql) and is
// turned into an object by enrich(); everything after that works on objects.

// Size groups by asset area, as explicit half-open intervals [lo, hi).
// They reproduce what the user's spreadsheet VLOOKUP actually does (its labels
// "1-54", "54-80"… are one off from its effective bounds): with integer areas,
// 2–54, 55–80, 81–104, 105–140, 141+. "No size" (area under 2 m²) carries no
// usable price per m² and never enters a price statistic.
export const SIZE_GROUPS = [
  { key: 's0', label: 'ללא גודל (עד 1 מ"ר)', lo: 0, hi: 2 },
  { key: 's1', label: '2–54 מ"ר', lo: 2, hi: 55 },
  { key: 's2', label: '55–80 מ"ר', lo: 55, hi: 81 },
  { key: 's3', label: '81–104 מ"ר', lo: 81, hi: 105 },
  { key: 's4', label: '105–140 מ"ר', lo: 105, hi: 141 },
  { key: 's5', label: '141 מ"ר ומעלה', lo: 141, hi: Infinity },
];
export const PRICED_SIZES = SIZE_GROUPS.filter((g) => g.key !== 's0').map((g) => g.key);

// Building age at the time of the deal (deal year − year built).
export const AGE_GROUPS = [
  { key: 'a0', label: 'חדש (עד שנה)', max: 1 },
  { key: 'a1', label: '2–10 שנים', max: 10 },
  { key: 'a2', label: '11–25 שנים', max: 25 },
  { key: 'a3', label: '26–40 שנים', max: 40 },
  { key: 'a4', label: '41 שנים ומעלה', max: Infinity },
  { key: 'unk', label: 'גיל לא ידוע' },
];

export const MIN_YEAR_BUILT = 1850;
// A flat is often sold off-plan, years before the recorded completion year.
export const MAX_YEARS_AHEAD = 5;

export const OUTLIER_METHODS = {
  sigma: { label: '2 סטיות תקן (על ln המחיר) בכל תא, איטרטיבי' },
  fixed: { label: 'טווח קבוע 1,000–80,000 ₪ למ"ר' },
  none: { label: 'ללא סינון חריגים' },
};
export const SIGMA_K = 2;
export const SIGMA_ROUNDS = 2;
export const PRESCREEN_K = 4; // robust pre-screen, in robust σ (1.4826 × MAD) of ln P
// In a sample of n the largest possible z-score is (n − 1)/√n, under 2 for
// n ≤ 5: a 2σ rule cannot catch anything in a small cell. So the bounds are
// computed on a REFERENCE group of at least SIGMA_REF_N deals, widened step by
// step from the cell itself (see REFERENCE_STEPS), and applied to the cell.
export const SIGMA_REF_N = 20;
export const SIGMA_MIN_N = 7; // below this even the widest reference is not used
export const REFERENCE_STEPS = [
  { key: 'cell', label: 'התא עצמו', sizes: 'same', years: 0 },
  { key: 'y1', label: 'אותו גודל, ±1 שנה', sizes: 'same', years: 1 },
  { key: 'y2', label: 'אותו גודל, ±2 שנים', sizes: 'same', years: 2 },
  { key: 'all0', label: 'כל הגדלים, אותה שנה', sizes: 'all', years: 0 },
  { key: 'all1', label: 'כל הגדלים, ±1 שנה', sizes: 'all', years: 1 },
  { key: 'all2', label: 'כל הגדלים, ±2 שנים', sizes: 'all', years: 2 },
];
export const FIXED_RANGE = [1000, 80000];
export const MIN_AMOUNT = 10; // the spreadsheet's "enough data" rule: declared ≥ 10 ₪

// Areas are rounded to whole m² first, so the labels ("2–54", "55–80"…) are
// exactly true: 54.4 → 54 → 2–54, 54.5 → 55 → 55–80, 1.5 → 2 → 2–54.
export function sizeGroup(sqm) {
  if (!(sqm > 0)) return 's0';
  const r = Math.round(sqm);
  return SIZE_GROUPS.find((g) => r >= g.lo && r < g.hi).key;
}

export function ageOf(yearBuilt, dealYear) {
  if (!Number.isFinite(yearBuilt) || yearBuilt < MIN_YEAR_BUILT || yearBuilt > dealYear + MAX_YEARS_AHEAD) return null;
  return Math.max(0, dealYear - yearBuilt);
}

export function ageGroup(age) {
  if (age == null) return 'unk';
  return AGE_GROUPS.find((g) => g.max != null && age <= g.max).key;
}

const num = (v) => (v == null || v === '' ? null : Number(v));

// raw = [yyyymmdd, amount, declared, area, portion, year_built, rooms, nature, gush, chelka, sub, settlement_code, loc_src, parcel_area, area_src]
export function enrich(raw, natureType) {
  const [date, amt0, decl0, sqm0, por0, yb0, rooms, nature, gush, chelka, sub, scode, locSrc, parcelArea, areaSrc] = raw;
  const yr = Math.floor(date / 10000);
  const amt = num(amt0);
  const sqm = num(sqm0);
  const por = num(por0);
  const yb = num(yb0);
  const valid = amt >= MIN_AMOUNT && sqm > 0 && por > 0;
  const age = ageOf(yb, yr);
  return {
    date,
    yr,
    month: Math.floor(date / 100) % 100,
    amt,
    decl: decl0 == null ? amt : num(decl0), // null in the payload means "same as the deal amount"
    sqm,
    por,
    yb,
    rooms: num(rooms),
    nature,
    type: natureType.get(nature) || 'לא ממופה',
    gush,
    chelka,
    sub,
    scode: scode ?? null,
    shuma: locSrc === 'm', // located by a tax-assessment parcel, not a statutory one
    parcelArea: num(parcelArea), // m² of the whole parcel (not of the asset sold)
    parcelAreaMeasured: areaSrc === 'g', // measured from the polygon: no registered area
    valid,
    pp: valid ? amt / (sqm * por) : null,
    size: sizeGroup(sqm),
    age,
    ageGroup: ageGroup(age),
    drop: null, // why the deal is out of price statistics: invalid | nosize | outlier
  };
}

// The register repeats many whole-asset sales: the same deal twice, identical
// in every field except the settlement (one row carries the settlement code,
// the other leaves it empty) — 373,746 extra rows nationally on 2026-10-02,
// 14% of all 100% deals. For a 100% sale, rows equal on every field but the
// settlement are one deal: the first (preferring a row with a settlement code)
// is kept, the rest are marked dup and counted nowhere. Partial sales are left
// alone — two sales of a half each can be legitimately identical.
export function dupKey(d) {
  return [d.date, d.amt, d.decl, d.sqm, d.por, d.yb, d.rooms, d.nature, d.gush, d.chelka, d.sub].join('|');
}
export function markDuplicates(deals) {
  const seen = new Set();
  let n = 0;
  const order = [...deals].sort((a, b) => Number(b.scode != null) - Number(a.scode != null));
  for (const d of order) {
    d.dup = false;
    if (d.por !== 1) continue;
    const k = dupKey(d);
    if (seen.has(k)) { d.dup = true; n += 1; } else seen.add(k);
  }
  return n;
}

export function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

// Sample standard deviation (n − 1).
export function sd(xs) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

// Sets deal.drop for every deal and returns per-cell filter records
// ({ size, yr, n0, ref, refN, rounds: [{ mean, sd, lo, hi, dropped }], kept })
// — rounds describe the REFERENCE group; kept counts the cell — so the page can
// show exactly what the filter did. A cell is size group × year, inside one
// area: a price that is ordinary for the city can still be extreme for the
// street, which is why the filter is never global.
export function markOutliers(deals, method) {
  const cells = new Map();
  for (const d of deals) {
    if (!d.valid) d.drop = 'invalid';
    else if (d.size === 's0') d.drop = 'nosize';
    else {
      d.drop = null;
      // Asset type is part of the cell: a shop is not an outlier of flats.
      const k = `${d.type}|${d.size}|${d.yr}`;
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(d);
    }
  }
  const priced = [...cells.values()].flat();
  const report = [];
  for (const [k, cell] of cells) {
    const [type, size, yr] = k.split('|');
    const rec = { type, size, yr: Number(yr), n0: cell.length, rounds: [] };
    if (method === 'fixed') {
      let dropped = 0;
      for (const d of cell) {
        if (d.pp < FIXED_RANGE[0] || d.pp > FIXED_RANGE[1]) { d.drop = 'outlier'; dropped += 1; }
      }
      rec.rounds.push({ lo: FIXED_RANGE[0], hi: FIXED_RANGE[1], dropped });
    } else if (method === 'sigma') {
      const size0 = size;
      const yr0 = Number(yr);
      const pool = (step) => priced.filter((d) => d.type === type
        && (step.sizes === 'all' || d.size === size0) && Math.abs(d.yr - yr0) <= step.years);
      let step = null;
      let ref = null;
      for (const s of REFERENCE_STEPS) {
        ref = s.key === 'cell' ? cell : pool(s);
        step = s;
        if (ref.length >= SIGMA_REF_N) break;
      }
      rec.ref = step.label;
      rec.refN = ref.length;
      if (ref.length >= SIGMA_MIN_N) {
        // Iterate on the reference (dropping from it), then apply the final
        // bounds to the cell's own deals.
        // On ln(P): prices are close to log-normal, so a deal priced ×20 (a
        // tiny sold portion) sits ~10σ out and is caught in the first round
        // even when several such deals inflate σ together, and the natural
        // right tail of premium flats is clipped less than on a linear scale.
        let kept = ref.map((d) => Math.log(d.pp));
        // Coarse pre-screen that masking cannot fool: median ± 4 robust σ
        // (1.4826 × MAD). On clean data it removes almost nothing; on a cell
        // full of tiny-portion deals it clears the gross errors so the 2σ
        // rounds below see a σ that describes the real market.
        const med = median(kept);
        const rsd = 1.4826 * median(kept.map((x) => Math.abs(x - med)));
        let preLo = 0;
        let preHi = Infinity;
        if (rsd > 0) {
          const lnLo = med - PRESCREEN_K * rsd;
          const lnHi = med + PRESCREEN_K * rsd;
          preLo = Math.exp(lnLo);
          preHi = Math.exp(lnHi);
          const next = kept.filter((x) => x >= lnLo && x <= lnHi);
          rec.rounds.push({ robust: true, mean: med, sd: rsd, lo: preLo, hi: preHi, dropped: kept.length - next.length });
          kept = next;
        }
        let lo = preLo;
        let hi = preHi;
        for (let r = 0; r < SIGMA_ROUNDS && kept.length >= SIGMA_MIN_N; r++) {
          const m = mean(kept);
          const s = sd(kept);
          const lnLo = m - SIGMA_K * s;
          const lnHi = m + SIGMA_K * s;
          lo = Math.exp(lnLo);
          hi = Math.exp(lnHi);
          const next = kept.filter((x) => x >= lnLo && x <= lnHi);
          // mean/sd are of ln P; lo/hi are back in ₪ per m²
          rec.rounds.push({ mean: m, sd: s, lo, hi, dropped: kept.length - next.length });
          if (next.length === kept.length) break;
          kept = next;
        }
        let dropped = 0;
        for (const d of cell) {
          if (d.pp < Math.max(lo, preLo) || d.pp > Math.min(hi, preHi)) { d.drop = 'outlier'; dropped += 1; }
        }
        rec.dropped = dropped;
      }
    }
    rec.kept = cell.filter((d) => !d.drop).length;
    report.push(rec);
  }
  report.sort((a, b) => a.yr - b.yr || a.type.localeCompare(b.type) || a.size.localeCompare(b.size));
  return report;
}

// Deals that pass the size/age selection.
export function select(deals, { sizes = null, ages = null } = {}) {
  return deals.filter((d) => (!sizes || sizes.has(d.size)) && (!ages || ages.has(d.ageGroup)));
}

// One row per year: counts for the quality view, and mean / median / sd of the
// chosen measure over the deals that survived the filter.
//   total  — every deal in the selection
//   valid  — enough data (amount ≥ 10, area > 0, portion > 0) and a size
//   used   — valid and not an outlier: the n behind every statistic
export function yearly(deals, measure = 'pp') {
  const by = new Map();
  for (const d of deals) {
    if (!by.has(d.yr)) by.set(d.yr, []);
    by.get(d.yr).push(d);
  }
  return [...by.keys()].sort((a, b) => a - b).map((yr) => {
    const ds = by.get(yr);
    const used = ds.filter((d) => d.drop == null);
    const xs = used.map((d) => (measure === 'pp' ? d.pp : d.amt));
    return {
      yr,
      total: ds.length,
      valid: ds.filter((d) => d.drop !== 'invalid' && d.drop !== 'nosize').length,
      used: used.length,
      n: xs.length,
      mean: mean(xs),
      median: median(xs),
      sd: sd(xs),
    };
  });
}

// Deals per year per 1,000 households, over the given full years.
export function turnover(deals, households, yFrom, yTo) {
  if (!(households > 0) || yTo < yFrom) return null;
  const n = deals.filter((d) => d.yr >= yFrom && d.yr <= yTo).length;
  const years = yTo - yFrom + 1;
  return { perYear: n / years, per1000: (n / years / households) * 1000, years, deals: n };
}

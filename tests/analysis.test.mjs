import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sizeGroup, ageOf, ageGroup, enrich, markOutliers, yearly, select, mean, sd, median, turnover, markDuplicates,
} from '../public/js/analysis.js';

const types = new Map([['דירה בבית קומות', 'מגורים רווי']]);
// [yyyymmdd, amount, declared, area, portion, year_built, rooms, nature, gush, chelka, sub, scode]
const raw = (date, amt, sqm, por = 1, yb = 2000) => [date, amt, null, sqm, por, yb, 3, 'דירה בבית קומות', 1, 2, 3, 5000];

test('size groups follow the spreadsheet\'s effective bounds', () => {
  assert.equal(sizeGroup(0), 's0');
  assert.equal(sizeGroup(1), 's0');
  assert.equal(sizeGroup(null), 's0');
  assert.equal(sizeGroup(2), 's1');
  assert.equal(sizeGroup(54), 's1');
  assert.equal(sizeGroup(54.4), 's1'); // areas are rounded to whole m²
  assert.equal(sizeGroup(54.5), 's2');
  assert.equal(sizeGroup(1.5), 's1');
  assert.equal(sizeGroup(55), 's2');
  assert.equal(sizeGroup(80), 's2');
  assert.equal(sizeGroup(81), 's3');
  assert.equal(sizeGroup(104), 's3');
  assert.equal(sizeGroup(105), 's4');
  assert.equal(sizeGroup(140), 's4');
  assert.equal(sizeGroup(141), 's5');
  assert.equal(sizeGroup(5000), 's5');
});

test('building age: unknown years, off-plan sales, groups', () => {
  assert.equal(ageOf(0, 2020), null);
  assert.equal(ageOf(1, 2020), null);
  assert.equal(ageOf(2024, 2020), 0); // sold off-plan
  assert.equal(ageOf(2030, 2020), null); // too far ahead to be real
  assert.equal(ageOf(1990, 2020), 30);
  assert.equal(ageGroup(null), 'unk');
  assert.equal(ageGroup(0), 'a0');
  assert.equal(ageGroup(1), 'a0');
  assert.equal(ageGroup(2), 'a1');
  assert.equal(ageGroup(25), 'a2');
  assert.equal(ageGroup(40), 'a3');
  assert.equal(ageGroup(41), 'a4');
});

test('enrich: validity, normalized price, classification', () => {
  const d = enrich(raw(20210315, 1_000_000, 100, 0.5), types);
  assert.equal(d.yr, 2021);
  assert.equal(d.month, 3);
  assert.equal(d.pp, 20000); // 1,000,000 / (100 × 0.5)
  assert.equal(d.type, 'מגורים רווי');
  assert.equal(d.decl, 1_000_000);
  assert.equal(enrich(raw(20210315, 5, 100), types).valid, false); // amount < 10
  assert.equal(enrich(raw(20210315, 1e6, 0), types).valid, false);
  assert.equal(enrich(raw(20210315, 1e6, 100, 0), types).valid, false);
  assert.equal(enrich([20210315, 1, 1, 1, 1, 0, 0, 'חניה', 1, 1, 1, null], types).type, 'לא ממופה');
});

test('sample sd, mean, median', () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Math.abs(sd([2, 4, 4, 4, 5, 5, 7, 9]) - 2.138089935) < 1e-9);
  assert.equal(sd([1]), null);
});

test('sigma filter drops a far outlier per cell and reports it', () => {
  const ds = [];
  for (let i = 0; i < 20; i++) ds.push(enrich(raw(20200101, 2_000_000 + i * 10_000, 100), types));
  ds.push(enrich(raw(20200101, 20_000_000, 100), types)); // 200,000 ₪/m²
  ds.push(enrich(raw(20200101, 1_000_000, 1), types)); // no size
  ds.push(enrich(raw(20200101, 5, 100), types)); // invalid
  const report = markOutliers(ds, 'sigma');
  assert.equal(ds.filter((d) => d.drop === 'outlier').length, 1);
  assert.equal(ds.at(-3).drop, 'outlier');
  assert.equal(ds.at(-2).drop, 'nosize');
  assert.equal(ds.at(-1).drop, 'invalid');
  const cell = report.find((r) => r.size === 's3' && r.yr === 2020);
  assert.equal(cell.n0, 21);
  assert.equal(cell.kept, 20);
  assert.equal(cell.rounds[0].dropped, 1);
});

test('sigma filter leaves small cells whole', () => {
  const ds = [1e6, 1.1e6, 9e6].map((a) => enrich(raw(20200101, a, 100), types));
  markOutliers(ds, 'sigma');
  assert.ok(ds.every((d) => d.drop == null));
});

test('fixed range filter', () => {
  const ds = [50_000, 5_000_000, 10_000_000].map((a) => enrich(raw(20200101, a, 100), types));
  markOutliers(ds, 'fixed');
  assert.deepEqual(ds.map((d) => d.drop), ['outlier', null, 'outlier']); // 500 and 100,000 ₪/m²
});

test('yearly counts and statistics', () => {
  const ds = [
    enrich(raw(20200101, 1_000_000, 50), types), // 20,000
    enrich(raw(20200601, 3_000_000, 100), types), // 30,000
    enrich(raw(20200601, 5, 100), types), // invalid
    enrich(raw(20210101, 4_000_000, 100), types), // 40,000
  ];
  markOutliers(ds, 'none');
  const y = yearly(ds, 'pp');
  assert.deepEqual(y.map((r) => [r.yr, r.total, r.valid, r.used, r.n]), [[2020, 3, 2, 2, 2], [2021, 1, 1, 1, 1]]);
  assert.equal(y[0].mean, 25000);
  assert.equal(y[0].median, 25000);
  assert.equal(yearly(ds, 'amt')[0].mean, 2_000_000);
  assert.equal(select(ds, { sizes: new Set(['s1']) }).length, 1); // the 50 m² deal
});

test('turnover per 1,000 households', () => {
  const ds = [20200101, 20210101, 20210601, 20220101].map((d) => enrich(raw(d, 1e6, 80), types));
  const t = turnover(ds, 500, 2020, 2021);
  assert.equal(t.deals, 3);
  assert.equal(t.perYear, 1.5);
  assert.equal(t.per1000, 3);
  assert.equal(turnover(ds, 0, 2020, 2021), null);
});

test('a small cell is filtered against a widened reference group', () => {
  const ds = [];
  for (let i = 0; i < 25; i++) ds.push(enrich(raw(20190101, 5_000_000 + i * 20_000, 100), types)); // 2019, ~50,000/m²
  const small = [5_100_000, 5_200_000, 5_050_000, 900_000_000].map((a) => enrich(raw(20200101, a, 100), types));
  ds.push(...small);
  const report = markOutliers(ds, 'sigma');
  assert.equal(small[3].drop, 'outlier');
  assert.ok(small.slice(0, 3).every((d) => d.drop == null));
  const cell = report.find((r) => r.yr === 2020);
  assert.equal(cell.ref, 'אותו גודל, ±1 שנה');
  assert.equal(cell.refN, 29);
  assert.equal(cell.kept, 3);
});

test('several tiny-portion deals cannot mask each other', () => {
  const ds = [];
  for (let i = 0; i < 40; i++) ds.push(enrich(raw(20190101, 4_000_000 + i * 50_000, 80), types)); // ~50–75k/m²
  const tiny = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08].map((p) => enrich(raw(20190101, 3_000_000, 80, p), types)); // 0.6–1.9M/m²
  ds.push(...tiny);
  markOutliers(ds, 'sigma');
  assert.ok(tiny.every((d) => d.drop === 'outlier'));
  assert.ok(ds.slice(0, 40).filter((d) => d.drop).length <= 4); // the real market is barely touched
});

test('a 100% sale repeated with and without a settlement code is one deal', () => {
  const withCode = [20221031, 2750000, null, 140, 1, 1985, 5, "קוטג' חד משפחתי", 38571, 42, 0, 666];
  const noCode = [...withCode.slice(0, 11), null];
  const ds = [enrich(noCode, types), enrich(withCode, types)];
  assert.equal(markDuplicates(ds), 1);
  assert.equal(ds[0].dup, true); // the row without the settlement code goes
  assert.equal(ds[1].dup, false);
});

test('partial sales and deals differing in any field are not duplicates', () => {
  const half = [20221031, 1000000, null, 100, 0.5, 1985, 4, 'דירה בבית קומות', 1, 2, 3, 666];
  const ds = [enrich(half, types), enrich([...half.slice(0, 11), null], types)];
  assert.equal(markDuplicates(ds), 0);
  const a = [20221031, 1000000, null, 100, 1, 1985, 4, 'דירה בבית קומות', 1, 2, 3, 666];
  const b = [20221031, 1000000, null, 100, 1, 1985, 4, 'דירה בבית קומות', 1, 2, 4, 666]; // other sub-parcel
  assert.equal(markDuplicates([enrich(a, types), enrich(b, types)]), 0);
});

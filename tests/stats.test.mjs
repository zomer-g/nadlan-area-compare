// npm test  (node --test tests/*.test.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { eligible, pointChange, logTrend, indexTo, within } from '../js/stats.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

const series = [
  { yr: 2018, deals: 40, n_amt: 40, med_amt: 1000000, n_pp: 38, med_pp: 20000 },
  { yr: 2019, deals: 4, n_amt: 4, med_amt: 900000, n_pp: 4, med_pp: 99999 }, // thin
  { yr: 2020, deals: 50, n_amt: 50, med_amt: 1100000, n_pp: 45, med_pp: 22000 },
  { yr: 2021, deals: 30, n_amt: 30, med_amt: 1210000, n_pp: 0, med_pp: null }, // no normalized price
];

test('eligible drops thin years and years without a value, per metric', () => {
  assert.deepEqual(eligible(series, 'med_pp', 10).map((p) => p.yr), [2018, 2020]);
  assert.deepEqual(eligible(series, 'med_amt', 10).map((p) => p.yr), [2018, 2020, 2021]);
  const p = eligible(series, 'med_pp', 10)[0];
  assert.deepEqual(p, { yr: 2018, m: 20000, n: 38 });
});

test('pointChange: percent and CAGR', () => {
  const pts = [{ yr: 2015, m: 100, n: 10 }, { yr: 2019, m: 146.41, n: 10 }];
  const c = pointChange(pts, 2015, 2019);
  close(c.pct, 46.41, 1e-9);
  close(c.cagr, 10, 1e-9); // 1.1^4 = 1.4641
  assert.equal(c.years, 4);
  assert.equal(pointChange(pts, 2015, 2018), null);
  assert.equal(pointChange(pts, 2019, 2015), null);
});

test('logTrend recovers an exact constant growth rate with R² = 1', () => {
  const pts = [2010, 2011, 2012, 2013, 2014].map((yr, i) => ({ yr, m: 1000 * Math.pow(1.05, i), n: 10 + i * 7 }));
  const t = logTrend(pts);
  close(t.annualPct, 5, 1e-9);
  close(t.r2, 1, 1e-12);
  assert.equal(t.n, 5);
});

test('logTrend weights by deal count', () => {
  // Two heavy years rising 10%, one light outlier year far above the line.
  const pts = [
    { yr: 2010, m: 100, n: 1000 },
    { yr: 2011, m: 300, n: 1 },
    { yr: 2012, m: 121, n: 1000 },
  ];
  const t = logTrend(pts);
  assert.ok(Math.abs(t.annualPct - 10) < 0.5, `weighted trend ${t.annualPct} should stay near 10%`);
});

test('logTrend needs at least three points', () => {
  assert.equal(logTrend([{ yr: 2010, m: 1, n: 1 }, { yr: 2011, m: 2, n: 1 }]), null);
});

test('indexTo and within', () => {
  const pts = [{ yr: 2010, m: 50, n: 1 }, { yr: 2011, m: 75, n: 1 }, { yr: 2012, m: 100, n: 1 }];
  assert.deepEqual(indexTo(pts, 2010).map((p) => p.v), [100, 150, 200]);
  assert.equal(indexTo(pts, 2009), null);
  assert.deepEqual(within(pts, 2011, 2012).map((p) => p.yr), [2011, 2012]);
});

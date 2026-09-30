import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCsv } from '../js/external.js';

test('parseCsv: quotes, doubled quotes, commas and CRLF', () => {
  const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\r\nplain,\r\n');
  assert.deepEqual(rows, [{ a: 'x, y', b: 'say "hi"' }, { a: 'plain', b: '' }]);
});

test('the shipped external tables parse and have their key columns', () => {
  const read = (n) => parseCsv(fs.readFileSync(new URL(`../data/external/${n}.csv`, import.meta.url), 'utf8'));
  const natures = read('nature_asset_type');
  assert.equal(natures.length, 34);
  assert.equal(natures.find((r) => r.deal_nature === 'דירה בבית קומות').asset_type, 'מגורים רווי');
  const s = read('settlements_cbs');
  assert.equal(s.length, 1180);
  assert.equal(s.find((r) => r.code === '5000')?.district, 'מחוז תל אביב');
  assert.ok(read('gush_neighborhood').some((r) => r.ambiguous === 'True'));
});

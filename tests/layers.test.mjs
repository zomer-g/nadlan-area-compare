import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decode, decodeRing, quantileBreaks } from '../js/layers.js';

test('decodeRing reverses integer delta encoding', () => {
  // (34.78, 32.08) → (34.78001, 32.08) → (34.78, 32.08002) → back to start
  const ring = decodeRing([3478000, 3208000, 1, 0, -1, 2, 0, -2]);
  assert.deepEqual(ring, [[34.78, 32.08], [34.78001, 32.08], [34.78, 32.08002], [34.78, 32.08]]);
});

test('every shipped tile decodes to closed rings inside its box', () => {
  const m = JSON.parse(fs.readFileSync(new URL('../data/layers/manifest.json', import.meta.url)));
  for (const layer of Object.keys(m.layers)) {
    const tile = m.layers[layer].tiles[0];
    const fs0 = JSON.parse(fs.readFileSync(new URL(`../data/layers/${layer}/${tile}.json`, import.meta.url)));
    for (const f of fs0) {
      const g = decode(f.g);
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      for (const ring of polys.flat()) {
        assert.deepEqual(ring[0], ring.at(-1), `${layer}/${f.id} ring not closed`);
        for (const [x, y] of ring) {
          assert.ok(x >= f.b[0] - 1e-5 && x <= f.b[2] + 1e-5 && y >= f.b[1] - 1e-5 && y <= f.b[3] + 1e-5, `${layer}/${f.id} outside its box`);
        }
      }
    }
  }
});

test('quantile breaks', () => {
  assert.deepEqual(quantileBreaks([1, 2, 3, 4, 5, 6, 7], 7), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(quantileBreaks([NaN, 5, 5, 5], 3), [5]);
});

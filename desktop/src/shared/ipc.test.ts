import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMenuPoint } from './ipc.ts';

test('a menu point is two finite, non-negative numbers, rounded', () => {
  assert.deepEqual(parseMenuPoint({ x: 56.4, y: 72.6 }), { x: 56, y: 73 });
  assert.deepEqual(parseMenuPoint({ x: 0, y: 0 }), { x: 0, y: 0 });
  for (const raw of [undefined, null, 5, {}, { x: 1 }, { x: '1', y: 2 }, { x: Number.NaN, y: 1 }, { x: Infinity, y: 1 }, { x: -4, y: 1 }, { x: 1e7, y: 1 }]) {
    assert.equal(parseMenuPoint(raw), undefined, String(JSON.stringify(raw)));
  }
});

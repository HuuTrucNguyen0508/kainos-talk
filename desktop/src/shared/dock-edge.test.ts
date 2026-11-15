import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exitZone, parsePagePointer, pointerZone } from './dock-edge.ts';

test('the last 3px are the edge, the dock-high band above them, and away above that', () => {
  assert.equal(pointerZone(1439, 1440), 'edge');
  assert.equal(pointerZone(1437, 1440), 'edge');
  assert.equal(pointerZone(1436, 1440), 'band');
  assert.equal(pointerZone(1376, 1440), 'band');
  assert.equal(pointerZone(1375, 1440), 'away');
  assert.equal(pointerZone(10, 2488), 'away');
});

test('leaving near the bottom, with the bottom the nearest edge, goes below the window', () => {
  assert.equal(exitZone(700, 1440, 3440, 1440), 'below', 'reported at the edge');
  assert.equal(exitZone(700, 1405, 3440, 1440), 'below', 'a fast pointer last seen 35px up');
  assert.equal(exitZone(700, 1450, 3440, 1440), 'below', 'reported past the edge');
  assert.equal(exitZone(700, 1390, 3440, 1440), 'away', 'too far up to have gone down');
  assert.equal(exitZone(5, 1420, 1418, 1440), 'away', 'out through the left side near the corner');
  assert.equal(exitZone(1412, 1430, 1418, 1440), 'away', 'out through the right side near the corner');
  assert.equal(exitZone(700, 3, 1418, 2488), 'away', 'out through the top');
});

test('a page may only report the four zones', () => {
  assert.equal(parsePagePointer('below'), 'below');
  assert.equal(parsePagePointer('left'), undefined);
  assert.equal(parsePagePointer({}), undefined);
});

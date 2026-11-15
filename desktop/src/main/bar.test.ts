import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutBar, outerSide, parsePointerEdge, resolveSide } from './bar.ts';

// The two screens this was built for: a 3440×1440 screen with a portrait 1440×2560 one on its right.
const wide = { x: 0, y: 0, width: 3440, height: 1440 };
const portrait = { x: 3440, y: -560, width: 1440, height: 2560 };

test('the bar goes on the outer edge of each screen', () => {
  assert.equal(outerSide(wide, [wide, portrait]), 'left');
  assert.equal(outerSide(portrait, [wide, portrait]), 'right');
});

test('a lone screen, a middle screen and stacked screens keep the left edge', () => {
  assert.equal(outerSide(wide, [wide]), 'left');
  const left = { x: -1920, y: 0, width: 1920, height: 1080 };
  const right = { x: 3440, y: 0, width: 1920, height: 1080 };
  assert.equal(outerSide(wide, [left, wide, right]), 'left');
  const above = { x: 0, y: -1080, width: 1920, height: 1080 };
  assert.equal(outerSide(wide, [wide, above]), 'left');
});

test('a screen only to the left puts the bar on the right', () => {
  const left = { x: -1920, y: 200, width: 1920, height: 1080 };
  assert.equal(outerSide(wide, [left, wide]), 'right');
});

test('a fixed side wins over the screen', () => {
  assert.equal(resolveSide('auto', 'right'), 'right');
  assert.equal(resolveSide('left', 'right'), 'left');
  assert.equal(resolveSide('right', 'left'), 'right');
});

const base = { width: 1000, height: 700, side: 'left' as const, autoHide: false, revealed: false, activeReady: true, activeFullscreen: false };

test('a docked bar takes a strip from the page on its side', () => {
  assert.deepEqual(layoutBar(base), {
    chrome: { x: 0, y: 0, width: 68, height: 700 },
    service: { x: 68, y: 0, width: 932, height: 700 },
  });
  assert.deepEqual(layoutBar({ ...base, side: 'right' }), {
    chrome: { x: 932, y: 0, width: 68, height: 700 },
    service: { x: 0, y: 0, width: 932, height: 700 },
  });
});

test('an auto-hidden bar leaves the page whole and covers its edge only while revealed', () => {
  const full = { x: 0, y: 0, width: 1000, height: 700 };
  assert.deepEqual(layoutBar({ ...base, autoHide: true }), { chrome: undefined, service: full });
  assert.deepEqual(layoutBar({ ...base, autoHide: true, revealed: true, side: 'right' }), {
    chrome: { x: 932, y: 0, width: 68, height: 700 },
    service: full,
  });
});

test('a loading or failed service shows the sidebar page over the whole window', () => {
  const full = { x: 0, y: 0, width: 1000, height: 700 };
  assert.deepEqual(layoutBar({ ...base, activeReady: false }).chrome, full);
  assert.deepEqual(layoutBar({ ...base, activeReady: false, autoHide: true }).chrome, full);
});

test('a page in fullscreen covers the bar', () => {
  assert.deepEqual(layoutBar({ ...base, activeFullscreen: true }), { chrome: undefined, service: { x: 0, y: 0, width: 1000, height: 700 } });
});

test('pointer edges from a page are checked', () => {
  assert.equal(parsePointerEdge('left'), 'left');
  assert.equal(parsePointerEdge('inside'), 'inside');
  assert.equal(parsePointerEdge('top'), undefined);
  assert.equal(parsePointerEdge(3), undefined);
});

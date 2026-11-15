import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutBar } from './bar.ts';

const group = { width: 820, height: 40 };
const base = { width: 1000, height: 700, activeReady: true, activeFullscreen: false, pinned: false, onScreen: false, group };

test('auto-hide: the page fills the window and the hidden dock has no view', () => {
  assert.deepEqual(layoutBar(base), { chrome: undefined, service: { x: 0, y: 0, width: 1000, height: 700 }, frame: 'float' });
});

test('auto-hide: on screen, the dock view is the centred group with room for its shadow, over the full page', () => {
  assert.deepEqual(layoutBar({ ...base, onScreen: true }), {
    chrome: { x: 74, y: 636, width: 852, height: 64 },
    service: { x: 0, y: 0, width: 1000, height: 700 },
    frame: 'float',
  });
});

test('auto-hide: a group wider than the window is held to the window', () => {
  assert.deepEqual(layoutBar({ ...base, onScreen: true, group: { width: 1400, height: 40 } }).chrome, { x: 0, y: 636, width: 1000, height: 64 });
});

test('auto-hide: before the dock page measures its group, the view spans the window', () => {
  assert.deepEqual(layoutBar({ ...base, onScreen: true, group: undefined }).chrome, { x: 0, y: 636, width: 1000, height: 64 });
});

test('always shown: the dock keeps a 64px strip along the bottom and the page ends above it', () => {
  const pinned = { ...base, pinned: true };
  const expected = { chrome: { x: 0, y: 636, width: 1000, height: 64 }, service: { x: 0, y: 0, width: 1000, height: 636 }, frame: 'strip' };
  assert.deepEqual(layoutBar(pinned), expected);
  assert.deepEqual(layoutBar({ ...pinned, onScreen: true }), expected, 'the reveal state does not matter');
});

test('a loading or failed service shows the dock page over the whole window, in both modes', () => {
  const full = { x: 0, y: 0, width: 1000, height: 700 };
  assert.deepEqual(layoutBar({ ...base, activeReady: false }), { chrome: full, service: full, frame: 'cover' });
  assert.deepEqual(layoutBar({ ...base, activeReady: false, pinned: true }), { chrome: full, service: full, frame: 'cover' });
});

test('a page in fullscreen covers the dock, in both modes', () => {
  const full = { x: 0, y: 0, width: 1000, height: 700 };
  assert.deepEqual(layoutBar({ ...base, onScreen: true, activeFullscreen: true }), { chrome: undefined, service: full, frame: 'float' });
  assert.deepEqual(layoutBar({ ...base, pinned: true, activeFullscreen: true }), { chrome: undefined, service: full, frame: 'strip' });
});

for (const [width, height] of [[3440, 1440], [1720, 1440], [1418, 2488], [709, 2488], [640, 480]] as const) {
  test(`${width}×${height}: the floating dock is centred over the full page, and the strip leaves the page above it`, () => {
    const full = { x: 0, y: 0, width, height };
    const fits = { width: Math.min(820, width - 32), height: 40 };
    const shown = layoutBar({ ...base, width, height, group: fits, onScreen: true });
    assert.deepEqual(shown.service, full);
    const chrome = shown.chrome!;
    assert.equal(chrome.width, fits.width + 32);
    assert.equal(chrome.height, 64);
    assert.equal(chrome.y + chrome.height, height, 'down to the window bottom');
    assert.ok(Math.abs(chrome.x + chrome.width / 2 - width / 2) <= 0.5, 'centred');
    assert.ok(chrome.x >= 0 && chrome.x + chrome.width <= width, 'inside the window');
    assert.deepEqual(layoutBar({ ...base, width, height }), { chrome: undefined, service: full, frame: 'float' });
    assert.deepEqual(layoutBar({ ...base, width, height, pinned: true }), {
      chrome: { x: 0, y: height - 64, width, height: 64 },
      service: { x: 0, y: 0, width, height: height - 64 },
      frame: 'strip',
    });
    assert.deepEqual(layoutBar({ ...base, width, height, activeReady: false }), { chrome: full, service: full, frame: 'cover' });
    assert.deepEqual(layoutBar({ ...base, width, height, activeFullscreen: true, onScreen: true }).chrome, undefined);
  });
}

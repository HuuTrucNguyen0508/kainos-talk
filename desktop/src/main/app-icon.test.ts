import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markPng, renderMark } from './app-icon.ts';

const pixel = (pixels: Uint8Array, size: number, x: number, y: number) => [...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];

test('draws a teal tile with a white socket, clear corners', () => {
  const size = 64;
  const plain = renderMark(size, false);
  assert.deepEqual(pixel(plain, size, 32, 32), [255, 255, 255, 255], 'centre dot');
  assert.deepEqual(pixel(plain, size, 32, 12), [14, 107, 102, 255], 'tile');
  assert.equal(pixel(plain, size, 0, 0)[3], 0, 'rounded corner is transparent');
});

test('the unread lamp is amber in the top-right corner', () => {
  const size = 64;
  assert.deepEqual(pixel(renderMark(size, true), size, 51, 13), [240, 180, 46, 255]);
  assert.deepEqual(pixel(renderMark(size, false), size, 51, 13), [14, 107, 102, 255]);
});

test('encodes a PNG with the right header and size', () => {
  const png = markPng(32, true);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('latin1', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), 32);
  assert.equal(png.readUInt32BE(20), 32);
});

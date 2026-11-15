import { crc32, deflateSync } from 'node:zlib';

type Rgba = readonly [number, number, number, number];

const TEAL: Rgba = [14, 107, 102, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const AMBER: Rgba = [240, 180, 46, 255];
const CLEAR: Rgba = [0, 0, 0, 0];
const SAMPLES = 4;

function insideRoundedSquare(x: number, y: number, inset: number, radius: number): boolean {
  const lo = inset + radius;
  const hi = 1 - inset - radius;
  const dx = Math.max(lo - x, 0, x - hi);
  const dy = Math.max(lo - y, 0, y - hi);
  return x >= inset && x <= 1 - inset && y >= inset && y <= 1 - inset && dx * dx + dy * dy <= radius * radius;
}

/**
 * The Kainos Talk mark, a socket on a teal tile, at one sample point (0..1 on both axes).
 * With `lamp`, an amber unread light sits in the top-right corner, cut out from the tile.
 */
function markColor(x: number, y: number, lamp: boolean): Rgba {
  const fromCentre = Math.hypot(x - 0.5, y - 0.5);
  const fromLamp = Math.hypot(x - 0.8, y - 0.2);
  if (lamp && fromLamp <= 0.17) return AMBER;
  if (lamp && fromLamp <= 0.235) return CLEAR;
  if (!insideRoundedSquare(x, y, 0.06, 0.24)) return CLEAR;
  if (fromCentre <= 0.075) return WHITE;
  if (Math.abs(fromCentre - 0.24) <= 0.045) return WHITE;
  return TEAL;
}

/** Renders the mark as straight-alpha RGBA pixels, supersampled for smooth edges. */
export function renderMark(size: number, lamp: boolean): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const [cr, cg, cb, ca] = markColor((px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size, lamp);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const offset = (py * size + px) * 4;
      pixels[offset] = a ? Math.round(r / a) : 0;
      pixels[offset + 1] = a ? Math.round(g / a) : 0;
      pixels[offset + 2] = a ? Math.round(b / a) : 0;
      pixels[offset + 3] = Math.round(a / (SAMPLES * SAMPLES));
    }
  }
  return pixels;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Encodes RGBA pixels as a PNG file. */
export function encodePng(pixels: Uint8Array, width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0; // filter: none
    rows.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', new Uint8Array()),
  ]);
}

export function markPng(size: number, lamp: boolean): Buffer {
  return encodePng(renderMark(size, lamp), size, size);
}

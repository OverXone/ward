/**
 * The Ward logo (a W with a gem above it, gold on navy), drawn without any image library,
 * so the phone icons and the exe icon come from one definition. branding/ward.svg is the
 * same artwork as a vector file.
 *
 *   renderLogo(size, { rounded })  -> RGBA pixels
 *   png(size, rgba)                -> PNG file
 *   ico(sizes)                     -> Windows .ico (PNG entries, rounded corners)
 */

import zlib from "node:zlib";

const BG_TOP = [22, 32, 58];
const BG_BOTTOM = [11, 15, 23];
const GOLD = [214, 180, 106];
const GOLD_HI = [240, 216, 154];

// Geometry in a 512 x 512 box, matching branding/ward.svg.
const W_POINTS = [
  [128, 186],
  [194, 352],
  [256, 226],
  [318, 352],
  [384, 186],
];
const W_RADIUS = 22; // stroke-width 44 with round caps and joins
const GEM = { x: 256, y: 134, r: 30 };
const CORNER = 112;

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function inW(x, y) {
  for (let i = 0; i < W_POINTS.length - 1; i++) if (distToSegment(x, y, W_POINTS[i], W_POINTS[i + 1]) <= W_RADIUS) return true;
  return false;
}

const inGem = (x, y) => Math.abs(x - GEM.x) + Math.abs(y - GEM.y) <= GEM.r;

function inRoundedSquare(x, y) {
  const cx = Math.max(CORNER, Math.min(512 - CORNER, x));
  const cy = Math.max(CORNER, Math.min(512 - CORNER, y));
  return Math.hypot(x - cx, y - cy) <= CORNER && x >= 0 && y >= 0 && x <= 512 && y <= 512;
}

/** RGBA pixels. `rounded` cuts the corners (transparent) for the exe icon; phone icons stay square, the phone rounds them. */
export function renderLogo(size, { rounded = false } = {}) {
  const out = new Uint8Array(size * size * 4);
  const ss = size <= 64 ? 8 : 4; // more samples for the tiny sizes
  const scale = 512 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) * scale;
          const y = (py + (sy + 0.5) / ss) * scale;
          if (rounded && !inRoundedSquare(x, y)) continue;
          const t = y / 512;
          let c = BG_TOP.map((v, i) => v + (BG_BOTTOM[i] - v) * t);
          if (inGem(x, y)) c = GOLD_HI;
          else if (inW(x, y)) c = GOLD;
          r += c[0];
          g += c[1];
          b += c[2];
          a++;
        }
      const i = (py * size + px) * 4;
      if (a) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return out;
}

export function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]));
    rows.push(Buffer.from(rgba.subarray(y * size * 4, (y + 1) * size * 4)));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A .ico with one PNG image per size (supported since Windows Vista). */
export function ico(sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]) {
  const images = sizes.map((s) => png(s, renderLogo(s, { rounded: true })));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const e = i * 16;
    dir[e] = s >= 256 ? 0 : s;
    dir[e + 1] = s >= 256 ? 0 : s;
    dir.writeUInt16LE(1, e + 4); // colour planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(images[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, dir, ...images]);
}

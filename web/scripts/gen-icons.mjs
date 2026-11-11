// Generates the app icons (original artwork: gold ring + diamond on navy) as PNGs.
// Usage: npm run icons -w web
import { writeFileSync } from "node:fs";
import zlib from "node:zlib";

const BG = [11, 15, 23];
const GOLD = [214, 180, 106];

function png(size, rgba) {
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
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]));
    rows.push(Buffer.from(rgba.subarray(y * size * 3, (y + 1) * size * 3)));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Coverage of the gold shape at normalised coords (−1..1), shape kept inside the maskable safe zone. */
function inside(x, y) {
  const r = Math.hypot(x, y);
  const ring = r > 0.5 && r < 0.62;
  const diamond = Math.abs(x) + Math.abs(y) < 0.3;
  return ring || diamond;
}

function render(size) {
  const out = new Uint8Array(size * size * 3);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hit = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const x = ((px + (sx + 0.5) / ss) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / ss) / size) * 2 - 1;
          if (inside(x, y)) hit++;
        }
      const a = hit / (ss * ss);
      const i = (py * size + px) * 3;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(BG[c] * (1 - a) + GOLD[c] * a);
    }
  }
  return png(size, out);
}

const dir = new URL("../public/", import.meta.url);
for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
]) {
  writeFileSync(new URL(name, dir), render(size));
  console.log("wrote", name);
}

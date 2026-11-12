// Writes the app icons to public/: a Mynt-green ring and dot on dark green, full bleed so it
// also works as a maskable icon. No dependencies. Run: node scripts/make-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0x0f, 0x2a, 0x23];
const GREEN = [0x12, 0xb8, 0x86];

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Coverage of a pixel by a shape, 4x4 supersampled, for smooth edges.
function coverage(size, x, y, inside) {
  let hits = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (inside((x + (i + 0.5) / 4) / size - 0.5, (y + (j + 0.5) / 4) / size - 0.5)) hits++;
  return hits / 16;
}

function png(size) {
  const ring = (u, v) => {
    const r = Math.hypot(u, v);
    return r <= 0.3 && r >= 0.22;
  };
  const dot = (u, v) => Math.hypot(u - 0.13, v + 0.13) <= 0.075;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0, then RGB
    for (let x = 0; x < size; x++) {
      const a = Math.min(1, coverage(size, x, y, ring) + coverage(size, x, y, dot));
      for (let c = 0; c < 3; c++) row[1 + x * 3 + c] = Math.round(BG[c] * (1 - a) + GREEN[c] * a);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../public/", import.meta.url);
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180]]) {
  writeFileSync(new URL(name, out), png(size));
}
writeFileSync(
  new URL("icon.svg", out),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0f2a23"/><circle cx="50" cy="50" r="26" fill="none" stroke="#12b886" stroke-width="8"/><circle cx="63" cy="37" r="7.5" fill="#12b886"/></svg>\n`,
);
console.log("icons written to public/");

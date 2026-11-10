// Generates the PWA icons (blue square, white up arrow + down arrow) with no dependencies.
// Usage: node tools/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size) {
  const BG = [29, 78, 216], FG = [255, 255, 255];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  const s = size;
  // Shapes in unit coordinates (0..1). Safe zone keeps content inside the central 70% for maskable use.
  const inTri = (x, y, up) => {
    const cx = up ? 0.36 : 0.64;
    const top = up ? 0.28 : 0.42, bot = up ? 0.58 : 0.72;
    // Arrowhead (triangle) + shaft (rectangle)
    const headTop = up ? top : bot - 0.16, headBot = up ? top + 0.16 : bot;
    if (y >= headTop && y <= headBot) {
      const t = up ? (y - headTop) / 0.16 : (headBot - y) / 0.16;
      return Math.abs(x - cx) <= 0.11 * t;
    }
    const shaftTop = up ? headBot : top, shaftBot = up ? bot : headTop;
    return y >= shaftTop && y <= shaftBot && Math.abs(x - cx) <= 0.035;
  };
  for (let y = 0; y < s; y++) {
    raw[y * (s * 3 + 1)] = 0;
    for (let x = 0; x < s; x++) {
      const ux = (x + 0.5) / s, uy = (y + 0.5) / s;
      const px = inTri(ux, uy, true) || inTri(ux, uy, false) ? FG : BG;
      raw.set(px, y * (s * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0); ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("app/icons", { recursive: true });
writeFileSync("app/icons/icon-192.png", png(192));
writeFileSync("app/icons/icon-512.png", png(512));
writeFileSync("app/icons/apple-touch-icon.png", png(180));
console.log("Icons written to app/icons");

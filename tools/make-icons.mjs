// tools/make-icons.mjs
// 零依赖图标栅格化脚本：从 app/icon.svg 的视觉语言出发，直接生成 PNG。
// 只使用 Node 内置模块（node:fs / node:zlib / node:path / node:url），
// 自己实现 CRC32 + zlib.deflateSync 写 PNG（8 位 RGB，color type 2，天然不透明）。
// 抗锯齿：每个像素 3x3 超采样后取平均。
// 幂等：不读取时间戳、不写入元数据，重复运行输出字节完全一致。
//
// 用法：node tools/make-icons.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// 几何全部定义在 512x512 的设计空间里（与 app/icon.svg 的 viewBox 一致），
// 输出时按比例缩放到目标尺寸并在设计空间里做超采样。
const BASE = 512;

const OUT = [
  { file: 'app/icon-180.png', size: 180 },
  { file: 'app/icon-192.png', size: 192 },
  { file: 'app/icon-512.png', size: 512 },
];

// ── 调色板 ────────────────────────────────────────────────────────────────
const GRAD_FROM = [0x4a, 0x86, 0xff]; // #4a86ff
const GRAD_TO = [0x2f, 0x4f, 0xd8]; // #2f4fd8
const WHITE = [0xff, 0xff, 0xff];
// 圆角外部的填充色：与 manifest 的 background_color (#f2f3f5) 一致。
// PNG 使用 color type 2（无 alpha 通道），因此这里必须是实色。
const CORNER_BG = [0xf2, 0xf3, 0xf5];

// 圆角半径 ≈ 边长 22%（与 icon.svg 的 rx=112 / 512 一致）。
const CORNER_RADIUS = 0.21875 * BASE; // 112

// ── 白色笔画（用 3 个几何体近似 icon.svg 中间的白色图形）─────────────
// 1) 左侧「C」形弧：圆环减去右侧开口
const ARC_CX = 198;
const ARC_CY = 256;
const ARC_R_OUT = 100;
const ARC_R_IN = 56;
const ARC_GAP_HALF = 74; // 右侧开口的半高（设计空间像素）

// 2) 右侧竖直白条  3) 右侧短横条（两者组成右上角的「文档页」意象）
const BAR_X0 = 318;
const BAR_X1 = 362;
const BAR_Y0 = 124;
const BAR_Y1 = 388;
const HORIZ_X1 = 414;
const HORIZ_Y1 = BAR_Y0 + (BAR_X1 - BAR_X0); // 横条粗细与竖条一致 => 168

function inRoundedSquare(x, y) {
  if (x < 0 || y < 0 || x > BASE || y > BASE) return false;
  const r = CORNER_RADIUS;
  const cx = x < r ? r : x > BASE - r ? BASE - r : x;
  const cy = y < r ? r : y > BASE - r ? BASE - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inWhiteGlyph(x, y) {
  // 「C」形弧
  const dx = x - ARC_CX;
  const dy = y - ARC_CY;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= ARC_R_OUT && d >= ARC_R_IN) {
    const inGap = dx > 0 && Math.abs(dy) < ARC_GAP_HALF;
    if (!inGap) return true;
  }
  // 竖直白条
  if (x >= BAR_X0 && x <= BAR_X1 && y >= BAR_Y0 && y <= BAR_Y1) return true;
  // 短横条
  if (x >= BAR_X0 && x <= HORIZ_X1 && y >= BAR_Y0 && y <= HORIZ_Y1) return true;
  return false;
}

function shade(x, y) {
  if (!inRoundedSquare(x, y)) return CORNER_BG;
  if (inWhiteGlyph(x, y)) return WHITE;
  // 对角线性渐变：左上 #4a86ff -> 右下 #2f4fd8
  const t = (x + y) / (2 * BASE);
  return [
    GRAD_FROM[0] + (GRAD_TO[0] - GRAD_FROM[0]) * t,
    GRAD_FROM[1] + (GRAD_TO[1] - GRAD_FROM[1]) * t,
    GRAD_FROM[2] + (GRAD_TO[2] - GRAD_FROM[2]) * t,
  ];
}

// ── 栅格化 ────────────────────────────────────────────────────────────────
const SS = 3; // 3x3 超采样

function rasterize(size) {
  const scale = BASE / size;
  const rgb = Buffer.alloc(size * size * 3);
  const samples = SS * SS;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          const c = shade(x, y);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const o = (py * size + px) * 3;
      rgb[o] = Math.round(r / samples);
      rgb[o + 1] = Math.round(g / samples);
      rgb[o + 2] = Math.round(b / samples);
    }
  }
  return rgb;
}

// ── 最小 PNG 编码器 ──────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB (no alpha)
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 主流程 ────────────────────────────────────────────────────────────────
let total = 0;
for (const { file, size } of OUT) {
  const png = encodePng(size, rasterize(size));
  const abs = resolve(ROOT, file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, png);
  total += png.length;
  console.log(`${file}  ${size}x${size}  ${png.length} bytes`);
}
console.log(`done: ${OUT.length} files, ${total} bytes total`);

// SPDX-License-Identifier: MIT

/**
 * 生成测试样本。
 *
 *   tests/fixtures/sample.caj        2 页、1 个书签的合成 CAJ 容器
 *   tests/fixtures/sample.pdf        1 页、结构良好的 PDF
 *   tests/fixtures/sample-long.pdf   60 页 PDF，每页都有文字与彩色块（滚动手势用）
 *   tests/fixtures/sample-long.caj   24 页的合成 CAJ，用来验证「多页 CAJ」的真实路径
 *
 * CAJ 容器的头部布局严格对齐上游的 syntheticCaj()：签名、0x10 页数、
 * 0x14 页表指针、0x110 书签条数、0x114 起每条 308 字节的书签记录。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

const text = new TextEncoder();

/** 一个 `<< /Length N >> stream ... endstream` 对象，长度精确到字节。 */
function streamObject(number, content) {
  const bytes = text.encode(content);
  return {
    bytes,
    source:
      `${number} 0 obj\n<< /Length ${bytes.length} >>\nstream\n` +
      content +
      `\nendstream\nendobj\n`,
  };
}

/* ─────────────────────────  通用 PDF 组装  ───────────────────────── */

/**
 * 把一组编号对象拼成带 xref 的 PDF。
 * objects: Map<number, {dict} | {stream}>
 */
function buildPdf(objects) {
  const maxObj = Math.max(...objects.keys());
  const parts = [text.encode("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
  let offset = parts[0].length;
  const offsets = new Array(maxObj + 1).fill(0);

  for (let n = 1; n <= maxObj; n++) {
    const object = objects.get(n);
    if (!object) continue;
    offsets[n] = offset;
    const body = object.stream !== undefined
      ? `<< /Length ${text.encode(object.stream).length} >>\nstream\n${object.stream}\nendstream`
      : object.dict;
    const part = text.encode(`${n} 0 obj\n${body}\nendobj\n`);
    parts.push(part);
    offset += part.length;
  }

  const startxref = offset;
  let xref = `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxObj; n++) {
    xref += offsets[n]
      ? `${String(offsets[n]).padStart(10, "0")} 00000 n \n`
      : `0000000000 65535 f \n`;
  }
  parts.push(text.encode(
    `${xref}trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`,
  ));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** 一页 A4 正文：随页号变化的配色 + 一个标题块 + 一栏正文行 + 角标定位块。 */
function longPageContent(index, pages, width, height) {
  const hue = pages > 1 ? index / (pages - 1) : 0;
  const r = (0.08 + 0.74 * hue).toFixed(3);
  const g = (0.32 + 0.25 * (1 - hue)).toFixed(3);
  const b = (0.88 - 0.55 * hue).toFixed(3);

  const lines = [
    `0.96 0.97 0.99 rg 0 0 ${width} ${height} re f`,
    // 随页变色的标题块：用来判断「这一页到底画没画出来」
    `${r} ${g} ${b} rg 40 ${height - 150} ${width - 80} 92 re f`,
    `BT /F1 26 Tf 1 1 1 rg 60 ${height - 108} Td (Page ${index + 1} of ${pages}) Tj ET`,
    `BT /F1 11 Tf 0.12 0.12 0.16 rg 40 ${height - 200} Td 16 TL`,
  ];
  for (let line = 0; line < 32; line++) {
    lines.push(`(Line ${line + 1} of page ${index + 1}: the quick brown fox jumps over the lazy dog.) Tj T*`);
  }
  lines.push("ET");
  // 右下角定位块：颜色也随页变化
  lines.push(`${b} ${r} 0.25 rg ${width - 90} 44 50 50 re f`);
  return `${lines.join("\n")}\n`;
}

/** 多页 A4 PDF（默认 60 页），每页都有可辨认的内容。 */
export function longPdf(pages = 60) {
  const width = 595;
  const height = 842;
  const fontObj = 3 + 2 * pages;
  const objects = new Map();
  const kids = [];

  objects.set(1, { dict: "<< /Type /Catalog /Pages 2 0 R >>" });
  for (let i = 0; i < pages; i++) {
    const pageObj = 3 + 2 * i;
    const contentObj = pageObj + 1;
    kids.push(`${pageObj} 0 R`);
    objects.set(pageObj, {
      dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] `
        + `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`,
    });
    objects.set(contentObj, { stream: longPageContent(i, pages, width, height) });
  }
  objects.set(2, { dict: `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>` });
  objects.set(fontObj, { dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" });
  return buildPdf(objects);
}

/* ─────────────────────────  CAJ 容器  ───────────────────────── */

export function syntheticCaj() {
  const page1 = [
    "0.95 0.95 0.97 rg 0 0 200 100 re f",
    "0.10 0.35 0.75 rg 16 16 168 68 re f",
    "BT /F1 18 Tf 1 1 1 rg 28 44 Td (CAJ page 1) Tj ET",
  ].join("\n");
  const page2 = [
    "0.97 0.95 0.95 rg 0 0 300 150 re f",
    "0.75 0.30 0.10 rg 20 20 260 110 re f",
    "BT /F1 22 Tf 1 1 1 rg 40 70 Td (CAJ page 2) Tj ET",
  ].join("\n");
  const contents1 = streamObject(6, page1);
  const contents2 = streamObject(8, page2);
  const font = "7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n";

  const body = text.encode(
    "3 0 obj\n<< /Type /Page /Parent 5 0 R /MediaBox [0 0 200 100] "
      + "/Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>\nendobj\n"
      + "4 0 obj\n<< /Type /Page /Parent 5 0 R /MediaBox [0 0 300 150] "
      + "/Resources << /Font << /F1 7 0 R >> >> /Contents 8 0 R >>\nendobj\n"
      + "5 0 obj\n<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>\nendobj\n"
      + contents1.source
      + font
      + contents2.source,
  );
  const table = 0x400;
  const bodyStart = table + 2 * 12;
  const bytes = new Uint8Array(bodyStart + body.length);
  const view = new DataView(bytes.buffer);
  bytes.set(text.encode("CAJ\0"));
  view.setUint32(0x10, 2, true); // 页数
  view.setUint32(0x14, table, true); // 页表指针
  view.setUint32(0x110, 1, true); // 书签条数
  bytes.set(text.encode("Intro"), 0x114); // 书签标题
  bytes[0x114 + 280] = "1".charCodeAt(0); // 书签页码（一基，ASCII）
  view.setUint32(0x114 + 304, 1, true); // 书签层级
  view.setUint32(table, bodyStart, true); // 行 0 偏移
  view.setUint32(table + 4, body.length, true); // 行 0 长度
  view.setUint32(table + 8, 3, true); // 行 0 页 ID
  view.setUint32(table + 12, bodyStart + body.length, true); // 行 1 偏移（零长度行）
  view.setUint32(table + 20, 4, true); // 行 1 页 ID
  bytes.set(body, bodyStart);
  return bytes;
}

/**
 * 多页 CAJ：页面对象 3..3+P-1，页表有 P 行（行 0 覆盖整个 body，其余为零长度行），
 * 页 ID 依次为 3..3+P-1 —— 与上游 2 页夹具完全相同的结构，只是放大到 P 页。
 */
export function longCaj(pages = 24) {
  const width = 420;
  const height = 594;
  const firstPageObj = 3;
  const pagesObj = firstPageObj + pages;
  const fontObj = pagesObj + 1;
  const firstContent = fontObj + 1;

  const kids = [];
  const chunks = [];
  for (let i = 0; i < pages; i++) {
    const pageObj = firstPageObj + i;
    const contentObj = firstContent + i;
    kids.push(`${pageObj} 0 R`);
    chunks.push(
      `${pageObj} 0 obj\n<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${width} ${height}] `
        + `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`,
    );
  }
  chunks.push(`${pagesObj} 0 obj\n<< /Type /Pages /Count ${pages} /Kids [${kids.join(" ")}] >>\nendobj\n`);
  chunks.push(`${fontObj} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  for (let i = 0; i < pages; i++) {
    const hue = pages > 1 ? i / (pages - 1) : 0;
    const r = (0.10 + 0.70 * hue).toFixed(3);
    const b = (0.85 - 0.55 * hue).toFixed(3);
    const content = [
      `0.96 0.97 0.99 rg 0 0 ${width} ${height} re f`,
      `${r} 0.34 ${b} rg 30 ${height - 120} ${width - 60} 74 re f`,
      `BT /F1 20 Tf 1 1 1 rg 46 ${height - 86} Td (CAJ long page ${i + 1}) Tj ET`,
      `BT /F1 10 Tf 0.15 0.15 0.2 rg 30 ${height - 150} Td 14 TL`,
      ...Array.from({ length: 14 }, (_, l) =>
        `(Body line ${l + 1} of page ${i + 1} for the CAJ scrolling fixture.) Tj T*`),
      "ET",
      `0.2 ${b} 0.3 rg ${width - 70} 36 40 40 re f`,
    ].join("\n");
    chunks.push(streamObject(firstContent + i, content).source);
  }

  const body = text.encode(chunks.join(""));
  const table = 0x400;
  const bodyStart = table + pages * 12;
  const bytes = new Uint8Array(bodyStart + body.length);
  const view = new DataView(bytes.buffer);

  bytes.set(text.encode("CAJ\0"));
  view.setUint32(0x10, pages, true);
  view.setUint32(0x14, table, true);
  view.setUint32(0x110, 0, true); // 这套样本不需要书签

  for (let i = 0; i < pages; i++) {
    const row = table + i * 12;
    if (i === 0) {
      view.setUint32(row, bodyStart, true);
      view.setUint32(row + 4, body.length, true);
    } else {
      view.setUint32(row, bodyStart + body.length, true); // 零长度行
      view.setUint32(row + 4, 0, true);
    }
    view.setUint32(row + 8, firstPageObj + i, true); // 页 ID
  }
  bytes.set(body, bodyStart);
  return bytes;
}

/** 单页 400x200 的 PDF，含矩形与可见文字，完全手工构造。 */
export function samplePdf() {
  const content = [
    "0.90 0.90 0.95 rg 0 0 400 200 re f",
    "0.15 0.45 0.80 rg 40 40 320 120 re f",
    "BT /F1 28 Tf 1 1 1 rg 70 95 Td (Hello PDF) Tj ET",
    "",
  ].join("\n");
  const contentBytes = text.encode(content);

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] "
      + "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    null, // 对象 4：内容流，下面单独拼
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  const parts = [text.encode("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
  let offset = parts[0].length;
  const offsets = [];
  for (const [index, dictionary] of objects.entries()) {
    offsets.push(offset);
    const part =
      index === 3
        ? text.encode(
            `4 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n${content}\nendstream\nendobj\n`,
          )
        : text.encode(`${index + 1} 0 obj\n${dictionary}\nendobj\n`);
    parts.push(part);
    offset += part.length;
  }
  const xref = ["xref\n0 6\n0000000000 65535 f \n"]
    .concat(offsets.map((value) => `${String(value).padStart(10, "0")} 00000 n \n`))
    .join("");
  parts.push(text.encode(`${xref}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/* ─────────────────────────  入口  ───────────────────────── */

export async function writeFixtures() {
  await mkdir(fixtures, { recursive: true });
  const written = {
    caj: syntheticCaj(),
    pdf: samplePdf(),
    longPdf: longPdf(60),
    longCaj: longCaj(24),
  };
  await writeFile(join(fixtures, "sample.caj"), written.caj);
  await writeFile(join(fixtures, "sample.pdf"), written.pdf);
  await writeFile(join(fixtures, "sample-long.pdf"), written.longPdf);
  await writeFile(join(fixtures, "sample-long.caj"), written.longCaj);
  return written;
}

const written = await writeFixtures();
for (const [file, key] of [
  ["sample.caj", "caj"],
  ["sample.pdf", "pdf"],
  ["sample-long.pdf", "longPdf"],
  ["sample-long.caj", "longCaj"],
]) {
  console.log(`wrote ${join(fixtures, file)} (${written[key].length} bytes)`);
}

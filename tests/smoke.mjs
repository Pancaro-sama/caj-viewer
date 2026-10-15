// SPDX-License-Identifier: MIT

/**
 * End-to-end smoke test against the packaged `caj2pdf-rust` WASM module.
 *
 * Run `node tests/make-fixtures.mjs` first, then `node tests/smoke.mjs`.
 * Exits 0 and prints PASS only when every observation matches; on any
 * mismatch it prints the observed and expected values and exits 1.
 */
import { execFile } from "node:child_process";
import { open, mkdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { finished } from "node:stream/promises";
// 指向已 vendor 的副本：跑测试不需要 node_modules，本工程自带全部运行时依赖
import { convert, inspect, loadModule, nodeWritableSink } from "../vendor/caj2pdf-rust/node.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");
const out = join(here, "out");

const run = promisify(execFile);
const checks = [];
let failed = false;

/** Record one observation and compare it with the expected value. */
function check(label, actual, expected) {
  const ok = actual === expected;
  checks.push({ label, actual, expected, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
  if (!ok) failed = true;
  return ok;
}

/** Convert `source` into `destination` with the package's Node sink adapter. */
async function convertFile(wasm, source, destination) {
  const stream = (await open(destination, "w")).createWriteStream();
  try {
    const report = await convert(wasm, source, nodeWritableSink(stream));
    stream.end();
    await finished(stream);
    return report;
  } finally {
    stream.destroy();
    await finished(stream).catch(() => {});
  }
}

/** JSON with BigInt fields rendered as strings, for readable diagnostics. */
function stringify(value) {
  return JSON.stringify(value, (key, item) => (typeof item === "bigint" ? `${item}n` : item));
}

function describeBytes(bytes) {
  return {
    size: bytes.length,
    header: Buffer.from(bytes.subarray(0, 5)).toString("latin1"),
  };
}

async function pdfFileInfo(path) {
  const bytes = await readFile(path);
  return { path, ...describeBytes(bytes) };
}

async function qpdfCheck(path) {
  try {
    await run("qpdf", ["--version"]);
  } catch {
    console.log("skip qpdf: not installed");
    return;
  }
  try {
    const { stdout, stderr } = await run("qpdf", ["--check", path]);
    const output = `${stdout}${stderr}`.trim();
    console.log(`qpdf --check ${path}: exit 0${output ? `\n${output}` : ""}`);
  } catch (error) {
    console.log(`FAIL qpdf --check ${path}: ${error.message}`);
    failed = true;
  }
}

await mkdir(out, { recursive: true });
const cajInput = join(fixtures, "sample.caj");
const pdfInput = join(fixtures, "sample.pdf");
const cajOutput = join(out, "sample.caj.pdf");
const pdfOutput = join(out, "sample.pdf.pdf");

for (const input of [cajInput, pdfInput]) {
  try {
    await stat(input);
  } catch {
    console.log(`FAIL missing fixture ${input}; run \`node tests/make-fixtures.mjs\` first`);
    process.exit(1);
  }
}

const wasm = await loadModule();
console.log(`wasm module compiled: ${wasm instanceof WebAssembly.Module}`);

// 1. CAJ conversion.
try {
  const report = await convertFile(wasm, cajInput, cajOutput);
  console.log(`convert(sample.caj) report: ${stringify(report)}`);
  check("convert(sample.caj).format", report.format, "caj");
  check("convert(sample.caj).pagesConverted", report.pagesConverted, 2);
  check("convert(sample.caj).bookmarksWritten", report.bookmarksWritten, 1);
} catch (error) {
  console.log(`FAIL convert(sample.caj) threw ${error?.name}: ${error?.message}`);
  if (error?.code) console.log(`     code: ${error.code}`);
  if (error?.stack) console.log(error.stack);
  failed = true;
}

// 2. CAJ inspection.
try {
  const info = await inspect(wasm, cajInput);
  console.log(`inspect(sample.caj): ${stringify(info)}`);
  check("inspect(sample.caj).format", info.format, "caj");
  check("inspect(sample.caj).pageCount", info.pageCount, 2);
  check("inspect(sample.caj).bookmarkCount", info.bookmarkCount, 1);
} catch (error) {
  console.log(`FAIL inspect(sample.caj) threw ${error?.name}: ${error?.message}`);
  if (error?.stack) console.log(error.stack);
  failed = true;
}

// 3. PDF conversion.
try {
  const report = await convertFile(wasm, pdfInput, pdfOutput);
  console.log(`convert(sample.pdf) report: ${stringify(report)}`);
  check("convert(sample.pdf).format", report.format, "pdf");
  check("convert(sample.pdf).pagesConverted", report.pagesConverted, 1);
} catch (error) {
  console.log(`FAIL convert(sample.pdf) threw ${error?.name}: ${error?.message}`);
  if (error?.code) console.log(`     code: ${error.code}`);
  if (error?.stack) console.log(error.stack);
  failed = true;
}

// 4. Output framing.
const outputs = [];
for (const [label, path] of [["caj output", cajOutput], ["pdf output", pdfOutput]]) {
  try {
    const info = await pdfFileInfo(path);
    outputs.push({ label, ...info });
    console.log(`${label}: ${info.path} ${info.size} bytes, header ${JSON.stringify(info.header)}`);
    check(`${label} non-empty`, info.size > 0, true);
    check(`${label} starts with %PDF-`, info.header === "%PDF-", true);
  } catch (error) {
    console.log(`FAIL ${label} unreadable: ${error.message}`);
    failed = true;
  }
}

// 5. Optional independent validation.
for (const info of outputs) {
  await qpdfCheck(info.path);
}

console.log("");
console.log(`observed: caj fixture ${(await stat(cajInput)).size} bytes, pdf fixture ${(await stat(pdfInput)).size} bytes`);
console.log(`checks: ${checks.length}, passed: ${checks.filter((entry) => entry.ok).length}, failed: ${checks.filter((entry) => !entry.ok).length}`);
for (const entry of checks.filter((item) => !item.ok)) {
  console.log(`  mismatch ${entry.label}: actual ${JSON.stringify(entry.actual)}, expected ${JSON.stringify(entry.expected)}`);
}
console.log(failed ? "FAIL" : "PASS");
process.exit(failed ? 1 : 0);

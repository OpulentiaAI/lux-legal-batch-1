import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const [root, work] = process.argv.slice(2);
const require = createRequire(join(root, 'package.json'));
const { marker } = JSON.parse(await readFile(join(work, 'fixtures.json')));
const { toMarkdown } = require('@firecrawl/anydoc');
const { LiteParse } = require('@llamaindex/liteparse');
const sharp = require('sharp');
const { PDFDocument } = require('pdf-lib');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const PptxGenJS = require('pptxgenjs');
const { parse } = require('csv-parse/sync');
const proof = {};
const exec = promisify(execFile);
const cliEnv = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: work, NODE_OPTIONS: '--invalid-test-only-option' };
for (const extension of ['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'epub', 'rtf', 'csv']) {
  assert.ok((await toMarkdown(join(work, `fixture.${extension}`))).includes(marker), `anydoc ${extension} conversion lost fixture text`);
  proof[`anydoc-${extension}-markdown`] = true;
}
await assert.rejects(toMarkdown(join(work, 'scan.pdf')), error => error.code === 'needsOcr');
proof['anydoc-scanned-pdf-needs-local-ocr'] = true;
const parser = new LiteParse({ tessdataPath: '/usr/share/tesseract-ocr/5/tessdata', ocrLanguage: 'eng',
  ocrEnabled: false, maxPages: 4, quiet: true, ocrFailureFatal: true });
for (const extension of ['pdf', 'docx', 'xlsx', 'pptx']) {
  const parsed = await parser.parse(join(work, `fixture.${extension}`));
  assert.ok(parsed.text.includes(marker), `LiteParse ${extension} parsing lost fixture text`);
  assert.ok(parsed.pages[0].textItems.length > 0);
  assert.equal(parsed.pageErrors.length, 0);
  proof[`liteparse-${extension}-spatial-text`] = true;
}
const screenshots = await parser.screenshot(join(work, 'fixture.pdf'), [1]);
assert.equal(screenshots.length, 1);
assert.equal((await sharp(screenshots[0].imageBuffer).metadata()).format, 'png');
proof['liteparse-native-pdf-screenshot'] = true;
const ocr = new LiteParse({ tessdataPath: '/usr/share/tesseract-ocr/5/tessdata', ocrLanguage: 'eng',
  ocrEnabled: true, maxPages: 1, quiet: true, numWorkers: 1, ocrFailureFatal: true });
const scanned = await ocr.parse(join(work, 'scan.pdf'));
assert.ok(scanned.text.includes(marker), 'LiteParse offline OCR lost fixture text');
assert.equal(scanned.pageErrors.length, 0);
proof['liteparse-offline-english-ocr'] = true;
const compressed = await sharp(join(work, 'scan.png'), { limitInputPixels: 40_000_000 }).rotate()
  .resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
const info = await sharp(compressed).metadata();
assert.equal(info.width, 1000);
assert.equal(info.format, 'jpeg');
assert.ok(compressed.length < 5 * 1024 * 1024);
await writeFile(join(work, 'sharp.jpg'), compressed);
proof['sharp-native-resize-compress'] = true;
const pdf = await PDFDocument.load(await readFile(join(work, 'fixture.pdf')));
assert.equal(pdf.getPageCount(), 1);
pdf.addPage();
assert.equal((await PDFDocument.load(await pdf.save())).getPageCount(), 2);
proof['pdf-lib-page-edit'] = true;
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(join(work, 'fixture.xlsx'));
assert.equal(workbook.worksheets[0].getCell('A1').value, marker);
workbook.worksheets[0].getCell('A2').note = 'Local comment exercises ExcelJS uuid';
await workbook.xlsx.writeFile(join(work, 'exceljs.xlsx'));
const reloaded = new ExcelJS.Workbook();
await reloaded.xlsx.readFile(join(work, 'exceljs.xlsx'));
assert.equal(reloaded.worksheets[0].getCell('A1').value, marker);
proof['exceljs-xlsx-read'] = true;
assert.ok((await mammoth.extractRawText({ path: join(work, 'fixture.docx') })).value.includes(marker));
proof['mammoth-docx-read'] = true;
const presentation = new PptxGenJS();
presentation.addSlide().addText(marker, { x: 1, y: 1, w: 8, h: 2 });
presentation.addSlide().addImage({ path: join(work, 'sharp.jpg'), x: 1, y: 1, w: 5, h: 2 });
await presentation.writeFile({ fileName: join(work, 'pptxgenjs.pptx') });
assert.ok((await toMarkdown(join(work, 'pptxgenjs.pptx'))).includes(marker));
proof['pptxgenjs-pptx-write'] = true;
assert.equal(parse(await readFile(join(work, 'fixture.csv')), { columns: true })[0].label, marker);
proof['csv-parse-table-read'] = true;
const anydocCli = await exec('/usr/local/bin/anydoc', [join(work, 'fixture.docx')], { env: cliEnv, timeout: 60_000 });
assert.ok(anydocCli.stdout.includes(marker));
proof['prepared-anydoc-path-cli'] = true;
const liteparseCli = await exec('/usr/local/bin/lit', ['parse', join(work, 'scan.pdf'), '--format', 'json', '--quiet'], { env: cliEnv, timeout: 60_000 });
assert.ok(JSON.parse(liteparseCli.stdout).pages.some(page => page.text.includes(marker)));
proof['prepared-liteparse-offline-path-cli'] = true;
await assert.rejects(exec('/usr/local/bin/lit', ['batch-parse', work, join(work, 'batch-output')], { env: cliEnv }),
  error => error.code === 2 && error.stderr.includes('batch-parse requires --no-ocr'));
proof['prepared-liteparse-batch-ocr-rejected'] = true;
await mkdir(join(work, 'batch-input'));
for (const name of ['fixture.pdf', 'scan.pdf']) await copyFile(join(work, name), join(work, 'batch-input', name));
await exec('/usr/local/bin/lit', ['batch-parse', join(work, 'batch-input'), join(work, 'batch-output'), '--no-ocr', '--format', 'json', '--quiet'],
  { env: cliEnv, timeout: 60_000 });
assert.ok(JSON.parse(await readFile(join(work, 'batch-output/fixture.json'))).pages.some(page => page.text.includes(marker)));
assert.ok(JSON.parse(await readFile(join(work, 'batch-output/scan.json'))).pages.every(page => page.text.trim() === ''));
proof['prepared-liteparse-no-ocr-batch'] = true;
await exec('/usr/local/bin/lit', ['screenshot', join(work, 'scan.pdf'), '--target-pages', '1', '--output-dir', join(work, 'passive-render'), '--quiet'],
  { env: cliEnv, timeout: 60_000 });
assert.equal((await sharp(join(work, 'passive-render/page_1.png')).metadata()).format, 'png');
proof['prepared-liteparse-screenshot-no-ocr'] = true;
await assert.rejects(exec('/usr/local/bin/lit', ['is-complex', join(work, 'scan.pdf'), '--quiet'], { env: cliEnv, timeout: 60_000 }), error => {
  assert.equal(error.code, 1);
  const page = JSON.parse(error.stdout)[0];
  assert.equal(page.needsOcr, true);
  assert.equal(page.textLength, 0);
  return true;
});
proof['prepared-liteparse-complexity-no-ocr'] = true;
if (process.geteuid() !== 0) {
  for (const [operation, file, backend, extra] of [
    ['parse', 'fixture.docx', 'anydoc', []], ['parse', 'scan.pdf', 'liteparse', ['--ocr', 'limited', '--pages', '1']],
    ['search', 'fixture.pdf', 'pymupdf', ['--pattern', marker, '--pages', '1']],
    ['render', 'fixture.pdf', 'pymupdf', ['--pages', '1', '--max-dimension', '500']],
  ]) {
    const output = await exec('/usr/bin/setpriv', ['--no-new-privs', '--', '/usr/local/bin/opulent-document', operation,
      '--input', join(work, file), '--workspace', work, '--backend', backend, '--preview-chars', '160', ...extra],
    { env: cliEnv, timeout: 60_000 });
    const result = JSON.parse(output.stdout);
    assert.equal(result.status, 'ok');
    assert.equal(result.ocr.network, false);
    if (operation !== 'render') assert.ok(result.snippets.some(item => item.text.includes(marker)));
    else assert.ok(result.images[0].width <= 500 && result.images[0].height <= 500);
    proof[`guarded-helper-${operation}-${backend}`] = true;
  }
}
console.log(JSON.stringify({ verified: true, checks: proof,
  policy: 'Real bundled native libraries and local files; explicit offline English OCR, no hosted providers.' }));

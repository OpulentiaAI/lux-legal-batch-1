import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const root = dirname(filename);
const require = createRequire(import.meta.url);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export const documentReadSource = readFileSync(join(root, 'document.py'), 'utf8');

function save(path, value) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_OUTPUT_BYTES) throw Object.assign(new Error('Document extraction exceeds the output limit'), { code: 'resource_limit' });
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
}

function packageInfo(name) {
  const entry = require.resolve(name);
  let folder = dirname(entry);
  while (!existsSync(join(folder, 'package.json'))) {
    if (dirname(folder) === folder) throw new Error('Installed document backend has no package metadata');
    folder = dirname(folder);
  }
  const metadata = JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'));
  return { name, version: metadata.version, file_sha256: createHash('sha256').update(readFileSync(entry)).digest('hex') };
}

function nativeFiles() {
  return Object.keys(require.cache).filter(path => path.endsWith('.node')).map(path => ({
    path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  }));
}

async function worker(requestPath) {
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));
  try {
    let result;
    if (request.backend === 'anydoc') {
      const info = packageInfo('@firecrawl/anydoc');
      const entry = require.resolve('@firecrawl/anydoc');
      const native = require(join(dirname(entry), 'index.js'));
      info.native_files = nativeFiles();
      const pages = [];
      for (const item of request.pages ?? [{ path: request.input, page: null }]) {
        const text = await native.toMarkdown(item.path);
        if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw Object.assign(new Error('Extracted text exceeds the output limit'), { code: 'resource_limit' });
        pages.push({ page: item.page, text });
      }
      result = { backend: info, pages };
    } else if (request.backend === 'liteparse') {
      const info = packageInfo('@llamaindex/liteparse');
      const { LiteParse } = require('@llamaindex/liteparse');
      info.native_files = nativeFiles();
      const pages = [], images = [];
      for (const item of request.pages) {
        if (request.ocr === 'limited' && !existsSync('/usr/share/tesseract-ocr/5/tessdata/eng.traineddata')) {
          throw Object.assign(new Error('Offline English OCR requires /usr/share/tesseract-ocr/5/tessdata/eng.traineddata; automatic downloads are disabled'), { code: 'ocr_unavailable' });
        }
        const dpi = Math.max(1, Math.floor(Math.min(144, 72 * request.max_dimension / Math.max(item.width, item.height), 72 * Math.sqrt(request.max_pixels / (item.width * item.height)))));
        const parser = new LiteParse({ ocrEnabled: request.ocr === 'limited', ocrLanguage: 'eng', tessdataPath: '/usr/share/tesseract-ocr/5/tessdata', numWorkers: 1,
          maxPages: 1, targetPages: '1', outputFormat: 'text', extractImages: false, extractScreenshots: false,
          extractLinks: false, quiet: true, dpi });
        if (request.operation === 'render') {
          const captures = await parser.screenshot(item.path, [1]);
          if (captures.length !== 1) throw new Error('LiteParse did not return the selected page screenshot');
          const capture = captures[0];
          if (capture.width > request.max_dimension || capture.height > request.max_dimension || capture.width * capture.height > request.max_pixels) {
            throw Object.assign(new Error('LiteParse screenshot exceeded the requested dimensions'), { code: 'resource_limit' });
          }
          const path = join(request.directory, `liteparse-page-${item.page}.png`);
          if (capture.imageBuffer.length > MAX_OUTPUT_BYTES) throw Object.assign(new Error('Screenshot exceeds the output limit'), { code: 'resource_limit' });
          writeFileSync(path, capture.imageBuffer, { flag: 'wx', mode: 0o600 });
          images.push({ ...item, path, width: capture.width, height: capture.height });
        } else {
          const parsed = await parser.parse(item.path);
          if (parsed.pageErrors?.length || parsed.pages.length !== 1) throw new Error('LiteParse could not extract the selected page');
          const page = parsed.pages[0];
          if (Buffer.byteLength(page.text) > MAX_OUTPUT_BYTES) throw Object.assign(new Error('Extracted text exceeds the output limit'), { code: 'resource_limit' });
          pages.push({ page: item.page, text: page.text, ocr_applied: page.textItems.some(item => Number.isFinite(item.confidence)),
            geometry: { width: page.width, height: page.height, unit: 'points', origin: 'top-left', rotation: item.rotation } });
        }
      }
      result = { backend: info, pages, images };
    } else throw Object.assign(new Error('Unsupported backend'), { code: 'unsupported_backend' });
    save(request.output, result);
  } catch (error) {
    const missing = error.code === 'MODULE_NOT_FOUND' || /native binding|shared object|Cannot find module/i.test(error.message);
    save(request.output, { error: { code: missing ? 'missing_dependency' : error.code ?? 'provider_error', message: String(error.message).slice(0, 512) } });
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === filename) {
  if (process.argv[2] === '--worker') {
    await worker(process.argv[3]);
  } else {
    const python = existsSync(join(root, 'venv/bin/python')) ? join(root, 'venv/bin/python') : '/usr/bin/python3';
    const child = spawn(python, ['-I', join(root, 'document.py'), ...process.argv.slice(2)], { stdio: 'inherit' });
    child.on('error', () => {
      process.stdout.write(JSON.stringify({ kind: 'document', status: 'error', error: { code: 'missing_dependency', message: 'Document Python interpreter is unavailable' } }) + '\n');
      process.exitCode = 1;
    });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
    child.on('exit', code => { process.exitCode = code ?? 1; });
  }
}

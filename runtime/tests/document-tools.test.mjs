import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCapyFileTools } from '../capy-files.mjs';

const exec = promisify(execFile);
const helper = fileURLToPath(new URL('../document-tools/document.mjs', import.meta.url));
const pythonHelper = fileURLToPath(new URL('../document-tools/document.py', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const liveHelper = process.env.OPULENT_DOCUMENT_LIVE_HELPER;
const livePath = process.env.OPULENT_DOCUMENT_LIVE_PATH ?? process.env.PATH;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'opulent-document-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function cli(root, args, executable = helper, path = process.env.PATH) {
  let result;
  try {
    result = await exec(process.execPath, [executable, ...args, '--workspace', root], {
      env: { PATH: path, HOME: root }, timeout: 130000, maxBuffer: 1000000,
    });
  } catch (error) {
    if (!error.stdout) throw error;
    result = error;
  }
  assert(result.stdout.length < 750000);
  return { value: JSON.parse(result.stdout), stdout: result.stdout, exit: result.code ?? 0 };
}

function readTools(root, path = '/usr/bin:/bin') {
  const calls = [];
  return { calls, tools: createCapyFileTools({ workspace: root, config: { instructionProfile: 'opulent2-fixed-v1' }, sandbox: {
    files: { read() { throw new Error('Bulk SDK file reads are forbidden'); } },
    commands: { async run(command, options) {
      assert.equal(options.user, 'user');
      assert.equal(options.rlmNoSecrets, true);
      calls.push(command);
      try {
        const result = await exec('/bin/sh', ['-c', command], { env: { PATH: path, HOME: root }, timeout: options.timeoutMs, maxBuffer: 1000000 });
        return { ...result, exitCode: 0 };
      } catch (error) {
        return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
      }
    } },
  } }) };
}

async function zip(root, name, entries) {
  const path = join(root, name);
  const request = join(root, `${name}.entries.json`);
  await writeFile(request, JSON.stringify({ path, entries }));
  await exec('/usr/bin/python3', ['-c', `import json,sys,zipfile
a=json.load(open(sys.argv[1]))
with zipfile.ZipFile(a['path'],'w',compression=zipfile.ZIP_DEFLATED) as z:
 for entry in a['entries']:
  i=zipfile.ZipInfo(entry['name']); i.compress_type=zipfile.ZIP_DEFLATED
  if entry.get('symlink'): i.create_system=3; i.external_attr=0o120777<<16
  z.writestr(i,entry.get('text',''))`, request]);
  return path;
}

test('VM text reads are streaming, bounded, hashed and recoverable in Unicode character space', async t => {
  const root = await fixture(t);
  const file = join(root, 'long.txt');
  const text = 'first\r\n' + '😀漢'.repeat(50000) + '\nlast\n';
  await writeFile(file, text);
  const { tools, calls } = readTools(root);
  const first = await tools.read({ path: 'long.txt', offset: 2, limit: 1 });
  assert.equal(Array.from(first.content).length, 60000);
  assert.equal(first.next_character_offset, 60000);
  assert.equal(first.absolute_character_start, 7);
  assert.equal(first.offset_unit, 'unicode_code_points');
  assert.equal(first.source_sha256, sha(Buffer.from(text)));
  const second = await tools.read({ path: 'long.txt', offset: 2, limit: 1, character_offset: first.next_character_offset });
  assert.equal(first.content + second.content, '😀漢'.repeat(50000) + '\n');
  assert.equal(second.absolute_character_end, 100008);
  assert.equal(first.total_lines, 3);
  assert.equal(second.next_character_offset, null);
  assert.equal(second.consultation.omitted_text_consulted, false);
  const end = await tools.read({ path: 'long.txt', offset: 10 });
  assert.equal(end.content, '');
  assert.equal(end.absolute_character_start, Array.from(text).length);
  assert(calls.every(command => command.includes('/usr/bin/python3 -I -c')));
});

test('read rejects binary, excessive input, unsafe symlinks and invalid ranges instead of returning bytes', async t => {
  const root = await fixture(t);
  const { tools } = readTools(root);
  await writeFile(join(root, 'binary.bin'), Buffer.from([0, 0xff, 0, 1]));
  await assert.rejects(tools.read({ path: 'binary.bin' }), /unsupported_binary/);
  await writeFile(join(root, 'too-large.txt'), '');
  await truncate(join(root, 'too-large.txt'), 32 * 1024 * 1024 + 1);
  await assert.rejects(tools.read({ path: 'too-large.txt' }), /resource_limit/);
  await writeFile(join(root, 'text.txt'), 'safe text');
  await symlink('text.txt', join(root, 'alias'));
  await assert.rejects(tools.read({ path: 'alias' }), /unsafe_path/);
  await symlink(root, join(root, 'directory-alias'));
  await assert.rejects(tools.read({ path: 'directory-alias/text.txt' }), /unsafe_path/);
  for (const args of [{ offset: 0 }, { limit: 0 }, { character_offset: -1 }, { character_offset: 1.5 }]) {
    await assert.rejects(tools.read({ path: 'text.txt', ...args }), /invalid_options/);
  }
});

test('real doubly hardened shell wrappers keep the bounded reader below the process argument limit', async t => {
  const root = await fixture(t);
  const name = "quoted ' 😀.txt";
  const text = 'Bounded Unicode text 😀漢\n';
  await writeFile(join(root, name), text);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const tools = createCapyFileTools({ workspace: root, config: { instructionProfile: 'opulent2-fixed-v1' }, sandbox: {
    commands: { async run(command, options) {
      assert.equal(options.user, 'user');
      assert.equal(options.rlmNoSecrets, true);
      for (let layer = 0; layer < 2; layer++) command = `setpriv --no-new-privs -- /bin/sh -c ${quote(command)}`;
      assert(Buffer.byteLength(command) < 131072);
      const result = await exec('/bin/bash', ['-l', '-c', command], {
        env: { PATH: '/usr/bin:/bin', HOME: root }, timeout: options.timeoutMs, maxBuffer: 1000000,
      });
      return { ...result, exitCode: 0 };
    } },
  } });
  const result = await tools.read({ path: name });
  assert.equal(result.content, text);
  assert.equal(result.source_sha256, sha(Buffer.from(text)));
  assert.equal(result.consultation.omitted_text_consulted, false);
});

test('document reads never decode a PDF as text and explicitly report an absent installed helper', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'source.pdf'), '%PDF-1.7\nSECRET BINARY MARKER\0\n');
  const { tools, calls } = readTools(root, join(root, 'no-helper-path'));
  await assert.rejects(tools.read({ path: 'source.pdf' }), /missing_dependency.*opulent-document/);
  assert.equal(calls.length, 2);
  assert(calls[1].includes("'--page-start' '1' '--page-count' '4'"));
  assert(!calls[1].includes('SECRET BINARY MARKER'));
});

test('document reads reject PATH-shadowed launchers before executing untrusted code', async t => {
  const root = await fixture(t);
  const bin = join(root, 'bin');
  await mkdir(bin);
  const marker = join(root, 'shadow-executed');
  await writeFile(join(bin, 'opulent-document'), `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\n`, { mode: 0o700 });
  await writeFile(join(root, 'source.pdf'), '%PDF-1.7\n');
  const { tools, calls } = readTools(root, `${bin}:/usr/bin:/bin`);
  await assert.rejects(tools.read({ path: 'source.pdf' }), /missing_dependency.*trusted \/usr\/bin path/);
  await assert.rejects(stat(marker), { code: 'ENOENT' });
  assert.equal(calls.length, 2);
  assert(calls[1].includes("'/usr/bin/opulent-document'"));
});

test('historical profiles retain the original files.read contract without requiring commands.run', async () => {
  const text = 'A'.repeat(90000) + '\nsecond\n';
  for (const instructionProfile of [undefined, 'professional-v1', 'capy-v1']) {
    const tools = createCapyFileTools({ workspace: '/workspace', config: { instructionProfile },
      sandbox: { files: { async read(path, options) {
        assert.equal(path, '/workspace/legacy.txt');
        assert.equal(options.format, 'bytes');
        return Buffer.from(text);
      } } } });
    const first = await tools.read({ path: 'legacy.txt' });
    assert.equal(first.content.length, 60000);
    assert.equal(first.next_character_offset, 60000);
    assert.equal(first.source_sha256, undefined);
    const rest = await tools.read({ path: 'legacy.txt', character_offset: 60000 });
    assert.equal(first.content + rest.content, text);
    assert.equal((await tools.read({ path: 'legacy.txt', document_backend: 'historical ignored argument' })).content, first.content);
  }
});

test('Opulent2 document backend selectors reject invalid values and non-auto ordinary text without changing text auto reads', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'text.txt'), 'ordinary local content');
  const { tools, calls } = readTools(root);
  for (const document_backend of ['hosted', '', null, 1, {}]) {
    await assert.rejects(tools.read({ path: 'text.txt', document_backend }), /document_backend must be/);
  }
  assert.equal(calls.length, 0);
  for (const document_backend of ['pymupdf', 'anydoc', 'liteparse']) {
    await assert.rejects(tools.read({ path: 'text.txt', document_backend }), /not ordinary UTF-8 text/);
  }
  assert.equal((await tools.read({ path: 'text.txt', document_backend: 'auto' })).content, 'ordinary local content');
  assert(calls.every(command => !command.startsWith('command -v')));
});

test('help needs no input and states real bounds and dependency discovery rather than declaring providers healthy', async () => {
  const { stdout } = await exec(process.execPath, [helper, '--help']);
  assert.match(stdout, /parse,search,render/);
  assert.match(stdout, /input 32 MiB/);
  assert.match(stdout, /preview\s+16000 Unicode code points/);
  assert.match(stdout, /Dependency discovery \(not a\s+provider health test\)/);
  assert.match(stdout, /PyMuPDF import=/);
});

test('real cancellation unwinds the document worker guard and terminates its separate process group', async t => {
  const root = await fixture(t), pidPath = join(root, 'worker.pid');
  const worker = `import os,time,pathlib;pathlib.Path(${JSON.stringify(pidPath)}).write_text(str(os.getpid()));time.sleep(30)`;
  const code = `import importlib.util,json,signal,time
s=importlib.util.spec_from_file_location('document_cancel_test',${JSON.stringify(pythonHelper)})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
signal.signal(signal.SIGTERM,m.cancel_operation)
signal.signal(signal.SIGINT,m.cancel_operation)
try: m.run_process(['/usr/bin/python3','-I','-c',${JSON.stringify(worker)}],${JSON.stringify(root)},time.monotonic()+30)
except m.DocumentError as e: print(json.dumps({'code':e.code}),flush=True)`;
  const running = exec('/usr/bin/python3', ['-I', '-B', '-c', code], { timeout: 10000, killSignal: 'SIGTERM', maxBuffer: 100000 });
  let pid;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = Number(await readFile(pidPath, 'utf8')); break; } catch { await delay(25); }
    }
    assert(Number.isSafeInteger(pid) && pid > 0, 'the actual worker must start before cancellation');
    running.child.kill('SIGTERM');
    const result = await running;
    assert.equal(JSON.parse(result.stdout).code, 'cancelled');
    await assert.rejects(stat(`/proc/${pid}`), { code: 'ENOENT' });
  } finally {
    running.child.kill('SIGTERM');
    await running.catch(() => {});
  }
});

test('plain parse keeps complete text private and returns only selected chunks with consultation ranges', async t => {
  const root = await fixture(t);
  const text = '😀α content\n'.repeat(18000);
  const source = join(root, 'source.txt');
  await writeFile(source, text);
  const { value, exit } = await cli(root, ['parse', '--input', source, '--chunk-start', '2', '--max-chunks', '1', '--preview-chars', '1234']);
  assert.equal(exit, 0);
  assert.equal(value.status, 'ok');
  assert.equal(value.source.sha256, sha(Buffer.from(text)));
  assert.equal(value.snippets.length, 1);
  assert.equal(value.snippets[0].chunk, 3);
  assert.equal(value.snippets[0].character_start, 8000);
  assert.equal(Array.from(value.snippets[0].text).length, 1234);
  assert.equal(value.snippets[0].text, Array.from(text).slice(8000, 9234).join(''));
  assert.equal(await readFile(value.artifacts.text.path, 'utf8'), text);
  assert.equal(value.artifacts.text.sha256, sha(Buffer.from(text)));
  assert.equal((await stat(value.output_directory)).mode & 0o777, 0o700);
  assert.equal((await stat(value.artifacts.text.path)).mode & 0o777, 0o600);
  assert.equal(value.consultation.omitted_text_consulted, false);
  assert.equal(value.consultation.artifacts_consulted, false);
  assert.equal(value.consultation.returned_ranges[0].character_end, 9234);
  const next = (await cli(root, ['parse', '--input', source, '--chunk-start', '2', '--max-chunks', '1', '--preview-chars', '1234', '--character-offset', '1234'])).value;
  assert.equal(next.snippets[0].character_start, 9234);
  assert.equal(next.source.sha256, value.source.sha256);
});

test('local path and output validation reject URLs, escapes, existing directories, signatures and macros', async t => {
  const root = await fixture(t);
  const source = join(root, 'ordinary.txt');
  await writeFile(source, 'ordinary local content');
  for (const url of ['https://example.com/document.pdf', 'file:///etc/passwd', 'data:application/pdf;base64,UEZERg==']) {
    assert.equal((await cli(root, ['parse', '--input', url])).value.error.code, 'unsafe_path');
  }
  assert.equal((await cli(root, ['parse', '--input', source, '--output-dir', join(root, '..', 'escape')])).value.error.code, 'unsafe_path');
  assert.equal((await cli(root, ['parse', '--input', source, '--output-dir', root])).value.error.code, 'unsafe_path');
  await mkdir(join(root, 'already'), { mode: 0o700 });
  assert.equal((await cli(root, ['parse', '--input', source, '--output-dir', join(root, 'already')])).value.error.code, 'unsafe_path');
  await symlink(root, join(root, 'linked'));
  assert.equal((await cli(root, ['parse', '--input', source, '--output-dir', join(root, 'linked', 'new')])).value.status, 'error');
  await writeFile(join(root, 'false.pdf'), 'ordinary local content');
  assert.equal((await cli(root, ['parse', '--input', join(root, 'false.pdf')])).value.error.code, 'malformed');
  await writeFile(join(root, 'macro.docm'), 'ordinary local content');
  assert.equal((await cli(root, ['parse', '--input', join(root, 'macro.docm')])).value.error.code, 'unsafe_document');
  const hostile = join(root, "literal '$(touch SHELL_INJECTION)' file.txt");
  await writeFile(hostile, 'literal local path');
  assert.equal((await readTools(root).tools.read({ path: hostile })).content, 'literal local path');
  assert.equal((await cli(root, ['parse', '--input', hostile])).value.status, 'ok');
  await assert.rejects(stat(join(root, 'SHELL_INJECTION')), { code: 'ENOENT' });
  assert.equal((await cli(root, ['parse', '--input', source, '--expected-sha256', '0'.repeat(64)])).value.error.code, 'source_changed');
});

test('document container preflight rejects traversal, nested archives, symlinks, macro streams and zip bombs before providers', async t => {
  const root = await fixture(t);
  const cases = [
    ['traversal.docx', [{ name: '../escape', text: 'bad' }], 'unsafe_archive'],
    ['nested.docx', [{ name: 'attachment.zip', text: 'bad' }], 'unsafe_archive'],
    ['linked.docx', [{ name: 'word/document.xml', text: '/etc/passwd', symlink: true }], 'unsafe_archive'],
    ['macro.docx', [{ name: 'word/vbaProject.bin', text: 'bad' }], 'unsafe_document'],
    ['bomb.docx', [{ name: 'word/document.xml', text: 'X'.repeat(500000) }], 'resource_limit'],
  ];
  for (const [name, entries, code] of cases) {
    const source = await zip(root, name, entries);
    const result = (await cli(root, ['parse', '--input', source, '--backend', 'anydoc'])).value;
    assert.equal(result.error.code, code, name);
  }
  const source = await zip(root, 'general.zip', [{ name: 'safe.txt', text: 'needle' }]);
  assert.equal((await cli(root, ['search', '--input', source, '--pattern', 'needle'])).value.error.code, 'unsafe_archive');
});

test('missing native packages fail honestly, and complete read-only input is never modified', async t => {
  const root = await fixture(t);
  const isolated = join(root, 'helper');
  await mkdir(isolated);
  await writeFile(join(isolated, 'document.mjs'), await readFile(helper));
  await writeFile(join(isolated, 'document.py'), await readFile(pythonHelper));
  const source = join(root, 'table.csv');
  await writeFile(source, 'Name,Value\nNeedle,42\n');
  await chmod(source, 0o444);
  const before = await readFile(source);
  const result = (await cli(root, ['parse', '--input', source, '--backend', 'anydoc'], join(isolated, 'document.mjs'))).value;
  assert.equal(result.status, 'error');
  assert.equal(result.error.code, 'missing_dependency', JSON.stringify(result));
  assert.deepEqual(await readFile(source), before);
});

async function isolatedProcess(root, code, timeout = 5, stdoutLimit = 1024) {
  const program = `import json,runpy,sys,time
m=runpy.run_path(sys.argv[1])
try:
 p=m['run_process'](['/usr/bin/python3','-c',sys.argv[3]],sys.argv[2],time.monotonic()+float(sys.argv[4]),stdout_limit=int(sys.argv[5]))
 print(json.dumps({'status':'ok','output':open(p).read()}))
except Exception as e: print(json.dumps({'status':'error','code':getattr(e,'code',None),'message':str(e)}))`;
  const { stdout } = await exec('/usr/bin/python3', ['-c', program, pythonHelper, root, code, String(timeout), String(stdoutLimit)], {
    env: { PATH: '/untrusted-bin:/usr/local/bin:/usr/bin:/bin', OPULENT_DOCUMENT_TEST_SECRET: 'must-not-reach-worker' }, timeout: 20000,
  });
  return JSON.parse(stdout);
}

test('real worker isolation strips secrets and denies IP networking without a fake provider', async t => {
  const root = await fixture(t);
  const result = await isolatedProcess(root, `import errno,os,socket
assert 'OPULENT_DOCUMENT_TEST_SECRET' not in os.environ
assert os.environ['PATH']==${JSON.stringify(join(dirname(pythonHelper), 'node/bin') + ':/usr/bin:/bin')}
try: socket.socket(socket.AF_INET,socket.SOCK_STREAM)
except OSError as e: assert e.errno==errno.EPERM; print('network-denied')
else: raise RuntimeError('network unexpectedly permitted')`);
  assert.equal(result.status, 'ok');
  assert.equal(result.output, 'network-denied\n');
});

test('real worker output limits and deadline kill process groups and leave explicit failure evidence', async t => {
  const root = await fixture(t);
  const output = await isolatedProcess(root, "print('X'*100000)", 5, 1024);
  assert.equal(output.code, 'resource_limit');
  const pid = join(root, 'child.pid');
  const timed = await isolatedProcess(root, `import pathlib,subprocess,time
pathlib.Path(${JSON.stringify(pid)}).write_text(str(subprocess.Popen(['/bin/sleep','30']).pid))
time.sleep(30)`, 0.7);
  assert.equal(timed.code, 'timeout');
  const child = Number(await readFile(pid, 'utf8'));
  const state = await readFile(`/proc/${child}/stat`, 'utf8').catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  assert(state === null || state.split(' ')[2] === 'Z', 'worker descendant must not remain running');
});

const fixtureProgram = `import pathlib,sys,zipfile,pymupdf
p=pathlib.Path(sys.argv[1]); d=pymupdf.open()
for text in ['First local page: covenant needle','Second local page: private selected evidence','', 'Rotated local page: coordinate evidence']:
 page=d.new_page(width=600,height=800)
 if text: page.insert_text((72,72),text)
 if text.startswith('Rotated'):
  annotation=page.add_rect_annot(pymupdf.Rect(60,60,400,120)); annotation.set_colors(stroke=(1,0,0)); annotation.update()
  page.set_rotation(90)
d.save(str(p/'fixture.pdf'))
d.save(str(p/'encrypted.pdf'),encryption=pymupdf.PDF_ENCRYPT_AES_256,owner_pw='test-owner',user_pw='test-user')
many=pymupdf.open()
for number in range(1,25):
 page=many.new_page(); page.insert_text((72,72),'Local fixture page %d selected needle evidence'%number)
many.save(str(p/'many-pages.pdf'))
original=pymupdf.open(); page=original.new_page(width=600,height=800)
page.insert_text((72,160),'LOCAL SCAN NEEDLE 73912',fontsize=28)
pixels=page.get_pixmap(matrix=pymupdf.Matrix(2,2),alpha=False).tobytes('png')
scan=pymupdf.open(); scanned=scan.new_page(width=600,height=800); scanned.insert_image(scanned.rect,stream=pixels); scan.save(str(p/'scan.pdf'))
def z(name,parts):
 with zipfile.ZipFile(p/name,'w',compression=zipfile.ZIP_DEFLATED) as archive:
  for name,text in parts.items(): archive.writestr(name,text)
z('fixture.docx',{'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', 'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Office local fixture needle</w:t></w:r></w:p><w:sectPr/></w:body></w:document>'})
z('fixture.odt',{'mimetype':'application/vnd.oasis.opendocument.text','content.xml':'<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text><text:p>ODF local fixture needle</text:p></office:text></office:body></office:document-content>'})
z('fixture.epub',{'mimetype':'application/epub+zip','META-INF/container.xml':'<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', 'package.opf':'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Local EPUB</dc:title><dc:identifier id="id">fixture</dc:identifier></metadata><manifest><item id="ch1" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch1"/></spine></package>', 'chapter.xhtml':'<html xmlns="http://www.w3.org/1999/xhtml"><body><p>EPUB local fixture needle</p></body></html>'})
(p/'fixture.csv').write_text('Name,Value\\nNeedle,42\\n')
(p/'fixture.txt').write_text('😀 prefix needle evidence\\nneedle second local match\\n')
`;

async function liveFixture(t) {
  const root = await fixture(t);
  await exec(join(dirname(liveHelper), 'venv/bin/python'), ['-I', '-c', fixtureProgram, root]);
  return root;
}

test('live pinned AnyDoc handles PDF, DOCX, ODF, EPUB and CSV through real native fixtures', { skip: !liveHelper, timeout: 120000 }, async t => {
  const root = await liveFixture(t);
  for (const extension of ['pdf', 'docx', 'odt', 'epub', 'csv']) {
    const source = join(root, `fixture.${extension}`);
    const args = ['parse', '--input', source, '--backend', 'anydoc', '--preview-chars', '400'];
    if (extension === 'pdf') args.push('--pages', '1');
    const { value, exit } = await cli(root, args, liveHelper, livePath);
    assert.equal(exit, 0, JSON.stringify(value));
    assert.equal(value.status, 'ok', extension);
    assert.equal(value.backend.version, '0.2.4');
    assert(value.backend.native_files.length);
    assert.match(value.snippets.map(item => item.text).join(''), /needle/i);
    assert.equal(value.source.sha256, sha(await readFile(source)));
    assert(!JSON.stringify(value).includes('image_base64'));
  }
});

test('live pinned PyMuPDF and LiteParse select pages, expose sparse/encrypted failures and preserve render coordinates', { skip: !liveHelper, timeout: 120000 }, async t => {
  const root = await liveFixture(t);
  const source = join(root, 'fixture.pdf');
  for (const backend of ['pymupdf', 'liteparse']) {
    const parsed = (await cli(root, ['parse', '--input', source, '--backend', backend, '--pages', '2', '--preview-chars', '100'], liveHelper, livePath)).value;
    assert.equal(parsed.status, 'ok', JSON.stringify(parsed));
    assert.equal(parsed.backend.version, backend === 'pymupdf' ? '1.28.2' : '2.15.1');
    assert.deepEqual(parsed.coverage.selected_pages, [2]);
    assert.match(parsed.snippets[0].text, /private selected evidence/);
    assert(!JSON.stringify(parsed).includes('First local page'));
    const sparse = (await cli(root, ['parse', '--input', source, '--backend', backend, '--pages', '3'], liveHelper, livePath)).value;
    assert.equal(sparse.status, 'partial');
    assert.deepEqual(sparse.sparse_pages, [3]);
    const rendered = (await cli(root, ['render', '--input', source, '--backend', backend, '--pages', '4', '--max-dimension', '800', '--max-pixels', '500000'], liveHelper, livePath)).value;
    assert.equal(rendered.status, 'ok', JSON.stringify(rendered));
    assert.equal(rendered.images.length, 1);
    const image = rendered.images[0], pixels = await readFile(image.path);
    assert(image.width <= 800 && image.height <= 800 && image.width * image.height <= 500000);
    assert.equal(image.sha256, sha(pixels));
    assert.equal(pixels.readUInt32BE(16), image.width);
    assert.equal(pixels.readUInt32BE(20), image.height);
    assert.equal(image.coordinate_space.rotation, 90);
    assert.equal(image.coordinate_space.scale_x, image.width / 800);
    assert.equal(image.coordinate_space.scale_y, image.height / 600);
    assert.equal(image.coordinate_space.origin, 'rotated-page-viewport-top-left');
    assert.deepEqual(image.coordinate_space.rotation_matrix, [0, 1, -1, 0, 800, 0]);
    assert.deepEqual(image.coordinate_space.derotation_matrix, [0, -1, 1, 0, 0, 800]);
    assert.equal(rendered.consultation.rendered_pixels_consulted, false);
    assert(!JSON.stringify(rendered).includes('base64'));
    const distant = (await cli(root, ['parse', '--input', join(root, 'many-pages.pdf'), '--backend', backend, '--pages', '2,24'], liveHelper, livePath)).value;
    assert.deepEqual(distant.coverage.selected_pages, [2, 24]);
    assert.equal(distant.coverage.total_source_pages, 24);
    assert.match(distant.snippets[0].text, /page 2 selected/);
    assert.match(distant.snippets[1].text, /page 24 selected/);
    if (backend === 'pymupdf') {
      const expected = join(root, 'direct-original.png');
      await exec(join(dirname(liveHelper), 'venv/bin/python'), ['-I', '-c', `import pymupdf,sys
with pymupdf.open(sys.argv[1]) as doc: doc[3].get_pixmap(matrix=pymupdf.Matrix(1,1),colorspace=pymupdf.csRGB,alpha=False,annots=True).save(sys.argv[2])`, source, expected]);
      assert.equal(image.sha256, sha(await readFile(expected)), 'selected rendering must preserve the original annotated page pixels');
    }
  }
  const encrypted = (await cli(root, ['parse', '--input', join(root, 'encrypted.pdf')], liveHelper, livePath)).value;
  assert.equal(encrypted.error.code, 'encrypted');
  assert.equal((await cli(root, ['parse', '--input', source, '--pages', '1-17'], liveHelper, livePath)).value.status, 'error');
});

test('live pinned offline English OCR reads genuine image-only PDF pixels through PyMuPDF and LiteParse', { skip: !liveHelper, timeout: 120000 }, async t => {
  const root = await liveFixture(t);
  for (const backend of ['pymupdf', 'liteparse']) {
    const result = (await cli(root, ['parse', '--input', join(root, 'scan.pdf'), '--backend', backend, '--pages', '1', '--ocr', 'limited'], liveHelper, livePath)).value;
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.match(result.snippets[0].text, /SCAN NEEDLE 73912/i);
    assert.equal(result.ocr.network, false);
    assert.equal(result.ocr.models.eng.sha256, '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2');
    assert.equal(result.ocr.models.osd.sha256, '9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff');
    assert.deepEqual(result.ocr.applied_pages, [1]);
    const plain = (await cli(root, ['parse', '--input', join(root, 'scan.pdf'), '--backend', backend, '--pages', '1'], liveHelper, livePath)).value;
    assert.equal(plain.status, 'partial');
    assert.deepEqual(plain.sparse_pages, [1]);
  }
});

test('live local office pagination uses real LibreOffice and size-limited normalization keeps coordinates', { skip: !liveHelper, timeout: 120000 }, async t => {
  const root = await liveFixture(t);
  const converted = (await cli(root, ['parse', '--input', join(root, 'fixture.docx'), '--backend', 'liteparse', '--pages', '1'], liveHelper, livePath)).value;
  assert.equal(converted.status, 'ok', JSON.stringify(converted));
  assert.match(converted.snippets[0].text, /Office local fixture needle/);
  assert.equal(converted.coverage.pagination, 'local_conversion_pages');
  assert.equal(converted.converter.name, 'libreoffice');
  assert.match(converted.converter.output_sha256, /^[a-f0-9]{64}$/);
  const tiny = (await cli(root, ['render', '--input', join(root, 'fixture.pdf'), '--pages', '1', '--max-image-bytes', '1024'], liveHelper, livePath)).value;
  assert.equal(tiny.status, 'ok', JSON.stringify(tiny));
  assert(tiny.images[0].bytes <= 1024);
  assert.equal(tiny.images[0].coordinate_space.scale_x, tiny.images[0].width / 600);
});

test('live pinned rga searches bounded extraction with byte/character/page provenance and explicit zero-match/errors', { skip: !liveHelper, timeout: 120000 }, async t => {
  const root = await liveFixture(t);
  const source = join(root, 'fixture.txt');
  const result = (await cli(root, ['search', '--input', source, '--pattern', 'needle', '--max-matches', '1'], liveHelper, livePath)).value;
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.search_backend.version, 'ripgrep-all 0.10.10');
  assert.equal(result.search_backend.archive_adapters_enabled, false);
  assert.equal(result.truncated, true);
  assert.equal(result.snippets.length, 1);
  const hit = result.snippets[0];
  assert.equal(hit.byte_offset, Buffer.byteLength('😀 prefix '));
  assert.equal(hit.match_character_start, Array.from('😀 prefix ').length);
  assert.equal(hit.match_character_end, hit.match_character_start + 6);
  const pdf = (await cli(root, ['search', '--input', join(root, 'fixture.pdf'), '--pages', '1-2', '--pattern', 'needle'], liveHelper, livePath)).value;
  assert.equal(pdf.snippets[0].page, 1);
  const empty = (await cli(root, ['search', '--input', source, '--pattern', 'not-present-anywhere'], liveHelper, livePath)).value;
  assert.equal(empty.status, 'ok');
  assert.equal(empty.snippets.length, 0);
  assert.equal(empty.search_complete, true);
  const invalid = (await cli(root, ['search', '--input', source, '--pattern', '[', '--regex'], liveHelper, livePath)).value;
  assert.equal(invalid.status, 'error');
  assert.equal(invalid.error.code, 'provider_error');
});

test('live document-aware read clips pages, preserves ranges and rejects a source changed after its probe', { skip: !liveHelper, timeout: 120000 }, async t => {
  const root = await liveFixture(t);
  const { tools, calls } = readTools(root, livePath);
  const result = await tools.read({ path: 'fixture.pdf', offset: 2 });
  assert.equal(result.document, true);
  assert.equal(result.kind, 'read');
  assert.deepEqual(result.coverage.selected_pages, [2, 3, 4]);
  assert.equal(result.status, 'partial');
  assert.match(result.content, /private selected evidence/);
  assert.equal(result.next_offset, null);
  assert(!result.content.includes('First local page'));
  assert.equal(calls.length, 2);
  assert(calls[1].includes("'/usr/bin/opulent-document'"));
  for (const document_backend of ['pymupdf', 'anydoc', 'liteparse']) {
    const explicit = await tools.read({ path: 'fixture.pdf', offset: 2, limit: 1, document_backend });
    assert.equal(explicit.requested_backend, document_backend);
    assert.match(explicit.content, /private selected evidence/);
    assert.deepEqual(explicit.coverage.selected_pages, [2]);
    assert.equal(explicit.next_offset, 3);
    assert(calls.at(-1).includes(`'--backend' '${document_backend}'`));
  }
  const office = await tools.read({ path: 'fixture.docx', document_backend: 'anydoc', limit: 1 });
  assert.equal(office.requested_backend, 'anydoc');
  assert.equal(office.offset_semantics, '1-based logical chunk');
  assert.match(office.content, /Office local fixture needle/);
  const source = join(root, 'fixture.pdf');
  const tamper = createCapyFileTools({ workspace: root, config: { instructionProfile: 'opulent2-fixed-v1' }, sandbox: { commands: { async run(command, options) {
    if (command.startsWith('command -v')) await writeFile(source, await readFile(join(root, 'encrypted.pdf')));
    return await exec('/bin/sh', ['-c', command], { env: { PATH: livePath }, timeout: options.timeoutMs, maxBuffer: 1000000 })
      .then(result => ({ ...result, exitCode: 0 }), error => ({ stdout: error.stdout, stderr: error.stderr, exitCode: error.code }));
  } } } });
  await assert.rejects(tamper.read({ path: 'fixture.pdf' }), /source_changed/);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import { Sandbox } from 'e2b';
import { prepareCorpus } from '../../eval/comparison-corpus.mjs';
import { provisionCorpus, BROAD_SANDBOX_WORKSPACE } from '../broad-legal-eval.mjs';
import { createSandbox } from '../e2b.mjs';
import { createTools as createComputerTools } from '../computer/tools.mjs';
import { createOpulent2MachineTools, probeOpulent2Machine } from '../opulent2-machine.mjs';

const live = process.env.OPULENT2_MACHINE_E2B_LIVE === '1';
const evidenceRoot = process.env.OPULENT2_MACHINE_EVIDENCE_DIRECTORY ?? '/home/user/.capy/work/opulent2-fixed-machine/e2b-probe';
const buildPath = process.env.OPULENT2_MACHINE_BUILD_RECORD ?? '/home/user/.capy/work/opulent2-fixed-machine/final-image/build.json';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test('owned E2B prepared image runs real corpus agrep and the documented useful Chrome interaction', { skip: !live && 'Opt in with OPULENT2_MACHINE_E2B_LIVE=1; no live VM is implied by unit tests', timeout: 240000 }, async () => {
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const build = JSON.parse(await readFile(buildPath, 'utf8'));
  const workspace = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
  const corpus = prepareCorpus({ workspace, directory: join(evidenceRoot, 'corpus') });
  const config = { sandboxTemplate: build.templateId, computerPreparedImage: true, computerImageSha256: build.imageSha256,
    sandboxTimeoutMs: 900000, network: { allowPublicTraffic: false, denyOut: ['0.0.0.0/0'] }, secureSandboxFileAccess: true,
    browserAllowedOrigins: ['http://127.0.0.1:8765'], workspace: BROAD_SANDBOX_WORKSPACE };
  const record = { schema: 1, createdAt: new Date().toISOString(), templateId: build.templateId, buildId: build.buildId,
    expectedImageSha256: build.imageSha256, corpus: { count: corpus.count, hash: corpus.hash },
    scope: 'One owned infrastructure probe; no model, native inference, child worker or scored task', cleanup: { attempted: false } };
  const persist = () => writeFile(join(evidenceRoot, 'probe.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  let owned;
  try {
    const sandbox = await provisionCorpus(config, corpus, workspace, async config => {
      owned = await createSandbox(config);
      record.sandboxId = owned.sandboxId;
      await persist();
      return owned;
    });
    const { computer, readiness } = await probeOpulent2Machine(sandbox, config);
    record.readiness = readiness;
    const marker = await sandbox.files.read('/opt/computer-use/image.json');
    record.actualImageSha256 = sha256(marker);
    assert.equal(record.actualImageSha256, build.imageSha256);
    const actualManifest = JSON.parse(marker);
    assert.equal(actualManifest.opulent2_machine.recipeSha256, build.recipeSha256);
    assert.equal(actualManifest.opulent2_machine.builderSha256, build.builderSha256);
    assert.equal(actualManifest.opulent2_machine.executableSha256, readiness.agrep.executableSha256);
    record.skills = [];
    for (const manifestName of ['manifest-v1.json', 'opulent2-manifest-v1.json']) {
      const manifest = JSON.parse(await readFile(new URL(`../skills/${manifestName}`, import.meta.url), 'utf8'));
      for (const skill of manifest.skills) {
        const path = `${manifest.destinationRoot}/${skill.name}/SKILL.md`;
        const digest = sha256(await sandbox.files.read(path));
        const permissions = await sandbox.commands.run(`test ! -w ${quote(path)} && test ! -w ${quote(`${manifest.destinationRoot}/${skill.name}`)} && test ! -w ${quote(manifest.destinationRoot)} && test "$(stat -c %u ${quote(path)})" = 0 && stat -c '%u %a' ${quote(path)} ${quote(`${manifest.destinationRoot}/${skill.name}`)}`);
        assert.equal(digest, skill.artifactSha256);
        assert.equal(permissions.exitCode, 0);
        record.skills.push({ manifest: manifestName, name: skill.name, sha256: digest, permissions: permissions.stdout.trim().split('\n') });
      }
    }
    assert.equal(sha256(await sandbox.files.read('/opt/opulent/skills/opulent2-manifest-v1.json')), build.skills.manifestSha256);
    const tools = createOpulent2MachineTools({ sandbox, workspace: BROAD_SANDBOX_WORKSPACE, config });
    const corpusBefore = await sandbox.commands.run(`bash -o pipefail -c ${quote(`cd ${BROAD_SANDBOX_WORKSPACE}/corpus && tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . | sha256sum`)} `);
    const searched = await tools.agrep({ pattern: 'assemblée généralle', path: 'corpus/chunks', max_errors: 1, max_results: 8, timeout_seconds: 30 });
    assert.ok(searched.matches.some(match => match.text.toLowerCase().includes('assemblée générale')));
    const absent = await tools.agrep({ pattern: 'opulent2-no-match-marker-7fe43dce9172', path: 'corpus', max_errors: 0, timeout_seconds: 30 });
    assert.equal(absent.status, 'no_matches');
    assert.equal(absent.complete, true);
    assert.equal(absent.files_searched, corpus.count + 3);
    record.agrep = { approximate: searched, fullCorpusNoMatch: absent };
    await sandbox.files.write(`${BROAD_SANDBOX_WORKSPACE}/outside-marker.txt`, 'symlink-escape-marker\n');
    await sandbox.commands.run(`ln -s /opt/computer-use/image.json ${BROAD_SANDBOX_WORKSPACE}/escape.txt`);
    await assert.rejects(tools.agrep({ pattern: 'schema', path: 'escape.txt' }));
    record.symlinkEscapeDenied = true;
    const corpusAfter = await sandbox.commands.run(`bash -o pipefail -c ${quote(`cd ${BROAD_SANDBOX_WORKSPACE}/corpus && tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - . | sha256sum`)} `);
    assert.equal(corpusAfter.stdout, corpusBefore.stdout);
    record.corpusUnchanged = true;
    const source = corpus.sources.find(source => source.text.includes('assemblée générale'));
    assert.ok(source);
    const escape = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const html = `<!doctype html><meta charset="utf-8"><title>Opulent2 local source inspection</title><style>body{font:20px sans-serif;padding:24px;max-width:1100px}pre{white-space:pre-wrap;font:18px monospace}</style><h1>Opulent2 local source inspection</h1><p>Genuine approximate-grep: ${searched.matches.length} observed matches. Full corpus: ${absent.files_searched} files searched with no-match exit 1.</p><h2>Actual corpus source [${escape(source.id)}]</h2><pre>${escape(source.text.slice(0, 4500))}</pre>`;
    await sandbox.files.makeDir(`${BROAD_SANDBOX_WORKSPACE}/analysis`);
    await sandbox.files.write(`${BROAD_SANDBOX_WORKSPACE}/analysis/inspection.html`, html);
    const process = await sandbox.commands.run(`python3 -m http.server 8765 --bind 127.0.0.1 --directory ${BROAD_SANDBOX_WORKSPACE}/analysis`, { background: true, timeoutMs: 15000, rlmNoSecrets: true });
    await process.disconnect();
    const httpReady = await sandbox.commands.run("python3 - <<'PY'\nimport time,urllib.request\nfor attempt in range(40):\n try:\n  with urllib.request.urlopen('http://127.0.0.1:8765/inspection.html',timeout=1) as response:\n   if response.status==200:break\n except Exception:pass\n time.sleep(0.25)\nelse:raise RuntimeError('Local viewer unavailable')\nprint('ready')\nPY", { timeoutMs: 20000 });
    assert.equal(httpReady.stdout.trim(), 'ready');
    const computerTools = createComputerTools({ sandbox, computer, config, sessionId: 'owned-machine-probe' });
    const opening = await computerTools.computer({ actions: [{ action: 'key', text: 'ctrl+l' }, { action: 'type', text: 'http://127.0.0.1:8765/inspection.html' }, { action: 'key', text: 'Return' }, { action: 'wait', duration: 2 }, { action: 'screenshot' }] });
    assert.equal(opening.ok, true);
    const screenshot = opening.screenshot;
    assert.ok(screenshot?.data_base64);
    await writeFile(join(evidenceRoot, 'local-source-inspection.png'), Buffer.from(screenshot.data_base64, 'base64'), { mode: 0o600 });
    const dom = await computerTools.computer({ actions: [{ action: 'read_dom' }] });
    assert.ok(JSON.stringify(dom).includes('Opulent2 local source inspection'));
    record.computer = { ok: opening.ok, callId: opening.call_id, observedDocument: 'http://127.0.0.1:8765/inspection.html',
      sourceId: source.id, actions: opening.results.map(({ index, type, ok }) => ({ index, type, ok })),
      screenshot: { path: 'local-source-inspection.png', width: screenshot.width, height: screenshot.height, sha256: sha256(Buffer.from(screenshot.data_base64, 'base64')) },
      localDocumentDomObserved: true };
    const resumed = await probeOpulent2Machine(sandbox, config, { bootstrap: false });
    assert.equal(resumed.readiness.agrep.executableSha256, readiness.agrep.executableSha256);
    record.existingDaemonReady = true;
    await persist();
  } catch (error) {
    record.error = { name: error.name, code: error.code ?? null, stage: error.stage ?? null, message: error.message, cause: error.cause?.message ?? null };
    throw error;
  } finally {
    let cleanupFailure;
    if (owned) {
      record.cleanup.attempted = true;
      try {
        const killed = await owned.kill();
        record.cleanup = { attempted: true, authenticated: true, terminated: killed === true, alreadyGone: killed === false };
        assert.ok(killed === true || killed === false);
        let absent = false;
        try { await Sandbox.getInfo(owned.sandboxId, { apiKey: process.env.E2B_API_KEY }); }
        catch (error) { if (error.name === 'SandboxNotFoundError') absent = true; else throw error; }
        assert.equal(absent, true, 'Authenticated provider query must confirm the owned sandbox is gone');
        record.cleanup.authenticatedQueryAbsent = true;
      } catch (error) { record.cleanup = { ...record.cleanup, attempted: true, authenticated: true, failed: true, name: error.name }; cleanupFailure = error; }
    }
    await persist();
    if (cleanupFailure) throw cleanupFailure;
  }
});

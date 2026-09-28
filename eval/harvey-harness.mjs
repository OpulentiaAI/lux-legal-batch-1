import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { captureVisibleSources } from './comparison-corpus.mjs'
import { redact } from '../runtime/security.mjs'
import { LUNA_MODEL, validateEvalModel } from '../runtime/eval-model-profile.mjs'

const HARVEY_COMMIT = '845a08840869b21a5c11958aae58bf5f00a7b775'
const MODEL = LUNA_MODEL
const GATEWAY = 'https://ai-gateway.vercel.sh/v1'
const HARVEY_IMAGE = 'ghcr.io/harveyai/lab-sandbox@sha256:96f6d1e51bc01de6f51e24539b7191c6a59c6b498f4646cec334d95f0717d6c2'
const E2B_TEMPLATE = 'gfkhlvaqlbbjrjm04d6d'
const TOOLS = Object.freeze(['bash', 'read', 'write', 'edit', 'glob', 'grep'])
const PUBLIC_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:md|csv|txt)$/

function validateWorkProduct(input) {
  const { task, materials } = input ?? {}
  if (!task || Object.keys(task).sort().join(',') !== 'deliverables,id,instructions,materials,scope,title' ||
      !['id', 'title', 'instructions'].every(key => typeof task[key] === 'string' && task[key].trim()) ||
      !task.scope || Object.keys(task.scope).sort().join(',') !== 'asOf,companyForm,jurisdiction' ||
      !Object.values(task.scope).every(value => typeof value === 'string' && value.trim()) ||
      !Array.isArray(task.deliverables) || !task.deliverables.length || !Array.isArray(task.materials) || !Array.isArray(materials) ||
      task.deliverables.some(name => typeof name !== 'string' || !PUBLIC_FILE.test(name)) ||
      task.materials.some(path => typeof path !== 'string' || !path.startsWith('materials/') || !PUBLIC_FILE.test(path.slice(10))) ||
      materials.some(row => !row || Object.keys(row).sort().join(',') !== 'content,path' || typeof row.content !== 'string' || typeof row.path !== 'string') ||
      new Set(task.deliverables.map(name => name.toLowerCase())).size !== task.deliverables.length ||
      new Set(task.materials.map(name => name.toLowerCase())).size !== task.materials.length ||
      new Set(materials.map(row => row.path)).size !== materials.length ||
      materials.length !== task.materials.length || materials.some(row => !task.materials.includes(row.path))) throw new Error('Invalid public work-product task or materials')
  return { task, materials }
}

function hash(text) { return createHash('sha256').update(text).digest('hex') }

function trajectoryAudit(artifacts) {
  const path = join(artifacts, 'trajectory.jsonl')
  if (!existsSync(path)) return {}
  if (!lstatSync(artifacts).isDirectory() || !lstatSync(path).isFile() ||
      realpathSync(path) !== path || realpathSync(artifacts) !== artifacts ||
      (lstatSync(path).mode & 0o077) !== 0) throw new Error('Unsafe Harvey trajectory artifact')
  return { trajectoryArtifact: path, trajectorySha256: hash(readFileSync(path)) }
}

function recordBridgeFailure(artifacts, reason, exitCode) {
  mkdirSync(artifacts, { recursive: true, mode: 0o700 })
  const path = join(artifacts, 'trajectory.jsonl')
  if (existsSync(path)) trajectoryAudit(artifacts)
  if (realpathSync(artifacts) !== artifacts) throw new Error('Unsafe Harvey trajectory directory')
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
  try {
    writeFileSync(fd, JSON.stringify({ at: new Date().toISOString(), event: 'bridge_failure', reason, exitCode }) + '\n')
    fsyncSync(fd)
  } finally { closeSync(fd) }
}

function isWithin(path, root) {
  const rel = relative(root, path)
  return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`))
}

function resolvedArtifactDirectory(path) {
  if (existsSync(path)) return realpathSync(path)
  return resolve(resolvedArtifactDirectory(dirname(path)), path.slice(dirname(path).length + 1))
}

function validateCorpus(corpus) {
  const directory = realpathSync(corpus.directory)
  if (readdirSync(directory).sort().join(',') !== 'README.txt,chunks,documents.json,index.json' ||
      !lstatSync(join(directory, 'chunks')).isDirectory()) throw new Error('Unexpected comparison corpus files')
  for (const name of ['README.txt', 'index.json', 'documents.json']) {
    if (!lstatSync(join(directory, name)).isFile()) throw new Error('Comparison corpus metadata must be ordinary files')
  }
  const rows = JSON.parse(readFileSync(join(directory, 'index.json'), 'utf8'))
  const documents = JSON.parse(readFileSync(join(directory, 'documents.json'), 'utf8'))
  if (!Array.isArray(rows) || rows.length !== corpus.sources.length || !Array.isArray(documents) ||
      documents.some(doc => !doc || Object.keys(doc).some(key => !['id', 'title', 'kind', 'authors', 'year', 'chunk_count'].includes(key)))) throw new Error('Invalid comparison corpus index')
  if (readdirSync(join(directory, 'chunks')).length !== rows.length) throw new Error('Unexpected comparison corpus chunks')
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i], source = corpus.sources[i]
    if (!source || row.id !== source.id || row.doc !== source.doc || row.path !== source.path ||
        row.sha256 !== hash(source.text) || !/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_:-]+$/.test(row.id) ||
        row.path !== `chunks/${row.id}.txt` || Object.keys(row).sort().join(',') !== 'doc,id,path,sha256') throw new Error('Invalid comparison corpus source')
    const path = join(directory, row.path)
    if (!lstatSync(path).isFile() || readFileSync(path, 'utf8') !== `[${row.id}]\n${source.text}\n`) throw new Error('Comparison corpus source differs')
  }
  if (hash(JSON.stringify({ version: 'comparison-corpus-v1', index: rows, documents })) !== corpus.hash) throw new Error('Comparison corpus hash differs')
}

function invoke(python, script, request, env, cwd, args = []) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(python, [script, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    const stderrHash = createHash('sha256')
    let stderrBytes = 0
    let stderrPrefix = ''
    let settled = false
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => {
      stderrHash.update(chunk)
      stderrBytes += chunk.length
      if (stderrPrefix.length < 8192) stderrPrefix += chunk.toString('utf8').slice(0, 8192 - stderrPrefix.length)
    })
    const fail = (reason, message, code = null) => {
      if (settled) return
      settled = true
      const text = stderrPrefix
      const classes = [...new Set([...text.matchAll(/(?:^|\n)(?:[A-Za-z][A-Za-z0-9_.]*\.)?(RuntimeError|ValueError|TypeError|KeyError|ImportError|ModuleNotFoundError|TimeoutError|ConnectionError|PermissionError|FileNotFoundError|JSONDecodeError|AuthenticationError|RateLimitError):/g)].map(match => match[1]))].slice(0, 8)
      const statuses = [...new Set([...text.matchAll(/\b(?:HTTP(?:Error| status)?\s*[:=]?\s*|status(?: code)?\s*[:=]\s*)([1-5][0-9]{2})\b/gi)].map(match => Number(match[1])))].slice(0, 8)
      const diagnostic = redact({ version: 1, reason, exitCode: code, stderrBytes,
        stderrSha256: stderrHash.digest('hex'), stderr: classes.map(name => `${name}: [redacted]`), httpStatuses: statuses,
        stdoutBytes: Buffer.byteLength(stdout), stdoutSha256: hash(stdout) },
      [env.AI_GATEWAY_API_KEY, env.E2B_API_KEY, env.OPENAI_API_KEY])
      try {
        recordBridgeFailure(request.artifacts, reason, code)
        writeFileSync(join(request.artifacts, 'bridge-failure.json'), JSON.stringify(diagnostic) + '\n', { mode: 0o600, flag: 'wx' })
      } catch {}
      reject(new Error(message))
    }
    child.on('error', () => fail('spawn', 'Harvey bridge process failed'))
    child.on('close', code => {
      if (settled) return
      if (code !== 0) return fail('nonzero_exit', `Harvey bridge exited ${code}; inspect local artifacts`, code)
      try { const result = JSON.parse(stdout); settled = true; resolveResult(result) } catch { fail('invalid_json', 'Invalid Harvey bridge result', code) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}

function collectEvidence(artifacts, corpus, answer, start, response, workProduct = false) {
  const calls = existsSync(join(artifacts, 'tool-results.jsonl'))
    ? readFileSync(join(artifacts, 'tool-results.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []
  const visible = new Map()
  const auditCalls = calls.map(({ tool, arguments: args, result }) => {
    const sources = captureVisibleSources(result, corpus.sources)
    for (const source of sources) visible.set(source.id, source)
    return { tool, arguments_sha256: hash(typeof args === 'string' ? args : JSON.stringify(args)),
      result: { ids: sources.map(source => source.id), count: sources.length,
        error: /^(?:Error:|SecurityError:)/.test(result) || /\(exit code \d+\)$/.test(result) } }
  })
  return { ...(typeof answer === 'string' ? { answer } : {}), sources: [...visible.values()],
    trace: auditCalls.map(call => ({ stage: 'tool', tool: call.tool, ok: !call.result.error })),
    metrics: { errors: auditCalls.filter(call => call.result.error).length + Number(!response?.finished_cleanly || (!workProduct && !answer?.trim())),
      toolCalls: calls.length, sourceCount: visible.size, turns: response?.turn_count ?? 0,
      usage: { input_tokens: response?.input_tokens ?? 0, output_tokens: response?.output_tokens ?? 0 },
      ...(workProduct ? { providerUsageRecords: response?.provider_usage_records ?? null } : {}),
      latencyMs: Math.round(performance.now() - start) },
    audit: { calls: auditCalls, finalAnswer: typeof answer === 'string' ? redact(answer) : null,
      ...trajectoryAudit(artifacts) } }
}

export function createHarveyHarness({ workspace, harveyRoot, python, corpus, artifactsDir, maxSteps, model = MODEL, providerOnly = null, workProduct } = {}) {
  validateEvalModel(model, providerOnly)
  if (workProduct !== undefined) {
    if (!workProduct || typeof workProduct !== 'object' || Array.isArray(workProduct) || Object.keys(workProduct).some(key => key !== 'maxCompletionTokens') ||
        !Number.isSafeInteger(workProduct.maxCompletionTokens ?? 8000) || (workProduct.maxCompletionTokens ?? 8000) < 1) throw new Error('Invalid work-product completion budget')
    workProduct = { maxCompletionTokens: workProduct.maxCompletionTokens ?? 8000 }
  }
  maxSteps ??= workProduct ? 80 : 40
  if (!corpus?.sources?.length || !corpus.directory || !corpus.hash) throw new Error('Prepared comparison corpus required')
  if (workProduct ? !Number.isSafeInteger(maxSteps) || maxSteps < 1 : maxSteps !== 40) throw new Error('Harvey comparison requires exactly 40 steps in QA mode')
  harveyRoot = realpathSync(harveyRoot)
  workspace = realpathSync(workspace)
  artifactsDir = resolve(artifactsDir)
  const artifactTarget = resolvedArtifactDirectory(artifactsDir)
  if (isWithin(artifactTarget, workspace) || isWithin(artifactTarget, harveyRoot) ||
      isWithin(artifactTarget, realpathSync(corpus.directory))) throw new Error('Harvey artifacts must be outside source repositories')
  validateCorpus(corpus)
  const script = resolve(workspace, 'eval/harvey-bridge.py')
  let prompt = readFileSync(join(harveyRoot, 'harness/system_prompt.md'), 'utf8')
  const skillsDir = join(harveyRoot, 'harness/skills')
  const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter(name => existsSync(join(skillsDir, name, 'SKILL.md'))).sort() : []
  prompt += skills.map(name => `\n\n## Skill: ${name}\n\n${readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8')}`).join('\n')
  const provenance = Object.freeze({
    harvey_commit: HARVEY_COMMIT, model, providerOnly, endpoint: GATEWAY,
    adapter: providerOnly ? 'eval.harvey-modal-adapter.ModalDeepSeekAdapter' : 'harness.adapters.openai.OpenAIAdapter',
    agent_loop: 'harness.agent_loop.run_agent', executor: 'harness.tools.ToolExecutor', sandbox: 'E2B pinned Harvey image (remote upstream ToolExecutor)',
    harvey_base_image: HARVEY_IMAGE, e2b_template_id: E2B_TEMPLATE,
    e2b_sdk: '2.34.0', e2b_internet_access: false,
    skills, tools: TOOLS, corpus_sha256: corpus.hash,
    max_steps: maxSteps, max_completion_tokens: workProduct?.maxCompletionTokens ?? 4000,
    system_prompt_sha256: hash(prompt), evidence_policy: 'full-model-visible-tool-result-v1',
    ...(workProduct ? { work_product: { version: 'complex-v1', materialPath: '/workspace/task/materials', outputPath: '/workspace/output', evidencePolicy: 'full-model-visible-tool-results-and-collected-deliverables-v1' } } : {}),
    ...(workProduct ? { sandbox_timeout_seconds: 3600 } : {}),
  })

  return {
    provenance,
    async run({ question, mode, workProduct: packet }) {
      if (mode !== 'harvey' || typeof question !== 'string' || !question.trim()) throw new Error('Harvey mode and question required')
      if (workProduct ? !packet : packet !== undefined) throw new Error('Work-product run mode mismatch')
      if (workProduct) validateWorkProduct(packet)
      if (!process.env.AI_GATEWAY_API_KEY || !process.env.E2B_API_KEY) throw new Error('AI_GATEWAY_API_KEY and E2B_API_KEY required; no model substitution')
      const artifacts = resolve(artifactsDir, randomUUID())
      mkdirSync(dirname(artifacts), { recursive: true })
      const request = { harvey_root: harveyRoot, documents: corpus.directory, corpus_hash: corpus.hash,
        artifacts, question, max_steps: maxSteps, model, provider_only: providerOnly,
        ...(workProduct ? { work_product: packet, max_completion_tokens: workProduct.maxCompletionTokens } : {}) }
      const start = performance.now()
      const env = { ...process.env, OPENAI_BASE_URL: GATEWAY, OPENAI_API_KEY: process.env.AI_GATEWAY_API_KEY }
      let response
      try {
        response = await invoke(python, script, request, env, harveyRoot)
      } catch (error) {
        Object.assign(error, collectEvidence(artifacts, corpus, null, start, null, !!workProduct))
        if (workProduct) error.artifactPaths = ['tool-results.jsonl', 'bridge-failure.json'].map(file => join(artifacts, file)).filter(existsSync)
        throw error
      }
      if (response.prompt_sha256 !== provenance.system_prompt_sha256 || JSON.stringify(response.tool_names) !== JSON.stringify(TOOLS) ||
          response.template_id !== E2B_TEMPLATE || response.harvey_base_image !== HARVEY_IMAGE) {
        const error = new Error('Harvey upstream policy changed')
        error.audit = trajectoryAudit(artifacts)
        throw error
      }
      const output = collectEvidence(artifacts, corpus, response.answer, start, response, !!workProduct)
      if (workProduct) {
        if (!Array.isArray(response.deliverables) || !Array.isArray(response.missingDeliverables) ||
            response.deliverables.some(row => !packet.task.deliverables.includes(row.file) || typeof row.content !== 'string' || row.sha256 !== hash(row.content)) ||
            response.deliverables.length + response.missingDeliverables.length !== packet.task.deliverables.length ||
            new Set([...response.deliverables.map(row => row.file), ...response.missingDeliverables]).size !== packet.task.deliverables.length ||
            [...response.deliverables.map(row => row.file), ...response.missingDeliverables].some(file => !packet.task.deliverables.includes(file))) throw new Error('Invalid Harvey deliverable collection')
        Object.assign(output, { deliverables: response.deliverables, missingDeliverables: response.missingDeliverables,
          artifactPaths: [join(artifacts, 'tool-results.jsonl'), join(artifacts, 'bridge-result.json')],
          agentStatus: { finishedCleanly: response.finished_cleanly, turnCount: response.turn_count,
            wallClockSeconds: response.wall_clock_seconds ?? null },
          workProductProvenance: { taskSha256: hash(JSON.stringify(packet.task)),
            materialHashes: Object.fromEntries(packet.materials.map(row => [row.path, hash(row.content)])),
            deliverables: [...packet.task.deliverables] } })
      }
      if (workProduct && output.missingDeliverables.length) {
        output.metrics.errors = Math.max(output.metrics.errors, 1)
        const error = new Error(`Harvey missing deliverables: ${output.missingDeliverables.join(', ')}`)
        Object.assign(error, output)
        throw error
      }
      if (!response.finished_cleanly || (!workProduct && !response.answer?.trim())) {
        const error = new Error('Harvey agent did not finish cleanly')
        Object.assign(error, output)
        throw error
      }
      return output
    },
  }
}

export async function smokeHarveyTools({ harveyRoot, python, corpus, artifactsDir }) {
  if (!process.env.E2B_API_KEY) throw new Error('E2B_API_KEY required for remote six-tool smoke')
  validateCorpus(corpus)
  const workspace = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
  if (isWithin(resolve(artifactsDir), workspace) || isWithin(resolve(artifactsDir), realpathSync(harveyRoot))) throw new Error('Harvey artifacts must be outside source repositories')
  const artifacts = resolve(artifactsDir, randomUUID())
  mkdirSync(dirname(artifacts), { recursive: true })
  const sample = corpus.sources[0]
  const request = { harvey_root: realpathSync(harveyRoot), documents: corpus.directory, corpus_hash: corpus.hash, artifacts,
    sample: { id: sample.id, path: sample.path } }
  return invoke(python, fileURLToPath(new URL('harvey-bridge.py', import.meta.url)), request, process.env, harveyRoot, ['--smoke'])
}

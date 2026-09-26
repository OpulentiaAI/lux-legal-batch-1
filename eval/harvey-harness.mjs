import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { captureVisibleSources } from './comparison-corpus.mjs'
import { redact } from '../runtime/security.mjs'

const HARVEY_COMMIT = '845a08840869b21a5c11958aae58bf5f00a7b775'
const MODEL = 'openai/gpt-6-luna'
const GATEWAY = 'https://ai-gateway.vercel.sh/v1'
const HARVEY_IMAGE = 'ghcr.io/harveyai/lab-sandbox@sha256:96f6d1e51bc01de6f51e24539b7191c6a59c6b498f4646cec334d95f0717d6c2'
const E2B_TEMPLATE = 'gfkhlvaqlbbjrjm04d6d'
const TOOLS = Object.freeze(['bash', 'read', 'write', 'edit', 'glob', 'grep'])

function hash(text) { return createHash('sha256').update(text).digest('hex') }

function isWithin(path, root) {
  const rel = relative(root, path)
  return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`))
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
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`Harvey bridge exited ${code}; inspect local artifacts (stderr sha256=${hash(stderr)})`))
      try { resolveResult(JSON.parse(stdout)) } catch { reject(new Error('Invalid Harvey bridge result')) }
    })
    child.stdin.end(JSON.stringify(request))
  })
}

function collectEvidence(artifacts, corpus, answer, start, response) {
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
    metrics: { errors: auditCalls.filter(call => call.result.error).length + Number(!response?.finished_cleanly || !answer?.trim()),
      toolCalls: calls.length, sourceCount: visible.size, turns: response?.turn_count ?? 0,
      usage: { input_tokens: response?.input_tokens ?? 0, output_tokens: response?.output_tokens ?? 0 },
      latencyMs: Math.round(performance.now() - start) },
    audit: { calls: auditCalls, finalAnswer: typeof answer === 'string' ? redact(answer) : null } }
}

export function createHarveyHarness({ workspace, harveyRoot, python, corpus, artifactsDir, maxSteps = 40 }) {
  if (!corpus?.sources?.length || !corpus.directory || !corpus.hash) throw new Error('Prepared comparison corpus required')
  if (maxSteps !== 40) throw new Error('Harvey comparison requires exactly 40 steps')
  harveyRoot = realpathSync(harveyRoot)
  workspace = realpathSync(workspace)
  artifactsDir = resolve(artifactsDir)
  if (isWithin(artifactsDir, workspace) || isWithin(artifactsDir, harveyRoot)) throw new Error('Harvey artifacts must be outside source repositories')
  validateCorpus(corpus)
  const script = resolve(workspace, 'eval/harvey-bridge.py')
  let prompt = readFileSync(join(harveyRoot, 'harness/system_prompt.md'), 'utf8')
  const skillsDir = join(harveyRoot, 'harness/skills')
  const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter(name => existsSync(join(skillsDir, name, 'SKILL.md'))).sort() : []
  prompt += skills.map(name => `\n\n## Skill: ${name}\n\n${readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8')}`).join('\n')
  const provenance = Object.freeze({
    harvey_commit: HARVEY_COMMIT, model: MODEL, endpoint: GATEWAY, adapter: 'harness.adapters.openai.OpenAIAdapter',
    agent_loop: 'harness.agent_loop.run_agent', executor: 'harness.tools.ToolExecutor', sandbox: 'E2B pinned Harvey image (remote upstream ToolExecutor)',
    harvey_base_image: HARVEY_IMAGE, e2b_template_id: E2B_TEMPLATE,
    e2b_sdk: '2.34.0', e2b_internet_access: false,
    skills, tools: TOOLS, corpus_sha256: corpus.hash,
    max_steps: maxSteps, max_completion_tokens: 4000,
    system_prompt_sha256: hash(prompt), evidence_policy: 'full-model-visible-tool-result-v1',
  })

  return {
    provenance,
    async run({ question, mode }) {
      if (mode !== 'harvey' || typeof question !== 'string' || !question.trim()) throw new Error('Harvey mode and question required')
      if (!process.env.AI_GATEWAY_API_KEY || !process.env.E2B_API_KEY) throw new Error('AI_GATEWAY_API_KEY and E2B_API_KEY required; no model substitution')
      const artifacts = resolve(artifactsDir, randomUUID())
      mkdirSync(dirname(artifacts), { recursive: true })
      const request = { harvey_root: harveyRoot, documents: corpus.directory, corpus_hash: corpus.hash,
        artifacts, question, max_steps: maxSteps }
      const start = performance.now()
      const env = { ...process.env, OPENAI_BASE_URL: GATEWAY, OPENAI_API_KEY: process.env.AI_GATEWAY_API_KEY }
      let response
      try {
        response = await invoke(python, script, request, env, harveyRoot)
      } catch (error) {
        Object.assign(error, collectEvidence(artifacts, corpus, null, start))
        throw error
      }
      if (response.prompt_sha256 !== provenance.system_prompt_sha256 || JSON.stringify(response.tool_names) !== JSON.stringify(TOOLS) ||
          response.template_id !== E2B_TEMPLATE || response.harvey_base_image !== HARVEY_IMAGE) throw new Error('Harvey upstream policy changed')
      const output = collectEvidence(artifacts, corpus, response.answer, start, response)
      if (!response.finished_cleanly || !response.answer?.trim()) {
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

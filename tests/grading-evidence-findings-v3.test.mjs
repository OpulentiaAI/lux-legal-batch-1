import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { loadChunks, chunkText } from '../src/tp/manifest.ts'
import { evidenceV4, PARENT_VISIBLE_EVIDENCE_VERSION, PARENT_VISIBLE_FINDINGS_EVIDENCE_VERSION } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const id = 'doc-01:a:c0', doc = 'doc-01'
const text = 'First rule.\nSecond rule.\nThird rule.\nRepeated rule. Repeated rule.\n🙂 café “exact”.\nThe State’s law governs.'
const finding = { source_id: id, quote: 'Second rule.', analysis: 'A child interpretation, not corpus evidence.' }
const v3 = PARENT_VISIBLE_FINDINGS_EVIDENCE_VERSION
const pythonString = value => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`

function fixture(t, sources = [{ id, doc, text }]) {
  const root = mkdtempSync(join(tmpdir(), 'grading-findings-v3-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'project'), artifacts = join(root, 'artifacts')
  for (const path of ['corpus/index', 'corpus/chunks']) mkdirSync(join(workspace, path), { recursive: true })
  for (const mode of ['broad', 'harvey']) mkdirSync(join(artifacts, mode), { recursive: true })
  const manifest = sources.map((source, index) => {
    const path = `corpus/chunks/${index}.txt`
    writeFileSync(join(workspace, path), source.text)
    return { chunk_id: source.id, doc_id: source.doc, path }
  })
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), manifest.map(item => JSON.stringify(item)).join('\n'))
  const artifact = join(artifacts, 'broad/abcdef.json')
  const options = { workspace, artifacts }
  function save(specs, { version = PARENT_VISIBLE_EVIDENCE_VERSION, policy = 'broad-legal-native-v8', extra = {}, inventory = [] } = {}) {
    const provenance = { policy, ...(version === null ? {} : { evidenceReplayVersion: version }) }
    const calls = specs.map(({ output, args = {}, tool = 'ipython', error = false }, index) => {
      const serialized = typeof output === 'string' ? output : JSON.stringify(output)
      return { tool, toolCallId: `call-${index}`, args, rawArguments: JSON.stringify(args), output: serialized,
        result: { error, sha256: hash(serialized) } }
    })
    const captured = { provenance, calls, ...extra }
    const row = { mode: 'broad', answer: 'Saved output.', sources: inventory, trace: [], metrics: {},
      audit: { provenance, finalAnswerHash: hash('Saved output.'), evidenceArtifact: artifact,
        calls: calls.map(call => ({ tool: call.tool, toolCallId: call.toolCallId,
          argsHash: hash(call.rawArguments), result: { ...call.result } })) } }
    const rewrite = () => writeFileSync(artifact, JSON.stringify(captured))
    rewrite()
    return { row, captured, rewrite, artifact, options,
      replay: (override = v3) => evidenceV4({ ...options, ...(override === null ? {} : { replayVersionOverride: override }) }).replay(row) }
  }
  const stdout = (value, changes = {}) => ({ ok: true, stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: '', result: null, ...changes })
  return { save, stdout, artifact, options }
}

test('v3 is an explicit compatible override and never rewrites original v2 artifacts or proofs', t => {
  const { save, stdout } = fixture(t)
  const run = save([{ output: stdout({ findings: [finding] }) }], { policy: 'broad-legal-native-delivery-v9' })
  const before = readFileSync(run.artifact)
  const original = run.replay(null)
  const corrected = run.replay()
  assert.deepEqual(original.sources, [])
  assert.equal(original.quoteAudit, undefined)
  assert.equal(original.proof.evidenceReplayVersion, PARENT_VISIBLE_EVIDENCE_VERSION)
  assert.equal(corrected.proof.evidenceReplayVersion, v3)
  assert.equal(corrected.proof.recordedEvidenceReplayVersion, PARENT_VISIBLE_EVIDENCE_VERSION)
  assert.equal(corrected.proof.replayOverride, true)
  assert.equal(corrected.proof.originalArtifactSha256, hash(before))
  assert.equal(corrected.proof.quoteAuditSha256, hash(JSON.stringify(corrected.quoteAudit)))
  assert.equal(corrected.proof.visibleSourceInventorySha256, hash(JSON.stringify(corrected.sources)))
  assert.equal(corrected.proof.replayImplementationSha256, hash(readFileSync(new URL('../eval/grading-evidence.mjs', import.meta.url))))
  assert.deepEqual(readFileSync(run.artifact), before)
  assert.deepEqual(run.replay(null), original)
  assert.throws(() => run.replay('unrecognized-override'), /replay override/)
  assert.throws(save([], { version: null }).replay, /incompatible replay override/)
  assert.throws(save([], { version: v3 }).replay, /replay version/)
})

test('unchanged real task05 parent receipt preserves both confirmed spans, receipt escapes and bound hashes', t => {
  const receiptBytes = gunzipSync(Buffer.from([
    'H4sIAAAAAAACA+1czY8bR3a/+68ozCEktSRFcobzQcEIHK13Y0TeGCs5OYjCuNhdJMtqdrWqujlDCwZ0zTm5BEiAnLLW5pJDLkFy0vwn+kvye6+qm2ySI3K8',
    'ySW7hi2R3fXxvt/vvSr67WdCnOTGJE9lknwVn4zESYRP17GcDuKLyXQqh/LsdNiTw7PpuZRnJ+1yAg3V2Sqfm9Q/lHbm8PAtPuNbZGJFQ2xffC7kjdS5sMmi',
    'a5UrkrwZzXUSX+vYvRyf8OeOyxKdd2KZK9exKrer8cmr1ji1g+OmT1Qy0zLtOJtsTvcD/axP74VtbP++CftWpwmDcTo1VqSLtrBCp6LZ/MQWGNNvtUXzE4ti',
    'yKDVGo1TEmFmdZo3ee3uTOWY53KZF2580lo/UtYaiyctP0dPqzemyLMix6tRWMm+XD989XJ01ev1XrU2txqffD4+eXTZa51AhT+yTq28+cLOioVKc9Ltydsx',
    'K3aMz+PDqh3fL40x6+cI/Y7vF1e5xpbODuzqFX3/rP37eG3vqvvTm1Uq//Tqpdrv0fu40vx4U/fjUvtj1v+2AYwrbY/rRlB7sTaEmiWMyRbG3hrGJz96B/ez',
    'ghm4PDZkSaN7BSAis8gSlatY/MakCht8kSTiTWHAizapE9IqsVRWTzWGyJnUqctFPlcimhfpazExsVZONOlJfmOEzDLMSHMxlTopoDhxo7CCFKlJOxOr5Gud',
    'zoTLZISH01xZQRycn5936W8hU2wiHBZQKUZMTJHGElROEe5oovR7KwwzU/EyNlGnNxi5Xu/0dBT1IaEu2BBOz1KowqqOsTG2sEWCObfa5eAnXd3MiSSYhp/e',
    'FX/J3x0vzVuCVZCupI3mwhsfyEvx73ffffe9M/TpLeuCiJ7qNAZtrPiReBl09Db87ce8KZQjefox9OffzsFLbCAgT4VwciUkdvcckopErEjVDh8aajpVOfEs',
    'RWSNc52JZ81F2jks3GbR3cwNJkGqC50q93iqb7G+zv+c7bdG0ALrWy2T60zm8zVV5WP3+Psi1cZ2Fmphuot4d4Eo0dDSNVmKWs//+O6fXoD6OURtrEaSqlHr',
    'zU8sTGpmVmZz4QlUsK+V4HcNfAOnUa6XQQaTFbjS0ZwGiYlK1VRHmkyClOywgnV59+O7fxZPNRmxSZPVqFTsLtXOFDZSCFprkrdsaLg7aYvHD/8mnsltBX18',
    '949eRXiUyEotMGWLsXfvvU7u3mOCtALmGFujabQTzkQaA+7eOzG5e48xzKGG3bUFnks4E/tDXMAv4Xcqz4NsUqwGhrCDSkVOpkPjmYZIFiDr7vc5OV+Kxa1W',
    'cAhx9y9EniceNMuI/R/EKkofNJPWAVUJKeZWz8gPIWZjFyqhZ3DwBIqd0GcstjF6gw9Na74pwC7MW0JNCfYyGajgqCI+/NeO7w5fieZcSfIkMnPyAScXIcyM',
    'BIT+ZVc8guDz+d172JYKko5MGsG4JIWL5qO/Mulr/vZDouZWPWo9wl5P/GplUAmOHmJI+uHfxeCq1waLJk+haNHvXVyKSOdEyYt5V3xj7/4bcd5kXXrabQt8',
    'uLxs7bEumcpk5bRb28oLeEK5YSadkzPFn713kS3ADax0KvYODJNAHCBZLlQ+JwpANUwhWYlYw758aLVmwauwc4pvUwoE9H2Le9Fk0hu8vbErZCVmvO5goK4K',
    'GTG5m4Q2Z/Bct3K5WoiP7/5BNI402IZPBGRTiLNQz02pS6sinVHECC+RNFq8NETOm6arELZBaFd8lRNdrN0pzC3vmGkHqzl6kBL1kMxURhjcFjc6n2NoGbpo',
    'nJgmxtjROpJGMoW3UAjJQImKVZn3yBopqiLpkY2DbaveFOCF0dSGtcPSeVRFPhLI0iRLFVPK8bpCSllnRlqAM2jJFs2BzukrGzlFRG+apfy9c4BxEsh6ZzDU',
    'Fq6YfA/GiYycUgeDDRKW53WPNSZ6oUMW3zTIXTPBhhQ28YciWTjIKd2VPNsQ8eAKu1Qr2ErTKbXtx4NXI9FwKssrP3ViQdEn5/CCMOBjkrrNjKP40IBVZpRs',
    'UwrfktNhDnzDkb9yvyfkGaCTrKU2OlG3kE8uxcRnYTDBIn3+xW+fdZ6Lx+IvPJYTz3/7DN8Q6Wji8y8gc5l0BYmjSkdwFHOD4PS7wWWfvfHD7wBMOufnF8LN',
    'zQ2vS8YFOorUIQwnUD4JNYj9x/aRuf+XG2m/wiOkUOV1u99LKVnGR+XDP4Z8/3Ny++lRuZ1s9H0GC6QMWiovZJtPZf16isOTNTZzeKcT/ksu734in1vA/p0m',
    '98ZIkosll8stglpBmZbTcUSfOpEOSZT2Nd8rjqGLgtbdiy4KOI+9+2mG8dAvp/6E5969X5oV4Yk3BVEOJyd/84J3e9mCXnUa5QRFNMW+dAkriGlTHrzUyd37',
    'mQbtpWzwd5YUgAbvEwOFEUkl7UgmmduX+k+R+snphlUkkGVcfqYQ7u0PVQqrpenh1XFJ+Gki9UIMyYc0gQVkgLzNoWShOLUa2NrEGolQ/iuyL+RiMS2SpJOr',
    'W0RaSh4hR/RFb3hRui7HecZGOxXHDf6iaNRs0BsCG8TaApJqtEWDP7IZVPOqx6pcjBIqPV1/28q265dcZ1Fm3k7HGFF/tLU2qLTK5/RqoUYLKRCfoLQflDXw',
    'beRBn6lFg91vnagbtdIqpL/K3bviuYLJxB52cIrh4aTjxcTXcyLXyteFQmLibMPlOcd66GQyeAtSSIkmKEo13EgUDH12jcRH1GDWCC12ptqc3oLN/jTDi8ax',
    'NhtQTULL5Tyl5dEaJ0qO2JytVcijeloDHoxwVAjflY/DmlalxOBQU0R9OLEji/k/CRaNFmU7baENn+A4e6dk4KGAbVFShm4cCGMQypzhAVAO6ariCSG6Bukg',
    '+JAWGwRSobySIsJKOdHdKFFabnKClpwXJspXKTlrixoNC1TaGrCsbgWwI1OpnWCXsrC2pmzRtp0JoectCLXEHHY861+3RXPSCgrk7gePYGPuVJbvddqMWptK',
    'ImkTzvCGT8Kw+UOwlm+dRBWykxD5THK6C/0FCj4eNhqbFYRwsxXZeS3IMP4B8cCD2s2VW+OEdXIlqqk9Q466rwPSFhNUiMEg1W2UFPEG3ggVyQ14raoS76HU',
    'uQm0+RTr3SF8TszMW0sD25YlDnigdpFOc684CtiIN84EuAsvrCRSsKwVId3Wz0JTBzopW/gCkq03UMgUHamYQwzGPZ5LC6lqMiuy6ybecQDCd/BT4tPWn7oq',
    'RyGvM67uL4+BXk/Z70LxJWQhGF048tsCEKO4RdrAVjNlYDeo0qgBQhNyLq4pfKFiwbeylYHAfix+wyeCTVXfBsumDoU2XCrxqVrtUkR9YsWESOp35hR0o7lB',
    'xECNhFCaSk8HIS8sDFFTAyc5unm0SwQBPqrC720o+QAIC9moH2Vx+4maXbz8+O5fX9EKNd7wH6FZJLht3vz4uASUus4VN5jecFYqeemIe7ghyhG1oCCUskFJ',
    'qSmWvtO0QTLJMmbOvZwOiiHg8bu/o3YYvG1iy35RtSqRlmIF1RVPuaUWIDP3Bqj29auQqVHa534BT9wB2XG5a4W2g4yC3j3iPqD4JUA1+IiQfysP8KUyIk+9',
    'f0ezbjG0lJnzCevuPxKP4kmPEDHxWEfbwRUBt6nrhbp2DaedOB2cn3Xwx8VIPEV9LCnH9geji1PghSGnRny76tG3J/S2K/rnvRgYAHN/qW2ILl+bieatj+2P',
    '7dbf1JNEUmDIXWuClGRzSd7impwSaj63SnUSuaLujo58Kk9DM0PnG7mQscBINPutDYqfr80sUXLJjR1YFUgNgbUeOh3lgK9hUdjtOZXsKI3m3FcMQJM+Elz+',
    'onDIE5Il92tYKXW4AHaJIqxgFVwt97Vi2zcpioUI6bLqaZJhwIC4jRQqEHoH6hhKlp2o5o6OL161RRAW906/hTTkxHk6YT9liivbsa0nojlocSlTy47gKWyP',
    'jMENsrIyS9XNmgKP8IPuV2vhNlzVR/LQPzOa2mqBz43+IIuy/EK7cvkUGolb3a+dnD5RjFT4OInXVWz/KwQsFb3eJ5/LSj4XxPppax04QdSoUkiTXGHtBY/X',
    'PtC6n5c9vU4qSYCKxbMqhwEv3Z+8GrxOlbvIhEKpCkwP2WwCQG+kiFKRtJZQFwEfMpL9ZkQwO5evEdc3pXJ6NorOX/k2exqiWT3ftqmGtWopUwiVuwEUFQFn',
    'QCUHK84GRRno6gcgeAWFUL8P74kbjlQcHJmoNaV0wlBgkk63W83B8PlMQRaURoSP4xxLqbHQ8v28tYw/vvv7UpFT4KYScaI4fx3khG12pFCWj3V07YMkIn9O',
    'HkctASB+PePeXC4aVOAT+AVVCZ+r5Ix6Ub+AQo8T1L5XW6CGWjZ3v18AjuMRKITQIRjuH0SJpFKCdzge19RLwY2mVIODlO4i/XH5WavwKuC+WZmGWhzWbWYB',
    'HRN89J2UWlf7IQXSZvRf97Sh+8jqbH0ELZ2P5j5FNOlYGMC0JW4sH9Q8CScsfD6yKChfk+uLqLD8aMPv/CYoYhyqFOVrl0FvcN7pDTuDqxaUNSWJk7eFfvJG',
    '1uEI6WsYah//hhpRwPUGLlqlDYgrZdOnkrc6ZfaHET64WsUnOXDRBuMnnU4p+xtH25CdYKcGJT9UiGA/sUrG3CwIlft2A60Pz93oi50hnIXWhClm8xr9flEu',
    'hfl2xDcwaPHVV3tTSOclR8oWCRfKX6CsAuUJxWEVa58ISN0cfOHUSMhFEovQ76C6tkOU//yiTgYvpC6MsZSQWWURsrTM3UaRLCkkgFtLQZ9UJFmlm2onhf2c',
    'io08PoVJH1+tvaiq6QYfWFB+SsyNuCFDzOumQlSBPbng2pwkJ4Vf1ccyfo8sMqHzfLyDH/tCdIOzcNSBFOmQNSX1v2Tt2EMmvBvny/KCBdX4OSWUcCKysZ73',
    'oj+Vef/Pyrz9pcATsoh2eWrGJ+5lymR80yZI8Ids6y8cUBvYR4zQYwz3DKZexQTZOCdyl5vFHfhP9NJSmqR7D0i93EpjQXdg1rz/1oECp/Djao8QVcp4MuKW',
    'YogoIIsSnY39MSM8KaScDUjQxFh/665Ll4JGorFCbG2MRFokiT/d1vlGBzjTaep7SJL6gqx7WvMJdycpt6nbsvLwzTWXygxRNfc50O+P6YhtvQ7+QCqgG1uf',
    '/y//U967270Ht3tb7Ffh8lP1htmW9TtkfAUMvFFPFVMRxCDABdUSEbfBqwsNmy1QilTri2ckG8zmSlfPCkPNyEz6sggzkUQj7lT5s/cmVX8ceBA7FOlw8/pZ',
    'x18/m2OHJBzbewsakgX1+6Oo9+rJDj3UGfX1RLHo7NyI+w5yULdsB9+VEKJwKkDSap11h7YM0IgNC2q8cX27bVBMVT90HTu9K27EhcMHrFGaC+eTWTh4JDoD',
    '04baFHIptfeUiVrBDbly6Iq/UTamsswwstQLAYTy6FF1PvboESvSi6U8DlgfxOy7Drf3Jtzbo3q2Q1SfZM5cL1mfqSo/a201dGupbWISXZakkcyAMTez/B/U',
    'kz3Yj90gBJl+Hymo2shGp3yn0Hq9kOJ0ipF0uFD4SwtZwqCAQUv9cPtTeZfN9ewK5lofv0XtM4KWZXIsCZP+vpijm1ohkWq4hS0+/OcT7m0hwlsTEai2JRaH',
    'UpoVY2BhUSxaZUoEBxF3p+pz/bEa7N4sqFAUzX6336pTuxuYS6PLfbuFTKWo7jiVQqfCnF00EMTlYYZK7F7OGuw2+TZLgZNOJRkiXkZzMUNagDetAmZTnouo',
    'GhBuj8g84ss/MSB3YjKPafLNiDLsUUShlMIsxT6UIe5J5JyGbz6uSSI9MUwRW7LmghugiURdAQLuBfpber4TyHOQkgkpWr6tM51yC9LxXcGyFFe2LEb1Uvsq',
    'mipErNtGpmWwo9IZdV0Vq5Q1CXeEHugULENYl9TtcbJqQk4NZ8jCuoYXzV6P4CqycPVbPABDNzKjYSAjV75SX6gIIVo7OhRlLiLuqVD9R37jxC/q/vOL0s+A',
    'aaXvRLV8cerL1oVZYn/sUQ6LC6rlu3Vz3Fuo+nNsCtPV7SQfsNZBar0TdbTBuM/WbKaI009EPbYz7g7nxTtR3of3lG/97MkTfJBGh3yhkqWQbSbGBndRG9cK',
    'mTlfdB0bievBliWLuC7TiK4mbFyOq0rhjTD4xxV6h4NDoffbdFuAdEHXI9vvESxZnFRZ050/JYvIFJmvE1K+JAc/5gkcUwCafxC2iDVJn8F1VzylsQgL5NrY',
    'WzNQNtTmIefOc0lRGHEsgsmASVQ2W/QoulzMhQZQQqL8fLooW3QPhela98ZDBFmuDAHzRgRGyv5FsJ24hEfeK6mpXAVmJj1FrRwroscxKPb05KLJIYoRZAhb',
    'dB3I70e/KWBVObqoq7gVNUGBQGHRzZVCHZPfmA7hc/HNnz17PCnimcpFWJGcvU3NTbBNrSYgvCw8NFmoeCqshQIGlQiA3ZcMSKlk6njUOTUJ6vxOkXFU35Y0',
    '8gPrEYF9yRciPSYrHJX2jkd3ETi/RGVJHOa7mBTLPgsFLMVbRHK+lu1vX3OAdhm4kVGR+NoL5U3O/dJQO/LZGmzAF3O+zqKVCEmRFVFRWmRcn3FQL0pn6oqv',
    'JbWACbzqsl6DwBNNJkI/M1HW8s9M+Lv/yQS+UyGE7+Y1Pue2UPQZ0HkKMfmYQFMe54vsMV+/6nDjvkP9WYboj7s2WXTKGe5x72J6fjE4m3Ti/rnsnF0N486l',
    'urzonKMSHQziydVVb9rNb/NAFMLM9QIZZAresNPb8UmounhbWprHdJb9agL9cGvEDOgYyuLndK/mepOFEBQUNeJhYHgxRTCjN0uJuEZX4/HsJfZLYRy8YOk9',
    '174S4HXzVeZfGj7boDi9OWVi4lV9nMvtziBEsUTVhxGs5ycJMjjL+LQ+CRWpSan0egA11Y+9Du11ds+86/LXc5+c3ds3O/z866E7M2/XVdqtT6f0W59+tXf6',
    'zKqsPhOJgyPGjoT8BK4DD+11ednbv52/E3TchtybP2ghdH2vf4ies9M9kyaHZg22tFWl+xCxD2pscM98uuKV0jnAQQq2FkDW6A0O7Xpen+Q/HJBiqm6OGTM4',
    'ZtDp4UGLg0NMEh8zZnDMoMME8Y8IN8dQ9+cFf9kZeHg1RP5jxswPDrIPDAm2/9AJg4dOANK5Ln2Z08RxvmzVQWfp78x4qKWXP2m85rPMQ7413JmcPVgYXCce',
    '3mrLjS1y/aEp/dPL3UmDQ7O2ApY7aA/D7Qn2oTMGD57w4C304VAQIEu4dXIwDQ+2shPQ2E16zdn4OHt2NnqgseTSvT5sz682QNY1XxOila5omgUpVHKXcOzH',
    'CgPKiG5VMSh7S/jGKeuvn1bxn9HmNSoCOlXyoI9Qp5yVwchSzehRIh1B8tO/5oW4n01FbPkDpMSY10XmS3tU/XwVRnCrda6SjEpRvjoeDrE6s8SgUCl/vuQb',
    '/eFybtwVX9ERBd3QpiM87lVzPRQ4WKK+J5qYBYKc2zhtCz/tld5gr/DCr8n91PX/MIJ/y46vHvD6Z24uB8Nz+sX5WTScTAfnV1enFxeX0Wn/Kr6Mzs6VGp5f',
    'nZ2fxtNpP1a90/4FXqnh1aXCOJTd0VVfXkYXQ9nn/6XBZz9+9j/Z7cnV8EIAAA==',
  ].join(''), 'base64'))
  assert.equal(hash(receiptBytes), '39b07b73827f6b3235d8b13cfdd431faec678180f5fd51722bf023bf8337a93a')
  const call = JSON.parse(receiptBytes), printed = JSON.parse(call.output).stdout
  assert.equal(hash(call.output), '4c5bf26993778c319d8c46ee569463dff1de0317c31e598e937202c91a8c75a1')
  assert.equal(hash(printed), '9c95704ac0e1461c2690f82310b7e91f3897f2737907f449c96d938c9e26e793')
  const workspace = new URL('..', import.meta.url).pathname, manifest = loadChunks(workspace)
  const { artifact, options } = fixture(t)
  const provenance = { evidenceReplayVersion: PARENT_VISIBLE_EVIDENCE_VERSION }
  const captured = { provenance, calls: [call] }
  writeFileSync(artifact, JSON.stringify(captured))
  const before = readFileSync(artifact)
  const row = { mode: 'broad', answer: 'Unscored actual-receipt regression.', sources: [], trace: [], metrics: {},
    audit: { provenance, evidenceArtifact: artifact, finalAnswerHash: hash('Unscored actual-receipt regression.'),
      calls: [{ tool: call.tool, toolCallId: call.toolCallId, argsHash: hash(call.rawArguments), result: call.result }] } }
  const original = evidenceV4({ ...options, workspace }).replay(row)
  const corrected = evidenceV4({ ...options, workspace, replayVersionOverride: v3 }).replay(row)
  assert.deepEqual(original.sources, [])
  assert.equal(corrected.sources.length, 10)
  assert.equal(corrected.quoteAudit.length, 7)
  for (const source of corrected.sources) {
    const receipt = source.origin.receipt
    assert.equal(chunkText(workspace, manifest.get(source.id)).slice(source.origin.start, source.origin.end), source.text)
    assert.equal(printed.slice(receipt.fragmentRange.start, receipt.fragmentRange.end), source.text)
    let encoded = call.output.slice(receipt.fragmentOutputRange.start, receipt.fragmentOutputRange.end)
    for (const decoding of receipt.decodingPath) {
      assert.equal(decoding.encoding, 'json-string')
      encoded = JSON.parse('"' + encoded + '"')
    }
    assert.equal(encoded, source.text)
    assert.equal(source.origin.toolCallId, call.toolCallId)
    assert.equal(source.origin.stdoutSha256, hash(printed))
    assert.equal(source.origin.outputSha256, hash(call.output))
    assert.equal(source.origin.artifactSha256, hash(before))
    assert.equal(source.origin.argumentHashVerified, true)
  }
  for (const [id, quote, canonicalStart, canonicalEnd, receiptStart, receiptEnd, association, canonicalSha256] of [
    ['doc-02:s0043:c158', 'par le droit de l’État membre de la société scindée.', 1772, 1824, 5426, 5478,
      'inline-citation', '898492a05c99033aede09cf6867a32499bc5140f6b259919747ad30178dcad13'],
    ['doc-02:s0034:c6', 'en clarifiant la question de la date de prise d’effet dans le projet de scission', 2096, 2176, 7105, 7185,
      'sentence-citation', 'b99420c3de9140fb30525b98b6b9f211c616b90359c3332daf71daf076ef833e'],
  ]) {
    const source = corrected.sources.find(source => source.id === id && source.text.includes(quote))
    assert(source)
    const index = source.text.indexOf(quote), audit = corrected.quoteAudit[source.origin.quoteAuditIndex]
    assert.equal(source.origin.start + index, canonicalStart)
    assert.equal(source.origin.start + index + quote.length, canonicalEnd)
    assert.equal(source.origin.receipt.fragmentRange.start + index, receiptStart)
    assert.equal(source.origin.receipt.fragmentRange.start + index + quote.length, receiptEnd)
    assert.equal(audit.association, association)
    assert.equal(audit.canonicalSha256, canonicalSha256)
    assert(audit.fragments.some(part => part.status === 'unsupported' || part.status === 'normalized-only'))
  }
  assert.equal(corrected.proof.originalArtifactSha256, hash(before))
  assert.equal(corrected.proof.quoteAuditSha256, hash(JSON.stringify(corrected.quoteAudit)))
  assert.equal(corrected.proof.visibleSourceInventorySha256, hash(JSON.stringify(corrected.sources)))
  assert.equal(corrected.proof.replayImplementationSha256, hash(readFileSync(new URL('../eval/grading-evidence.mjs', import.meta.url))))
  assert.deepEqual(readFileSync(artifact), before)
  assert.deepEqual(evidenceV4({ ...options, workspace }).replay(row), original)
})


test('confirmed canonical clauses recover at matching controlled stdout coordinates, without report-tail credit', t => {
  const workspace = new URL('..', import.meta.url).pathname
  const manifest = loadChunks(workspace)
  const ids = ['doc-02:s0043:c158', 'doc-02:s0034:c6']
  const sources = ids.map(id => ({ id, doc: 'doc-02', text: chunkText(workspace, manifest.get(id)) }))
  const { save, stdout } = fixture(t, sources)
  const quotes = ['par le droit de l’État membre de la société scindée.',
    'en clarifiant la question de la date de prise d’effet dans le projet de scission']
  let printed = `Split findings\n\`\`\`json\n{"findings":[{"source_id":"${ids[0]}","quote":"`
  printed += ' '.repeat(5426 - printed.length) + quotes[0]
  printed += `","analysis":"Complete finding"},{"source_id":"${ids[1]}","quote":"`
  printed += ' '.repeat(7105 - printed.length) + quotes[1] + '","analysis":"cut-off interpretation'
  const run = save([{ output: stdout(printed, { overflow_path: '.rlm-overflows/unread.txt' }) }])
  const corrected = run.replay()
  assert.deepEqual(corrected.sources.map(source => [source.id, source.kind, source.text, source.origin.start, source.origin.end]),
    [[ids[0], 'excerpt', quotes[0], 1772, 1824], [ids[1], 'excerpt', quotes[1], 2096, 2176]])
  assert.deepEqual(corrected.sources.map(source => source.origin.receipt.fragmentRange),
    [{ start: 5426, end: 5478 }, { start: 7105, end: 7185 }])
  assert.deepEqual(corrected.quoteAudit.map(item => item.recordComplete), [true, false])
  assert.deepEqual(corrected.quoteAudit.map(item => item.canonicalSha256), [
    '898492a05c99033aede09cf6867a32499bc5140f6b259919747ad30178dcad13',
    'b99420c3de9140fb30525b98b6b9f211c616b90359c3332daf71daf076ef833e'])
  for (const source of corrected.sources) {
    const range = source.origin.receipt.fragmentRange
    assert.equal(printed.slice(range.start, range.end), source.text)
    assert.equal(source.origin.stdoutSha256, hash(printed))
    assert.equal(source.origin.outputSha256, hash(run.captured.calls[0].output))
    assert.equal(source.origin.toolCallId, 'call-0')
    assert.equal(source.origin.artifactSha256, hash(readFileSync(run.artifact)))
  }
  assert.deepEqual(run.replay(null).sources, [])
})

test('actual task05 finding shape survives a sliced following analysis and a competing second fenced child report', t => {
  const workspace = new URL('..', import.meta.url).pathname, manifest = loadChunks(workspace)
  const governingId = 'doc-02:s0043:c158', dateId = 'doc-02:s0034:c6'
  const sources = [governingId, dateId].map(id => ({ id, doc: 'doc-02', text: chunkText(workspace, manifest.get(id)) }))
  const { save, stdout } = fixture(t, [...sources, { id, doc, text }])
  const governingQuote = '« Contrairement au législateur luxembourgeois qui ne traite pas explicitement de la question de la date de prise d’effet d’une scission transfrontalière et au législateur belge qui a fait le choix surprenant de préciser que la date de prise d’effet de la scission transfrontalière serait déterminée par le droit national applicable aux sociétés bénéficiaires […] le législateur européen a fait le choix […] de prévoir que la date à laquelle la scis- sion transfrontalière par constitution de nouvelles sociétés prendrait effet serait déterminée par le droit de l’État membre de la société scindée. Cette règle de conflit de lois est complétée par une règle de droit matériel […] précisant que la date de prise d’effet devra nécessairement être postérieure à l’exécution des contrôles de légalité » [doc-02:s0043:c158] (n° 667, footnotes 3264-3267: CSA arts 12:73 §5 and 12:90 §5; art. 160decies Directive Mobilité).'
  const dateAnalysis = "The Luxembourg–Belgium friction is worked out in [doc-02:s0034:c6], where the monograph notes parties can mitigate it 'en passant l’acte notarié belge et l’acte notarié luxembourgeois le même jour ou encore en clarifiant la question de la date de prise d’effet dans le projet de scission' — i.e. drafting the date into the draft terms is the recognised lever, not signing order."
  const record = { source_id: governingId, quote: governingQuote, analysis: dateAnalysis,
    limitations: 'The parent must check current Luxembourg statute (scope says 2026-05-29).' }
  const malformed = `{"source_id":"${governingId}","quote":${JSON.stringify(governingQuote)},"analysis":"Temporal caveats: (a) doc-02 is recorded as an undated monograph (documents.json: 'year': null) — it cannot be pinned to a version date; (b) its external-source snapshots are dated to 2020-2021 (e`
  const printed = `child-split-dates-retry completed None\nHere is the bounded research result.\n\n\`\`\`json\n{\n "findings": [\n${JSON.stringify(record, null, 2)},\n${malformed}\n${'='.repeat(80)}\nchild-belgian-srl-retry completed None\nFindings complete — all quotations were extracted programmatically from the corpus copy.\n\n\`\`\`json\n${JSON.stringify({ findings: [finding] })}`
  const result = save([{ output: stdout(printed, { overflow_path: '.rlm-overflows/unread.txt' }) }]).replay()
  const governingSpan = 'par le droit de l’État membre de la société scindée.'
  const dateSpan = 'en clarifiant la question de la date de prise d’effet dans le projet de scission'
  assert(result.sources.some(source => source.id === governingId && source.text.includes(governingSpan)))
  assert(result.sources.some(source => source.id === dateId && source.text.includes(dateSpan)))
  assert(result.sources.some(source => source.id === id && source.text === finding.quote))
  assert(!result.quoteAudit.some(item => item.fieldPath.at(-2) === 1))
  const dateAudit = result.quoteAudit.find(item => item.id === dateId)
  assert.equal(dateAudit.association, 'sentence-citation')
  assert(dateAudit.fragments.some(item => item.reason === 'unsupported-quoted-prefix'))
  assert(!result.sources.some(source => source.id === dateId && source.text.includes('en passant')))
  const governingAudit = result.quoteAudit.find(item => item.id === governingId)
  assert(governingAudit.fragments.some(item => item.status === 'normalized-only'))
  for (const source of result.sources) {
    assert.equal(printed.slice(source.origin.receipt.fragmentRange.start, source.origin.receipt.fragmentRange.end), source.text)
    assert.equal([...sources, { id, text }].find(item => item.id === source.id).text.slice(source.origin.start, source.origin.end), source.text)
  }
})

test('local recovery keeps earlier complete records but rejects the malformed record and incomplete transport wrappers', t => {
  const { save, stdout } = fixture(t)
  const malformed = `{"source_id":"${id}","quote":"Third rule.","limitations":"cut\nnext child prose`
  const report = `{"findings":[${JSON.stringify(finding)},${malformed}`
  const recovered = save([{ output: stdout(report) }]).replay()
  assert.deepEqual(recovered.sources.map(source => source.text), ['Second rule.'])
  assert.equal(recovered.quoteAudit.length, 1)
  for (const wrapper of [
    `{"agent_id":"child-a","status":"completed","response":${report}`,
    `{"stdout":${report},"exit_code":0`,
    `{"findings":[${JSON.stringify(finding)}],"stdout":"broken\nnext child prose`,
  ]) assert.deepEqual(save([{ output: stdout(wrapper) }]).replay().sources, [])
})

test('unique whitespace and hyphen alignment credits only unchanged runs, including zero-width printed gaps', t => {
  const canonical = 'A luxem- bourgeois company has a funding plan. Its initial\u00a0funding is documented.'
  const quoted = 'A luxembourgeois company has a funding plan. Its initial funding is documented.'
  const { save, stdout } = fixture(t, [{ id, doc, text: canonical }])
  const result = save([{ output: stdout({ source_id: id, quote: quoted }) }]).replay()
  assert.deepEqual(result.sources.map(source => source.text), ['A luxem', 'bourgeois company has a funding plan. Its initial', 'funding is documented.'])
  const audit = result.quoteAudit[0]
  assert.equal(audit.status, 'partially-verified')
  assert(audit.fragments.some(item => item.status === 'normalized-only' && item.quoteStart === item.quoteEnd && item.canonicalEnd - item.canonicalStart === 2))
  assert(audit.fragments.some(item => item.status === 'normalized-only' && item.quoteEnd - item.quoteStart === 1))
  assert(result.sources.every(source => source.kind === 'excerpt'))
  for (const source of result.sources) {
    assert.equal(canonical.slice(source.origin.start, source.origin.end), source.text)
    assert.equal(quoted.slice(source.origin.receipt.quoteStart, source.origin.receipt.quoteEnd), source.text)
  }
})

test('normalization alignment rejects ambiguity and substitutions outside whitespace/hyphen artifacts', t => {
  const canonical = 'One co- mpany obligation.\nOne company obligation.'
  const { save, stdout } = fixture(t, [{ id, doc, text: canonical }])
  const result = save([{ output: stdout({ source_id: id, quote: 'One co-\nmpany obligation.' }) }]).replay()
  assert.deepEqual(result.sources, [])
  assert.equal(result.quoteAudit[0].fragments[0].reason, 'multiple-normalized-locations')
  for (const quote of ['One corporation obligation.', 'One company obligations.', 'One company—obligation.']) {
    assert.deepEqual(save([{ output: stdout({ source_id: id, quote }) }]).replay().sources, [])
  }
})

test('sentence-local single-quoted citations are independent of the primary finding ID and reject competing associations', t => {
  const alternative = 'doc-02:a:c0'
  const { save, stdout } = fixture(t, [{ id, doc, text }, { id: alternative, doc: 'doc-02', text }])
  const positive = { source_id: id, analysis: `The other source [${alternative}] explicitly provides 'Second rule.' for this point.` }
  const result = save([{ output: stdout(positive) }]).replay()
  assert.deepEqual(result.sources.map(source => [source.id, source.text]), [[alternative, finding.quote]])
  assert.equal(result.quoteAudit[0].association, 'sentence-citation')
  assert(result.quoteAudit[0].receipt.sentenceRange)
  for (const analysis of [
    `The other source [${alternative}] provides Second rule. for this point.`,
    `The other source [${alternative}] differs from [${id}] and provides 'Second rule.' for this point.`,
    `The other source [${alternative}] provides 'Second rule.' and 'Third rule.' for this point.`,
    `The other source [${alternative}] is discussed. Another point provides 'Second rule.'.`,
    `The source provides 'Second rule. [${alternative}]' without attribution.`,
    `The other source [${alternative}] cites [${id}, ${alternative}] and provides 'Second rule.' for this point.`,
  ]) assert.deepEqual(save([{ output: stdout({ source_id: id, analysis }) }]).replay().sources, [])
})

test('sentence-local suffix recovery credits a unique long word-boundary ending and audits the unsupported opening', t => {
  const passage = 'the effective date of a cross-border division must follow completion of every required legality check'
  const canonical = `The statute confirms that ${passage}. No other date rule applies.`
  const prefix = 'Unsupported opening '
  const analysis = `The cited monograph [${id}] explicitly records '${prefix}${passage}' for this issue.`
  const { save, stdout } = fixture(t, [{ id, doc, text: canonical }])
  const printed = JSON.stringify({ source_id: id, analysis })
  const result = save([{ output: stdout(printed) }]).replay()
  assert.deepEqual(result.sources.map(source => [source.id, source.kind, source.text]), [[id, 'excerpt', passage]])
  const source = result.sources[0], audit = result.quoteAudit[0]
  assert.equal(source.origin.start, canonical.indexOf(passage))
  assert.equal(source.origin.end, canonical.indexOf(passage) + passage.length)
  assert.equal(audit.association, 'sentence-citation')
  assert.equal(audit.status, 'partially-verified')
  assert(audit.fragments.some(part => part.status === 'unsupported' && part.reason === 'unsupported-quoted-prefix' &&
    part.quoteStart === analysis.indexOf(prefix) && part.quoteEnd === analysis.indexOf(passage)))
  assert.equal(printed.slice(source.origin.receipt.fragmentRange.start, source.origin.receipt.fragmentRange.end), passage)
  assert(!source.text.includes(prefix))
  assert.equal(result.proof.analysisMatchingPolicy,
    'one-sentence-one-complete-quotation-one-citation-unique-word-boundary-quote-end-suffix-min64-min8words-v2')
  const floor = 'abcdefg '.repeat(7) + 'abcdefgh'
  assert.equal(floor.length, 64)
  assert.equal(floor.match(/\p{L}+/gu).length, 8)
  const boundary = fixture(t, [{ id, doc, text: `The rule confirms ${floor}.` }])
  const atFloor = boundary.save([{ output: boundary.stdout({ source_id: id,
    analysis: `The cited source [${id}] records '${prefix}${floor}' for this issue.` }) }]).replay()
  assert.deepEqual(atFloor.sources.map(source => source.text), [floor])
})

test('sentence-local suffix recovery rejects short, nonterminal, ambiguous, unquoted and authoritative-body controls', t => {
  const passage = 'the effective date of a cross-border division must follow completion of every required legality check'
  const short = 'one two three four five six seven eight'
  const fewWords = 'hyperconstitutionalization counterinstitutionalization superadministrativeness'
  const astral = 'foreign laws require corporate officers to complete every statutory legality check before 𐐀'
  const normalizedAstral = 'the company must complete every required statutory legality check before 𐐀'
  assert(short.length < 64 && short.match(/\p{L}+/gu).length >= 8)
  assert(fewWords.length >= 64 && fewWords.match(/\p{L}+/gu).length < 8)
  const prefix = 'Unsupported opening '
  const canonical = `The statute confirms that ${passage}. ${short}. ${fewWords}. ${astral}additional. ${normalizedAstral.replace('company', 'co- mpany')}additional.`
  const duplicate = 'doc-02:a:c0'
  const { save, stdout } = fixture(t, [{ id, doc, text: canonical }, { id: duplicate, doc: 'doc-02', text: `${canonical}\n${canonical}` }])
  const quoted = value => `The cited monograph [${id}] explicitly records '${prefix}${value}' for this issue.`
  const analysis = quoted(passage)
  for (const [label, record] of [
    ['fewer than 64 characters', { source_id: id, analysis: quoted(short) }],
    ['fewer than eight words', { source_id: id, analysis: quoted(fewWords) }],
    ['unsupported text after the passage', { source_id: id, analysis: quoted(`${passage} unsupported ending`) }],
    ['a fragment before a later omission', { source_id: id, analysis: quoted(`${passage} […] unsupported ending`) }],
    ['a fragment before closing markdown', { source_id: id, analysis: quoted(`${passage}**`) }],
    ['partial final canonical word', { source_id: id, analysis: quoted(passage.slice(0, -1)) }],
    ['partial final supplementary-Unicode word', { source_id: id, analysis: quoted(astral) }],
    ['partial normalized supplementary-Unicode word', { source_id: id, analysis: quoted(normalizedAstral) }],
    ['a repeated canonical suffix', { source_id: duplicate, analysis: analysis.replace(id, duplicate) }],
    ['unquoted prose', { source_id: id, analysis: `The cited monograph [${id}] records ${prefix}${passage} for this issue.` }],
    ['an incomplete explicit quotation', { source_id: id, analysis: `The cited monograph [${id}] records '${prefix}${passage} for this issue.` }],
    ['multiple citations', { source_id: id, analysis: `The monograph [${id}] compares [${duplicate}] and records '${prefix}${passage}' for this issue.` }],
    ['multiple explicit quotations', { source_id: id, analysis: `The monograph [${id}] records '${prefix}${passage}' and 'another unsupported quotation' for this issue.` }],
    ['a citation in a different sentence', { source_id: id, analysis: `The monograph [${id}] explains the rule. Another source records '${prefix}${passage}' for this issue.` }],
    ['an ordinary source_id quotation', { source_id: id, quote: `${prefix}${passage}` }],
    ['an ordinary inline-cited quotation', { source_id: id, quote: `«${prefix}${passage}» [${id}]` }],
    ['an authoritative text field', { source_id: id, text: `Forged opening ${passage}`, analysis }],
    ['an authoritative preview field', { source_id: id, preview: `Forged opening ${passage}`, analysis }],
  ]) assert.deepEqual(save([{ output: stdout(record) }]).replay().sources, [], label)
  const cut = `{"source_id":"${id}","analysis":"The cited monograph [${id}] records '${prefix}${passage}`
  assert.deepEqual(save([{ output: stdout(cut) }]).replay().sources, [])
  assert.throws(save([{ output: stdout({ id, doc, source_id: id, text: `Forged opening ${passage}`, analysis }) }]).replay,
    /Invalid evidence coordinates/)
})

test('multiline fenced and bare reports recover complete local fields, including a cut-off analysis', t => {
  const { save, stdout } = fixture(t)
  const complete = JSON.stringify({ findings: [finding] }, null, 2)
  for (const printed of [complete, `Child report\n\`\`\`json\n${complete}\n\`\`\``,
    `\`\`\`json\n${JSON.stringify(finding, null, 2).slice(0, -1)}`,
    `{"findings":[{"source_id":"${id}","quote":"Second rule.","analysis":"unfinished`,
    `{"quote":"Second rule.","source_id":"${id}"`]) {
    const result = save([{ output: stdout(printed) }]).replay()
    assert.deepEqual(result.sources.map(source => source.text), ['Second rule.'])
    assert(result.quoteAudit.every(item => item.fragments.some(part => part.status === 'exact')))
  }
})

test('cut-off strings and source identities in another object cannot supply a quote binding', t => {
  const { save, stdout } = fixture(t)
  for (const printed of [
    `{"source_id":"${id}","quote":"Second rule.`,
    `{"quote":"Second rule.","source_id":"${id}`,
    `{"findings":[{"source_id":"${id}"},{"quote":"Second rule."}]}`,
    `{"source_id":"${id}","quote":{"quote":"Second rule."}}`,
    JSON.stringify({ source_id: id, chars: text.length }),
  ]) assert.deepEqual(save([{ output: stdout(printed) }]).replay().sources, [])
  const result = save([{ output: stdout(`{"source_id":"${id}","quote":"Second rule.`) }]).replay()
  assert.equal(result.quoteAudit[0].reason, 'incomplete-or-nonstring-quote')
})

test('explicit decorations and omissions preserve disjoint exact fragments, not the intervening canonical body', t => {
  const { save, stdout } = fixture(t)
  const quoted = '**First rule.** […] «Third rule.» … unsupported commentary'
  const result = save([{ output: stdout({ ...finding, quote: quoted }) }]).replay()
  assert.deepEqual(result.sources.map(source => source.text), ['First rule.', 'Third rule.'])
  assert(result.sources.every(source => source.kind === 'excerpt'))
  assert.equal(result.quoteAudit[0].status, 'partially-verified')
  assert(result.quoteAudit[0].fragments.some(part => part.status === 'decoration'))
  assert(result.quoteAudit[0].fragments.some(part => part.status === 'unsupported'))
  assert(!result.sources.some(source => source.text.includes('Second rule.')))
  for (const source of result.sources) {
    assert.equal(quoted.slice(source.origin.receipt.quoteStart, source.origin.receipt.quoteEnd), source.text)
  }
  for (const quote of ['"Second rule."', "'Second rule.'", '“Second rule.”']) {
    assert.deepEqual(save([{ output: stdout({ ...finding, quote }) }]).replay().sources.map(source => source.text), ['Second rule.'])
  }
})

test('changed typography is unsupported and never normalized into source credit', t => {
  const { save, stdout } = fixture(t)
  const changed = "The State's law governs."
  assert.deepEqual(save([{ output: stdout({ ...finding, quote: changed }) }]).replay().sources, [])
  const result = save([{ output: stdout({ ...finding, quote: `First rule. … ${changed} … Third rule.` }) }]).replay()
  assert.deepEqual(result.sources.map(source => source.text), ['First rule.', 'Third rule.'])
  assert.equal(result.proof.findingMatchingPolicy, 'exact-fragments-whitespace-hyphen-v2')
  assert(result.quoteAudit[0].fragments.some(part => part.status === 'unsupported'))
})

test('canonical ambiguity is rejected even when a finding asserts an occurrence coordinate', t => {
  const { save, stdout } = fixture(t)
  const result = save([{ output: stdout({ source_id: id, quote: 'Repeated rule.', start: text.indexOf('Repeated rule.') }) }]).replay()
  assert.deepEqual(result.sources, [])
  assert.equal(result.quoteAudit[0].fragments[0].status, 'ambiguous')
  assert.equal(result.quoteAudit[0].status, 'rejected')
})

test('partial canonical words and incomplete Unicode characters are not quotation fragments', t => {
  const { save, stdout } = fixture(t)
  for (const quote of ['**cond**', 'afé', '\ud83d', '\ude42']) {
    const result = save([{ output: stdout({ ...finding, quote }) }]).replay()
    assert.deepEqual(result.sources, [])
    assert.equal(result.quoteAudit[0].fragments.find(part => part.status !== 'decoration').status, 'unsupported')
  }
})

test('escaped JSON and supplementary Unicode retain quote, receipt and serialized-output coordinates', t => {
  const { save, stdout } = fixture(t)
  const encoded = '\\ud83d\\ude42 ca\\u0066\\u00e9 \\u201cexact\\u201d.'
  const printed = `{"source_id":"${id}","quote":"${encoded}"}`
  const run = save([{ output: stdout(printed) }])
  const result = run.replay(), source = result.sources[0], part = result.quoteAudit[0].fragments[0]
  assert.equal(source.text, '🙂 café “exact”.')
  assert.equal(source.origin.start, text.indexOf(source.text))
  assert.equal(source.origin.end - source.origin.start, source.text.length)
  assert.equal(printed.slice(part.receiptRange.start, part.receiptRange.end), encoded)
  const serialized = run.captured.calls[0].output.slice(part.outputRange.start, part.outputRange.end)
  assert.equal(JSON.parse(`"${JSON.parse(`"${serialized}"`)}"`), source.text)
  assert.equal(JSON.parse(printed.slice(result.quoteAudit[0].receipt.sourceIdRange.start,
    result.quoteAudit[0].receipt.sourceIdRange.end)), id)
  assert.deepEqual(result.quoteAudit[0].receipt.decodingPath.map(item => item.encoding), ['json-string', 'json-string'])
  assert.equal(result.proof.coordinateUnit, 'utf16')
})

test('completed Python RLM wrappers retain nested escape coordinates without crediting resident-only data', t => {
  const { save, stdout } = fixture(t)
  const report = `\`\`\`json\n${JSON.stringify({ findings: [finding] }, null, 2)}\n\`\`\``
  const printed = `{'rlm_child_id': 'child-a', 'status': 'completed', 'output': ${pythonString(report)}, 'error': None}`
  const result = save([{ output: stdout(printed) }]).replay()
  assert.deepEqual(result.sources.map(source => source.text), ['Second rule.'])
  assert.equal(result.sources[0].origin.childSessionId, 'child-a')
  assert.equal(result.quoteAudit[0].receipt.channelSha256, hash(printed))
  assert(result.quoteAudit[0].receipt.decodingPath.some(item => item.encoding === 'python-string'))
  assert.equal(printed.slice(result.sources[0].origin.receipt.fragmentRange.start,
    result.sources[0].origin.receipt.fragmentRange.end), 'Second rule.')
})

test('direct completed child receipts and structured output objects use the same exact-field contract', t => {
  const { save } = fixture(t)
  for (const spec of [
    { tool: 'read_subagent', args: { agent_id: 'child-a' }, output: { agent_id: 'child-a', status: 'completed', response: JSON.stringify(finding) } },
    { tool: 'opulent_session_interact', args: { action: 'get', session_id: 'child-b' },
      output: { session_id: 'child-b', status: 'completed', output: { findings: [finding] } } },
  ]) {
    const result = save([spec]).replay()
    assert.deepEqual(result.sources.map(source => source.text), ['Second rule.'])
    assert.equal(result.sources[0].origin.childSessionId, spec.args.agent_id ?? spec.args.session_id)
  }
})

test('explicit inline quotations bind adjacent citations, never arbitrary analysis sentences', t => {
  const { save, stdout } = fixture(t)
  for (const analysis of [`“Second rule.” [${id}]`, `[${id}] «Second rule.»`, `"Second rule." (${id})`]) {
    const printed = JSON.stringify({ findings: [{ analysis }] })
    const result = save([{ output: stdout(printed) }]).replay()
    assert.deepEqual(result.sources.map(source => source.text), ['Second rule.'])
    assert.equal(result.quoteAudit[0].association, 'inline-citation')
    const range = result.quoteAudit[0].receipt.sourceIdRange
    assert.equal(printed.slice(range.start, range.end), id)
    assert.deepEqual(result.sources[0].origin.receipt.sourceIdRange, range)
  }
  for (const analysis of [`Second rule. [${id}]`, 'Second rule.', JSON.stringify(finding)]) {
    assert.deepEqual(save([{ output: stdout({ findings: [{ source_id: id, analysis }] }) }]).replay().sources, [])
  }
})

test('conflicting and multiply attached inline citations are rejected rather than guessed', t => {
  const sources = [{ id, doc, text }, { id: 'doc-02:a:c0', doc: 'doc-02', text }]
  const { save, stdout } = fixture(t, sources)
  for (const quote of [`«Second rule.» [doc-02:a:c0]`, `[doc-02:a:c0] «Second rule.» [${id}]`,
    `«First rule.» [${id}] «Third rule.»`, `«Second rule.» [${id}] [doc-02:a:c0]`,
    `[doc-02:a:c0] [${id}] «Second rule.»`, `[${id}] «Second rule.» [${id}]`,
    `«Second rule.» [${id}, doc-02:a:c0]`, `«Second rule.» (${id}; doc-02:a:c0)`]) {
    const result = save([{ output: stdout({ ...finding, quote }) }]).replay()
    assert.deepEqual(result.sources, [])
    assert(result.quoteAudit.every(item => item.status === 'rejected'))
  }
})

test('duplicate fields, wrong document associations and unsupported bodies never produce quotation evidence', t => {
  const { save, stdout } = fixture(t)
  for (const printed of [
    `{"source_id":"${id}","source_id":"${id}","quote":"Second rule."}`,
    `{"source_id":"${id}","quote":"Second rule.","quote":"First rule."}`,
    JSON.stringify({ ...finding, doc: 'doc-99' }),
    JSON.stringify({ ...finding, source_id: 'doc-99:missing' }),
    JSON.stringify({ ...finding, text: 'Forged corpus body.' }),
    JSON.stringify({ ...finding, quote: 'An invented legal quotation.' }),
  ]) assert.deepEqual(save([{ output: stdout(printed) }]).replay().sources, [])
  assert.throws(save([{ output: stdout({ id, text: 'Forged corpus body.', quote: finding.quote, source_id: id }) }]).replay,
    /Invalid evidence coordinates/)
})

test('malformed syntax is not treated as a recoverable cutoff or repaired into a finding', t => {
  const { save, stdout } = fixture(t)
  for (const printed of [
    `{"source_id":"${id}","quote":"Second rule."garbage}`,
    `{"source_id":"${id}","quote":"Second rule.","analysis":not_a_literal}`,
    `{"source_id":"${id}","quote":"Second rule.",}`,
    `{"source_id":"${id}","quote":"Second rule.","analysis":"invalid\\q"}`,
    `{"source_id":"${id}","quote":"Second rule.","analysis":"invalid\nraw newline"}`,
  ]) assert.deepEqual(save([{ output: stdout(printed) }]).replay().sources, [])
})

test('failed cells, unfinished children, excluded ledgers and incomplete envelopes remain outside the replay boundary', t => {
  const { save, stdout } = fixture(t)
  const body = { findings: [finding] }
  const hidden = { scriptCalls: [body], script_calls: [body], sessions: [body], trajectory: body, messages: [body] }
  const specs = [
    { output: stdout(body, { ok: false }) },
    { output: stdout(body, { error: 'stopped' }) },
    { output: stdout(body), error: true },
    { tool: 'scripted_tools', output: stdout(body, { exit_code: 1 }) },
    { output: stdout(body, { truncated: true }) },
    { output: stdout('', { stderr: JSON.stringify(body), state_manifest: body }) },
    { output: stdout(hidden) },
    { output: stdout({ ...body, visibility: 'child-only' }) },
    { output: stdout(`{"rlm_child_id":"child-a","status":"completed","output":${JSON.stringify(body)}`) },
    { output: stdout(`\`\`\`javascript\n${JSON.stringify(body)}\n\`\`\``) },
  ]
  for (const status of ['queued', 'running', 'sleeping', 'failed', 'cancelled']) {
    specs.push({ tool: 'read_subagent', output: { agent_id: 'child-a', status, response: JSON.stringify(body) } },
      { output: stdout({ rlm_child_id: 'child-a', status, output: body }) })
  }
  for (const spec of specs) assert.deepEqual(save([spec], { extra: hidden }).replay().sources, [])
})

test('unread overflow files and full child outputs in the artifact cannot restore a sliced quote', t => {
  const { save, stdout, options } = fixture(t)
  const hiddenReport = JSON.stringify({ findings: [finding] })
  const run = save([{ output: stdout(`{"source_id":"${id}","quote":"Second`, { overflow_path: '.rlm-overflows/unread.txt' }) }],
    { extra: { childSessions: [{ output: hiddenReport }], scriptCalls: [{ result: hiddenReport }] } })
  mkdirSync(join(options.artifacts, '.rlm-overflows'))
  writeFileSync(join(options.artifacts, '.rlm-overflows/unread.txt'), hiddenReport)
  assert.deepEqual(run.replay().sources, [])
  assert.equal(run.replay().quoteAudit[0].status, 'rejected')
})

test('explicitly returned RLM overflow pages admit only complete local stdout fields, never stderr or missing pages', t => {
  const { save, stdout } = fixture(t)
  const path = '/tmp/broad-legal-workspace/.rlm-overflows/cell.txt'
  const content = `\n--- stdout ---\n${JSON.stringify(finding)}\n\n--- stderr ---\n${JSON.stringify({ ...finding, quote: 'Third rule.' })}\n`
  const lines = content.match(/[^\n]*\n|[^\n]+$/g)
  const owner = { output: stdout('preview only', { overflow_path: path }) }
  const read = (offset, limit) => ({ tool: 'read', args: { file_path: path, offset, limit },
    output: { content: lines.slice(offset - 1, offset - 1 + limit).join(''), total_lines: lines.length } })
  const complete = save([owner, read(1, 2000)]).replay()
  assert.deepEqual(complete.sources.map(source => source.text), ['Second rule.'])
  assert.equal(complete.quoteAudit[0].origin.overflowOwnerCall, 0)
  assert.equal(complete.quoteAudit[0].origin.call, 1)
  assert.equal(complete.quoteAudit[0].receipt.channel, 'content')
  const range = complete.sources[0].origin.receipt.fragmentRange
  assert.equal(content.slice(range.start, range.end), finding.quote)
  assert.deepEqual(save([owner]).replay().sources, [])
  assert.deepEqual(save([read(1, 2000)]).replay().sources, [])
  assert.deepEqual(save([owner, read(3, 1)]).replay().sources, [])
  assert.deepEqual(save([{ output: stdout('failed', { ok: false, overflow_path: path }) }, read(1, 2000)]).replay().sources, [])
  assert.deepEqual(save([owner, read(1, 2), read(3, 1)]).replay().sources.map(source => source.text), ['Second rule.'])
})

test('scripted overflow quotations require an explicitly returned complete successful envelope', t => {
  const { save } = fixture(t)
  const path = '.scripted-tools-overflows/script.json'
  const content = JSON.stringify({ stdout: JSON.stringify(finding), stderr: '', exit_code: 0 })
  const owner = { tool: 'scripted_tools', output: { stdout: 'prefix\n... truncated ...\ntail', stderr: '', exit_code: 0, overflow_path: path } }
  const read = { tool: 'read', args: { file_path: path }, output: { content, total_lines: 1 } }
  assert.deepEqual(save([owner]).replay().sources, [])
  assert.deepEqual(save([owner, read]).replay().sources.map(source => source.text), ['Second rule.'])
  assert.deepEqual(save([owner, { ...read, output: { content: JSON.stringify({ stdout: JSON.stringify(finding), exit_code: 1 }),
    total_lines: 1 } }]).replay().sources, [])
})

test('repeated source spans deduplicate the inventory without losing distinct receipt provenance', t => {
  const { save, stdout } = fixture(t)
  const run = save([{ output: stdout(finding) }, { output: stdout(finding) }])
  const result = run.replay()
  assert.equal(result.sources.length, 1)
  assert.equal(result.quoteAudit.length, 2)
  assert.deepEqual(result.quoteAudit.map(item => item.origin.toolCallId), ['call-0', 'call-1'])
  assert.deepEqual(result.quoteAudit.map(item => item.fragments[0].canonicalStart), [text.indexOf(finding.quote), text.indexOf(finding.quote)])
})

test('v3 keeps artifact, argument, source-inventory and tool-call identity verification binding', t => {
  const { save, stdout } = fixture(t)
  const specs = [{ output: stdout(finding), args: { code: 'print(report)' } }]
  const changedOutput = save(specs)
  changedOutput.captured.calls[0].output = JSON.stringify(stdout({ ...finding, quote: 'Third rule.' }))
  changedOutput.rewrite()
  assert.throws(changedOutput.replay, /call hash/)
  const changedArgs = save(specs)
  changedArgs.captured.calls[0].rawArguments = '{"code":"different"}'
  changedArgs.rewrite()
  assert.throws(changedArgs.replay, /raw argument hash/)
  const changedIdentity = save(specs)
  changedIdentity.captured.calls[0].toolCallId = 'call-elsewhere'
  changedIdentity.rewrite()
  assert.throws(changedIdentity.replay, /tool call identity/)
  assert.throws(save(specs, { inventory: [{ id, doc, chars: text.length, sha256: hash('forged') }] }).replay, /source hash/)
  const changedProvenance = save(specs)
  changedProvenance.captured.provenance = { evidenceReplayVersion: v3 }
  changedProvenance.rewrite()
  assert.throws(changedProvenance.replay, /run identity/)
})

test('the broad override leaves Harvey replay and historical binding strength unchanged', t => {
  const { options } = fixture(t)
  const directory = join(options.artifacts, 'harvey/session')
  mkdirSync(directory)
  const args = JSON.stringify({ file_path: `/workspace/documents/chunks/${id}.txt` })
  writeFileSync(join(directory, 'tool-results.jsonl'), `${JSON.stringify({ tool: 'read', arguments: args, result: `[${id}]\n${text}\n` })}\n`)
  const row = { mode: 'harvey', answer: 'Saved output.', sources: [], trace: [], metrics: {},
    audit: { finalAnswer: 'Saved output.', calls: [{ tool: 'read', arguments_sha256: hash(args) }] } }
  const original = evidenceV4(options).replay(row)
  assert.deepEqual(evidenceV4({ ...options, replayVersionOverride: v3 }).replay(row), original)
  assert.equal(original.proof.binding_strength, 'legacy-artifact-snapshot-arguments-canonical')
})

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { Template } from 'e2b';

const recipeUrl = new URL('./opulent2-machine-image.json', import.meta.url);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export async function buildOpulent2Machine({ alias, outputDirectory, apiKey = process.env.E2B_API_KEY, TemplateImpl = Template } = {}) {
  if (typeof alias !== 'string' || !/^opulent2-machine-v1-[a-z0-9-]+$/.test(alias)) throw new TypeError('A new unique opulent2-machine-v1-* alias is required');
  if (typeof outputDirectory !== 'string' || !outputDirectory.startsWith('/') || resolve(outputDirectory) !== outputDirectory) throw new TypeError('An absolute private output directory is required');
  if (!apiKey) throw new Error('E2B_API_KEY is required for an authenticated template build');
  const bytes = await readFile(recipeUrl);
  const recipe = JSON.parse(bytes);
  const skillsUrl = new URL('../skills/opulent2-manifest-v1.json', import.meta.url);
  const skillsBytes = await readFile(skillsUrl);
  const skillsManifest = JSON.parse(skillsBytes);
  const names = ['data-analysis', 'opulent2-child-sessions', 'opulent2-computer-use'];
  if (skillsManifest.destinationRoot !== '/opt/opulent/skills' || !Array.isArray(skillsManifest.skills) ||
    skillsManifest.skills.length !== names.length || new Set(skillsManifest.skills.map(skill => skill.name)).size !== names.length ||
    skillsManifest.skills.some(skill => !names.includes(skill.name) || !/^[a-f0-9]{64}$/.test(skill.artifactSha256))) throw new Error('Invalid Opulent2 skill inventory');
  const skills = [];
  for (const skill of skillsManifest.skills) {
    const body = await readFile(new URL(`../skills/${skill.name}/SKILL.md`, import.meta.url));
    if (sha256(body) !== skill.artifactSha256) throw new Error(`Opulent2 skill source mismatch: ${skill.name}`);
    skills.push({ name: skill.name, sha256: skill.artifactSha256, body: body.toString('base64') });
  }
  const builderSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
  if (recipe.schema !== 1 || recipe.name !== 'opulent2-machine-v1' || recipe.architecture !== 'amd64' || !/^[a-f0-9]{64}$/.test(recipe.sourceImageSha256) || !/^[a-z0-9]+$/.test(recipe.sourceTemplateId)) throw new Error('Invalid source image recipe');
  for (const pkg of recipe.packages) {
    if (!/^[a-z0-9-]+$/.test(pkg.name) || !/^[0-9][a-z0-9.+-]*$/.test(pkg.version) || !/^https:\/\/archive\.ubuntu\.com\/ubuntu\/pool\/[a-zA-Z0-9_./+-]+\.deb$/.test(pkg.url) || !/^[a-f0-9]{64}$/.test(pkg.sha256)) throw new Error('Invalid pinned package recipe');
  }
  if (await TemplateImpl.exists(alias, { apiKey })) throw new Error('Refusing to rebuild an existing alias; use a new unique image name');
  const sourceTags = await TemplateImpl.getTags(recipe.sourceTemplateId, { apiKey });
  const sourceTag = sourceTags.find(tag => tag.tag === 'default') ?? sourceTags.find(tag => tag.tag === 'latest');
  if (!sourceTag?.buildId) throw new Error('The approved source template has no recorded default build');
  const addition = { name: recipe.name, schema: recipe.schema, sourceTemplateId: recipe.sourceTemplateId,
    sourceBuildId: sourceTag.buildId, sourceTag: sourceTag.tag, sourceImageSha256: recipe.sourceImageSha256,
    recipeSha256: sha256(bytes), builderSha256, packages: recipe.packages,
    executable: recipe.executable, resolvedExecutable: recipe.resolvedExecutable, version: recipe.version,
    skills: { destinationRoot: skillsManifest.destinationRoot, manifestSha256: sha256(skillsBytes),
      installedManifestPath: '/opt/opulent/skills/opulent2-manifest-v1.json', files: skills.map(({ name, sha256 }) => ({ path: `${name}/SKILL.md`, sha256 })) } };
  let image = TemplateImpl().fromTemplate(`${recipe.sourceTemplateId}:${sourceTag.tag}`).setUser('root');
  image = image.runCmd(`set -eu; test "$(sha256sum /opt/computer-use/image.json | cut -d' ' -f1)" = ${quote(recipe.sourceImageSha256)}; test ! -e /opt/computer-use/opulent2-machine.json; test ! -e /usr/local/bin/agrep; install -d -m 0755 /opt/opulent2-machine-build`);
  const download = recipe.packages.map(pkg => {
    const file = `/opt/opulent2-machine-build/${pkg.name}.deb`;
    return `curl -fsSL --retry 3 -o ${quote(file)} ${quote(pkg.url)} && printf '%s\\n' ${quote(`${pkg.sha256}  ${file}`)} | sha256sum -c -`;
  }).join(' && ');
  image = image.runCmd(`set -eu; ${download}; DEBIAN_FRONTEND=noninteractive dpkg -i ${recipe.packages.map(pkg => quote(`/opt/opulent2-machine-build/${pkg.name}.deb`)).join(' ')}; ln -s /usr/bin/tre-agrep /usr/local/bin/agrep; test "$(readlink -f /usr/local/bin/agrep)" = /usr/bin/tre-agrep; /usr/local/bin/agrep --version; rm -rf /opt/opulent2-machine-build`);
  const skillsPayload = Buffer.from(JSON.stringify({ manifest: skillsBytes.toString('base64'), skills })).toString('base64');
  image = image.runCmd(String.raw`python3 - '${skillsPayload}' <<'PY'
import base64,hashlib,json,pathlib,os,sys
p=json.loads(base64.b64decode(sys.argv[1]))
root=pathlib.Path('/opt/opulent/skills')
if root.is_symlink() or root.stat().st_uid!=0:raise RuntimeError('Untrusted skill root')
for skill in p['skills']:
 directory=root/skill['name']
 body=base64.b64decode(skill['body'])
 if hashlib.sha256(body).hexdigest()!=skill['sha256']:raise RuntimeError('Skill hash mismatch')
 if skill['name']=='data-analysis':
  if hashlib.sha256((directory/'SKILL.md').read_bytes()).hexdigest()!=skill['sha256']:raise RuntimeError('Historical data-analysis differs')
  continue
 if directory.exists() or directory.is_symlink():raise RuntimeError('New skill path already exists')
 directory.mkdir(mode=0o755)
 (directory/'SKILL.md').write_bytes(body)
 (directory/'SKILL.md').chmod(0o444)
 directory.chmod(0o555)
manifest=root/'opulent2-manifest-v1.json'
if manifest.exists() or manifest.is_symlink():raise RuntimeError('New skill inventory already exists')
manifest.write_bytes(base64.b64decode(p['manifest']))
manifest.chmod(0o444)
root.chmod(0o555)
PY`);
  const payload = Buffer.from(JSON.stringify(addition)).toString('base64');
  image = image.runCmd(String.raw`python3 - '${payload}' <<'PY'
import base64,hashlib,json,pathlib,os,stat,sys
addition=json.loads(base64.b64decode(sys.argv[1]))
marker=pathlib.Path('/opt/computer-use/image.json')
if hashlib.sha256(marker.read_bytes()).hexdigest()!=addition['sourceImageSha256']:raise RuntimeError('Source image changed')
manifest=json.loads(marker.read_bytes())
if 'opulent2_machine' in manifest:raise RuntimeError('Source image already carries a machine layer')
addition['executableSha256']=hashlib.sha256(pathlib.Path(addition['resolvedExecutable']).read_bytes()).hexdigest()
addition['installedPackages']={p['name']:p['version'] for p in addition['packages']}
manifest['opulent2_machine']=addition
marker.write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
marker.chmod(0o644)
pathlib.Path('/opt/computer-use/opulent2-machine.json').write_text(json.dumps(addition,sort_keys=True,indent=2)+'\n')
pathlib.Path('/opt/computer-use/opulent2-machine.json').chmod(0o444)
print('OPULENT2_IMAGE_SHA256='+hashlib.sha256(marker.read_bytes()).hexdigest())
PY`);
  image = image.setUser('user').runCmd('set -eu; test "$(id -u)" != 0; test ! -w /opt/computer-use/image.json; test ! -w /opt/computer-use/opulent2-machine.json; test ! -w /usr/bin/tre-agrep; /usr/local/bin/agrep --version');
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const logs = [];
  const built = await TemplateImpl.build(image, alias, { apiKey, cpuCount: 2, memoryMB: 4096,
    onBuildLogs: entry => { const line = String(entry.message ?? ''); logs.push(line); process.stdout.write(`${line}\n`); } });
  const imageSha256 = logs.map(line => line.match(/OPULENT2_IMAGE_SHA256=([a-f0-9]{64})/)?.[1]).filter(Boolean).at(-1);
  const record = { schema: 1, alias, templateId: built.templateId, buildId: built.buildId, imageSha256: imageSha256 ?? null,
    ...addition, createdAt: new Date().toISOString(), provenance: 'Authenticated E2B build; no runtime installs or credentials in image' };
  await writeFile(join(outputDirectory, 'build.json'), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await writeFile(join(outputDirectory, 'build.log'), `${logs.join('\n')}\n`, { mode: 0o600 });
  if (!imageSha256) throw new Error('Build completed but its image marker digest was not returned; record the actual digest in the owned verification probe');
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [alias, outputDirectory] = process.argv.slice(2);
  try { console.log(JSON.stringify(await buildOpulent2Machine({ alias, outputDirectory }))); }
  catch (error) { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; }
}

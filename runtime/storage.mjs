import { GitStorage } from '@pierre/storage';

function pathAllowed(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.git') || path.includes('\\')) throw new Error('Invalid storage path');
  if (/(^|\/)(\.env(?:\..*)?|id_rsa|id_ed25519|credentials)(\/|$)/i.test(path)) throw new Error('Credential files cannot be committed');
}

export function createStorage(config, client) {
  let sdk = client;
  const getSdk = () => {
    if (!sdk) {
      if (!process.env.PIERRE_PRIVATE_KEY || !process.env.CODE_STORAGE_NAME) throw new Error('PIERRE_PRIVATE_KEY and CODE_STORAGE_NAME are required');
      sdk = new GitStorage({ name: process.env.CODE_STORAGE_NAME, key: process.env.PIERRE_PRIVATE_KEY });
    }
    return sdk;
  };
  const authorize = repoId => { if (!config.storageRepo || repoId !== config.storageRepo) throw new Error('Storage repository is not configured or allowed'); };
  const queues = new Map();
  return {
    async ensureRepo() {
      authorize(config.storageRepo);
      return await getSdk().findOne({ id: config.storageRepo }) ?? await getSdk().createRepo({ id: config.storageRepo });
    },
    async saveFiles({ repoId, branch, files, message }) {
      authorize(repoId);
      if (!config.authorName || !config.authorEmail) throw new Error('Explicit storage commit author is required');
      if (!branch || !message || !files || !Object.keys(files).length) throw new Error('Storage branch, files and message are required');
      for (const [path, bytes] of Object.entries(files)) {
        pathAllowed(path);
        const text = Buffer.from(bytes).toString('utf8');
        if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(text)) throw new Error('Private keys cannot be committed');
        for (const [name, secret] of Object.entries(process.env)) {
          if (/KEY|TOKEN|SECRET|PASSWORD|PRIVATE/.test(name) && secret?.length >= 8 && text.includes(secret)) throw new Error('Credential material cannot be committed');
        }
      }
      const key = `${repoId}:${branch}`;
      const pending = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        const repo = getSdk().repo({ id: repoId });
        const builder = repo.createCommit({ targetBranch: branch, commitMessage: message, author: { name: config.authorName, email: config.authorEmail } });
        for (const [path, bytes] of Object.entries(files)) builder.addFile(path, bytes);
        const result = await builder.send();
        return result.commitSha;
      });
      queues.set(key, pending);
      try { return await pending; } finally { if (queues.get(key) === pending) queues.delete(key); }
    },
    async readFile({ repoId, ref, path }) {
      authorize(repoId);
      pathAllowed(path);
      if (typeof ref !== 'string' || !ref) throw new Error('An exact artifact ref is required');
      const response = await getSdk().repo({ id: repoId }).getFileStream({ ref, path });
      if (!response.ok) throw new Error(`Storage read failed (${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

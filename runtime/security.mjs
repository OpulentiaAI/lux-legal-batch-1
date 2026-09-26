import { timingSafeEqual } from 'node:crypto';

export function sameToken(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function redact(value, secrets = []) {
  if (typeof value === 'string') {
    let result = value.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@');
    for (const [name, secret] of Object.entries(process.env)) {
      if (/KEY|TOKEN|SECRET|PASSWORD|PRIVATE/.test(name) && secret?.length >= 8) result = result.split(secret).join('[redacted]');
    }
    for (const secret of secrets) if (typeof secret === 'string' && secret) result = result.split(secret).join('[redacted]');
    return result.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]');
  }
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /^(apiKey|token|privateKey|password|authorization|scriptToken)$/i.test(key) ? '[redacted]' : redact(entry, secrets)]));
  return value;
}

export function safeError(error) {
  return redact(error instanceof Error ? error.message : 'Runtime operation failed');
}

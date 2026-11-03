import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/** Deterministic JSON: object keys sorted recursively, Dates as ISO strings. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = normalize(val);
    }
    return out;
  }
  return v;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pin, salt, 32);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPin(pin: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const key = scryptSync(pin, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** 32-byte key for secrets at rest (connector tokens). Set OMOSHINE_SECRETS_KEY (base64, 32 bytes) in production. */
function secretsKey(): Buffer {
  if (config.secretsKey) {
    const k = Buffer.from(config.secretsKey, 'base64');
    if (k.length !== 32) throw new Error('OMOSHINE_SECRETS_KEY must be 32 bytes, base64-encoded');
    return k;
  }
  return createHash('sha256').update(`omoshine-secrets:${config.jwtSecret}`).digest();
}

/** AES-256-GCM: returns v1.<iv>.<tag>.<ciphertext>, all base64url. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretsKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(box: string): string {
  const [v, iv, tag, ct] = box.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unrecognised secret format');
  const d = createDecipheriv('aes-256-gcm', secretsKey(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

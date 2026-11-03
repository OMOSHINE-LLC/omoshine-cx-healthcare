import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';

const key = () => new TextEncoder().encode(config.jwtSecret);

export interface Principal {
  userId: string;
  tenantId: string;
  name: string;
}

export async function issueSessionToken(p: Principal): Promise<string> {
  return new SignJWT({ tid: p.tenantId, name: p.name, typ: 'session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(p.userId)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(key());
}

/** Short-lived step-up token required for e-signatures. */
export async function issueReauthToken(p: Principal, method: string): Promise<string> {
  return new SignJWT({ tid: p.tenantId, typ: 'reauth', method })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(p.userId)
    .setIssuedAt()
    .setExpirationTime(`${config.reauthMaxAgeSeconds}s`)
    .sign(key());
}

export async function verifySessionToken(token: string): Promise<Principal> {
  const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'] });
  if (payload.typ !== 'session' || typeof payload.sub !== 'string' || typeof payload.tid !== 'string') {
    throw new Error('Invalid session token');
  }
  return { userId: payload.sub, tenantId: payload.tid, name: String(payload.name ?? '') };
}

export async function verifyReauthToken(token: string, expectedUserId: string): Promise<{ method: string }> {
  const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'], maxTokenAge: `${config.reauthMaxAgeSeconds}s` });
  if (payload.typ !== 'reauth' || payload.sub !== expectedUserId) throw new Error('Invalid re-authentication token');
  return { method: String(payload.method ?? 'unknown') };
}

import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { config } from './config.js';
import { HttpError } from './http.js';

/**
 * Minimal OpenID Connect relying party: discovery, authorization code with PKCE (S256),
 * and ID token validation (signature against the issuer's JWKS, iss, aud, exp, nonce).
 */
export interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string }

const discoveryCache = new Map<string, { at: number; doc: Discovery }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function validateIssuer(issuer: string): string {
  let u: URL;
  try { u = new URL(issuer); } catch { throw new HttpError(400, 'Issuer must be a URL', 'validation'); }
  if (u.protocol !== 'https:' && !(config.ssoAllowInsecure && u.protocol === 'http:')) throw new HttpError(400, 'Issuer must use https', 'validation');
  if (u.search || u.hash) throw new HttpError(400, 'Issuer must not have a query or fragment', 'validation');
  return issuer.replace(/\/$/, '');
}

export async function discover(issuer: string): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 3600e3) return hit.doc;
  let doc: Discovery;
  try {
    const res = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(String(res.status));
    doc = await res.json() as Discovery;
  } catch {
    throw new HttpError(502, 'Could not reach the identity provider', 'idp_unavailable');
  }
  // The discovery document must describe the configured issuer (OIDC Discovery 4.3).
  if (doc.issuer?.replace(/\/$/, '') !== issuer) throw new HttpError(502, 'Identity provider issuer does not match the configuration', 'idp_mismatch');
  for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    const u = new URL(doc[k]);
    if (u.protocol !== 'https:' && !(config.ssoAllowInsecure && u.protocol === 'http:')) throw new HttpError(502, 'Identity provider endpoints must use https', 'idp_mismatch');
  }
  discoveryCache.set(issuer, { at: Date.now(), doc });
  return doc;
}

const b64url = (b: Buffer) => b.toString('base64url');

export function newAuthRequest() {
  const verifier = b64url(randomBytes(32));
  return {
    state: b64url(randomBytes(24)),
    nonce: b64url(randomBytes(24)),
    verifier,
    challenge: b64url(createHash('sha256').update(verifier).digest()),
  };
}

export function authorizationUrl(d: Discovery, p: { clientId: string; redirectUri: string; state: string; nonce: string; challenge: string; loginHint?: string; stepUp?: boolean }): string {
  const u = new URL(d.authorization_endpoint);
  const q: Record<string, string> = {
    response_type: 'code', client_id: p.clientId, redirect_uri: p.redirectUri, scope: 'openid email profile',
    state: p.state, nonce: p.nonce, code_challenge: p.challenge, code_challenge_method: 'S256',
  };
  if (p.loginHint) q.login_hint = p.loginHint;
  // Step-up for e-signatures: the person must authenticate again now.
  if (p.stepUp) { q.prompt = 'login'; q.max_age = '0'; }
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

export interface VerifiedIdentity { issuer: string; subject: string; email: string; name: string; authTime: number | null; claims: JWTPayload }

export async function exchangeCode(d: Discovery, p: { issuer: string; clientId: string; clientSecret?: string | null; code: string; redirectUri: string; verifier: string; nonce: string }): Promise<VerifiedIdentity> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier });
  if (p.clientSecret) body.set('client_secret', p.clientSecret);
  let tokens: { id_token?: string };
  try {
    const res = await fetch(d.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
    tokens = await res.json() as { id_token?: string };
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    throw new HttpError(401, 'The identity provider did not accept the sign-in', 'sso_failed');
  }
  if (!tokens.id_token) throw new HttpError(401, 'The identity provider returned no ID token', 'sso_failed');
  let jwks = jwksCache.get(d.jwks_uri);
  if (!jwks) { jwks = createRemoteJWKSet(new URL(d.jwks_uri)); jwksCache.set(d.jwks_uri, jwks); }
  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(tokens.id_token, jwks, { issuer: [p.issuer, `${p.issuer}/`], audience: p.clientId, clockTolerance: 60 }));
  } catch {
    throw new HttpError(401, 'The ID token could not be verified', 'sso_failed');
  }
  if (claims.nonce !== p.nonce) throw new HttpError(401, 'The ID token does not match this sign-in', 'sso_failed');
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  if (!email || claims.email_verified === false) throw new HttpError(401, 'The identity provider did not return a verified email', 'sso_failed');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new HttpError(401, 'The ID token has no subject', 'sso_failed');
  return {
    issuer: p.issuer, subject: claims.sub, email,
    name: typeof claims.name === 'string' && claims.name ? claims.name : email,
    authTime: typeof claims.auth_time === 'number' ? claims.auth_time : null, claims,
  };
}

/** Test hook: forget cached discovery documents and key sets. */
export function resetSsoCaches() { discoveryCache.clear(); jwksCache.clear(); }

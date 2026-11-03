import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';

/**
 * A small OpenID provider for tests: discovery, JWKS, an authorize endpoint that
 * "signs in" whoever the test chooses, and a token endpoint that checks PKCE.
 */
export interface MockIdp {
  issuer: string;
  /** Who the next authorization signs in as. */
  user: { sub: string; email: string; name?: string; emailVerified?: boolean };
  /** Seconds to subtract from auth_time (simulate a reused session). */
  authAgeSeconds: number;
  /** Override the nonce placed in the next ID token. */
  forceNonce?: string;
  lastAuthorize?: URLSearchParams;
  /** Follow an authorization URL like a browser and return the code and state sent to the redirect URI. */
  authorize(url: string): Promise<{ code: string; state: string }>;
  close(): Promise<void>;
}

export async function startMockIdp(clientId: string, clientSecret?: string): Promise<MockIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { challenge: string; nonce: string; redirectUri: string; user: MockIdp['user']; authTime: number }>();
  let server: Server;
  const idp = {} as MockIdp;
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', idp.issuer);
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer: idp.issuer, authorization_endpoint: `${idp.issuer}/authorize`, token_endpoint: `${idp.issuer}/token`, jwks_uri: `${idp.issuer}/jwks` });
    }
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const f = new URLSearchParams(raw);
      const c = codes.get(f.get('code') ?? '');
      codes.delete(f.get('code') ?? '');
      if (!c || f.get('client_id') !== clientId || f.get('redirect_uri') !== c.redirectUri) return json(400, { error: 'invalid_grant' });
      if (clientSecret && f.get('client_secret') !== clientSecret) return json(401, { error: 'invalid_client' });
      const { createHash } = await import('node:crypto');
      if (createHash('sha256').update(f.get('code_verifier') ?? '').digest('base64url') !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
      const idToken = await new SignJWT({
        email: c.user.email, email_verified: c.user.emailVerified ?? true, name: c.user.name ?? 'Test Person', nonce: c.nonce, auth_time: c.authTime,
      }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(idp.issuer).setAudience(clientId).setSubject(c.user.sub)
        .setIssuedAt().setExpirationTime('5m').sign(privateKey as KeyLike);
      return json(200, { access_token: 'at', token_type: 'Bearer', id_token: idToken });
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  idp.issuer = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  idp.user = { sub: 'idp-user-1', email: 'person@example.test' };
  idp.authAgeSeconds = 0;
  idp.authorize = async (authUrl: string) => {
    const u = new URL(authUrl);
    const q = u.searchParams;
    idp.lastAuthorize = q;
    if (q.get('client_id') !== clientId || q.get('code_challenge_method') !== 'S256' || q.get('response_type') !== 'code') throw new Error('bad authorize request');
    const code = Math.random().toString(36).slice(2);
    codes.set(code, {
      challenge: q.get('code_challenge')!, nonce: idp.forceNonce ?? q.get('nonce')!, redirectUri: q.get('redirect_uri')!, user: { ...idp.user },
      authTime: Math.floor(Date.now() / 1000) - idp.authAgeSeconds,
    });
    idp.forceNonce = undefined;
    return { code, state: q.get('state')! };
  };
  idp.close = () => new Promise<void>((r) => server.close(() => r()));
  return idp;
}

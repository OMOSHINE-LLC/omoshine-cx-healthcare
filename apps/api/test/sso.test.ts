import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { config } from '../src/config.js';
import { resetSsoCaches } from '../src/sso.js';
import { Client, createWorld, expectStatus, type World } from './helpers.js';
import { startMockIdp, type MockIdp } from './mock-idp.js';

let w: World;
let idp: MockIdp;
const domain = `h${Math.random().toString(36).slice(2, 8)}.test`;
const nurse = `nurse@${domain}`;
const REDIRECT = `${config.webBaseUrl}/sso/callback`;
let connectionId: string;

beforeAll(async () => {
  config.ssoAllowInsecure = true;
  resetSsoCaches();
  w = await createWorld();
  idp = await startMockIdp('omoshine-web', 'top-secret');
  const admin = new pg.Client({ connectionString: w.adminUrl });
  await admin.connect();
  await admin.query(`INSERT INTO app_user (tenant_id, email, name) VALUES ($1, $2, 'Nora Nurse')`, [w.tenant.tenantId, nurse]);
  await admin.end();
});
afterAll(async () => { await idp.close(); await w.close(); config.ssoAllowInsecure = false; });

async function ssoLogin(email: string) {
  const start = await w.anon.post('/auth/sso/start', { email, redirectUri: REDIRECT });
  if (start.status !== 200) return start;
  const { code, state } = await idp.authorize(start.body.authorizationUrl);
  return w.anon.post('/auth/sso/callback', { code, state });
}

describe('SSO configuration', () => {
  it('tenant administrators configure a connection; the secret is never returned', async () => {
    const body = { name: 'Hospital Entra ID', issuer: idp.issuer, clientId: 'omoshine-web', clientSecret: 'top-secret', emailDomains: [domain.toUpperCase()] };
    expect((await w.as.cxa.post('/sso-connections', body)).status).toBe(403);
    config.ssoAllowInsecure = false;
    expect((await w.as.admin.post('/sso-connections', body)).status).toBe(400);
    config.ssoAllowInsecure = true;
    const c = expectStatus(await w.as.admin.post('/sso-connections', body), 201);
    connectionId = c.id;
    expect(c).toMatchObject({ email_domains: [domain], hasClientSecret: true, auto_provision: false, allow_pin_signing: true });
    expect(JSON.stringify(c)).not.toContain('top-secret');
    expect(JSON.stringify(expectStatus(await w.as.admin.get('/sso-connections'), 200))).not.toContain('ciphertext');
    // A domain belongs to one connection.
    expect((await w.as.admin.post('/sso-connections', { ...body, name: 'Duplicate' })).status).toBe(409);
  });
});

describe('SSO sign-in', () => {
  it('rejects unknown domains and redirects off the web app', async () => {
    expect((await w.anon.post('/auth/sso/start', { email: 'x@nowhere.test', redirectUri: REDIRECT })).status).toBe(404);
    expect((await w.anon.post('/auth/sso/start', { email: nurse, redirectUri: 'https://evil.example/cb' })).status).toBe(400);
  });

  it('signs in an existing person with PKCE, links the identity, and the state is single use', async () => {
    idp.user = { sub: 'sub-nora', email: nurse, name: 'Nora N.' };
    const start = expectStatus(await w.anon.post('/auth/sso/start', { email: nurse, redirectUri: REDIRECT }), 200);
    const { code, state } = await idp.authorize(start.authorizationUrl);
    expect(idp.lastAuthorize!.get('login_hint')).toBe(nurse);
    const r = expectStatus(await w.anon.post('/auth/sso/callback', { code, state }), 200);
    expect(r.user.name).toBe('Nora Nurse');
    const me = expectStatus(await new Client(w.app, r.token).get('/me'), 200);
    expect(me.user).toMatchObject({ email: nurse, sso_linked: true });
    expect(me.signing).toEqual({ sso: true, pin: true });
    expect((await w.anon.post('/auth/sso/callback', { code, state })).status).toBe(401);
    expectStatus(await ssoLogin(nurse), 200);
  });

  it('refuses a different identity for a linked email, a wrong nonce and unverified email', async () => {
    idp.user = { sub: 'someone-else', email: nurse };
    const r = await ssoLogin(nurse);
    expect(r.status).toBe(403);
    expect(r.body.title).toMatch(/already linked to a different identity/);
    idp.user = { sub: 'sub-nora', email: nurse };
    idp.forceNonce = 'replayed';
    expect((await ssoLogin(nurse)).status).toBe(401);
    idp.user = { sub: 'sub-nora', email: nurse, emailVerified: false };
    expect((await ssoLogin(nurse)).status).toBe(401);
    // An identity at another domain cannot come in through this connection.
    idp.user = { sub: 'sub-x', email: 'x@other.test' };
    expect((await ssoLogin(nurse)).status).toBe(403);
  });

  it('only provisions new people when the connection allows it, and with no project roles', async () => {
    idp.user = { sub: 'sub-new', email: `new.hire@${domain}`, name: 'New Hire' };
    const refused = await ssoLogin(`new.hire@${domain}`);
    expect(refused.status).toBe(403);
    expect(refused.body.title).toMatch(/do not have an OMOSHINE account/);
    expectStatus(await w.as.admin.patch(`/sso-connections/${connectionId}`, { autoProvision: true }), 200);
    const r = expectStatus(await ssoLogin(`new.hire@${domain}`), 200);
    const me = expectStatus(await new Client(w.app, r.token).get('/me'), 200);
    expect(me.user.name).toBe('New Hire');
    expect(me.assignments).toEqual([]);
    expect((await new Client(w.app, r.token).get(`/projects/${w.ids.project}/readiness`)).status).toBe(403);
  });
});

describe('SSO step-up for e-signatures', () => {
  let nora: Client;
  beforeAll(async () => {
    idp.user = { sub: 'sub-nora', email: nurse };
    nora = new Client(w.app, expectStatus(await ssoLogin(nurse), 200).token);
  });

  it('forces a fresh sign-in at the identity provider and issues a re-authentication token', async () => {
    const s = expectStatus(await nora.post('/auth/sso/reauth/start', { redirectUri: REDIRECT }), 200);
    const { code, state } = await idp.authorize(s.authorizationUrl);
    expect(idp.lastAuthorize!.get('prompt')).toBe('login');
    expect(idp.lastAuthorize!.get('max_age')).toBe('0');
    const r = expectStatus(await nora.post('/auth/sso/reauth/callback', { code, state }), 200);
    expect(r.reauthToken).toEqual(expect.any(String));
    // People without SSO keep using the PIN.
    expect((await w.as.cxa.post('/auth/sso/reauth/start', { redirectUri: REDIRECT })).status).toBe(409);
  });

  it('refuses a reused session, someone else, or another user completing it', async () => {
    idp.authAgeSeconds = 3600;
    let s = expectStatus(await nora.post('/auth/sso/reauth/start', { redirectUri: REDIRECT }), 200);
    let a = await idp.authorize(s.authorizationUrl);
    expect((await nora.post('/auth/sso/reauth/callback', a)).status).toBe(401);
    idp.authAgeSeconds = 0;
    idp.user = { sub: 'someone-else', email: nurse };
    s = expectStatus(await nora.post('/auth/sso/reauth/start', { redirectUri: REDIRECT }), 200);
    a = await idp.authorize(s.authorizationUrl);
    expect((await nora.post('/auth/sso/reauth/callback', a)).status).toBe(401);
    idp.user = { sub: 'sub-nora', email: nurse };
    s = expectStatus(await nora.post('/auth/sso/reauth/start', { redirectUri: REDIRECT }), 200);
    a = await idp.authorize(s.authorizationUrl);
    expect((await w.as.cxa.post('/auth/sso/reauth/callback', a)).status).toBe(401);
  });

  it('when PIN signing is turned off, the PIN is refused and SSO is required', async () => {
    const admin = new pg.Client({ connectionString: w.adminUrl });
    await admin.connect();
    const { hashPin } = await import('../src/crypto.js');
    await admin.query('UPDATE app_user SET signing_pin_hash = $2 WHERE email = $1', [nurse, hashPin('2468')]);
    await admin.end();
    expectStatus(await nora.post('/auth/reauth', { pin: '2468' }), 200);
    expectStatus(await w.as.admin.patch(`/sso-connections/${connectionId}`, { allowPinSigning: false }), 200);
    const r = await nora.post('/auth/reauth', { pin: '2468' });
    expect(r.status).toBe(403);
    expect(r.body.title).toMatch(/requires single sign-on/);
    expect(expectStatus(await nora.get('/me'), 200).signing).toEqual({ sso: true, pin: false });
    // Deactivating the connection stops SSO sign-in.
    expectStatus(await w.as.admin.patch(`/sso-connections/${connectionId}`, { active: false }), 200);
    expect((await w.anon.post('/auth/sso/start', { email: nurse, redirectUri: REDIRECT })).status).toBe(404);
  });
});

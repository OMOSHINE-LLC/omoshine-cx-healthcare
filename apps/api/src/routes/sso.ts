import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appendAudit } from '../audit.js';
import { issueReauthToken, issueSessionToken } from '../auth.js';
import { config } from '../config.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import { withTenant, type Db, type Tx } from '../db.js';
import { HttpError, notFound, requireTenantAdmin, tenantTx } from '../http.js';
import { authorizationUrl, discover, exchangeCode, newAuthRequest, validateIssuer } from '../sso.js';

const uuid = z.string().uuid();
const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

function checkRedirect(uri: string): string {
  let u: URL;
  try { u = new URL(uri); } catch { throw new HttpError(400, 'Invalid redirect URI', 'validation'); }
  if (u.origin !== new URL(config.webBaseUrl).origin || u.search || u.hash) throw new HttpError(400, 'Redirect URI must be on the OMOSHINE web app', 'validation');
  return uri;
}

interface Consumed {
  connection_id: string; tenant_id: string; purpose: 'login' | 'reauth'; user_id: string | null; code_verifier: string; nonce: string; redirect_uri: string;
  issuer: string; client_id: string; client_secret_ciphertext: string | null; auto_provision: boolean;
}

async function consume(db: Db, state: string, purpose: 'login' | 'reauth'): Promise<Consumed> {
  const s = (await db.query<Consumed>('SELECT * FROM sso_consume($1)', [state])).rows[0];
  if (!s || s.purpose !== purpose) throw new HttpError(401, 'This sign-in link has expired or was already used. Start again.', 'sso_failed');
  return s;
}

async function verify(s: Consumed, code: string) {
  const d = await discover(s.issuer);
  return exchangeCode(d, {
    issuer: s.issuer, clientId: s.client_id, clientSecret: s.client_secret_ciphertext ? decryptSecret(s.client_secret_ciphertext) : null,
    code, redirectUri: s.redirect_uri, verifier: s.code_verifier, nonce: s.nonce,
  });
}

/** The active connection for a user's email domain, if any. */
export async function connectionForEmail(db: Db | Tx, email: string) {
  return (await db.query<{ id: string; tenant_id: string; issuer: string; client_id: string; allow_pin_signing: boolean }>(
    'SELECT * FROM sso_connection_for_domain($1)', [domainOf(email)])).rows[0] ?? null;
}

const OUTCOME_MESSAGE: Record<string, string> = {
  no_account: 'You do not have an OMOSHINE account yet. Ask your administrator to add you.',
  wrong_tenant: 'This identity belongs to a different organization.',
  identity_mismatch: 'This email is already linked to a different identity at your identity provider. Contact your administrator.',
};

export async function ssoRoutes(api: FastifyInstance, db: Db) {
  // --- Sign-in ----------------------------------------------------------------------
  api.post('/auth/sso/start', async (req) => {
    const b = z.object({ email: z.string().email(), redirectUri: z.string() }).parse(req.body);
    const redirectUri = checkRedirect(b.redirectUri);
    const c = await connectionForEmail(db, b.email);
    if (!c) throw new HttpError(404, 'Single sign-on is not set up for this email domain', 'no_sso');
    const d = await discover(c.issuer);
    const r = newAuthRequest();
    await db.query('SELECT sso_begin($1,$2,$3,$4,$5,$6,$7)', [r.state, c.id, 'login', null, r.verifier, r.nonce, redirectUri]);
    return { authorizationUrl: authorizationUrl(d, { clientId: c.client_id, redirectUri, state: r.state, nonce: r.nonce, challenge: r.challenge, loginHint: b.email }) };
  });

  api.post('/auth/sso/callback', async (req) => {
    const b = z.object({ code: z.string().min(1).max(4096), state: z.string().min(16).max(200) }).parse(req.body);
    const s = await consume(db, b.state, 'login');
    const id = await verify(s, b.code);
    // The identity's email must belong to this connection's domains.
    const c = await connectionForEmail(db, id.email);
    if (!c || c.id !== s.connection_id) throw new HttpError(403, 'This email domain does not sign in through this identity provider', 'sso_failed');
    const u = (await db.query<{ id: string | null; name: string | null; outcome: string }>(
      'SELECT * FROM sso_resolve_user($1,$2,$3,$4,$5,$6)', [s.tenant_id, id.email, id.name, id.issuer, id.subject, s.auto_provision])).rows[0]!;
    if (!u.id) {
      await withTenant(db, s.tenant_id, (tx) => appendAudit(tx, s.tenant_id, { actorId: null, action: 'auth.sso.refused', entityType: 'sso_connection', entityId: s.connection_id, data: { email: id.email, outcome: u.outcome } }));
      throw new HttpError(403, OUTCOME_MESSAGE[u.outcome] ?? 'Sign-in refused', 'sso_refused');
    }
    await withTenant(db, s.tenant_id, (tx) =>
      appendAudit(tx, s.tenant_id, { actorId: u.id!, action: 'auth.login', entityType: 'user', entityId: u.id!, data: { method: 'oidc', connectionId: s.connection_id, outcome: u.outcome } }));
    return { token: await issueSessionToken({ userId: u.id, tenantId: s.tenant_id, name: u.name! }), user: { id: u.id, name: u.name } };
  });

  // --- Step-up re-authentication for e-signatures -----------------------------------
  api.post('/auth/sso/reauth/start', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const b = z.object({ redirectUri: z.string() }).parse(req.body);
      const redirectUri = checkRedirect(b.redirectUri);
      const me = (await tx.query<{ email: string; sso_subject: string | null }>('SELECT email, sso_subject FROM app_user WHERE id = $1', [p.userId])).rows[0]!;
      const c = await connectionForEmail(tx, me.email);
      if (!c || !me.sso_subject) throw new HttpError(409, 'Your account does not sign in with single sign-on; use your signing PIN', 'no_sso');
      const d = await discover(c.issuer);
      const r = newAuthRequest();
      await tx.query('SELECT sso_begin($1,$2,$3,$4,$5,$6,$7)', [r.state, c.id, 'reauth', p.userId, r.verifier, r.nonce, redirectUri]);
      return { authorizationUrl: authorizationUrl(d, { clientId: c.client_id, redirectUri, state: r.state, nonce: r.nonce, challenge: r.challenge, loginHint: me.email, stepUp: true }) };
    }),
  );

  api.post('/auth/sso/reauth/callback', async (req) => {
    const b = z.object({ code: z.string().min(1).max(4096), state: z.string().min(16).max(200) }).parse(req.body);
    return tenantTx(db, req, async (tx, p) => {
      const s = await consume(db, b.state, 'reauth');
      if (s.user_id !== p.userId) throw new HttpError(401, 'This re-authentication was started by someone else', 'reauth_failed');
      const id = await verify(s, b.code);
      const me = (await tx.query<{ sso_issuer: string; sso_subject: string }>('SELECT sso_issuer, sso_subject FROM app_user WHERE id = $1', [p.userId])).rows[0]!;
      if (me.sso_issuer !== id.issuer || me.sso_subject !== id.subject) throw new HttpError(401, 'You signed in as a different person at the identity provider', 'reauth_failed');
      // The identity provider must report a fresh authentication, not a reused session.
      if (!id.authTime || Date.now() / 1000 - id.authTime > config.reauthMaxAgeSeconds) {
        throw new HttpError(401, 'The identity provider did not confirm a fresh sign-in; try again', 'reauth_failed');
      }
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'auth.reauth', entityType: 'user', entityId: p.userId, data: { method: 'oidc' } });
      return { reauthToken: await issueReauthToken(p, 'oidc'), expiresInSeconds: config.reauthMaxAgeSeconds };
    });
  });

  // --- Administration -----------------------------------------------------------------
  const view = (c: Record<string, unknown> & { client_secret_ciphertext?: string | null }) => {
    const { client_secret_ciphertext, ...rest } = c;
    return { ...rest, hasClientSecret: !!client_secret_ciphertext };
  };
  const domains = z.array(z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Use a bare domain such as hospital.org').transform((d) => d.toLowerCase())).min(1).max(20);

  api.get('/sso-connections', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      await requireTenantAdmin(tx, p);
      return (await tx.query('SELECT * FROM sso_connection ORDER BY created_at')).rows.map(view);
    }),
  );

  api.post('/sso-connections', async (req, reply) =>
    tenantTx(db, req, async (tx, p) => {
      await requireTenantAdmin(tx, p);
      const b = z.object({
        name: z.string().min(2).max(100), issuer: z.string().max(500), clientId: z.string().min(1).max(300), clientSecret: z.string().max(2000).optional(),
        emailDomains: domains, autoProvision: z.boolean().default(false), allowPinSigning: z.boolean().default(true),
      }).parse(req.body);
      const issuer = validateIssuer(b.issuer);
      const row = (await tx.query(
        `INSERT INTO sso_connection (tenant_id, name, issuer, client_id, client_secret_ciphertext, email_domains, auto_provision, allow_pin_signing, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [p.tenantId, b.name, issuer, b.clientId, b.clientSecret ? encryptSecret(b.clientSecret) : null, b.emailDomains, b.autoProvision, b.allowPinSigning, p.userId])).rows[0];
      for (const d of b.emailDomains) await tx.query('INSERT INTO sso_domain (domain, connection_id, tenant_id) VALUES ($1,$2,$3)', [d, row.id, p.tenantId]);
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'sso.connection.create', entityType: 'sso_connection', entityId: row.id,
        data: { name: b.name, issuer, clientId: b.clientId, emailDomains: b.emailDomains, autoProvision: b.autoProvision, allowPinSigning: b.allowPinSigning } });
      reply.status(201);
      return view(row);
    }),
  );

  api.patch('/sso-connections/:id', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      await requireTenantAdmin(tx, p);
      const { id } = z.object({ id: uuid }).parse(req.params);
      const b = z.object({
        active: z.boolean().optional(), autoProvision: z.boolean().optional(), allowPinSigning: z.boolean().optional(),
        clientSecret: z.string().max(2000).nullable().optional(), emailDomains: domains.optional(),
      }).parse(req.body);
      const cur = (await tx.query('SELECT * FROM sso_connection WHERE id = $1', [id])).rows[0];
      if (!cur) throw notFound('SSO connection');
      const row = (await tx.query(
        `UPDATE sso_connection SET active = $2, auto_provision = $3, allow_pin_signing = $4, client_secret_ciphertext = $5, email_domains = $6 WHERE id = $1 RETURNING *`,
        [id, b.active ?? cur.active, b.autoProvision ?? cur.auto_provision, b.allowPinSigning ?? cur.allow_pin_signing,
          b.clientSecret === undefined ? cur.client_secret_ciphertext : b.clientSecret ? encryptSecret(b.clientSecret) : null, b.emailDomains ?? cur.email_domains])).rows[0];
      if (b.emailDomains) {
        await tx.query('DELETE FROM sso_domain WHERE connection_id = $1', [id]);
        for (const d of b.emailDomains) await tx.query('INSERT INTO sso_domain (domain, connection_id, tenant_id) VALUES ($1,$2,$3)', [d, id, p.tenantId]);
      }
      const { clientSecret, ...logged } = b;
      await appendAudit(tx, p.tenantId, { actorId: p.userId, action: 'sso.connection.update', entityType: 'sso_connection', entityId: id, data: { ...logged, clientSecretChanged: clientSecret !== undefined } });
      return view(row);
    }),
  );
}

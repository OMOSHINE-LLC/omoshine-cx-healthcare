import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { appendAudit } from '../audit.js';
import { issueReauthToken, issueSessionToken } from '../auth.js';
import { config } from '../config.js';
import { verifyPin } from '../crypto.js';
import { withTenant, type Db } from '../db.js';
import { HttpError, tenantTx } from '../http.js';
import { connectionForEmail } from './sso.js';

export async function authRoutes(api: FastifyInstance, db: Db) {
  /** Development login (email + PIN). Production deployments use OIDC/SAML through the IdP broker. */
  api.post('/auth/dev-login', async (req) => {
    if (config.authMode !== 'dev') throw new HttpError(404, 'Not found');
    const body = z.object({ email: z.string().email(), pin: z.string().min(4) }).parse(req.body);
    const r = await db.query<{ id: string; tenant_id: string; name: string; signing_pin_hash: string | null }>(
      'SELECT * FROM auth_lookup_user($1)',
      [body.email],
    );
    const u = r.rows[0];
    if (!u || !verifyPin(body.pin, u.signing_pin_hash)) throw new HttpError(401, 'Invalid credentials', 'unauthenticated');
    await withTenant(db, u.tenant_id, (tx) =>
      appendAudit(tx, u.tenant_id, { actorId: u.id, action: 'auth.login', entityType: 'user', entityId: u.id, data: { method: 'dev_pin' } }),
    );
    return { token: await issueSessionToken({ userId: u.id, tenantId: u.tenant_id, name: u.name }), user: { id: u.id, name: u.name } };
  });

  /** Step-up re-authentication before an e-signature. */
  api.post('/auth/reauth', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const body = z.object({ pin: z.string().min(4) }).parse(req.body);
      const r = await tx.query<{ signing_pin_hash: string | null; email: string }>('SELECT signing_pin_hash, email FROM app_user WHERE id = $1', [p.userId]);
      const sso = r.rows[0] ? await connectionForEmail(tx, r.rows[0].email) : null;
      if (sso && !sso.allow_pin_signing) throw new HttpError(403, 'Your organization requires single sign-on to sign; re-authenticate with SSO', 'sso_required');
      if (!verifyPin(body.pin, r.rows[0]?.signing_pin_hash)) throw new HttpError(401, 'Re-authentication failed', 'reauth_failed');
      return { reauthToken: await issueReauthToken(p, 'pin'), expiresInSeconds: config.reauthMaxAgeSeconds };
    }),
  );

  api.get('/me', async (req) =>
    tenantTx(db, req, async (tx, p) => {
      const u = await tx.query('SELECT id, email, name, is_tenant_admin, organization_id, sso_subject IS NOT NULL AS sso_linked FROM app_user WHERE id = $1', [p.userId]);
      const a = await tx.query('SELECT project_id, role, scope_type, scope_id FROM role_assignment WHERE user_id = $1', [p.userId]);
      const sso = u.rows[0] ? await connectionForEmail(tx, u.rows[0].email) : null;
      return { user: u.rows[0], assignments: a.rows, signing: { sso: !!sso && !!u.rows[0]?.sso_linked, pin: !sso || sso.allow_pin_signing } };
    }),
  );

  api.get('/organizations', async (req) => tenantTx(db, req, async (tx) => (await tx.query('SELECT * FROM organization ORDER BY name')).rows));
}

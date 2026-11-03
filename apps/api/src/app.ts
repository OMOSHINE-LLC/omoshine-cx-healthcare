import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { verifySessionToken, type Principal } from './auth.js';
import type { Db } from './db.js';
import { HttpError } from './http.js';
import { authRoutes } from './routes/auth.js';
import { libraryRoutes } from './routes/library.js';
import { projectRoutes } from './routes/projects.js';
import { testRoutes } from './routes/tests.js';
import { issueRoutes } from './routes/issues.js';
import { roomRoutes } from './routes/rooms.js';
import { eesRoutes } from './routes/ees.js';
import { reportRoutes } from './routes/reports.js';
import { icraRoutes } from './routes/icra.js';
import { medgasRoutes } from './routes/medgas.js';
import { binderRoutes } from './routes/binder.js';
import { API_KEY_PATTERN, integrationRoutes } from './routes/integrations.js';
import { connectorRoutes } from './routes/connectors.js';
import { lifeSafetyRoutes } from './routes/lifesafety.js';
import { activationRoutes } from './routes/activation.js';
import { ssoRoutes } from './routes/sso.js';
import { turnoverRoutes } from './routes/turnover.js';
import { sha256 } from './crypto.js';
import { timingSafeEqual } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
export const LOGO_PATH = join(here, '..', 'assets', 'omoshine-logo.png');

const PUBLIC_ROUTES = new Set(['/api/v1/auth/dev-login', '/api/v1/auth/sso/start', '/api/v1/auth/sso/callback', '/api/v1/health', '/brand/logo.png']);

/** Resolve an integration API key to its service user. */
async function principalForApiKey(db: Db, token: string): Promise<Principal> {
  const m = API_KEY_PATTERN.exec(token);
  const bad = () => new HttpError(401, 'Invalid API key', 'unauthenticated');
  if (!m) throw bad();
  const row = (await db.query<{ key_id: string; tenant_id: string; user_id: string; user_name: string; secret_sha256: string }>(
    'SELECT * FROM resolve_api_key($1)', [m[1]])).rows[0];
  const given = Buffer.from(sha256(m[2]!), 'hex');
  if (!row || !timingSafeEqual(given, Buffer.from(row.secret_sha256, 'hex'))) throw bad();
  await db.query('SELECT touch_api_key($1)', [row.key_id]);
  return { userId: row.user_id, tenantId: row.tenant_id, name: row.user_name };
}

export async function buildApp(opts: { db: Db; logger?: boolean; fetchImpl?: typeof fetch }): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 10 * 1024 * 1024 });
  await app.register(cors, { origin: true });

  app.addHook('onRequest', async (req: FastifyRequest) => {
    const path = req.url.split('?')[0] ?? '';
    if (PUBLIC_ROUTES.has(path) || req.method === 'OPTIONS') return;
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'Authentication required', 'unauthenticated');
    const token = header.slice(7);
    if (token.startsWith('omk_')) {
      (req as FastifyRequest & { principal?: Principal }).principal = await principalForApiKey(opts.db, token);
      return;
    }
    try {
      (req as FastifyRequest & { principal?: Principal }).principal = await verifySessionToken(token);
    } catch {
      throw new HttpError(401, 'Invalid or expired session', 'unauthenticated');
    }
  });

  app.setErrorHandler((err: Error & { code?: string; statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ type: err.code, title: err.message, status: err.status });
    if (err instanceof ZodError) return reply.status(400).send({ type: 'validation', title: 'Invalid request', status: 400, errors: err.issues });
    if (err.code === 'P0001' && err.message.startsWith('IMMUTABLE')) return reply.status(423).send({ type: 'locked', title: err.message, status: 423 });
    if (err.code === '42501') return reply.status(423).send({ type: 'locked', title: 'Record is append-only', status: 423 });
    if (err.code === '23505') return reply.status(409).send({ type: 'conflict', title: 'Duplicate record', status: 409 });
    if (err.code === '23503') return reply.status(400).send({ type: 'reference', title: 'Referenced record does not exist', status: 400 });
    if (err.code === '22P02') return reply.status(400).send({ type: 'validation', title: 'Malformed identifier', status: 400 });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ type: 'error', title: err.message, status: err.statusCode });
    app.log.error(err);
    return reply.status(500).send({ type: 'internal', title: 'Internal error', status: 500 });
  });

  app.get('/api/v1/health', async () => ({ ok: true, product: 'OMOSHINE CX Planner – Healthcare Edition' }));
  app.get('/brand/logo.png', async (_req, reply) => reply.type('image/png').send(readFileSync(LOGO_PATH)));

  await app.register(async (api) => {
    await authRoutes(api, opts.db);
    await libraryRoutes(api);
    await projectRoutes(api, opts.db);
    await testRoutes(api, opts.db);
    await issueRoutes(api, opts.db);
    await roomRoutes(api, opts.db);
    await eesRoutes(api, opts.db);
    await reportRoutes(api, opts.db);
    await icraRoutes(api, opts.db);
    await medgasRoutes(api, opts.db);
    await binderRoutes(api, opts.db);
    await integrationRoutes(api, opts.db);
    await connectorRoutes(api, opts.db, () => opts.fetchImpl ?? fetch);
    await lifeSafetyRoutes(api, opts.db);
    await activationRoutes(api, opts.db);
    await ssoRoutes(api, opts.db);
    await turnoverRoutes(api, opts.db);
  }, { prefix: '/api/v1' });

  return app;
}

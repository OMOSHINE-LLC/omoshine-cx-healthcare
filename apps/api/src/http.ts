import type { FastifyRequest } from 'fastify';
import {
  EES_REQUIREMENTS,
  SPACE_REQUIREMENTS,
  applyOverlays,
  findStateProfile,
  type JurisdictionOverlay,
  type Requirement,
} from '@omoshine/rules';
import { loadAssignments, rolesWithPermission, type Permission, type Role, type Scope } from './access.js';
import type { Principal } from './auth.js';
import type { Db, Tx } from './db.js';
import { withTenant } from './db.js';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error') {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`, 'not_found');
export const forbidden = (msg = 'You do not have permission for this action') => new HttpError(403, msg, 'forbidden');

export function principal(req: FastifyRequest): Principal {
  const p = (req as FastifyRequest & { principal?: Principal }).principal;
  if (!p) throw new HttpError(401, 'Authentication required', 'unauthenticated');
  return p;
}

export function tenantTx<T>(db: Db, req: FastifyRequest, fn: (tx: Tx, p: Principal) => Promise<T>): Promise<T> {
  const p = principal(req);
  return withTenant(db, p.tenantId, (tx) => fn(tx, p));
}

export async function isTenantAdmin(tx: Tx, userId: string): Promise<boolean> {
  const r = await tx.query<{ is_tenant_admin: boolean }>('SELECT is_tenant_admin FROM app_user WHERE id = $1', [userId]);
  return !!r.rows[0]?.is_tenant_admin;
}

/** Throws 403 unless the user holds a role with `perm` covering `scope`. Returns the qualifying roles. */
export async function requirePermission(tx: Tx, p: Principal, scope: Scope | null, perm: Permission): Promise<Role[]> {
  if (!scope) throw notFound('Resource');
  const roles = rolesWithPermission(await loadAssignments(tx, p.userId, scope.projectId), scope, perm);
  if (roles.length === 0) {
    if (perm === 'read' && (await isTenantAdmin(tx, p.userId))) return ['owner'];
    throw forbidden();
  }
  return roles;
}

export async function requireTenantAdmin(tx: Tx, p: Principal): Promise<void> {
  if (!(await isTenantAdmin(tx, p.userId))) throw forbidden('Tenant administrator required');
}

/** State overlays from the rules library plus project/AHJ overlays stored for the project. */
export async function overlaysForProject(tx: Tx, projectId: string): Promise<JurisdictionOverlay[]> {
  const proj = await tx.query<{ state_code: string }>('SELECT state_code FROM project WHERE id = $1', [projectId]);
  const state = proj.rows[0] ? findStateProfile(proj.rows[0].state_code) : undefined;
  const rows = await tx.query<{
    id: string; action: 'replace' | 'add' | 'disable'; requirement_key: string; requirement: Partial<Requirement> | null; effective_date: Date; source_note: string; verified: boolean;
  }>('SELECT * FROM project_overlay WHERE project_id = $1 ORDER BY created_at', [projectId]);
  const projectOverlays: JurisdictionOverlay[] = rows.rows.map((r) => ({
    id: r.id,
    stateCode: proj.rows[0]?.state_code ?? '',
    action: r.action,
    requirementKey: r.requirement_key,
    requirement: r.requirement ?? undefined,
    effectiveDate: r.effective_date.toISOString().slice(0, 10),
    sourceNote: r.source_note,
    verified: r.verified,
  }));
  return [...(state?.overlays ?? []), ...projectOverlays];
}

export async function requirementsForProject(tx: Tx, projectId: string): Promise<Requirement[]> {
  return applyOverlays([...SPACE_REQUIREMENTS, ...EES_REQUIREMENTS], await overlaysForProject(tx, projectId));
}

export async function projectIdOf(tx: Tx, table: 'building' | 'phase' | 'system', id: string): Promise<string> {
  const r = await tx.query<{ project_id: string }>(`SELECT project_id FROM ${table} WHERE id = $1`, [id]);
  if (!r.rows[0]) throw notFound(table);
  return r.rows[0].project_id;
}

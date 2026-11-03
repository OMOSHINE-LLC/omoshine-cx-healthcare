import type { Tx } from './db.js';

export const ROLES = [
  'owner',
  'cxa',
  'gc',
  'trade',
  'infection_prevention',
  'safety_officer',
  'clinical_rep',
  'medgas_verifier',
  'tab',
  'ahj',
  'design_engineer',
  'facilities_ops',
] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | 'read'
  | 'project.manage'
  | 'hierarchy.edit'
  | 'template.edit'
  | 'test.execute'
  | 'test.sign'
  | 'issue.create'
  | 'issue.update'
  | 'measurement.record'
  | 'ees.record'
  | 'icra.manage'
  | 'icra.log'
  | 'icra.approve'
  | 'ilsm.manage'
  | 'firewatch.log'
  | 'medgas.manage'
  | 'medgas.test';

/**
 * Role → permission matrix. AHJ / Inspector is read-and-sign only.
 * Clinical reps and infection prevention can raise issues but not execute tests in the MVP.
 */
export const PERMISSIONS: Record<Role, Permission[]> = {
  owner: ['read', 'project.manage', 'hierarchy.edit', 'template.edit', 'test.sign', 'issue.create', 'issue.update', 'ilsm.manage'],
  cxa: ['read', 'project.manage', 'hierarchy.edit', 'template.edit', 'test.execute', 'test.sign', 'issue.create', 'issue.update', 'measurement.record', 'ees.record', 'icra.manage', 'icra.log', 'ilsm.manage', 'firewatch.log', 'medgas.manage'],
  gc: ['read', 'test.execute', 'test.sign', 'issue.create', 'issue.update', 'icra.manage', 'icra.log', 'firewatch.log', 'medgas.manage'],
  trade: ['read', 'test.execute', 'test.sign', 'issue.update', 'icra.log', 'firewatch.log'],
  infection_prevention: ['read', 'issue.create', 'issue.update', 'test.sign', 'icra.manage', 'icra.log', 'icra.approve'],
  safety_officer: ['read', 'issue.create', 'issue.update', 'test.sign', 'ilsm.manage', 'firewatch.log'],
  clinical_rep: ['read', 'issue.create'],
  medgas_verifier: ['read', 'test.execute', 'test.sign', 'issue.create', 'medgas.manage', 'medgas.test'],
  tab: ['read', 'measurement.record', 'test.execute', 'test.sign', 'issue.update'],
  ahj: ['read', 'test.sign'],
  design_engineer: ['read', 'issue.create', 'issue.update'],
  facilities_ops: ['read', 'issue.create', 'ees.record', 'test.execute', 'test.sign', 'firewatch.log'],
};

/** Signature meanings each role may apply. */
export const SIGNATURE_MEANINGS: Record<Role, string[]> = {
  owner: ['reviewed', 'approved'],
  cxa: ['performed', 'witnessed', 'reviewed', 'approved'],
  gc: ['performed', 'witnessed'],
  trade: ['performed'],
  infection_prevention: ['reviewed', 'approved'],
  safety_officer: ['reviewed', 'approved'],
  clinical_rep: [],
  medgas_verifier: ['performed', 'approved'],
  tab: ['performed'],
  ahj: ['ahj_accepted'],
  design_engineer: [],
  facilities_ops: ['performed', 'witnessed'],
};

export interface Scope {
  projectId: string;
  phaseId?: string | null;
  departmentId?: string | null;
  systemId?: string | null;
}

export interface Assignment {
  role: Role;
  scope_type: 'project' | 'phase' | 'department' | 'system';
  scope_id: string;
}

/** Pure scope check: does any assignment cover the target scope? */
export function assignmentsCovering(assignments: Assignment[], scope: Scope): Assignment[] {
  return assignments.filter((a) => {
    switch (a.scope_type) {
      case 'project': return a.scope_id === scope.projectId;
      case 'phase': return !!scope.phaseId && a.scope_id === scope.phaseId;
      case 'department': return !!scope.departmentId && a.scope_id === scope.departmentId;
      case 'system': return !!scope.systemId && a.scope_id === scope.systemId;
    }
  });
}

export function rolesWithPermission(assignments: Assignment[], scope: Scope, perm: Permission): Role[] {
  return assignmentsCovering(assignments, scope)
    .map((a) => a.role)
    .filter((r) => PERMISSIONS[r]?.includes(perm));
}

export async function loadAssignments(tx: Tx, userId: string, projectId: string): Promise<Assignment[]> {
  const r = await tx.query<Assignment>(
    'SELECT role, scope_type, scope_id FROM role_assignment WHERE user_id = $1 AND project_id = $2',
    [userId, projectId],
  );
  return r.rows;
}

// --- Scope resolution for each kind of target -------------------------------

export async function scopeOfRoom(tx: Tx, roomId: string): Promise<Scope | null> {
  const r = await tx.query<{ project_id: string; phase_id: string | null; department_id: string }>(
    `SELECT b.project_id, COALESCE(rm.phase_id, d.phase_id) AS phase_id, d.id AS department_id
       FROM room rm JOIN department d ON d.id = rm.department_id
       JOIN floor f ON f.id = d.floor_id JOIN building b ON b.id = f.building_id
      WHERE rm.id = $1`,
    [roomId],
  );
  const row = r.rows[0];
  return row ? { projectId: row.project_id, phaseId: row.phase_id, departmentId: row.department_id } : null;
}

export async function scopeOfSystem(tx: Tx, systemId: string): Promise<Scope | null> {
  const r = await tx.query<{ project_id: string }>('SELECT project_id FROM system WHERE id = $1', [systemId]);
  const row = r.rows[0];
  return row ? { projectId: row.project_id, systemId } : null;
}

export async function scopeOfAsset(tx: Tx, assetId: string): Promise<Scope | null> {
  const r = await tx.query<{ project_id: string; system_id: string; room_id: string | null }>(
    'SELECT s.project_id, a.system_id, a.room_id FROM asset a JOIN system s ON s.id = a.system_id WHERE a.id = $1',
    [assetId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const roomScope = row.room_id ? await scopeOfRoom(tx, row.room_id) : null;
  return { projectId: row.project_id, systemId: row.system_id, phaseId: roomScope?.phaseId, departmentId: roomScope?.departmentId };
}

export async function scopeOfTarget(tx: Tx, type: 'room' | 'system' | 'asset', id: string): Promise<Scope | null> {
  if (type === 'room') return scopeOfRoom(tx, id);
  if (type === 'system') return scopeOfSystem(tx, id);
  return scopeOfAsset(tx, id);
}

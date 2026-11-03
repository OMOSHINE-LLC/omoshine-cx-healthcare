/**
 * Issue sync to Procore (Observations) and Autodesk Construction Cloud (Issues).
 * One-way: OMOSHINE is the record of truth for commissioning issues; the
 * construction platform gets a mirrored item the GC can work in. Payload shapes
 * follow each provider's public REST API and must be confirmed in a sandbox
 * account before go-live (see README).
 */
import { HttpError } from './http.js';
import { config } from './config.js';

export type Provider = 'procore' | 'acc';

export const PROVIDER_HOSTS: Record<Provider, string[]> = {
  procore: ['api.procore.com', 'sandbox.procore.com'],
  acc: ['developer.api.autodesk.com'],
};

export function checkConnectorBaseUrl(provider: Provider, raw: string, allowAny = config.connectorAllowAnyHost): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new HttpError(400, 'Base URL is not a valid URL', 'validation'); }
  if (!allowAny && (u.protocol !== 'https:' || !PROVIDER_HOSTS[provider].includes(u.hostname))) {
    throw new HttpError(400, `Base URL must be https on ${PROVIDER_HOSTS[provider].join(' or ')}`, 'validation');
  }
  return u.origin;
}

export interface SyncIssue {
  id: string; number: number; title: string; description: string; status: string; priority: string;
  life_safety: boolean; due_date: string | null; room_number: string | null; requirement_key: string | null;
}

export interface ConnectionInfo { provider: Provider; base_url: string; external_project_id: string; settings: Record<string, unknown> }

const PROCORE_STATUS: Record<string, string> = { open: 'initiated', in_progress: 'initiated', ready_for_review: 'ready_for_review', closed: 'closed' };
const PROCORE_PRIORITY: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Urgent' };
const ACC_STATUS: Record<string, string> = { open: 'open', in_progress: 'in_progress', ready_for_review: 'in_review', closed: 'closed' };

export function externalTitle(i: SyncIssue): string {
  return `${i.life_safety ? '[LIFE SAFETY] ' : ''}CX-${i.number}: ${i.title}`.slice(0, 255);
}

export function externalDescription(i: SyncIssue): string {
  return [
    i.description,
    i.room_number ? `Room: ${i.room_number}` : '',
    i.requirement_key ? `Requirement: ${i.requirement_key}` : '',
    `Priority: ${i.priority}${i.life_safety ? ' · Life safety' : ''}`,
    'Synced from OMOSHINE CX Planner. Close it in OMOSHINE; changes made here are not copied back.',
  ].filter(Boolean).join('\n\n');
}

/** Build the request for creating or updating the mirrored item. */
export function buildRequest(c: ConnectionInfo, i: SyncIssue, externalId: string | null): { method: 'POST' | 'PATCH'; url: string; headers: Record<string, string>; body: unknown } {
  if (c.provider === 'procore') {
    const companyId = String(c.settings.companyId ?? '');
    if (!companyId) throw new HttpError(400, 'Procore connection needs settings.companyId', 'validation');
    const observation: Record<string, unknown> = {
      name: externalTitle(i), description: externalDescription(i), status: PROCORE_STATUS[i.status] ?? 'initiated',
      priority: PROCORE_PRIORITY[i.priority] ?? 'Medium', ...(i.due_date ? { due_date: i.due_date } : {}),
    };
    if (!externalId && c.settings.observationTypeId) observation.type_id = Number(c.settings.observationTypeId);
    return {
      method: externalId ? 'PATCH' : 'POST',
      url: externalId
        ? `${c.base_url}/rest/v1.0/observations/items/${encodeURIComponent(externalId)}?project_id=${encodeURIComponent(c.external_project_id)}`
        : `${c.base_url}/rest/v1.0/observations/items?project_id=${encodeURIComponent(c.external_project_id)}`,
      headers: { 'Procore-Company-Id': companyId },
      body: { observation },
    };
  }
  const subtype = String(c.settings.issueSubtypeId ?? '');
  if (!externalId && !subtype) throw new HttpError(400, 'ACC connection needs settings.issueSubtypeId', 'validation');
  const base = `${c.base_url}/construction/issues/v1/projects/${encodeURIComponent(c.external_project_id)}/issues`;
  return {
    method: externalId ? 'PATCH' : 'POST',
    url: externalId ? `${base}/${encodeURIComponent(externalId)}` : base,
    headers: {},
    body: {
      title: externalTitle(i), description: externalDescription(i), status: ACC_STATUS[i.status] ?? 'open',
      ...(externalId ? {} : { issueSubtypeId: subtype }), ...(i.due_date ? { dueDate: i.due_date } : {}),
    },
  };
}

/** Pull the provider's id for the created item out of its response. */
export function externalIdFrom(provider: Provider, json: unknown): string | null {
  const j = json as Record<string, unknown> | null;
  if (!j) return null;
  const id = provider === 'procore' ? j.id : (j.id ?? (j.data as Record<string, unknown> | undefined)?.id);
  return id === undefined || id === null ? null : String(id);
}

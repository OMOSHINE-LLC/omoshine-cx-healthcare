/**
 * Operations turnover: the documents each system hands to the owner, warranty
 * tracking, and readiness of the turnover package.
 *
 * Wording is OMOSHINE's own. The document list follows common hospital
 * commissioning practice and is verified=false until OMOSHINE's reviewer
 * confirms it; owners may add requirements per project.
 */

export type TurnoverKind =
  | 'om_manual' | 'warranty' | 'as_built' | 'training_record' | 'spare_parts'
  | 'tab_report' | 'acceptance_test_report' | 'sequence_of_operations' | 'certificate';

export const TURNOVER_KINDS: Record<TurnoverKind, { label: string; hint: string }> = {
  om_manual: { label: 'Operation and maintenance manual', hint: 'Approved O&M data with maintenance tasks and intervals' },
  warranty: { label: 'Warranty', hint: 'Warranty certificate with start date and length' },
  as_built: { label: 'As-built drawings', hint: 'Record drawings reflecting installed conditions' },
  training_record: { label: 'Owner training record', hint: 'Agenda, attendees and sign-in sheet' },
  spare_parts: { label: 'Spare parts and attic stock', hint: 'List of spares and attic stock delivered to the owner' },
  tab_report: { label: 'Final test and balance report', hint: 'Accepted TAB report' },
  acceptance_test_report: { label: 'Acceptance test report', hint: 'Signed acceptance or record-of-completion report' },
  sequence_of_operations: { label: 'Final sequence of operations', hint: 'As-programmed control sequences' },
  certificate: { label: 'Certificate or inspection approval', hint: 'Jurisdictional certificate, permit sign-off or verifier certification' },
};

const COMMON: TurnoverKind[] = ['om_manual', 'warranty', 'as_built', 'training_record'];
const BY_DISCIPLINE: Record<string, TurnoverKind[]> = {
  mechanical: ['tab_report', 'sequence_of_operations', 'spare_parts'],
  electrical: ['acceptance_test_report', 'spare_parts'],
  plumbing: ['certificate'],
  fire_protection: ['acceptance_test_report', 'certificate'],
  fire_alarm: ['acceptance_test_report', 'certificate', 'sequence_of_operations'],
  medical_gas: ['certificate'],
  controls: ['sequence_of_operations'],
};

export const TURNOVER_VERIFIED = false;

/** Documents required for a system, by its discipline. */
export function requiredTurnoverKinds(discipline: string): TurnoverKind[] {
  return [...COMMON, ...(BY_DISCIPLINE[discipline] ?? [])];
}

export function addMonthsIso(iso: string, months: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

/** Warranty end and status; "expiring" within 90 days. */
export function warrantyStatus(startOn: string | null, months: number | null, asOf: string): { endsOn: string | null; status: 'not_started' | 'active' | 'expiring' | 'expired' } {
  if (!startOn || !months) return { endsOn: null, status: 'not_started' };
  const endsOn = addMonthsIso(startOn, months);
  const today = asOf.slice(0, 10);
  if (endsOn < today) return { endsOn, status: 'expired' };
  const soon = new Date(Date.parse(today) + 90 * 864e5).toISOString().slice(0, 10);
  return { endsOn, status: endsOn <= soon ? 'expiring' : 'active' };
}

export type DocStatus = 'submitted' | 'accepted' | 'rejected';

/**
 * Turnover matrix for one system: each required kind is accepted, under review,
 * rejected (resubmission needed) or missing. Latest document of each kind wins.
 */
export function turnoverMatrix(required: TurnoverKind[], docs: { kind: string; status: DocStatus; submittedAt: string }[]) {
  return required.map((kind) => {
    const latest = docs.filter((d) => d.kind === kind).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
    return { kind, label: TURNOVER_KINDS[kind].label, status: latest ? latest.status : 'missing' as const };
  });
}

import { describe, expect, it } from 'vitest';
import { requiredTurnoverKinds, turnoverMatrix, warrantyStatus } from '../src/index.js';

describe('turnover', () => {
  it('requires the common documents plus discipline-specific ones', () => {
    expect(requiredTurnoverKinds('mechanical')).toEqual(['om_manual', 'warranty', 'as_built', 'training_record', 'tab_report', 'sequence_of_operations', 'spare_parts']);
    expect(requiredTurnoverKinds('medical_gas')).toContain('certificate');
    expect(requiredTurnoverKinds('unknown')).toHaveLength(4);
  });
  it('tracks warranties, flagging those ending within 90 days', () => {
    expect(warrantyStatus('2026-01-15', 12, '2026-11-03')).toEqual({ endsOn: '2027-01-15', status: 'expiring' });
    expect(warrantyStatus('2026-06-01', 24, '2026-11-03')).toEqual({ endsOn: '2028-06-01', status: 'active' });
    expect(warrantyStatus('2024-01-31', 13, '2026-11-03')).toEqual({ endsOn: '2025-02-28', status: 'expired' });
    expect(warrantyStatus(null, 12, '2026-11-03').status).toBe('not_started');
  });
  it('uses the latest document of each kind', () => {
    const m = turnoverMatrix(['om_manual', 'warranty', 'as_built'], [
      { kind: 'om_manual', status: 'rejected', submittedAt: '2026-10-01T00:00:00Z' },
      { kind: 'om_manual', status: 'accepted', submittedAt: '2026-10-20T00:00:00Z' },
      { kind: 'warranty', status: 'submitted', submittedAt: '2026-10-21T00:00:00Z' },
    ]);
    expect(m.map((x) => x.status)).toEqual(['accepted', 'submitted', 'missing']);
  });
});

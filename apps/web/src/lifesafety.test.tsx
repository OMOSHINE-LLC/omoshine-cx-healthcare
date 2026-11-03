import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DueChip, InspectionForm, LsItemTable, LsSummaryCards, PfiTable, type LsItem, type PfiItem } from './pages/LifeSafety';

const item = (over: Partial<LsItem>): LsItem => ({
  id: 'x', kind: 'fire_damper', tag: 'FD-1', label: 'Fire damper', group: 'damper', room_number: null, location: '', rating_minutes: null,
  last_performed_on: null, dueStatus: 'current', nextDue: null, ...over,
});
const doorDef = { label: 'Smoke barrier door', group: 'door' as const, standard: 'NFPA 101', items: [
  { key: 'self_closing', label: 'Closes fully' }, { key: 'latches', label: 'Latches' },
] };

describe('Life safety', () => {
  it('lists failed and overdue items first, flagged as life safety', () => {
    render(<LsItemTable canInspect onInspect={() => {}} items={[
      item({ id: 'a', tag: 'FD-1', dueStatus: 'current', nextDue: '2031-01-01' }),
      item({ id: 'b', tag: 'FD-2', dueStatus: 'overdue' }),
      item({ id: 'c', tag: 'D-1', label: 'Fire door assembly', group: 'door', dueStatus: 'failed', rating_minutes: 90, room_number: 'OR-04', location: 'Corridor' }),
    ]} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual(['D-1', 'FD-2', 'FD-1']);
    expect(within(rows[0]!).getByLabelText('Life safety')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('OR-04 · Corridor')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('90 min')).toBeInTheDocument();
    expect(within(rows[2]!).queryByLabelText('Life safety')).toBeNull();
  });

  it('summary cards count each group and call out failures', () => {
    render(<LsSummaryCards summary={{ damper: { total: 4, current: 2, due_soon: 1, overdue: 1, never_inspected: 0, failed: 0 } }} />);
    const card = screen.getByLabelText('Fire and smoke dampers summary');
    expect(within(card).getByText(/0 failed, 1 overdue/)).toBeInTheDocument();
    expect(within(screen.getByLabelText('Fire and smoke doors summary')).getByText('None recorded')).toBeInTheDocument();
  });

  it('the checklist needs every item answered and warns when one is "No"', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<InspectionForm item={item({ tag: 'SD-7', kind: 'smoke_door', group: 'door' })} def={doorDef} onSubmit={onSubmit} onCancel={() => {}} />);
    const save = screen.getByRole('button', { name: 'Save inspection' });
    expect(save).toBeDisabled();
    await userEvent.click(within(screen.getByRole('group', { name: 'Closes fully' })).getByRole('button', { name: 'Yes' }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Latches' })).getByRole('button', { name: 'No' }));
    expect(screen.getByRole('note')).toHaveTextContent(/open a high-priority life safety issue/);
    await userEvent.click(within(screen.getByRole('group', { name: 'Latches' })).getByRole('button', { name: 'N/A' }));
    expect(screen.queryByRole('note')).toBeNull();
    await userEvent.click(save);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ answers: { self_closing: true, latches: 'na' } }));
  });

  it('plan-for-improvement items show status text and resolve with a description', async () => {
    const onResolve = vi.fn();
    const pfi: PfiItem[] = [
      { id: 'p1', number: 1, deficiency: 'Barrier penetrations', code_reference: 'NFPA 101 8.5.6', location: 'Corridor 2C', planned_completion: '2026-01-15', status: 'open', resolution: null, pfiStatus: 'overdue' },
      { id: 'p2', number: 2, deficiency: 'Door gap', code_reference: '', location: 'D-2-101', planned_completion: '2026-12-01', status: 'resolved', resolution: 'Adjusted', pfiStatus: 'resolved' },
    ];
    render(<PfiTable items={pfi} canManage onResolve={onResolve} />);
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Resolution: Adjusted')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Resolve' })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await userEvent.type(screen.getByLabelText('How PFI 1 was corrected'), 'Firestopped');
    await userEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    expect(onResolve).toHaveBeenCalledWith(pfi[0], 'Firestopped');
  });

  it('due chip uses text, not colour alone', () => {
    render(<DueChip status="never_inspected" />);
    expect(screen.getByText('Never inspected')).toBeInTheDocument();
  });
});

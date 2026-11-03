import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChecklistItem, GateList, PhaseCard, type ActivationItem } from './pages/Activation';

const item = (over: Partial<ActivationItem> = {}): ActivationItem => ({
  id: 'i1', key: 'water_flush', label: 'Water system flushed and sampled', category: 'infection_control', required: true, source: 'template',
  status: 'open', evidence: null, completed_by_name: null, completed_at: null, ...over,
});

describe('Phased occupancy and activation', () => {
  it('gates show text status and flag failing life safety gates', () => {
    render(<GateList gates={[
      { key: 'rooms', label: 'Every room meets its ventilation requirements', status: 'fail', detail: '1 of 2 rooms pass' },
      { key: 'tests', label: 'Functional tests signed', status: 'not_applicable', detail: 'No tests' },
      { key: 'checklist', label: 'Activation checklist complete', status: 'fail', detail: '3 of 14' },
      { key: 'life_safety_issues', label: 'No open life safety issues', status: 'pass', detail: 'None open' },
    ]} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Not met')).toBeInTheDocument();
    expect(within(rows[0]!).getByLabelText('Life safety')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Not applicable')).toBeInTheDocument();
    expect(within(rows[2]!).queryByLabelText('Life safety')).toBeNull();
    expect(within(rows[3]!).getByText('Pass')).toBeInTheDocument();
  });

  it('marking an item done asks for evidence', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    render(<ul><ChecklistItem item={item()} locked={false} onChange={onChange} /></ul>);
    await userEvent.click(screen.getByRole('button', { name: 'Mark done' }));
    await userEvent.type(screen.getByLabelText('Evidence'), 'Lab report WM-12');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onChange).toHaveBeenCalledWith('done', 'Lab report WM-12');
  });

  it('completed items show their evidence; locked phases offer no changes', () => {
    render(<ul><ChecklistItem item={item({ status: 'na', evidence: 'No water fixtures in scope', completed_by_name: 'Ivy IP', completed_at: '2026-11-01T10:00:00Z' })} locked onChange={async () => {}} /></ul>);
    expect(screen.getByText('Not applicable', { selector: '.chip' })).toBeInTheDocument();
    expect(screen.getByText(/No water fixtures in scope/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('phase card summarizes gates and checklist and flags lapsed readiness', () => {
    render(<PhaseCard selected={false} onOpen={() => {}} phase={{
      id: 'p', name: 'Phase 1 – Surgery', sequence: 1, targetOccupancyDate: '2027-03-01', status: 'ready', ready: false, readinessLapsed: true,
      gates: [{ key: 'rooms', label: 'x', status: 'fail', detail: '' }, { key: 'tests', label: 'y', status: 'pass', detail: '' }],
      checklist: { required: 14, resolved: 14 }, occupiedOn: null,
    }} />);
    const card = screen.getByLabelText('Phase Phase 1 – Surgery');
    expect(within(card).getByText('Signed ready')).toBeInTheDocument();
    expect(within(card).getByText(/1 gate not met · checklist 14\/14/)).toBeInTheDocument();
    expect(within(card).getByText(/Readiness lapsed/)).toBeInTheDocument();
    expect(within(card).getByText('Target occupancy 2027-03-01')).toBeInTheDocument();
  });
});

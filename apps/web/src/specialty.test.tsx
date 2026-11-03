import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InterfaceForm, SpecialtyCard, type SpecialtySystem } from './pages/Specialty';

const system: SpecialtySystem = {
  id: 's1', name: 'Pneumatic tube', type: 'pneumatic_tube', label: 'Pneumatic tube',
  readiness: { total: 2, passed: 1, failed: 1, untested: 0, ready: false },
  interfaces: [
    { key: 'fire_alarm', with: 'Fire alarm', label: 'Responds to fire alarm', acceptance: 'Stops on alarm', lifeSafety: true, latest: { result: 'fail', tested_on: '2026-11-01', evidence_reference: null, notes: 'Blower kept running', recorded_by_name: 'Gus GC' } },
    { key: 'ees', with: 'Essential electrical system', label: 'Recovers from transfer', acceptance: 'Resumes', lifeSafety: false, latest: null },
  ],
  templates: [{ id: 't1', name: 'Functional test – Pneumatic tube', kind: 'fpt' }, { id: 't2', name: 'Pre-functional checklist – Pneumatic tube', kind: 'pfc' }],
  runs: [{ kind: 'fpt', status: 'in_progress', result: null }],
};

describe('Specialty systems', () => {
  it('shows each interface with a text result, life safety flag and actions', async () => {
    const onRecord = vi.fn(); const onStart = vi.fn();
    render(<SpecialtyCard system={system} onRecord={onRecord} onStart={onStart} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Failed')).toBeInTheDocument();
    expect(within(rows[0]!).getByLabelText('Life safety')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Not tested')).toBeInTheDocument();
    await userEvent.click(within(rows[0]!).getByRole('button', { name: 'Retest' }));
    expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ key: 'fire_alarm' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start functional test (1 on record)' }));
    expect(onStart).toHaveBeenCalledWith('t1');
  });

  it('a pass needs the record location; a fail needs what failed', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<InterfaceForm system="Pneumatic tube" iface={system.interfaces[0]!} onSave={onSave} onCancel={() => {}} />);
    const save = screen.getByRole('button', { name: 'Save' });
    await userEvent.click(screen.getByLabelText('Passed'));
    expect(save).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Failed'));
    expect(screen.getByText(/opens an issue flagged life safety/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/What failed/), 'Zone 3 blower ran');
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ interfaceKey: 'fire_alarm', result: 'fail', notes: 'Zone 3 blower ran' }));
  });
});

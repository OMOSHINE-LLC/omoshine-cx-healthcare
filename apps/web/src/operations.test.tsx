import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompletionForm, TaskTable, TrainingMatrix, type ComplianceTask } from './pages/Operations';

const task = (o: Partial<ComplianceTask>): ComplianceTask => ({
  id: 't', kind: 'k', label: 'Task', category: 'water', target_label: null, frequency: 'Monthly', status: 'current', nextDue: '2026-12-01', last_done_on: null,
  checks: [{ key: 'a', label: 'Check A' }], ...o,
});

describe('Operations', () => {
  it('lists failed and overdue tasks first and flags life safety ones', async () => {
    const onRecord = vi.fn();
    render(<TaskTable onRecord={onRecord} tasks={[
      task({ id: '1', label: 'Flush outlets', status: 'current' }),
      task({ id: '2', label: 'Transfer switch monthly test', category: 'ees', target_label: 'ATS-1', status: 'failed' }),
      task({ id: '3', label: 'Water temperatures', status: 'overdue' }),
    ]} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => (r as HTMLTableRowElement).cells[0]!.textContent)).toEqual([expect.stringContaining('Transfer switch'), 'Water temperatures', 'Flush outlets']);
    expect(within(rows[0]!).getByText('Failed')).toBeInTheDocument();
    expect(within(rows[0]!).getByLabelText(/life safety/i)).toBeInTheDocument();
    expect(within(rows[1]!).queryByLabelText(/life safety/i)).toBeNull();
    await userEvent.click(within(rows[2]!).getByRole('button', { name: 'Record' }));
    expect(onRecord).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
  });

  it('needs every check answered, and notes when one fails', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CompletionForm onSave={onSave} onCancel={() => {}} task={task({ category: 'ees', label: 'Generator monthly load test', checks: [{ key: 'ran', label: 'Ran 30 minutes' }, { key: 'ok', label: 'No alarms' }] })} />);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    const ran = screen.getByRole('group', { name: 'Ran 30 minutes' });
    const ok = screen.getByRole('group', { name: 'No alarms' });
    await userEvent.click(within(ran).getByLabelText('Yes'));
    await userEvent.click(within(ok).getByLabelText('No'));
    expect(screen.getByText(/opens an issue flagged life safety/)).toBeInTheDocument();
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/What was found/), 'High coolant temp alarm');
    await userEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ answers: { ran: true, ok: false }, notes: 'High coolant temp alarm' }));
  });

  it('shows training status as text for each audience', () => {
    render(<TrainingMatrix rows={[{ id: 's', name: 'AHU-1', discipline: 'mechanical', audiences: [
      { audience: 'facilities', label: 'Facilities and engineering', status: 'trained' },
      { audience: 'infection_prevention', label: 'Infection prevention', status: 'needed' },
    ] }]} />);
    expect(screen.getByText('Trained')).toBeInTheDocument();
    expect(screen.getByText('Needed')).toBeInTheDocument();
  });
});

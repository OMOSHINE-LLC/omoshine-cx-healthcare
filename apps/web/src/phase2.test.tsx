import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DailyLogForm, HistoryStrip, ZoneCard, type IcraZone } from './pages/Icra';
import { AssessmentCard, type Assessment } from './pages/Ilsm';

const days = (statuses: string[]) => statuses.map((s, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, status: s }));
const zone: IcraZone = {
  id: 'z1', name: 'OR suite demo', icra_class: 'IV', construction_type: 'D', risk_group: 'highest', barrier_type: 'Hard wall', adjacent_areas: 'OR-01',
  department_name: 'Surgical Services', active: true, approval: { status: 'reapproval_required', by: null, at: null }, today: 'missing',
  history: days(['pass', 'fail', 'missing', 'pass']),
};
const controls = [
  { key: 'barriers_intact', label: 'Critical barriers intact', fromClass: 'III' },
  { key: 'hepa_running', label: 'HEPA units running', fromClass: 'III' },
];

describe('ICRA', () => {
  it('summarises the 30-day history in words, not colour alone', () => {
    render(<HistoryStrip history={zone.history} />);
    expect(screen.getByRole('img', { name: 'Last 4 days: 1 failed, 1 not logged' })).toBeInTheDocument();
  });

  it('zone card shows class, approval state and today’s status', () => {
    render(<ZoneCard zone={zone} onOpen={() => {}} />);
    const card = screen.getByLabelText('ICRA zone OR suite demo');
    expect(within(card).getByText('Class IV')).toBeInTheDocument();
    expect(within(card).getByText('IP re-approval needed')).toBeInTheDocument();
    expect(within(card).getByText('not logged')).toBeInTheDocument();
  });

  it('daily log requires every answer and the pressure reading for class IV, and asks for corrective action on a "No"', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<DailyLogForm zone={zone} controls={controls} onSubmit={onSubmit} onCancel={() => {}} />);
    const save = screen.getByRole('button', { name: 'Save inspection' });
    expect(save).toBeDisabled();
    await userEvent.click(within(screen.getByRole('group', { name: 'Critical barriers intact' })).getByRole('button', { name: 'No' }));
    await userEvent.click(within(screen.getByRole('group', { name: 'HEPA units running' })).getByRole('button', { name: 'Yes' }));
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Pressure differential/), '-0.02');
    await userEvent.type(screen.getByLabelText('Corrective action taken'), 'Resealed barrier');
    await userEvent.click(save);
    expect(onSubmit).toHaveBeenCalledWith({ controls: { barriers_intact: false, hepa_running: true }, pressureDiffInWc: -0.02, correctiveAction: 'Resealed barrier' });
  });
});

describe('ILSM', () => {
  const a: Assessment = {
    id: 'a1', deficiency_type: 'fire_alarm_impaired', description: 'Loop disabled', location: 'Level 2 west', identified_at: '2026-11-03T08:00:00Z',
    expected_out_of_service_hours: '12', required_measures: ['fire_watch', 'notify_fire_department'], implemented_measures: ['notify_fire_department'],
    status: 'open', fireWatchRequired: true, patrolIntervalMin: 60,
    patrols: [{ id: 'p1', patrolled_at: '2026-11-03T08:50:00Z', area: 'Level 2 west', all_clear: true, findings: '', recorded_by_name: 'Jordan GC' }],
    gaps: [{ from: '2026-11-03T08:50:00Z', to: '2026-11-03T10:20:00Z', minutes: 90 }],
  };
  const catalog = { deficiencyTypes: { fire_alarm_impaired: 'Fire alarm or detection system out of service' }, measures: { fire_watch: 'Fire watch with documented patrols', notify_fire_department: 'Notify the fire department' } };

  it('flags fire watch gaps and blocks resolving until every measure is documented', () => {
    render(<AssessmentCard a={a} catalog={catalog} onToggleMeasure={() => {}} onPatrol={() => {}} onResolve={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('1 gap over 60 min, longest 90 min');
    expect(screen.getByRole('button', { name: 'Resolve deficiency' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Fire watch with documented patrols' })).not.toBeChecked();
  });

  it('logs an all-clear patrol in one tap, and needs findings otherwise', async () => {
    const onPatrol = vi.fn();
    render(<AssessmentCard a={a} catalog={catalog} onToggleMeasure={() => {}} onPatrol={onPatrol} onResolve={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Patrol done, all clear' }));
    expect(onPatrol).toHaveBeenCalledWith(true, '');
    const withFindings = screen.getByRole('button', { name: 'Log with findings' });
    expect(withFindings).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Findings'), 'Door wedged open');
    await userEvent.click(withFindings);
    expect(onPatrol).toHaveBeenLastCalledWith(false, 'Door wedged open');
  });
});

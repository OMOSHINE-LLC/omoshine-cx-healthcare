import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LifeSafetyFlag, StatusChip } from './components';
import { RoomDataSheetView, RoomGridView, type DataSheet } from './pages/RoomCompliance';
import { EesDashboardView, type EesSummary } from './pages/Ees';
import { ReadinessView } from './pages/Home';
import { SignDialog } from './pages/TestRuns';

describe('status indicators', () => {
  it('always carry a text label, not colour alone', () => {
    render(<><StatusChip status="pass" /><StatusChip status="fail" /><StatusChip status="not_tested" /><StatusChip status="ready_for_review" /></>);
    for (const t of ['Pass', 'Fail', 'Not tested', 'Ready for review']) expect(screen.getByText(t)).toBeInTheDocument();
    expect(screen.getByText('Fail')).toHaveClass('chip-fail');
  });
  it('life safety flag is distinct and named for screen readers', () => {
    render(<LifeSafetyFlag />);
    expect(screen.getByRole('img', { name: 'Life safety' })).toHaveClass('ls-flag');
  });
});

const sheet: DataSheet = {
  room: { id: 'r1', number: 'ISO-12', name: 'Isolation 12', department_name: 'Med/Surg', phase_name: 'Phase 1', qr_code: 'abc', volume_cuft: '1200', state_code: 'CA' },
  spaceType: { id: 'aiir', name: 'Airborne infection isolation room (AIIR)', pressureRelationship: 'negative' },
  requirements: [
    { key: 'ashrae170.aiir.pressure_relationship', parameter: 'pressure_relationship', description: '', required: 'negative, ≥ 0.01 in. w.c.', citation: 'ASHRAE 170-2021 Table 7-1', severity: 'life_safety', verified: false },
    { key: 'ashrae170.aiir.total_ach', parameter: 'total_ach', description: '', required: '≥ 12 ACH', citation: 'ASHRAE 170-2021 Table 7-1', severity: 'regulatory', verified: false },
  ],
  latest: {
    source: 'tab', measured_at: '2026-10-30T14:00:00Z', recorded_by_name: 'Riley TAB', engine_version: 'rules-2026.11.0',
    readings: { pressureDiffInWc: 0.01 },
    evaluation: {
      computed: { totalAch: 13 },
      results: [
        { requirementKey: 'ashrae170.aiir.pressure_relationship', parameter: 'pressure_relationship', status: 'fail', measured: 0.01, required: 'negative', citation: 'ASHRAE 170-2021 Table 7-1', severity: 'life_safety' },
        { requirementKey: 'ashrae170.aiir.total_ach', parameter: 'total_ach', status: 'pass', measured: 13, required: '≥ 12 ACH', citation: 'ASHRAE 170-2021 Table 7-1', severity: 'regulatory' },
      ],
    },
  },
  overall: 'fail',
  lifeSafetyFailure: true,
  history: [{ id: 'm1', measured_at: '2026-10-30T14:00:00Z', overall: 'fail', source: 'tab' }],
  issues: [],
};

describe('room data sheet', () => {
  it('shows each requirement with its code citation and result', () => {
    render(<RoomDataSheetView sheet={sheet} onCreateIssue={() => {}} />);
    expect(screen.getByRole('heading', { name: 'ISO-12 Isolation 12' })).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    const pressureRow = rows.find((r) => within(r).queryByText('Pressure relationship'))!;
    expect(within(pressureRow).getByText('+0.010 in. w.c.')).toBeInTheDocument();
    expect(within(pressureRow).getByText('Fail')).toBeInTheDocument();
    expect(within(pressureRow).getByText('ASHRAE 170-2021 Table 7-1')).toBeInTheDocument();
    expect(pressureRow).toHaveClass('failed');
    expect(screen.getAllByText('Value pending code review')).toHaveLength(2);
  });

  it('offers "Create issue" only on failed requirements and passes the failure through', async () => {
    const onCreate = vi.fn();
    render(<RoomDataSheetView sheet={sheet} onCreateIssue={onCreate} />);
    const buttons = screen.getAllByRole('button', { name: 'Create issue' });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]!);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ parameter: 'pressure_relationship', severity: 'life_safety' }));
  });

  it('flags the room as a life safety failure', () => {
    render(<RoomDataSheetView sheet={sheet} onCreateIssue={() => {}} />);
    expect(screen.getAllByRole('img', { name: 'Life safety' }).length).toBeGreaterThan(0);
  });

  it('room grid opens a room by click or keyboard', async () => {
    const onOpen = vi.fn();
    render(<RoomGridView onOpen={onOpen} rows={[{ id: 'r1', number: 'OR-04', name: 'OR 4', spaceTypeName: 'Operating room', department_name: 'Surgery', overall: 'pass', life_safety_failure: false, parameters: { total_ach: { status: 'pass' } } }]} />);
    await userEvent.click(screen.getByText('OR-04'));
    expect(onOpen).toHaveBeenCalledWith('r1');
  });
});

describe('EES dashboard', () => {
  const data: EesSummary = {
    branches: [
      { branch: 'life_safety', name: 'Life Safety branch', atsCount: 2, passed: 2, failed: 0, percentPassed: 100, lifeSafetyFailure: false },
      { branch: 'critical', name: 'Critical branch', atsCount: 2, passed: 1, failed: 1, percentPassed: 50, lifeSafetyFailure: true },
      { branch: 'equipment', name: 'Equipment branch', atsCount: 0, passed: 0, failed: 0, percentPassed: 0, lifeSafetyFailure: false },
    ],
    ats: [{ id: 'a1', tag: 'ATS-CR-1', branch: 'critical', servedPanel: 'CR-2A', lastTestAt: '2026-10-30T14:00:00Z', transferTimeS: 11.2, result: 'fail', lifeSafetyFailure: true }],
    generators: [{ id: 'g1', tag: 'GEN-1', ratingKw: 1500, lastTestType: 'generator_monthly', lastTestAt: '2026-10-15T10:00:00Z', loadPct: 35, durationMin: 30, result: 'pass', nextMonthlyDue: '2026-11-15' }],
    openIssues: 1,
  };
  it('shows three branch cards with progress and the life safety flag on the failing branch', () => {
    render(<EesDashboardView data={data} onRecordAts={() => {}} />);
    const crit = screen.getByLabelText('Critical branch summary');
    expect(within(crit).getByText('50%')).toBeInTheDocument();
    expect(within(crit).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
    expect(within(crit).getByRole('img', { name: 'Life safety' })).toBeInTheDocument();
    expect(within(screen.getByLabelText('Life Safety branch summary')).queryByRole('img', { name: 'Life safety' })).toBeNull();
  });
  it('marks transfers over 10 seconds', () => {
    render(<EesDashboardView data={data} onRecordAts={() => {}} />);
    expect(screen.getByText(/exceeds NFPA 110 Type 10/)).toBeInTheDocument();
    expect(screen.getByText('2026-11-15')).toBeInTheDocument();
  });
});

describe('readiness dashboard', () => {
  it('shows signed percentage, open life safety issues and per-phase readiness', () => {
    render(<ReadinessView data={{ tests: { total: 4, signed: 3, failed: 1, percentSigned: 75 }, issues: { open: 5, closed: 2, openLifeSafety: 1 }, roomsByPhase: [{ phase: 'Phase 1', pass: 3, fail: 1, incomplete: 0, notTested: 0 }] }} />);
    expect(screen.getByRole('progressbar', { name: 'Tests signed' })).toHaveAttribute('aria-valuenow', '75');
    expect(screen.getByText('3 of 4 · 1 failed')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Phase 1 rooms passing' })).toHaveAttribute('aria-valuenow', '75');
    expect(screen.getByRole('img', { name: 'Life safety' })).toBeInTheDocument();
  });
});

describe('signing', () => {
  it('requires the PIN and a signature meaning before signing', async () => {
    const onSign = vi.fn().mockResolvedValue(undefined);
    render(<SignDialog onSign={onSign} onClose={() => {}} />);
    await userEvent.selectOptions(screen.getByLabelText('Signature meaning'), 'witnessed');
    await userEvent.type(screen.getByLabelText('Re-enter your signing PIN'), '2468');
    await userEvent.click(screen.getByRole('button', { name: 'Sign' }));
    expect(onSign).toHaveBeenCalledWith('2468', 'witnessed');
  });
  it('shows a server refusal', async () => {
    render(<SignDialog onSign={() => Promise.reject(new Error('Re-authentication failed'))} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Re-enter your signing PIN'), '0000');
    await userEvent.click(screen.getByRole('button', { name: 'Sign' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Re-authentication failed');
  });
});

describe('brand tokens', () => {
  const css = readFileSync(join(__dirname, 'theme.css'), 'utf8');
  it('defines the OMOSHINE palette', () => {
    for (const hex of ['#072740', '#061a2c', '#092f4c', '#b1844f', '#e7bc7a', '#835e34', '#f5f2ea']) expect(css.toLowerCase()).toContain(hex);
  });

  // WCAG 2.1 relative luminance contrast.
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); };

  it.each([
    ['body text on ivory', '#061a2c', '#f5f2ea'],
    ['ivory on navy header', '#f5f2ea', '#072740'],
    ['navy link on white', '#072740', '#ffffff'],
    ['muted text on white', '#4a5561', '#ffffff'],
    ['pass chip', '#1e6b34', '#e6f4ea'],
    ['fail chip', '#a61b1b', '#fde7e7'],
    ['open chip', '#8a5300', '#fff4e0'],
    ['closed chip', '#444444', '#eeeeee'],
    ['life safety flag', '#ffffff', '#c00000'],
  ])('%s meets AA (4.5:1)', (_n, fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });
});

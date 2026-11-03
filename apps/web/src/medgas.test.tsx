import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MedGasZoneCard, RequirementTable, TestEntryForm, type Catalog, type MedGasZone, type RequirementItem } from './pages/MedGas';

const catalog: Catalog = {
  gases: {
    oxygen: { label: 'Oxygen', kind: 'positive', pressurePsig: { min: 50, max: 55 }, testFlowSlpm: 100, maxFlowDropPsi: 5, concentration: { analyte: 'oxygen', minPct: 99 } },
    vacuum: { label: 'Medical-surgical vacuum', kind: 'vacuum', minVacuumInHg: 12, testFlowSlpm: 85 },
  },
  tests: [
    { key: 'outlet_flow', label: 'Outlet pressure and flow', per: 'outlet', fields: [
      { key: 'staticPsig', label: 'Static pressure', type: 'number', unit: 'psig' },
      { key: 'flowingPsig', label: 'Pressure at test flow', type: 'number', unit: 'psig' },
      { key: 'vacuumInHg', label: 'Vacuum at test flow (vacuum inlets)', type: 'number', unit: 'in. Hg' },
    ] },
    { key: 'valve_test', label: 'Zone valve test', per: 'zone', fields: [
      { key: 'valvesControlLabeledOutlets', label: 'Every zone valve shuts off only the outlets it is labeled for', type: 'boolean' },
    ] },
  ],
  pipingLimits: { maxDewPointF: 54, maxHydrocarbonDeltaPpm: 5, maxParticulateMgPerM3: 0.1, minStandingHours: 24 },
};

const zone: MedGasZone = {
  id: 'z', name: 'OR zone 2A', zone_valve_tag: 'ZVB-2A', gases: ['oxygen', 'vacuum'], outletCount: 4,
  summary: { required: 20, passed: 15, failed: 1, incomplete: 0, notTested: 4 }, readyToCertify: false,
  certification: { status: 'recertification_required', by: null, at: null },
};

const flowItem = (gas: string): RequirementItem => ({ key: `outlet_flow:${gas}:o1`, testType: 'outlet_flow', gas, outletId: 'o1', label: `Outlet pressure and flow: OR-04 ${gas}`, status: 'not_tested', latest: null });

describe('Medical gas', () => {
  it('zone card shows certification, progress and a life safety flag on failures', () => {
    render(<MedGasZoneCard zone={zone} catalog={catalog} onOpen={() => {}} />);
    const card = screen.getByLabelText('Medical gas zone OR zone 2A');
    expect(within(card).getByText('Recertification needed')).toBeInTheDocument();
    expect(within(card).getByText('1 failed test')).toBeInTheDocument();
    expect(within(card).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75');
    expect(within(card).getByText(/Oxygen, Medical-surgical vacuum · 4 outlets/)).toBeInTheDocument();
  });

  it('oxygen flow entry asks for static and flowing pressure and states the limit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<TestEntryForm item={flowItem('oxygen')} catalog={catalog} onSubmit={onSubmit} onCancel={() => {}} />);
    expect(screen.getByText(/Static 50–55 psig; drop no more than 5 psi at 100 SLPM/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Vacuum at test flow/)).not.toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save result' });
    await userEvent.type(screen.getByLabelText(/Static pressure/), '52');
    await userEvent.type(screen.getByLabelText(/Pressure at test flow/), '50');
    await userEvent.clear(screen.getByLabelText('Verifier credential'));
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Verifier credential'), 'ASSE 6030 #1');
    await userEvent.click(save);
    expect(onSubmit).toHaveBeenCalledWith({ readings: { staticPsig: 52, flowingPsig: 50 }, verifierCredential: 'ASSE 6030 #1' });
  });

  it('vacuum flow entry asks only for the vacuum reading', () => {
    render(<TestEntryForm item={flowItem('vacuum')} catalog={catalog} onSubmit={vi.fn()} onCancel={() => {}} />);
    expect(screen.getByLabelText(/Vacuum at test flow/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Static pressure/)).not.toBeInTheDocument();
    expect(screen.getByText(/At least 12 in. Hg at 85 SLPM/)).toBeInTheDocument();
  });

  it('lists failures first, flagged as life safety, with retest buttons', () => {
    const items: RequirementItem[] = [
      { ...flowItem('oxygen'), status: 'pass', latest: { testedAt: '2026-11-01T10:00:00Z' } },
      { key: 'valve_test:-:-', testType: 'valve_test', gas: null, outletId: null, label: 'Zone valve test', status: 'fail', latest: { testedAt: '2026-11-02T10:00:00Z' } },
    ];
    render(<RequirementTable items={items} canRecord onRecord={() => {}} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Zone valve test')).toBeInTheDocument();
    expect(within(rows[0]!).getByLabelText(/life safety/i)).toBeInTheDocument();
    expect(within(rows[0]!).getByRole('button', { name: 'Retest' })).toBeInTheDocument();
  });
});

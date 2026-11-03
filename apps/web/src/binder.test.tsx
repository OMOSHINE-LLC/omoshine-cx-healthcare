import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BinderView, type Binder } from './pages/SurveyBinder';

const binder: Binder = {
  generatedAt: '2026-11-03T05:00:00Z',
  sections: [
    { key: 'rooms', title: 'Room ventilation compliance (ASHRAE 170)', status: 'attention', summary: '7 of 9 rooms pass', gaps: [{ severity: 'regulatory', text: 'OR-03 fails' }] },
    { key: 'icra', title: 'Infection control risk assessment (ICRA)', status: 'ready', summary: '1 active zone', gaps: [] },
    { key: 'medgas', title: 'Medical gas and vacuum verification (NFPA 99)', status: 'no_records', summary: 'No zones', gaps: [] },
  ],
  gaps: [
    { severity: 'life_safety', text: 'ATS-CR-2 latest test failed', section: 'Essential electrical' },
    ...Array.from({ length: 11 }, (_, i) => ({ severity: 'regulatory' as const, text: `Room R-${i} has no ventilation measurements`, section: 'Rooms' })),
  ],
  summary: { ready: 1, attention: 1, noRecords: 1, lifeSafetyGaps: 1, otherGaps: 11 },
};

describe('Survey binder', () => {
  it('shows section status in words and flags life safety gaps first', () => {
    render(<BinderView binder={binder} onOpenReport={() => {}} />);
    expect(within(screen.getByLabelText(/Binder section Room ventilation/)).getByText('Needs attention')).toBeInTheDocument();
    expect(within(screen.getByLabelText(/Binder section Medical gas/)).getByText('No records')).toBeInTheDocument();
    const items = within(screen.getByLabelText('Gaps to close')).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('ATS-CR-2 latest test failed');
    expect(within(items[0]!).getByLabelText('Life safety')).toBeInTheDocument();
  });

  it('shows the first ten gaps and expands to all', async () => {
    render(<BinderView binder={binder} onOpenReport={() => {}} />);
    const list = screen.getByLabelText('Gaps to close');
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    await userEvent.click(screen.getByRole('button', { name: 'Show all 12' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(12);
  });

  it('opens the printable binder', async () => {
    const onOpen = vi.fn();
    render(<BinderView binder={binder} onOpenReport={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open printable binder' }));
    expect(onOpen).toHaveBeenCalled();
  });
});

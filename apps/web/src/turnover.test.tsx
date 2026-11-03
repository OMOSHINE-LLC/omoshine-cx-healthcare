import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewForm, SystemMatrix, type TurnoverSystem } from './pages/Turnover';

const system: TurnoverSystem = {
  id: 's1', name: 'AHU-1 Surgery', discipline: 'mechanical', accepted: 1, required: 3,
  matrix: [
    { kind: 'om_manual', label: 'Operation and maintenance manual', status: 'accepted' },
    { kind: 'warranty', label: 'Warranty', status: 'submitted' },
    { kind: 'as_built', label: 'As-built drawings', status: 'rejected' },
  ],
  documents: [
    { id: 'd1', kind: 'om_manual', title: 'O&M rev C', reference: 'DMS://om', status: 'accepted', review_note: null, asset_tag: null, submitted_by_name: 'Gus GC', submitted_at: '2026-10-01T00:00:00Z', reviewed_by_name: 'Avery CxA', warranty: null },
    { id: 'd2', kind: 'warranty', title: 'One-year warranty', reference: 'DMS://w', status: 'submitted', review_note: null, asset_tag: 'AHU-1', submitted_by_name: 'Gus GC', submitted_at: '2026-10-02T00:00:00Z', reviewed_by_name: null, warranty: { endsOn: '2027-01-15', status: 'expiring' } },
    { id: 'd3', kind: 'as_built', title: 'Mech as-builts', reference: 'DMS://ab', status: 'rejected', review_note: 'Missing level 3', asset_tag: null, submitted_by_name: 'Gus GC', submitted_at: '2026-10-03T00:00:00Z', reviewed_by_name: 'Avery CxA', warranty: null },
  ],
};

describe('Turnover', () => {
  it('shows each required document with a text status and the right action', async () => {
    const onSubmit = vi.fn(); const onReview = vi.fn();
    render(<SystemMatrix system={system} onSubmit={onSubmit} onReview={onReview} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Accepted')).toBeInTheDocument();
    expect(within(rows[0]!).queryByRole('button')).toBeNull();
    expect(within(rows[1]!).getByText(/Warranty ends 2027-01-15 \(within 90 days\)/)).toBeInTheDocument();
    await userEvent.click(within(rows[1]!).getByRole('button', { name: 'Review' }));
    expect(onReview).toHaveBeenCalledWith(expect.objectContaining({ id: 'd2' }));
    expect(within(rows[2]!).getByText('Review: Missing level 3')).toBeInTheDocument();
    await userEvent.click(within(rows[2]!).getByRole('button', { name: 'Resubmit' }));
    expect(onSubmit).toHaveBeenCalledWith('as_built');
  });

  it('rejecting needs a note', async () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<ReviewForm doc={{ title: 'One-year warranty' }} onDecide={onDecide} onCancel={() => {}} />);
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect(reject).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Review note/), 'Start date wrong');
    await userEvent.click(reject);
    expect(onDecide).toHaveBeenCalledWith('rejected', 'Start date wrong');
  });
});

import { render, screen, within } from '@testing-library/react';
import { TrendTable, type TrendRoom } from './pages/DataExchange';

const rooms: TrendRoom[] = [{
  roomId: 'r1', roomNumber: 'ISO-12', roomName: 'Isolation 12', overallAtMedian: 'pass', worstPctCompliant: 75,
  points: [
    { point: 'pressure_in_wc', label: 'Pressure differential (in. w.c.)', samples: 8, min: -0.02, max: 0.002, median: -0.02, pctOfTimeCompliant: 75, excursions: [{ from: 'a', to: 'b', minutes: 30, worst: 0.002 }], longestExcursionMin: 30, dataGaps: [] },
    { point: 'temp_f', label: 'Temperature (°F)', samples: 8, min: 71, max: 72, median: 71.5, pctOfTimeCompliant: 100, excursions: [], longestExcursionMin: 0, dataGaps: [] },
  ],
}];

describe('BAS trend table', () => {
  it('shows time compliant as text and flags pressure excursions as life safety', () => {
    render(<TrendTable rooms={rooms} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('ISO-12')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('75%')).toBeInTheDocument();
    expect(within(rows[0]!).getByLabelText('Life safety')).toBeInTheDocument();
    expect(within(rows[0]!).getByText(/1, longest 30 min/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText('100%')).toBeInTheDocument();
  });
});

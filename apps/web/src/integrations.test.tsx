import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OneTimeSecret, WebhookRow, type Webhook } from './pages/Integrations';

describe('Integrations', () => {
  it('shows a secret once with a clear warning', async () => {
    const onDone = vi.fn();
    render(<OneTimeSecret label="API key for BAS gateway" value="omk_abc_def" onDone={onDone} />);
    expect(screen.getByRole('alert')).toHaveTextContent('will not be shown again');
    expect(screen.getByText('omk_abc_def')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'I have stored it' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('webhook row shows state and failures, with pause and test actions', async () => {
    const hook: Webhook = { id: 'h', url: 'https://hooks.example.com/x', events: ['issue.created'], active: true, description: 'Procore relay', failed: '2', pending: '0', last_delivered_at: null };
    const onToggle = vi.fn();
    const onPing = vi.fn();
    render(<table><tbody><WebhookRow hook={hook} onToggle={onToggle} onPing={onPing} onShowDeliveries={() => {}} /></tbody></table>);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('2 failed')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send test' }));
    expect(onToggle).toHaveBeenCalled();
    expect(onPing).toHaveBeenCalled();
  });
});

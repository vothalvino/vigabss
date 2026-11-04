// ASY-36: the automation and integration pages offered actions that do
// nothing — a rule action with no handler, a remediation action no device
// receives, script execution and integration test/sync (both 501) — with no
// sign that they do nothing. They are now labelled, or the button is gone.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import AutomationPage from '../AutomationPage';
import { IntegrationsPage } from '../IntegrationsPage';

vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, organization_id: 1 } }) }));

const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;
const list = (data: unknown[]) => json({ data, meta: { total: data.length, page: 1, limit: 20, pages: 1 } });

function serve(routes: Record<string, unknown[]>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const key = Object.keys(routes).find(k => url.includes(k));
    return list(key ? routes[key] : []);
  });
}

describe('AutomationPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.restoreAllMocks();
  });

  it('labels a rule whose action has no handler, and only that one', async () => {
    serve({ '/automation-rules': [
      { id: 1, name: 'Ticket', trigger_event: 'invoice.overdue', action_type: 'create_ticket', is_enabled: 1, run_count: 0, last_triggered_at: null },
      { id: 2, name: 'Script', trigger_event: 'invoice.overdue', action_type: 'run_script', is_enabled: 1, run_count: 0, last_triggered_at: null },
    ] });
    render(<AutomationPage />);
    const scriptRow = (await screen.findByText('Script')).closest('tr') as HTMLElement;
    expect(within(scriptRow).getByText(i18n.t('automation.actionNotImplemented'))).toBeTruthy();
    const ticketRow = screen.getByText('Ticket').closest('tr') as HTMLElement;
    expect(within(ticketRow).queryByText(i18n.t('automation.actionNotImplemented'))).toBeNull();
  });

  it('labels remediation actions that no device receives', async () => {
    serve({ '/remediation-rules': [
      { id: 1, name: 'Reboot hot AP', condition_metric: 'cpu_usage', condition_operator: 'gt', action_type: 'reboot', is_enabled: 1, cooldown_minutes: 30 },
      { id: 2, name: 'Page NOC', condition_metric: 'cpu_usage', condition_operator: 'gt', action_type: 'notify', is_enabled: 1, cooldown_minutes: 30 },
    ] });
    render(<AutomationPage />);
    await userEvent.click(screen.getByRole('button', { name: i18n.t('automation.remediation') }));
    const pageRow = (await screen.findByText('Page NOC')).closest('tr') as HTMLElement;
    expect(within(pageRow).getByText(i18n.t('automation.notDispatched'))).toBeTruthy();
    const rebootRow = screen.getByText('Reboot hot AP').closest('tr') as HTMLElement;
    expect(within(rebootRow).queryByText(i18n.t('automation.notDispatched'))).toBeNull();
  });

  it('says scripts do not run and offers no Queue button', async () => {
    serve({ '/automation-scripts': [
      { id: 1, name: 'Nightly', language: 'bash', version: 1, is_shared: 0, description: null, created_at: '2026-10-01T00:00:00Z' },
    ] });
    render(<AutomationPage />);
    await userEvent.click(screen.getByRole('button', { name: i18n.t('automation.scripts') }));
    const row = (await screen.findByText('Nightly')).closest('tr') as HTMLElement;
    expect(screen.getByText(i18n.t('automation.scriptsNotRunnable'))).toBeTruthy();
    expect(within(row).getAllByRole('button').map(b => b.textContent)).toEqual([i18n.t('common.delete')]);
  });
});

describe('IntegrationsPage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.restoreAllMocks();
  });

  it('says live test and sync are not implemented and offers neither', async () => {
    serve({ '/integrations/connections': [
      { id: 1, name: 'Books', provider_name: 'QuickBooks', category: 'accounting', status: 'active', last_synced_at: null },
    ] });
    render(<MemoryRouter><IntegrationsPage /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: i18n.t('integration.tabConnections') }));
    const row = (await screen.findByText('Books')).closest('tr') as HTMLElement;
    expect(screen.getByText(i18n.t('integration.liveNotImplemented'))).toBeTruthy();
    const labels = within(row).getAllByRole('button').map(b => b.textContent);
    expect(labels).toEqual([i18n.t('integration.logs'), i18n.t('integration.delete')]);
  });
});

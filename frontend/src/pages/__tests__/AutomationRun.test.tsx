// ASY-16: "Run" on an automation rule always said "Execution triggered
// successfully", even though no action type does anything. It now reports the
// outcome the API returns.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '@/i18n';
import AutomationPage from '../AutomationPage';

const RULE = {
  id: 3, name: 'Notify on payment', trigger_event: 'payment.received', action_type: 'send_notification',
  is_enabled: 1, priority: 50, run_count: 0, last_triggered_at: null, created_at: '2026-10-01T00:00:00Z',
};

const json = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as unknown as Response;

describe('AutomationPage — Run', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    vi.restoreAllMocks();
  });

  it('shows what the run did instead of a blanket success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/execute')) {
        return json({ data: { rule_id: 3, result: { evaluated: 1, triggered: 0, results: [
          { rule_id: 3, status: 'skipped', message: "Action 'send_notification' is not implemented yet; nothing was done" },
        ] } } });
      }
      return json({ data: [RULE], meta: { total: 1, page: 1, limit: 20, pages: 1 } });
    });
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(<AutomationPage />);
    await userEvent.click(await screen.findByRole('button', { name: i18n.t('automation.run') }));

    await waitFor(() => expect(alertMock).toHaveBeenCalled());
    expect(alertMock.mock.calls[0][0]).toMatch(/skipped/);
    expect(alertMock.mock.calls[0][0]).toMatch(/not implemented/);
    expect(alertMock.mock.calls[0][0]).not.toMatch(/successfully/);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/automation-rules/3/execute'))).toBe(true);
  });
});

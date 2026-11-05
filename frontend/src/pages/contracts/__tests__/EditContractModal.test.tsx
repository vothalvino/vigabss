// A staff plan change billed nothing for the rest of an invoiced period. The
// edit form now sends prorate with a plan change: on by default, untickable
// for a courtesy change or a correction.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18n from '@/i18n';
import type { ContractRow } from '@/api/rows';
import { EditContractModal } from '../EditContractModal';

const mockPut = vi.fn();
vi.mock('@/api/client', () => ({ api: { PUT: (...a: unknown[]) => mockPut(...a) } }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, permissions: [] } }) }));

const CONTRACT = {
  id: 8, plan_id: 2, status: 'active', connection_type: 'pppoe', start_date: '2026-01-01', end_date: null,
  billing_day: 1, ip_address: null, price_override: null, facturar: 0, contract_template_mx_id: null,
  escalation_enabled: 1, escalate_on_disconnect: 0, optical_min_dbm: null, wireless_signal_min_dbm: null,
  wireless_link_capacity_min_mbps: null,
} as unknown as ContractRow;
const PLANS = [{ id: 2, name: 'Basic', price: '300.00' }, { id: 3, name: 'Fiber Pro', price: '600.00' }];

function open(contract = CONTRACT) {
  const qc = new QueryClient();
  render(<QueryClientProvider client={qc}><EditContractModal contract={contract} plans={PLANS} isMxOrg={false} onClose={vi.fn()} onSaved={vi.fn()} /></QueryClientProvider>);
}
const prorateBox = () => screen.queryByRole('checkbox', { name: i18n.t('contractList.editModal.prorate') });
const sentBody = () => (mockPut.mock.calls[0][1] as { body: Record<string, unknown> }).body;

describe('EditContractModal plan change', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    mockPut.mockReset().mockResolvedValue({ data: { data: {} } });
  });

  it('offers proration, ticked, only once the plan changes', async () => {
    open();
    expect(prorateBox()).toBeNull();
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '3' } });
    expect(prorateBox()).toBeTruthy();
    expect((prorateBox() as HTMLInputElement).checked).toBe(true);
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(mockPut).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({ plan_id: 3, prorate: true });
  });

  it('sends prorate: false when unticked, and nothing about it without a plan change', async () => {
    open();
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '3' } });
    fireEvent.click(prorateBox() as HTMLElement);
    fireEvent.submit(screen.getByRole('dialog').querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(mockPut).toHaveBeenCalled());
    expect(sentBody()).toMatchObject({ plan_id: 3, prorate: false });

    mockPut.mockClear();
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '2' } });
    expect(prorateBox()).toBeNull();
  });

  it('a pending contract has no period to prorate', () => {
    open({ ...CONTRACT, status: 'pending' } as ContractRow);
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: '3' } });
    expect(prorateBox()).toBeNull();
  });
});

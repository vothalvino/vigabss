// Changing technology is done with a new contract the client signs. The
// contract page starts it and shows how two contracts are related.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/api/apiFetch', () => ({ apiFetch: (...a: unknown[]) => mocks.apiFetch(...a) }));

import { ContractTransition } from '../ContractTransition';

const PLANS = [
  { id: 1, name: 'Wireless 20', price: '400', access_technology: 'wisp' },
  { id: 2, name: 'Fibre 100', price: '600', access_technology: 'ftth' },
  { id: 3, name: 'Flex 50', price: '500', access_technology: 'both' },
];

function serve(relations: unknown) {
  mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/transition')) return { data: relations };
    if (path.startsWith('/plans')) return { data: PLANS };
    if (path === '/contracts' && init?.method === 'POST') return { data: { id: 77 } };
    return { data: null };
  });
}
function Landed() { const { id } = useParams(); return <p>opened contract {id}</p>; }
const renderPanel = (props: Partial<Parameters<typeof ContractTransition>[0]> = {}) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/contracts/10']}>
      <Routes>
        <Route path="/contracts/10" element={<ContractTransition contractId="10" clientId="5" status="active" technology="wisp" connectionType="pppoe" canEdit {...props} />} />
        <Route path="/contracts/:id" element={<Landed />} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);

describe('technology transition on the contract page', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('creates the replacement contract for the other technology and opens it', async () => {
    serve({ replaces: null, replaced_by: null });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Change technology to FTTH (fibre)' }));
    expect(screen.getByText(/which the client must sign/)).toBeInTheDocument();

    // Only plans offered over fibre.
    await screen.findByRole('option', { name: 'Fibre 100' });
    expect(screen.getByRole('option', { name: 'Flex 50' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Wireless 20' })).toBeNull();

    await user.selectOptions(screen.getByLabelText('Plan'), '2');
    await user.click(screen.getByRole('button', { name: 'Create the new contract' }));
    expect(await screen.findByText('opened contract 77')).toBeInTheDocument();
    const post = mocks.apiFetch.mock.calls.find(([path, init]) => path === '/contracts' && (init as RequestInit)?.method === 'POST')!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toMatchObject({
      client_id: 5, plan_id: 2, connection_type: 'pppoe', access_technology: 'ftth', replaces_contract_id: 10,
    });
  });

  it('a contract already being replaced shows the pending one and offers no second transition', async () => {
    serve({ replaces: null, replaced_by: { id: 77, status: 'pending' } });
    renderPanel();
    expect(await screen.findByText(/is being replaced by contract/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#77' })).toHaveAttribute('href', '/contracts/77');
    expect(screen.queryByRole('button', { name: /Change technology/ })).toBeNull();
  });

  it('the new contract says what it replaces', async () => {
    serve({ replaces: { id: 10, status: 'active' }, replaced_by: null });
    renderPanel({ contractId: '77', status: 'pending', technology: 'ftth' });
    expect(await screen.findByText(/This contract replaces contract/)).toBeInTheDocument();
    expect(screen.getByText(/ends when this one is activated/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Change technology/ })).toBeNull();
  });

  it('is not offered without edit permission or for a contract that is not in service', async () => {
    serve({ replaces: null, replaced_by: null });
    const { container, unmount } = renderPanel({ canEdit: false });
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    unmount();
    const second = renderPanel({ status: 'cancelled' });
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    expect(second.container).toBeEmptyDOMElement();
  });
});

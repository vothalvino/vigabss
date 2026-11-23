// Changes to an OLT are previewed first: the exact commands are shown and
// nothing is sent until "Send to the OLT" is pressed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/api/apiFetch', () => {
  class ApiRequestError extends Error {
    constructor(message: string, readonly status: number, readonly body: unknown = null) { super(message); }
  }
  return { apiFetch: (...a: unknown[]) => mocks.apiFetch(...a), ApiRequestError };
});

import { ApiRequestError } from '@/api/apiFetch';
import { AuthoriseOnu, ManagedOnus, ProvisioningSettingsForm } from '../OltProvisioning';

const wrap = (node: ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>,
);
const bodies = () => mocks.apiFetch.mock.calls
  .filter(([, init]) => (init as RequestInit | undefined)?.body)
  .map(([path, init]) => ({ path, ...(JSON.parse(String((init as RequestInit).body))) }));
const PLAN = { applied: false, commands: [{ command: 'config', note: 'configuration mode' }, { command: 'interface gpon 0/1' }, { command: 'ont add 0 2 sn-auth "48575443A1B2C3D4" omci ont-lineprofile-id 20 ont-srvprofile-id 20 desc "contract-55"', note: 'authorise the ONU' }] };

describe('OLT provisioning screen', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('authorising shows the commands first and sends only on confirmation', async () => {
    mocks.apiFetch.mockImplementation(async (_p: string, init?: RequestInit) => ({ data: { ...PLAN, applied: JSON.parse(String(init?.body)).apply === true } }));
    const done = vi.fn();
    const user = userEvent.setup();
    wrap(<AuthoriseOnu oltId={7} port="0/1/0" serial="48575443A1B2C3D4" onDone={done} />);
    await user.click(screen.getByRole('button', { name: 'Authorise' }));
    await user.type(screen.getByLabelText('Contract number'), '55');
    await user.click(screen.getByRole('button', { name: 'Show the commands' }));

    expect(await screen.findByText(/ont add 0 2 sn-auth/)).toBeInTheDocument();
    expect(bodies()).toEqual([{ path: '/olt-management/7/managed-onus', port: '0/1/0', serial_number: '48575443A1B2C3D4', apply: false, contract_id: 55 }]);
    expect(done).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send to the OLT' }));
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(bodies()[1]).toMatchObject({ apply: true, contract_id: 55 });
  });

  it('speeds can be typed instead of a contract, in Mbps', async () => {
    mocks.apiFetch.mockResolvedValue({ data: PLAN });
    const user = userEvent.setup();
    wrap(<AuthoriseOnu oltId={7} port="0/1/0" serial="48575443A1B2C3D4" onDone={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Authorise' }));
    // Nothing can be previewed until there is a contract or both speeds.
    expect(screen.queryByRole('button', { name: 'Show the commands' })).toBeNull();
    await user.type(screen.getByLabelText('Download (Mbps)'), '100');
    await user.type(screen.getByLabelText('Upload (Mbps)'), '20');
    await user.click(screen.getByRole('button', { name: 'Show the commands' }));
    await screen.findByText(/These commands will be sent/);
    expect(bodies()[0]).toMatchObject({ down_kbps: 100000, up_kbps: 20000, apply: false });
    expect(bodies()[0]).not.toHaveProperty('contract_id');
  });

  it('a refusal shows what the OLT answered and leaves the plan open', async () => {
    mocks.apiFetch.mockImplementation(async (_p: string, init?: RequestInit) => {
      if (JSON.parse(String(init?.body)).apply) {
        throw new ApiRequestError('The OLT refused "ont add ...": The line profile does not exist', 502, {
          error: { transcript: [{ command: 'config', output: '' }, { command: 'ont add 0 2', output: '', failed: 'The line profile does not exist' }] },
        });
      }
      return { data: PLAN };
    });
    const user = userEvent.setup();
    wrap(<AuthoriseOnu oltId={7} port="0/1/0" serial="48575443A1B2C3D4" onDone={() => {}} />);
    await user.click(screen.getByRole('button', { name: 'Authorise' }));
    await user.type(screen.getByLabelText('Contract number'), '55');
    await user.click(screen.getByRole('button', { name: 'Show the commands' }));
    await user.click(await screen.findByRole('button', { name: 'Send to the OLT' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The line profile does not exist');
    expect(screen.getByText(/! The line profile does not exist/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to the OLT' })).toBeInTheDocument();
  });

  it('a managed ONU can be re-speeded, switched off and removed, each after a preview', async () => {
    mocks.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (!init?.method) return { data: [{ id: 9, port: '0/1/0', ont_id: 2, serial_number: '48575443A1B2C3D4', contract_id: 55, description: 'contract-55', service_port_index: 1002, up_kbps: 20000, down_kbps: 100000, active: true }] };
      return { data: { applied: false, commands: [{ command: path.endsWith('/remove') ? 'ont delete 0 2' : 'ont deactivate 0 2' }] } };
    });
    const user = userEvent.setup();
    wrap(<ManagedOnus oltId={7} />);
    expect(await screen.findByText(/100 Mbps \/ 20 Mbps/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change speed' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Switch off' }));
    expect(await screen.findByText('ont deactivate 0 2')).toBeInTheDocument();
    expect(bodies()[0]).toEqual({ path: '/olt-management/7/managed-onus/9/active', active: false, apply: false });
    await user.click(screen.getByRole('button', { name: 'Remove from the OLT' }));
    expect(await screen.findByText('ont delete 0 2')).toBeInTheDocument();
    expect(bodies()[1]).toEqual({ path: '/olt-management/7/managed-onus/9/remove', apply: false });
  });

  it('provisioning settings save blanks as "not set"', async () => {
    mocks.apiFetch.mockResolvedValue({ data: {} });
    const user = userEvent.setup();
    wrap(<ProvisioningSettingsForm oltId={7} settings={{ line_profile_id: 20, srv_profile_id: 20, service_vlan: 200, user_vlan: null, gem_port: 2, native_vlan_eth_port: null, traffic_table_base: 200 }} />);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalled());
    expect(bodies()[0]).toEqual({ path: '/olt-management/7/provisioning', line_profile_id: 20, srv_profile_id: 20, service_vlan: 200, gem_port: 2, user_vlan: null, native_vlan_eth_port: null, traffic_table_base: 200 });
  });
});

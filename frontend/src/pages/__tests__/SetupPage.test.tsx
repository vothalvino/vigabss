// A section's setup page: one card per setup tab set, with a line on what it
// is for, listing only what the person's permissions open.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SetupPage } from '../SetupPage';

let user: { role: string; permissions?: string[] } = { role: 'admin' };
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user }) }));

const show = () => render(<MemoryRouter><SetupPage section="network" /></MemoryRouter>);

describe('Network setup page', () => {
  it('shows every setup card with its description and pages', () => {
    user = { role: 'admin' };
    show();
    expect(screen.getByRole('heading', { level: 1, name: 'Network setup' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual([
      'Polling', 'Alerts', 'Device configuration', 'Fibre plant', 'Customer equipment', 'Sessions and speed', 'Addressing', 'Equipment tools', 'Access',
    ]);
    const alerts = screen.getByRole('region', { name: 'Alerts' });
    expect(within(alerts).getByText(/Who is told when something goes wrong/)).toBeInTheDocument();
    expect(within(alerts).getAllByRole('link').map(l => l.getAttribute('href'))).toEqual(['/alert-channels', '/alert-escalation-chains', '/alert-suppression-rules']);
  });

  it('lists only what the person can open', () => {
    user = { role: 'custom', permissions: ['alert_channels.view', 'vlans.view'] };
    show();
    expect(screen.getAllByRole('heading', { level: 2 }).map(h => h.textContent)).toEqual(['Alerts']);
    expect(screen.getAllByRole('link').map(l => l.getAttribute('href'))).toEqual(['/alert-channels']);
  });

  it('says so when nothing is available', () => {
    user = { role: 'custom', permissions: [] };
    show();
    expect(screen.getByText('No pages available for your role.')).toBeInTheDocument();
  });
});

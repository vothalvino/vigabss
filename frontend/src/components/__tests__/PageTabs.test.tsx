// Tabs over the pages of a tab set: every page is a visible link, a phone
// gets a drop-down, and a setup set also links back to its setup page.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PageTabs } from '../PageTabs';
import { ROUTES, SETUP_PAGES, TABSETS, type RouteDef } from '@/nav/routes';
import { lastTab } from '@/nav/lastTab';

const set = (id: string) => TABSETS.find(tabset => tabset.id === id)!;
const pages = (id: string): RouteDef[] => set(id).paths.map(path => ROUTES.find(r => r.path === path)!);

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function show(id: string, at: string, options: { tabs?: RouteDef[]; back?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route
          path="*"
          element={<><PageTabs tabset={set(id)} tabs={options.tabs ?? pages(id)} activePath={at} back={options.back ? SETUP_PAGES.network : null} /><Where /></>}
        />
      </Routes>
    </MemoryRouter>,
  );
}
const strip = () => document.querySelector('.page-tabs-strip') as HTMLElement;

beforeEach(() => window.localStorage.clear());

describe('PageTabs', () => {
  it('shows every page of a set as a link and marks the open one', () => {
    show('equipment', '/nas');
    expect(within(strip()).getAllByRole('link').map(l => l.getAttribute('href'))).toEqual(set('equipment').paths);
    expect(within(strip()).getByRole('link', { current: 'page' }).getAttribute('href')).toBe('/nas');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing for a single everyday page', () => {
    show('equipment', '/sites', { tabs: pages('equipment').slice(0, 1) });
    expect(document.querySelector('.page-tabs')).toBeNull();
  });

  it('a setup set starts with a link back to the setup page', () => {
    show('alerts', '/alert-channels', { back: true });
    const links = within(strip()).getAllByRole('link');
    expect(links[0].getAttribute('href')).toBe('/network/setup');
    expect(links[0].textContent).toBe('‹ Network setup');
    expect(links.slice(1).map(l => l.getAttribute('href'))).toEqual(set('alerts').paths);
    fireEvent.click(links[0]);
    expect(screen.getByTestId('where').textContent).toBe('/network/setup');
  });

  it('a setup set of one page still shows the way back', () => {
    show('access', '/wg-tunnels', { back: true });
    expect(within(strip()).getAllByRole('link').map(l => l.getAttribute('href'))).toEqual(['/network/setup', '/wg-tunnels']);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('offers the same pages as a drop-down, which a phone shows instead', () => {
    show('addresses', '/ip-pools');
    const select = screen.getByRole('combobox', { name: 'IP addresses' }) as HTMLSelectElement;
    expect([...select.options].map(o => o.value)).toEqual(set('addresses').paths);
    expect(select.value).toBe('/ip-pools');
    fireEvent.change(select, { target: { value: '/vlans' } });
    expect(screen.getByTestId('where').textContent).toBe('/vlans');
  });

  it('remembers the open page of the set', () => {
    show('addresses', '/vlans');
    expect(lastTab('addresses')).toBe('/vlans');
    expect(lastTab('equipment')).toBeNull();
  });
});

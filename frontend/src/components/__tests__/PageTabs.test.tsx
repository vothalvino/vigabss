// Tabs over the pages of a tab set: long sets fold under "More", the open
// page is always in the strip, and a phone gets a drop-down.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { MAX_TABS, PageTabs } from '../PageTabs';
import { ROUTES, TABSETS, type RouteDef } from '@/nav/routes';
import { lastTab } from '@/nav/lastTab';

const set = (id: string) => TABSETS.find(tabset => tabset.id === id)!;
const pages = (id: string): RouteDef[] => set(id).paths.map(path => ROUTES.find(r => r.path === path)!);

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function show(id: string, at: string, tabs = pages(id)) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route path="*" element={<><PageTabs tabset={set(id)} tabs={tabs} activePath={at} /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => window.localStorage.clear());

describe('PageTabs', () => {
  it('shows every page of a short set as a link and marks the open one', () => {
    show('speedAccess', '/suspension-rules');
    const strip = document.querySelector('.page-tabs-strip') as HTMLElement;
    expect(within(strip).getAllByRole('link').map(l => l.getAttribute('href'))).toEqual(['/qos-bandwidth', '/suspension-rules', '/suspension-console']);
    expect(within(strip).getByRole('link', { current: 'page' }).getAttribute('href')).toBe('/suspension-rules');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders nothing for a single page', () => {
    show('speedAccess', '/qos-bandwidth', pages('speedAccess').slice(0, 1));
    expect(document.querySelector('.page-tabs')).toBeNull();
  });

  it('folds the rest of a long set under "More"', () => {
    show('pollingAlerts', '/snmp-metrics');
    const strip = document.querySelector('.page-tabs-strip') as HTMLElement;
    expect(within(strip).getAllByRole('link')).toHaveLength(MAX_TABS);
    const more = screen.getByRole('button', { name: 'More (3)' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    const menu = document.querySelector('.page-tabs-menu') as HTMLElement;
    expect(within(menu).getAllByRole('link').map(l => l.getAttribute('href'))).toEqual(['/alert-channels', '/alert-escalation-chains', '/alert-suppression-rules']);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('.page-tabs-menu')).toBeNull();
  });

  it('keeps the open page in the strip when it would fall under "More"', () => {
    show('pollingAlerts', '/alert-suppression-rules');
    const strip = document.querySelector('.page-tabs-strip') as HTMLElement;
    const shown = [...strip.querySelectorAll(':scope > a')].map(l => l.getAttribute('href'));
    expect(shown).toHaveLength(MAX_TABS);
    expect(shown[MAX_TABS - 1]).toBe('/alert-suppression-rules');
    expect(screen.getByRole('button', { name: 'More (3)' })).toBeInTheDocument();
  });

  it('closes "More" after moving to another page', () => {
    show('pollingAlerts', '/snmp-metrics');
    fireEvent.click(screen.getByRole('button', { name: 'More (3)' }));
    fireEvent.click(within(document.querySelector('.page-tabs-menu') as HTMLElement).getAllByRole('link')[0]);
    expect(screen.getByTestId('where').textContent).toBe('/alert-channels');
    expect(document.querySelector('.page-tabs-menu')).toBeNull();
  });

  it('offers the same pages as a drop-down, which a phone shows instead', () => {
    show('fibre', '/olt-management');
    const select = screen.getByRole('combobox', { name: 'Fibre (FTTH)' }) as HTMLSelectElement;
    expect([...select.options].map(o => o.value)).toEqual(set('fibre').paths);
    expect(select.value).toBe('/olt-management');
    fireEvent.change(select, { target: { value: '/fiber-plant-management' } });
    expect(screen.getByTestId('where').textContent).toBe('/fiber-plant-management');
  });

  it('remembers the open page of the set', () => {
    show('fibre', '/pon-port-management');
    expect(lastTab('fibre')).toBe('/pon-port-management');
    expect(lastTab('cpe')).toBeNull();
  });
});

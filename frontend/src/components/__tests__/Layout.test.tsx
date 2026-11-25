// =============================================================================
// VigaBSS 5.0 — Layout (sidebar navigation grouping) tests
// =============================================================================
// Verifies the sidebar groups nav items into translated sections and that
// section headings only appear when the user can see at least one item in them.
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from '../Layout';
import { DarkModeProvider } from '@/auth/DarkModeContext';
import { AccentProvider } from '@/auth/AccentContext';
import * as AuthContextModule from '@/auth/AuthContext';
import type { AuthUser } from '@/auth/AuthContext';

// ---------------------------------------------------------------------------
// Mocks — api client (used by DrDrillBanner/ChangelogPanel inside Layout)
// ---------------------------------------------------------------------------

const mockApiGet = vi.fn();
// The person's own menu (GET /menus/mine). Tests set `myMenu` to give one.
let myMenu: unknown = { layout: null, source: 'standard', template: null, can_edit: true };
const menuSaves: unknown[] = [];
vi.mock('@/api/apiFetch', () => ({
  apiFetch: async (path: string, init?: RequestInit) => {
    if (path === '/menus/mine' && init?.method === 'PUT') {
      const layout = JSON.parse(String(init.body)).layout;
      menuSaves.push(layout);
      myMenu = { layout, source: 'personal', template: null, can_edit: true };
    }
    return { data: myMenu };
  },
}));

vi.mock('@/api/client', () => ({
  api: { GET: (...args: unknown[]) => mockApiGet(...args) },
  tokenStore: {
    getAccess: () => 'test-token',
    setAccess: vi.fn(),
    getRefresh: () => null,
    setRefresh: vi.fn(),
    clear: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * @param isInstallOperator drives the all-orgs switcher. It is a BACKEND-resolved
 *   fact, not users.role: every organisation has an admin, so the role could
 *   never distinguish the person who runs the install (j67).
 */
function makeUser(role: string, isInstallOperator = false): AuthUser {
  return {
    id: 1,
    email: `${role}@test.com`,
    name: role,
    role,
    is_install_operator: isInstallOperator,
    has_global_organization_access: isInstallOperator,
    organization_id: 1,
    is_active: true,
    email_verified_at: '2026-01-01T00:00:00.000Z',
    twofa_enabled: false,
  };
}

function mockUseAuth(user: AuthUser | null, overrides?: Partial<ReturnType<typeof AuthContextModule.useAuth>>) {
  vi.spyOn(AuthContextModule, 'useAuth').mockReturnValue({
    user,
    loading: false,
    initialized: true,
    login: vi.fn(),
    logout: vi.fn(),
    refresh: vi.fn(),
    switchOrganization: vi.fn(),
    ...overrides,
  } as ReturnType<typeof AuthContextModule.useAuth>);
}

// Most tests don't care about routing at all — Layout is just mounted as a
// plain child. The org-switch navigation test needs real route matching (to
// prove `navigate('/')` actually lands somewhere), so it opts into a Routes
// stub with a sentinel standing in for the Dashboard page at '/'.
function buildTree(qc: QueryClient, options?: { initialEntries?: string[]; withDashboardStub?: boolean }) {
  const routed = options?.withDashboardStub;
  const initialEntries = options?.initialEntries ?? ['/'];
  return (
    <QueryClientProvider client={qc}>
      <DarkModeProvider>
        <AccentProvider>
        <MemoryRouter initialEntries={initialEntries}>
          {routed ? (
            <Routes>
              <Route path="/" element={<div>DASHBOARD_SENTINEL</div>} />
              <Route path="*" element={<Layout />} />
            </Routes>
          ) : (
            <Layout />
          )}
        </MemoryRouter>
        </AccentProvider>
      </DarkModeProvider>
    </QueryClientProvider>
  );
}

function renderLayout(options?: { initialEntries?: string[]; withDashboardStub?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(buildTree(qc, options));
  return { ...utils, qc };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Layout — grouped sidebar navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue({ data: undefined, error: undefined });
    sessionStorage.clear();
    localStorage.clear(); // accordion expanded-state persists here between renders
    myMenu = { layout: null, source: 'standard', template: null, can_edit: true };
    menuSaves.length = 0;
    // jsdom does not implement matchMedia, which DarkModeProvider relies on.
    if (!window.matchMedia) {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as unknown as typeof window.matchMedia;
    }
  });

  it('renders every section header for an admin, fully collapsed until a section is opened', async () => {
    mockUseAuth(makeUser('admin'));
    renderLayout();
    const { fireEvent } = await import('@testing-library/react');
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });

    // Section headers are always visible; collapsed sections hide their rows.
    for (const heading of ['Dashboard', 'Billing', 'Support', 'Field Work', 'Network', 'Inventory', 'Compliance', 'Administration']) {
      expect(within(nav).getByText(heading)).toBeInTheDocument();
    }
    // Nothing auto-expands on first load — the sidebar starts fully collapsed.
    expect(screen.queryByText('Leads')).not.toBeInTheDocument();
    expect(screen.queryByText('Invoices')).not.toBeInTheDocument();
    // The responsive shell mounts one global notification control, rather
    // than duplicate desktop/mobile copies hidden only by CSS.
    expect(screen.getAllByRole('button', { name: /^Notifications/ })).toHaveLength(1);

    // Clicking a section header opens it.
    fireEvent.click(screen.getByText('Clients'));
    // 'Clients' now appears twice: the (open) section header and its first row.
    expect(screen.getAllByText('Clients').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Leads')).toBeInTheDocument();
    // Other sections remain collapsed.
    expect(screen.queryByText('Invoices')).not.toBeInTheDocument();
    // Plain groups expose one disclosure control, not duplicate adjacent
    // buttons that perform the same action.
    expect(within(nav).getAllByRole('button', { name: /Clients/ })).toHaveLength(1);
  });

  it('gives support only its sections, all collapsed until the support kit is opened', async () => {
    mockUseAuth(makeUser('support'));
    renderLayout();
    const { fireEvent } = await import('@testing-library/react');

    expect(screen.getByText('Clients')).toBeInTheDocument();
    expect(screen.getByText('Support')).toBeInTheDocument();
    expect(screen.getByText('Network')).toBeInTheDocument();
    // Billing (all rows billing-only), Compliance, Field Work and Admin are gone —
    // support lacks the permissions/route guards for every row in them.
    expect(screen.queryByText('Billing')).not.toBeInTheDocument();
    expect(screen.queryByText('Compliance')).not.toBeInTheDocument();
    expect(screen.queryByText('Field Work')).not.toBeInTheDocument();
    expect(screen.queryByText('Administration')).not.toBeInTheDocument();
    // Support's primary section stays collapsed until clicked.
    expect(screen.queryByText('Tickets')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Support'));
    expect(screen.getByText('Tickets')).toBeInTheDocument();
  });

  it('gives technicians their field kit from the shared registry (no hardcoded fork)', async () => {
    mockUseAuth(makeUser('technician'));
    renderLayout();
    const { fireEvent } = await import('@testing-library/react');

    expect(screen.getByText('Field Work')).toBeInTheDocument();
    expect(screen.getByText('Network')).toBeInTheDocument();
    expect(screen.getByText('Inventory')).toBeInTheDocument();
    // Pages the technician role 403s on (audit: leads/surveys) and the
    // billing/admin sections are gone.
    expect(screen.queryByText('Leads')).not.toBeInTheDocument();
    expect(screen.queryByText('Billing')).not.toBeInTheDocument();
    expect(screen.queryByText('Administration')).not.toBeInTheDocument();
    // Nothing auto-expands, including the technician's own primary section.
    expect(screen.queryByText('Work Orders')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Field Work'));
    expect(screen.getByText('Work Orders')).toBeInTheDocument();
    // Tickets lives in the (collapsed) Support section since migration 394
    // granted technicians tickets.view.
    fireEvent.click(screen.getByText('Support'));
    expect(screen.getByText('Tickets')).toBeInTheDocument();
    // Expanding Network reveals the shortlist and the View-all row to the hub.
    fireEvent.click(screen.getByText('Network'));
    // Only one section remains open, so the rail cannot accumulate density.
    expect(screen.queryByText('Tickets')).not.toBeInTheDocument();
    expect(screen.getByText('Equipment')).toBeInTheDocument();
    expect(screen.getByText(/View all \d+/)).toBeInTheDocument();
    // The long tail is hub-only, not rail rows.
    expect(screen.queryByText('VLANs')).not.toBeInTheDocument();
  });

  it('honors a stored expanded-sections array from localStorage instead of collapsing it', () => {
    // A section other than admin's persona default ('clients') so this test
    // can't pass by accident via the (now-removed) persona-seeding behavior.
    localStorage.setItem('vigabss.nav.expanded', JSON.stringify(['support']));
    mockUseAuth(makeUser('admin'));
    renderLayout();

    // 'support' was explicitly persisted open — its rows render with no click.
    expect(screen.getByText('Tickets')).toBeInTheDocument();
    // Sections that were never stored/opened stay collapsed.
    expect(screen.queryByText('Leads')).not.toBeInTheDocument();
    expect(screen.queryByText('Invoices')).not.toBeInTheDocument();
  });

  it('reseeds the persona default when a role switch stops the sidebar from stranding on an invisible section', async () => {
    mockUseAuth(makeUser('billing'));
    const { rerender, qc } = renderLayout();
    const { fireEvent } = await import('@testing-library/react');

    // Billing opens its own section by clicking the header.
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByText('Billing'));
    expect(screen.getByText('Invoices')).toBeInTheDocument();

    // Switch to a role that can't see Billing at all. The previously-open
    // section is now invisible ("stranded") — the new persona's default
    // section must open in its place rather than leaving the nav empty.
    mockUseAuth(makeUser('support'));
    rerender(buildTree(qc));
    expect(within(screen.getByRole('navigation', { name: 'Primary navigation' })).queryByText('Billing')).not.toBeInTheDocument();
    expect(screen.getByText('Tickets')).toBeInTheDocument();
  });

  it('hub sections collapse again via the chevron after being opened (regression)', async () => {
    mockUseAuth(makeUser('technician'));
    renderLayout();
    const { fireEvent } = await import('@testing-library/react');

    // Label click on a hub header expands the section (and navigates to the hub).
    fireEvent.click(screen.getByText('Network'));
    expect(screen.getByText('Equipment')).toBeInTheDocument();

    // The chevron is a separate toggle — an opened hub must collapse again.
    const chevron = screen.getByRole('button', { name: 'Expand or collapse Network' });
    fireEvent.click(chevron);
    expect(screen.queryByText('Equipment')).not.toBeInTheDocument();
    fireEvent.click(chevron);
    expect(screen.getByText('Equipment')).toBeInTheDocument();
  });

  it('opens the command palette from the sidebar button and filters by role', async () => {
    mockUseAuth(makeUser('technician'));
    renderLayout();
    const { fireEvent } = await import('@testing-library/react');

    fireEvent.click(screen.getByText('Search…'));
    const input = screen.getByRole('combobox', { name: 'Go to page' });
    expect(input).toBeInTheDocument();

    // Technician can jump to work orders…
    fireEvent.change(input, { target: { value: 'Work Or' } });
    expect(screen.getByRole('option', { name: /Work Orders/ })).toBeInTheDocument();

    // …but pages their role can't load never appear (leads — no leads.view).
    fireEvent.change(input, { target: { value: 'Leads' } });
    expect(screen.queryByRole('option', { name: /Leads/ })).not.toBeInTheDocument();

    // Esc closes.
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('combobox', { name: 'Go to page' })).not.toBeInTheDocument();
  });

  it('opens the command palette with Ctrl+K', async () => {
    mockUseAuth(makeUser('admin'));
    renderLayout();
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(screen.getByRole('combobox', { name: 'Go to page' })).toBeInTheDocument();
  });

  it('offers navigation focus to multi-area staff and keeps every authorized area available', async () => {
    mockUseAuth(makeUser('technician'));
    const first = renderLayout();
    expect(screen.queryByLabelText('Navigation focus')).not.toBeInTheDocument();
    first.unmount();

    mockUseAuth(makeUser('admin'));
    renderLayout();
    const { fireEvent } = await import('@testing-library/react');
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    const select = screen.getByLabelText('Navigation focus');
    fireEvent.change(select, { target: { value: 'billing' } });
    // Billing-related areas move first, while unrelated authorized tools stay
    // discoverable below the explicit All areas divider.
    expect(within(nav).getByText('Dashboard')).toBeInTheDocument();
    expect(within(nav).getByText('Billing')).toBeInTheDocument();
    expect(within(nav).getByText('Compliance')).toBeInTheDocument();
    expect(within(nav).getByText('Network')).toBeInTheDocument();
    expect(within(nav).getByText('Field Work')).toBeInTheDocument();
    expect(within(nav).getByText('Focused areas')).toBeInTheDocument();
    expect(within(nav).getByText('All areas')).toBeInTheDocument();
    expect(
      within(nav).getByText('Billing').compareDocumentPosition(within(nav).getByText('Network'))
      & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Back to the full view restores canonical order and removes group dividers.
    fireEvent.change(select, { target: { value: 'full' } });
    expect(within(nav).getByText('Network')).toBeInTheDocument();
    expect(within(nav).queryByText('Focused areas')).not.toBeInTheDocument();
  });

  it('keeps the current route visible when another navigation focus is selected', async () => {
    mockUseAuth(makeUser('admin'));
    renderLayout({ initialEntries: ['/network'] });
    const { fireEvent } = await import('@testing-library/react');
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });

    fireEvent.change(screen.getByLabelText('Navigation focus'), { target: { value: 'billing' } });
    const network = within(nav).getByText('Network');
    const allAreas = within(nav).getByText('All areas');
    expect(network).toBeInTheDocument();
    expect(network.compareDocumentPosition(allAreas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(nav).getByText('Equipment')).toBeInTheDocument();
  });

  it('closes the mobile drawer with Escape and restores focus to its opener', async () => {
    mockUseAuth(makeUser('admin'));
    renderLayout();
    const { fireEvent, waitFor } = await import('@testing-library/react');
    const opener = screen.getByRole('button', { name: 'Open navigation' });

    fireEvent.click(opener);
    expect(screen.getByRole('button', { name: 'Close navigation' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Open navigation' })).toHaveFocus());
    expect(opener).toHaveAttribute('aria-expanded', 'false');
  });

  // A tenant admin carries users.role='admin' too, but cannot switch into an
  // org they are not a member of — so offering them the all-orgs switcher is a
  // list of doors that 403 (j67).
  it('does not offer the all-orgs switcher to a tenant admin', async () => {
    mockUseAuth(makeUser('admin', false));
    renderLayout();
    expect((await screen.findAllByText(/Dashboard/i)).length).toBeGreaterThan(0);
    expect(mockApiGet).not.toHaveBeenCalledWith('/organizations', expect.anything());
  });

  it('shows an org switcher listing all organizations for the install operator', async () => {
    mockUseAuth(makeUser('admin', true));
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/organizations') {
        return Promise.resolve({ data: { data: [{ id: 1, name: 'Org A' }, { id: 2, name: 'Org B' }] }, error: undefined });
      }
      return Promise.resolve({ data: undefined, error: undefined });
    });
    renderLayout();

    // The all-orgs query populates the switcher with every organization, even
    // ones the operator isn't an explicit member of. 'Org B' appears only as a
    // switcher option; 'Org A' (the active org) shows in both the option list
    // and the topbar label.
    expect(await screen.findByText('Org B')).toBeInTheDocument();
    expect(screen.getAllByText('Org A').length).toBeGreaterThanOrEqual(1);
  });

  it('shows the same all-organization switcher for a backend-resolved super administrator', async () => {
    const superAdmin = makeUser('admin', false);
    superAdmin.has_global_organization_access = true;
    mockUseAuth(superAdmin);
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/organizations') {
        return Promise.resolve({ data: { data: [{ id: 1, name: 'Org A' }, { id: 2, name: 'Org B' }] }, error: undefined });
      }
      return Promise.resolve({ data: undefined, error: undefined });
    });
    renderLayout();

    expect(await screen.findByText('Org B')).toBeInTheDocument();
  });

  it('readonly (multi-org member) sees its own memberships and never fires the global-only all-orgs query', async () => {
    // Regression for a review-caught bug: hasRole(user.role, 'admin') gives
    // readonly a bypass for PAGE-REACHABILITY (PrivateRoute/canSee), but
    // Layout's global-access flag decides a LITERAL privilege (can this user list every
    // org on the platform?) — readonly must not inherit that bypass here, or
    // the all-orgs query fires, 403s/returns something readonly has no real
    // access to, and — worse — `orgs = isAdmin ? (allOrgs ?? memberships) :
    // memberships` would stop falling back to `memberships`, so a readonly
    // user who legitimately belongs to 2 orgs would lose the switcher.
    const readonlyUser = makeUser('readonly');
    readonlyUser.organizations = [
      { id: 1, name: 'Org A' },
      { id: 2, name: 'Org B' },
    ];
    mockUseAuth(readonlyUser);
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/organizations') {
        // If this fired for readonly it would "succeed" here, which is
        // exactly why the assertion below must prove it was never called.
        return Promise.resolve({ data: { data: [{ id: 1, name: 'Org A' }, { id: 2, name: 'Org B' }, { id: 3, name: 'Org C (not a member)' }] }, error: undefined });
      }
      return Promise.resolve({ data: undefined, error: undefined });
    });
    renderLayout();

    // Own memberships render (from user.organizations, not the all-orgs query).
    expect(await screen.findByLabelText('Active organization')).toBeInTheDocument();
    expect(screen.getAllByText('Org A').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Org B')).toBeInTheDocument();
    // Never sees an org it isn't a member of.
    expect(screen.queryByText('Org C (not a member)')).not.toBeInTheDocument();
    // The global-only all-orgs query itself must never have fired.
    expect(mockApiGet).not.toHaveBeenCalledWith('/organizations', expect.anything());
  });

  it('navigates to the dashboard after a successful org switch, even from a non-dashboard page', async () => {
    const switchOrganization = vi.fn().mockResolvedValue(undefined);
    mockUseAuth(makeUser('admin', true), { switchOrganization });
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/organizations') {
        return Promise.resolve({ data: { data: [{ id: 1, name: 'Org A' }, { id: 2, name: 'Org B' }] }, error: undefined });
      }
      return Promise.resolve({ data: undefined, error: undefined });
    });
    // Mounted on a page that is not the dashboard (the sentinel below stands
    // in for it), proving the switch actually navigates rather than being a
    // no-op because the user happened to already be there.
    renderLayout({ withDashboardStub: true, initialEntries: ['/clients'] });
    const { fireEvent } = await import('@testing-library/react');

    await screen.findByText('Org B');
    const select = screen.getByLabelText('Active organization');
    fireEvent.change(select, { target: { value: '2' } });

    expect(switchOrganization).toHaveBeenCalledWith(2);
    expect(await screen.findByText('DASHBOARD_SENTINEL')).toBeInTheDocument();
  });

  it('does not navigate when the org switch fails, leaving the user on the current page', async () => {
    const switchOrganization = vi.fn().mockRejectedValue(new Error('switch failed'));
    mockUseAuth(makeUser('admin', true), { switchOrganization });
    mockApiGet.mockImplementation((path: string) => {
      if (path === '/organizations') {
        return Promise.resolve({ data: { data: [{ id: 1, name: 'Org A' }, { id: 2, name: 'Org B' }] }, error: undefined });
      }
      return Promise.resolve({ data: undefined, error: undefined });
    });
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    renderLayout({ withDashboardStub: true, initialEntries: ['/clients'] });
    const { fireEvent, waitFor } = await import('@testing-library/react');

    await screen.findByText('Org B');
    const select = screen.getByLabelText('Active organization');
    fireEvent.change(select, { target: { value: '2' } });

    // The existing alert path fires and the user stays put — no navigation.
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('switch failed'));
    expect(screen.queryByText('DASHBOARD_SENTINEL')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Active organization')).toBeInTheDocument();
    alertSpy.mockRestore();
  });

  // --- Tab sets: several pages behind one sidebar row -------------------------

  it('shows the pages of a tab set as tabs over the page, titled by the set', () => {
    mockUseAuth(makeUser('admin'));
    renderLayout({ initialEntries: ['/onu-management'] });
    const tabs = screen.getByRole('navigation', { name: 'Equipment' });
    const links = within(tabs.querySelector('.page-tabs-strip') as HTMLElement).getAllByRole('link');
    expect(links.map(link => link.getAttribute('href'))).toEqual(['/sites', '/devices', '/nas', '/olt-management', '/onu-management', '/wireless', '/cpe-management']);
    expect(links.find(link => link.getAttribute('aria-current'))?.textContent).toBe('ONU Management');
    expect(document.querySelector('.app-topbar-title')?.textContent).toBe('Equipment');
    // The sidebar row for the set is current on any of its pages.
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(within(nav).getByRole('link', { current: 'page' }).textContent).toBe('Equipment');
  });

  it('a setup page shows the way back and its card\'s pages, under the Network setup row', () => {
    mockUseAuth(makeUser('admin'));
    renderLayout({ initialEntries: ['/alert-escalation-chains'] });
    const strip = document.querySelector('.page-tabs-strip') as HTMLElement;
    expect(within(strip).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/network/setup', '/alert-channels', '/alert-escalation-chains', '/alert-suppression-rules']);
    expect(document.querySelector('.app-topbar-title')?.textContent).toBe('Alerts');
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    const row = within(nav).getByRole('link', { current: 'page' });
    expect([row.textContent, row.getAttribute('href')]).toEqual(['Network setup', '/network/setup']);
  });

  it('the setup page itself is titled and highlights its row', () => {
    mockUseAuth(makeUser('admin'));
    renderLayout({ initialEntries: ['/network/setup'] });
    expect(document.querySelector('.app-topbar-title')?.textContent).toBe('Network setup');
    expect(document.querySelector('.page-tabs')).toBeNull();
    expect(document.querySelector('.nav-leaf.active')?.textContent).toBe('Network setup');
  });

  it('a sidebar row leads to the page of its set that was open last', () => {
    mockUseAuth(makeUser('admin'));
    const first = renderLayout({ initialEntries: ['/vlans'] });
    first.unmount();
    renderLayout({ initialEntries: ['/network'] });
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(within(nav).getByText('IP addresses').getAttribute('href')).toBe('/vlans');
    expect(within(nav).getByText('Equipment').getAttribute('href')).toBe('/sites');
  });

  it('the row of the page being viewed points at that page, not at the one opened before', () => {
    mockUseAuth(makeUser('admin'));
    localStorage.setItem('vigabss.nav.lastTab.equipment', '/olt-management');
    renderLayout({ initialEntries: ['/onu-management'] });
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(within(nav).getByText('Equipment').getAttribute('href')).toBe('/onu-management');
  });

  it('a section grouped into tab sets counts its groups, not the pages inside them', () => {
    mockUseAuth(makeUser('admin'));
    renderLayout({ initialEntries: ['/network'] });
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(within(nav).getByText('View all 6 →')).toBeInTheDocument();
    expect(within(nav).queryByText('55')).not.toBeInTheDocument();
  });

  it('Menu templates is a tab of People and access, and that row is highlighted on it', async () => {
    mockUseAuth(makeUser('admin'));
    renderLayout({ initialEntries: ['/menu-templates'] });
    expect(document.querySelector('.nav-leaf.active')?.textContent).toBe('People and access');
    const strip = document.querySelector('.page-tabs-strip') as HTMLElement;
    expect(within(strip).getAllByRole('link').map(link => link.textContent)).toEqual(['Users', 'User groups', 'Menu templates', 'Security & Access Control', 'API Tokens', 'User Tunnels']);
    expect(within(strip).getByRole('link', { current: 'page' }).getAttribute('href')).toBe('/menu-templates');
  });

  it('Billing: an everyday page shows its set\'s tabs, a setup page the way back', () => {
    mockUseAuth(makeUser('admin'));
    const first = renderLayout({ initialEntries: ['/credit-notes'] });
    let strip = document.querySelector('.page-tabs-strip') as HTMLElement;
    expect(within(strip).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/invoices', '/credit-notes', '/billing-adjustments']); // no CFDI: this user's organization is not in Mexico
    expect(document.querySelector('.app-topbar-context')?.textContent).toBe('BillingInvoices');
    expect(document.querySelector('.nav-leaf.active')?.textContent).toBe('Invoices');
    first.unmount();
    renderLayout({ initialEntries: ['/late-fee-rules'] });
    strip = document.querySelector('.page-tabs-strip') as HTMLElement;
    expect(within(strip).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/billing/setup', '/late-fee-rules', '/payment-reminder-settings']);
    expect(document.querySelector('.nav-leaf.active')?.textContent).toBe('Billing setup');
  });

  it('a page that is alone in its set has no tabs and keeps its own title', () => {
    mockUseAuth(makeUser('admin'));
    renderLayout({ initialEntries: ['/topology-map'] });
    expect(document.querySelector('.page-tabs')).toBeNull();
    expect(document.querySelector('.app-topbar-title')?.textContent).toBe('Topology Map');
  });

  it('a page outside any tab set has no tabs', () => {
    mockUseAuth(makeUser('admin'));
    renderLayout({ initialEntries: ['/clients'] });
    expect(document.querySelector('.page-tabs')).toBeNull();
  });

  // --- A menu of one's own -----------------------------------------------------

  const desk = { layout: { groups: [{ name: 'My mornings', pages: ['/invoices', '/noc-dashboard'] }, { name: 'Empty for me', pages: ['/not-a-page'] }] }, source: 'personal', template: null, can_edit: true };

  it('shows the person\'s groups instead of the standard sidebar, which folds under All pages', async () => {
    myMenu = desk;
    mockUseAuth(makeUser('admin'));
    renderLayout({ initialEntries: ['/invoices'] });
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    const group = await within(nav).findByRole('group', { name: 'My mornings' });
    expect(within(group).getAllByRole('link').map(link => [link.textContent, link.getAttribute('href')])).toEqual([['Invoices', '/invoices'], ['NOC Dashboard', '/noc-dashboard']]);
    expect(within(group).getByRole('link', { current: 'page' }).textContent).toBe('Invoices');
    // A group with nothing the person can open is not shown.
    expect(within(nav).queryByRole('group', { name: 'Empty for me' })).toBeNull();
    // The standard sections are one click away.
    expect(within(nav).queryByText('Billing')).toBeNull();
    const all = within(nav).getByRole('button', { name: 'All pages' });
    expect(all.getAttribute('aria-expanded')).toBe('false');
    const { fireEvent } = await import('@testing-library/react');
    // Navigation focus orders the standard sidebar, so with a menu of one's own
    // it is hidden until that sidebar is, and then sits right under "All pages".
    expect(screen.queryByLabelText('Navigation focus')).toBeNull();
    fireEvent.click(all);
    expect(within(nav).getByText('Billing')).toBeInTheDocument();
    expect(within(nav).getByText('Dashboard')).toBeInTheDocument();
    const focus = screen.getByLabelText('Navigation focus');
    expect(document.getElementById('nav-all-pages')?.contains(focus)).toBe(true);
    expect(all.compareDocumentPosition(focus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(focus.compareDocumentPosition(within(nav).getByText('Billing')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a menu never shows a page the person may not open', async () => {
    myMenu = { ...desk, layout: { groups: [{ name: 'Mixed', pages: ['/invoices', '/tickets', '/users'] }] } };
    mockUseAuth(makeUser('support'));
    renderLayout();
    const group = await screen.findByRole('group', { name: 'Mixed' });
    expect(within(group).getAllByRole('link').map(link => link.getAttribute('href'))).toEqual(['/tickets']);
  });

  it('without a menu the standard sidebar is shown, with no All pages row', async () => {
    mockUseAuth(makeUser('admin'));
    renderLayout();
    const nav = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect(within(nav).getByText('Billing')).toBeInTheDocument();
    expect(within(nav).queryByRole('button', { name: 'All pages' })).toBeNull();
    // With no menu of one's own, Navigation focus stays above the sidebar.
    expect(nav.contains(screen.getByLabelText('Navigation focus'))).toBe(false);
    expect(await screen.findByRole('link', { name: 'Edit my menu' })).toHaveAttribute('href', '/my-menu');
  });

  it('pins the open page into a named group and saves it as the person\'s own menu', async () => {
    mockUseAuth(makeUser('admin'));
    renderLayout({ initialEntries: ['/invoices'] });
    const { fireEvent, waitFor } = await import('@testing-library/react');
    fireEvent.click(await screen.findByRole('button', { name: 'Pin Invoices to my menu' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'New group' }), { target: { value: 'Collections' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(menuSaves).toEqual([{ groups: [{ name: 'Collections', pages: ['/invoices'] }] }]));
    const group = await screen.findByRole('group', { name: 'Collections' });
    expect(within(group).getByRole('link').getAttribute('href')).toBe('/invoices');
    expect(screen.getByRole('button', { name: 'Invoices is in my menu' })).toBeInTheDocument();
    // Unticking the group takes the page out again.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Collections' }));
    await waitFor(() => expect(menuSaves[1]).toEqual({ groups: [{ name: 'Collections', pages: [] }] }));
  });

  it('a locked template can be neither pinned to nor edited', async () => {
    myMenu = { ...desk, source: 'template', template: { id: 7, name: 'Billing desk', locked: true, given_to: 'group' }, can_edit: false };
    mockUseAuth(makeUser('admin'));
    renderLayout({ initialEntries: ['/invoices'] });
    await screen.findByRole('group', { name: 'My mornings' });
    expect(screen.queryByRole('button', { name: /my menu/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit my menu' })).toBeNull();
  });
});

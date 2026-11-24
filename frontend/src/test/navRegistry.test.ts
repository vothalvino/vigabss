// =============================================================================
// VigaBSS 5.0 — Nav registry invariants ("Faro" nav)
// =============================================================================
// Kills the URL-only-page bug class forever:
//   • every staff path routed in App.tsx has exactly one home in the registry
//   • every registry entry is actually routed (no dead nav rows)
//   • every entry is reachable — sidebar rail and/or hub card
//   • the registry `guard` mirrors the PrivateRoute wrapper in App.tsx, so
//     canSee() can never show a row that would render <NotAllowed/>
//   • every i18n key the nav consumes exists in all three locales
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HUB_CARDS, ROUTES, SECTIONS, TABSETS, WORKSPACES, routeForPath, tabsetForPath, visibleHubCards, visibleRailItems, visibleRailRows, visibleTabs, type Guard } from '@/nav/routes';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';
import ptBR from '@/i18n/locales/pt-BR.json';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appSrc = fs.readFileSync(path.resolve(__dirname, '../App.tsx'), 'utf8');

// Public/portal paths and the fallbacks are not staff nav destinations.
// 'ai-assistant' is a redirect to the Settings tab of /ai-support (the two AI
// pages became one); it has no page and so no nav home of its own.
const IGNORED = new Set(['login', 'forgot-password', 'reset-password', 'verify-email', '404', '*', 'ai-assistant']);

/** Parse App.tsx into (path → guard) using the PrivateRoute wrapper structure. */
function routedPaths(): Map<string, Guard> {
  const result = new Map<string, Guard>();
  let guard: Guard | 'portal' | null = null;
  for (const line of appSrc.split('\n')) {
    const wrapper = line.match(/<Route element={<(PrivateRoute|PortalRoute)(?:\s+requiredRole="(\w+)")?\s*\/>}>/);
    if (wrapper) {
      guard = wrapper[1] === 'PortalRoute' ? 'portal' : ((wrapper[2] as Guard) ?? 'any');
      continue;
    }
    const m = line.match(/<Route path="([^"]+)"/);
    if (!m) continue;
    const p = m[1];
    if (guard === 'portal' || p.startsWith('portal')) continue;
    if (IGNORED.has(p) || p.includes(':')) continue;
    if (guard === null) continue; // public routes before the wrappers
    result.set(`/${p}`, guard);
  }
  return result;
}

const HUB_PATHS: Record<string, string> = { '/billing': 'billing', '/network': 'network', '/admin': 'admin' };

describe('nav registry ↔ App.tsx invariants', () => {
  const routed = routedPaths();

  it('parses a plausible number of staff routes from App.tsx', () => {
    expect(routed.size).toBeGreaterThan(100);
  });

  it('has no duplicate paths in the registry', () => {
    const seen = new Set<string>();
    for (const r of ROUTES) {
      expect(seen.has(r.path), `duplicate registry entry for ${r.path}`).toBe(false);
      seen.add(r.path);
    }
  });

  it('uses the most specific registered route for shell page context', () => {
    expect(routeForPath('/clients')?.path).toBe('/clients');
    expect(routeForPath('/admin/user-tunnels')?.path).toBe('/admin/user-tunnels');
    expect(routeForPath('/admin/user-tunnels/42')?.path).toBe('/admin/user-tunnels');
    expect(routeForPath('/clients/42')?.path).toBe('/clients');
    expect(routeForPath('/not-a-staff-route')).toBeNull();
  });

  it('every staff path routed in App.tsx has exactly one nav home', () => {
    for (const [p] of routed) {
      if (HUB_PATHS[p]) continue; // hub landing pages are section headers, not items
      const matches = ROUTES.filter(r => r.path === p);
      expect(matches.length, `route ${p} must appear exactly once in the nav registry`).toBe(1);
    }
  });

  it('every registry entry is actually routed in App.tsx', () => {
    for (const r of ROUTES) {
      expect(routed.has(r.path), `registry entry ${r.path} is not routed in App.tsx`).toBe(true);
    }
  });

  it('registry guards mirror the App.tsx PrivateRoute wrappers', () => {
    for (const r of ROUTES) {
      expect(routed.get(r.path), `guard mismatch for ${r.path}`).toBe(r.guard);
    }
  });

  it('keeps Regulatory Compliance discoverable only through explicit view permissions', () => {
    const route = ROUTES.find(r => r.path === '/regulatory-compliance');
    expect(route?.guard).toBe('any');
    expect(route?.requiredAnyPermissions).toContain('gov_data_requests.view');
    expect(route?.requiredAnyPermissions).toContain('subscriber_consents.view');
    expect(route?.roles).toBeUndefined();
  });

  it('hub landing pages are routed with the guard their section declares', () => {
    for (const [p, sectionId] of Object.entries(HUB_PATHS)) {
      const section = SECTIONS.find(s => s.id === sectionId);
      expect(section?.kind).toBe('hub');
      expect(section?.hubPath).toBe(p);
      expect(routed.get(p), `hub ${p} guard must match SECTIONS.hubGuard`).toBe(section?.hubGuard);
    }
  });

  it('every registry entry is reachable (rail row, hub card or tab set)', () => {
    const tabbed = new Set(TABSETS.flatMap(set => set.paths));
    for (const r of ROUTES) {
      expect(
        Boolean(r.rail || r.card || tabbed.has(r.path)),
        `${r.path} is neither a rail row, on a hub card nor in a tab set — unreachable`,
      ).toBe(true);
    }
  });

  it('every card id is declared in HUB_CARDS for its section', () => {
    for (const r of ROUTES) {
      if (!r.card) continue;
      expect(
        HUB_CARDS[r.section] ?? [],
        `${r.path} uses card "${r.card}" missing from HUB_CARDS.${r.section}`,
      ).toContain(r.card);
    }
  });
});

describe('nav registry i18n coverage', () => {
  type Dict = Record<string, unknown>;
  function lookup(dict: Dict, dotted: string): unknown {
    return dotted.split('.').reduce<unknown>((acc, k) => (acc as Dict | undefined)?.[k as keyof Dict], dict);
  }

  const locales: [string, Dict][] = [
    ['en', en as Dict],
    ['es', es as Dict],
    ['pt-BR', ptBR as Dict],
  ];

  it('every nav i18n key exists in all three locales', () => {
    const keys = new Set<string>();
    for (const s of SECTIONS) keys.add(s.labelKey);
    for (const set of TABSETS) keys.add(set.labelKey);
    keys.add('nav.tabs.more');
    for (const r of ROUTES) {
      keys.add(r.labelKey);
      if (r.sub) keys.add(`nav.subsections.${r.sub}`);
      if (r.card) keys.add(`nav.cards.${r.card}`);
    }
    keys.add('nav.viewAll');
    keys.add('nav.hubs.empty');
    keys.add('nav.toggleSection');
    for (const w of WORKSPACES) keys.add(w.labelKey);
    for (const k of ['title', 'placeholder', 'searchButton', 'noResults', 'hint']) keys.add(`nav.palette.${k}`);
    for (const k of ['label', 'hint', 'focusedAreas', 'allAreas']) keys.add(`nav.workspaces.${k}`);
    for (const hub of Object.values(SECTIONS).filter(s => s.kind === 'hub')) {
      keys.add(`nav.hubs.${hub.id}.title`);
      keys.add(`nav.hubs.${hub.id}.hint`);
    }
    for (const [name, dict] of locales) {
      for (const key of keys) {
        expect(typeof lookup(dict, key), `${name} is missing ${key}`).toBe('string');
      }
    }
  });
});

describe('FE-25 — every page names the permissions that open it', () => {
  // Every permission slug the migrations seed.
  const migrations = path.join(__dirname, '..', '..', '..', 'database', 'migrations');
  const seeded = new Set<string>();
  for (const file of fs.readdirSync(migrations)) {
    for (const m of fs.readFileSync(path.join(migrations, file), 'utf8').matchAll(/'([a-z0-9_]+(?:\.[a-z0-9_]+)+)'/g)) seeded.add(m[1]);
  }

  it('every registry entry has view permissions', () => {
    const missing = ROUTES.filter(r => !(r.viewPermissions ?? r.requiredAnyPermissions)?.length).map(r => r.path);
    expect(missing).toEqual([]);
  });

  it('every view permission is a slug the migrations seed', () => {
    const unknown = ROUTES.flatMap(r => (r.viewPermissions ?? []).filter(p => !seeded.has(p)).map(p => `${r.path}: ${p}`));
    expect(unknown).toEqual([]);
  });
});

// A section with tab sets is described by them alone: its sidebar rows, the
// tabs over each page and its hub cards all come from TABSETS.
describe('tab sets', () => {
  const admin = { role: 'admin' } as Parameters<typeof visibleRailItems>[0];
  const tabbedSections = [...new Set(TABSETS.map(set => set.section))];

  it('every page of a tabbed section is in exactly one tab set, and every tab is a page of that section', () => {
    for (const section of tabbedSections) {
      const inSets = TABSETS.filter(set => set.section === section).flatMap(set => set.paths);
      const pages = ROUTES.filter(r => r.section === section).map(r => r.path);
      expect([...inSets].sort()).toEqual([...pages].sort());
      expect(new Set(inSets).size).toBe(inSets.length);
    }
    expect(new Set(TABSETS.map(set => set.id)).size).toBe(TABSETS.length);
  });

  it('a tabbed section leaves rail, sub and card to its tab sets', () => {
    const stray = ROUTES.filter(r => tabbedSections.includes(r.section) && (r.rail || r.sub || r.card)).map(r => r.path);
    expect(stray).toEqual([]);
    expect(tabbedSections.filter(section => HUB_CARDS[section])).toEqual([]);
  });

  it('Network has one sidebar row per tab set, each leading to its first page', () => {
    const rows = visibleRailRows(admin, 'network');
    expect(rows.map(r => r.key)).toEqual([
      'monitor', 'topology', 'subscribers', 'equipment', 'fibre', 'wireless',
      'cpe', 'addresses', 'speedAccess', 'pollingAlerts', 'deviceConfig', 'vpn',
    ]);
    expect(rows.map(r => r.to)).toEqual(TABSETS.filter(set => set.section === 'network').map(set => set.paths[0]));
    expect(rows.flatMap(r => r.paths)).toHaveLength(ROUTES.filter(r => r.section === 'network').length);
  });

  it('a section without tab sets keeps one row per rail page', () => {
    const rows = visibleRailRows(admin, 'fieldops');
    expect(rows.map(r => r.to)).toEqual(visibleRailItems(admin, 'fieldops').map(r => r.path));
    expect(rows.every(r => r.paths.length === 1 && !r.tabset)).toBe(true);
  });

  it('the hub shows the same sets as the sidebar', () => {
    const cards = visibleHubCards(admin, 'network');
    expect(cards.map(c => c.card)).toEqual(visibleRailRows(admin, 'network').map(r => r.key));
    expect(cards.find(c => c.card === 'fibre')?.items.map(i => i.path)).toEqual(['/olt-management', '/onu-management', '/pon-port-management', '/fiber-plant-management']);
    expect(cards.find(c => c.card === 'fibre')?.labelKey).toBe('nav.tabsets.fibre');
    expect(visibleHubCards(admin, 'billing')[0].labelKey).toBe('nav.cards.receivables');
  });

  it('a detail page belongs to the tab set of its list', () => {
    expect(tabsetForPath('/devices/42')?.id).toBe('equipment');
    expect(tabsetForPath('/topology-map')?.id).toBe('topology');
    expect(tabsetForPath('/clients')).toBeNull();
  });

  it('shows only the tabs a person can open, and names a one-page row after that page', () => {
    const support = { role: 'support', organization_locale: 'MX' } as Parameters<typeof visibleRailItems>[0];
    const rows = visibleRailRows(support, 'network');
    expect(rows.map(r => [r.key, r.labelKey, r.paths])).toEqual([
      ['monitor', 'nav.tabsets.monitor', ['/network-health', '/outages']],
      ['subscribers', 'nav.tabsets.subscribers', ['/connection-logs', '/pppoe-diagnostics']],
      ['vpn', 'nav.myWgTunnels', ['/wg-tunnels']],
    ]);
    const onlyOutages = { role: 'custom', permissions: ['outages.view'] } as Parameters<typeof visibleRailItems>[0];
    expect(visibleRailRows(onlyOutages, 'network').map(r => [r.labelKey, r.to])).toEqual([['nav.outages', '/outages']]);
    const monitor = TABSETS.find(set => set.id === 'monitor')!;
    expect(visibleTabs(onlyOutages, monitor).map(tab => tab.path)).toEqual(['/outages']);
  });
});

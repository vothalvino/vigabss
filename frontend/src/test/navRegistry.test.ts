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
import { HUB_CARDS, RAIL_SUBS, ROUTES, SECTIONS, WORKSPACES, routeForPath, visibleHubCards, visibleRailItems, type Guard } from '@/nav/routes';
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

  it('every registry entry is reachable (rail row and/or hub card)', () => {
    for (const r of ROUTES) {
      expect(
        Boolean(r.rail || r.card),
        `${r.path} is neither a rail row nor on a hub card — unreachable`,
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

// The Network section is grouped by what an operator is doing, not by
// protocol names: the sidebar has headings, and every heading's rows sit
// together even though the registry lists them in another order.
describe('Network section layout', () => {
  const admin = { role: 'admin' } as Parameters<typeof visibleRailItems>[0];

  it('sidebar rows are grouped under their headings in the declared order', () => {
    const rows = visibleRailItems(admin, 'network');
    const subs = rows.map(r => r.sub);
    expect(subs.every(Boolean)).toBe(true);
    // Each heading appears as one unbroken run, in RAIL_SUBS order.
    const runs = subs.filter((s, i) => s !== subs[i - 1]);
    expect(runs).toEqual(RAIL_SUBS.network);
    expect(rows.map(r => r.path)).toEqual([
      '/noc-dashboard', '/network-health', '/outages',
      '/radius-sessions', '/connection-logs', '/pppoe-diagnostics',
      '/devices', '/nas', '/olt-management',
      '/ip-pools',
      '/wg-tunnels',
    ]);
  });

  it('every Network page is on exactly one hub card, and no card is empty', () => {
    const cards = visibleHubCards(admin, 'network');
    expect(cards.map(c => c.card)).toEqual(HUB_CARDS.network);
    const onCards = cards.flatMap(c => c.items.map(i => i.path));
    const all = ROUTES.filter(r => r.section === 'network').map(r => r.path);
    expect([...onCards].sort()).toEqual([...all].sort());
    expect(new Set(onCards).size).toBe(onCards.length);
  });

  it('fibre, wireless and customer equipment each have their own card', () => {
    const byCard = Object.fromEntries(visibleHubCards(admin, 'network').map(c => [c.card, c.items.map(i => i.path)]));
    expect(byCard.fibre).toEqual(['/olt-management', '/onu-management', '/pon-port-management', '/fiber-plant-management']);
    expect(byCard.wirelessNet).toEqual(['/wireless', '/wireless-metrics']);
    expect(byCard.cpe).toEqual(['/cpe-management', '/cpe-profiles', '/cpe-diagnostics']);
  });
});

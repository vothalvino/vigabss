// A person's own menu: it only ever shows pages their permissions open.
import { describe, it, expect } from 'vitest';
import { moved, ownLayout, pinnableBySection, pinnablePages, togglePin, visibleGroups } from '../customMenu';
import type { NavUser } from '../routes';

const admin: NavUser = { role: 'admin', organization_locale: 'MX' };
const support: NavUser = { role: 'support', organization_locale: 'MX' };
const custom: NavUser = { role: 'custom', permissions: ['invoices.view'] };
const layout = { groups: [{ name: 'Daily', pages: ['/invoices', '/tickets', '/users', '/nope'] }, { name: 'Admin only', pages: ['/users'] }] };
const shape = (groups: ReturnType<typeof visibleGroups>) => groups.map(g => [g.name, g.pages.map(p => p.path)]);

describe('visibleGroups', () => {
  it('keeps the order given and drops pages that are unknown or not allowed', () => {
    expect(shape(visibleGroups(admin, layout))).toEqual([['Daily', ['/invoices', '/tickets', '/users']], ['Admin only', ['/users']]]);
    expect(shape(visibleGroups(support, layout))).toEqual([['Daily', ['/tickets']]]);
    expect(shape(visibleGroups(custom, layout))).toEqual([['Daily', ['/invoices']]]);
  });

  it('is empty without a menu or with a malformed one', () => {
    expect(visibleGroups(admin, null)).toEqual([]);
    expect(visibleGroups(admin, undefined)).toEqual([]);
    expect(visibleGroups(admin, {} as never)).toEqual([]);
  });

  it('never shows an MX-only page to an organization elsewhere', () => {
    const mx = { groups: [{ name: 'Tax', pages: ['/cfdi'] }] };
    expect(visibleGroups({ role: 'admin', organization_locale: 'global' }, mx)).toEqual([]);
    expect(visibleGroups(admin, mx)).toHaveLength(1);
  });
});

describe('what can be pinned', () => {
  it('is exactly the pages the person may open, under their sections', () => {
    const paths = pinnablePages(custom).map(p => p.path);
    expect(paths).toContain('/invoices');
    expect(paths).not.toContain('/payments');
    expect(paths).not.toContain('/users');
    expect(pinnableBySection(custom).map(s => s.section.id)).toEqual(['billing']);
    expect(pinnablePages(support).some(p => p.path === '/users')).toBe(false);
  });

  it('a layout reduced to one\'s own pages keeps empty groups to fill', () => {
    expect(ownLayout(support, layout)).toEqual({ groups: [{ name: 'Daily', pages: ['/tickets'] }, { name: 'Admin only', pages: [] }] });
    expect(ownLayout(support, null)).toEqual({ groups: [] });
  });
});

describe('editing helpers', () => {
  it('togglePin adds to a group, takes out again, and creates a new group', () => {
    const one = togglePin({ groups: [] }, ' Mine ', '/invoices');
    expect(one).toEqual({ groups: [{ name: 'Mine', pages: ['/invoices'] }] });
    const two = togglePin(one, 'Mine', '/payments');
    expect(two.groups[0].pages).toEqual(['/invoices', '/payments']);
    expect(togglePin(two, 'Mine', '/invoices').groups[0].pages).toEqual(['/payments']);
  });

  it('moved swaps neighbours and leaves the ends alone', () => {
    expect(moved(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moved(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moved(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moved(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});

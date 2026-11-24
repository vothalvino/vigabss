// =============================================================================
// VigaBSS 5.0 — menus people arrange themselves
// =============================================================================
// A menu is groups a person names, each holding page addresses. It comes from
// GET /menus/mine: the person's own, a template given to them or their user
// group, or none (the standard sidebar).
//
// A menu never opens a page. Everything here passes each address through the
// same canSee() as the standard sidebar, so a group shows only the pages the
// person's permissions already open, and a group left empty is not shown.
// =============================================================================
import { apiFetch } from '@/api/apiFetch';
import { ROUTES, SECTIONS, canSee, type NavUser, type RouteDef, type SectionDef } from './routes';

export interface MenuGroup { name: string; pages: string[] }
export interface MenuLayout { groups: MenuGroup[] }
export interface MenuTemplateSummary { id: number; name: string; locked: boolean; given_to: 'person' | 'group' }
export interface MyMenu {
  layout: MenuLayout | null;
  source: 'personal' | 'template' | 'standard';
  template: MenuTemplateSummary | null;
  can_edit: boolean;
}
export interface MenuTemplate {
  id: number;
  name: string;
  locked: boolean;
  layout: MenuLayout;
  groups: Array<{ id: number; name: string }>;
  people: Array<{ id: number; name: string }>;
}

export const MY_MENU_KEY = ['my-menu'];
export const MENU_LIMITS = { groups: 20, pages: 30, name: 40, templateName: 80 };
/** The page where a person arranges their own menu. */
export const MY_MENU_PAGE = { path: '/my-menu', labelKey: 'customMenu.myMenu' };

export async function fetchMyMenu(): Promise<MyMenu> {
  return (await apiFetch<{ data: MyMenu }>('/menus/mine')).data;
}

export async function saveMyMenu(layout: MenuLayout): Promise<MyMenu> {
  return (await apiFetch<{ data: MyMenu }>('/menus/mine', { method: 'PUT', body: JSON.stringify({ layout }) })).data;
}

/** Every page this person may put in a menu: the pages their permissions open. */
export function pinnablePages(user: NavUser): RouteDef[] {
  return ROUTES.filter(route => canSee(user, route));
}

/** The same pages under their sections, for a picker. */
export function pinnableBySection(user: NavUser): Array<{ section: SectionDef; pages: RouteDef[] }> {
  const pages = pinnablePages(user);
  return SECTIONS
    .map(section => ({ section, pages: pages.filter(page => page.section === section.id) }))
    .filter(entry => entry.pages.length > 0);
}

/** A menu as this person sees it: only pages they may open, without empty groups. */
export function visibleGroups(user: NavUser, layout: MenuLayout | null | undefined): Array<{ name: string; pages: RouteDef[] }> {
  if (!layout || !Array.isArray(layout.groups)) return [];
  const allowed = new Map(pinnablePages(user).map(route => [route.path, route]));
  return layout.groups
    .map(group => ({ name: group.name, pages: group.pages.flatMap(path => { const route = allowed.get(path); return route ? [route] : []; }) }))
    .filter(group => group.pages.length > 0);
}

/** A layout reduced to what this person may open: what they can edit and save as their own. */
export function ownLayout(user: NavUser, layout: MenuLayout | null | undefined): MenuLayout {
  if (!layout || !Array.isArray(layout.groups)) return { groups: [] };
  const allowed = new Set(pinnablePages(user).map(route => route.path));
  return { groups: layout.groups.map(group => ({ name: group.name, pages: group.pages.filter(path => allowed.has(path)) })) };
}

/** Put a page in a group, or take it out; the group is created when new. */
export function togglePin(layout: MenuLayout, groupName: string, path: string): MenuLayout {
  const name = groupName.trim();
  const found = layout.groups.some(group => group.name === name);
  const groups = found
    ? layout.groups.map(group => (group.name !== name ? group
      : { ...group, pages: group.pages.includes(path) ? group.pages.filter(p => p !== path) : [...group.pages, path] }))
    : [...layout.groups, { name, pages: [path] }];
  return { groups };
}

/** Move the item at `index` one place up (-1) or down (+1). */
export function moved<T>(list: T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (to < 0 || to >= list.length) return list;
  const copy = [...list];
  [copy[index], copy[to]] = [copy[to], copy[index]];
  return copy;
}

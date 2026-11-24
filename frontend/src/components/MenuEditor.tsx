// =============================================================================
// VigaBSS 5.0 — arranging a menu
// =============================================================================
// Groups with a name, each holding pages, in the order chosen. Used for a
// person's own menu and for a template. Pages are picked from `pages`, the
// ones the person editing may open; a page already in a group that is not
// among them (a template naming a page this editor cannot open) is kept and
// shown by its address.
// =============================================================================
import { useTranslation } from 'react-i18next';
import { SECTIONS, type RouteDef } from '@/nav/routes';
import { MENU_LIMITS, moved, type MenuLayout } from '@/nav/customMenu';

interface MenuEditorProps {
  value: MenuLayout;
  onChange: (next: MenuLayout) => void;
  pages: RouteDef[];
}

export function MenuEditor({ value, onChange, pages }: MenuEditorProps) {
  const { t } = useTranslation();
  const byPath = new Map(pages.map(page => [page.path, page]));
  const sections = SECTIONS.map(section => ({ section, pages: pages.filter(page => page.section === section.id) })).filter(s => s.pages.length > 0);
  const setGroup = (index: number, patch: Partial<MenuLayout['groups'][number]>) =>
    onChange({ groups: value.groups.map((group, i) => (i === index ? { ...group, ...patch } : group)) });
  const label = (path: string) => { const page = byPath.get(path); return page ? t(page.labelKey) : path; };

  return (
    <div className="menu-editor">
      {value.groups.length === 0 && <p className="menu-editor-empty">{t('customMenu.noGroups')}</p>}
      {value.groups.map((group, index) => (
        <fieldset key={index} className="menu-editor-group">
          <legend className="menu-editor-legend">{t('customMenu.groupNumber', { number: index + 1 })}</legend>
          <div className="menu-editor-row">
            <input
              className="menu-editor-name" value={group.name} maxLength={MENU_LIMITS.name}
              aria-label={t('customMenu.groupName')} placeholder={t('customMenu.groupName')}
              onChange={e => setGroup(index, { name: e.target.value })}
            />
            <button type="button" className="menu-editor-btn" disabled={index === 0} aria-label={t('customMenu.moveGroupUp', { name: group.name })} onClick={() => onChange({ groups: moved(value.groups, index, -1) })}>↑</button>
            <button type="button" className="menu-editor-btn" disabled={index === value.groups.length - 1} aria-label={t('customMenu.moveGroupDown', { name: group.name })} onClick={() => onChange({ groups: moved(value.groups, index, 1) })}>↓</button>
            <button type="button" className="menu-editor-btn" aria-label={t('customMenu.removeGroup', { name: group.name })} onClick={() => onChange({ groups: value.groups.filter((_, i) => i !== index) })}>✕</button>
          </div>
          <ul className="menu-editor-pages">
            {group.pages.map((path, at) => (
              <li key={path} className="menu-editor-page">
                <span>{label(path)}</span>
                <span className="menu-editor-actions">
                  <button type="button" className="menu-editor-btn" disabled={at === 0} aria-label={t('customMenu.movePageUp', { name: label(path) })} onClick={() => setGroup(index, { pages: moved(group.pages, at, -1) })}>↑</button>
                  <button type="button" className="menu-editor-btn" disabled={at === group.pages.length - 1} aria-label={t('customMenu.movePageDown', { name: label(path) })} onClick={() => setGroup(index, { pages: moved(group.pages, at, 1) })}>↓</button>
                  <button type="button" className="menu-editor-btn" aria-label={t('customMenu.removePage', { name: label(path) })} onClick={() => setGroup(index, { pages: group.pages.filter(p => p !== path) })}>✕</button>
                </span>
              </li>
            ))}
          </ul>
          {group.pages.length < MENU_LIMITS.pages && (
            <select
              className="menu-editor-add" value="" aria-label={t('customMenu.addPageTo', { name: group.name })}
              onChange={e => { if (e.target.value) setGroup(index, { pages: [...group.pages, e.target.value] }); }}
            >
              <option value="">{t('customMenu.addPage')}</option>
              {sections.map(({ section, pages: list }) => (
                <optgroup key={section.id} label={t(section.labelKey)}>
                  {list.filter(page => !group.pages.includes(page.path)).map(page => <option key={page.path} value={page.path}>{t(page.labelKey)}</option>)}
                </optgroup>
              ))}
            </select>
          )}
        </fieldset>
      ))}
      {value.groups.length < MENU_LIMITS.groups && (
        <button type="button" className="menu-editor-btn menu-editor-new" onClick={() => onChange({ groups: [...value.groups, { name: '', pages: [] }] })}>
          {t('customMenu.addGroup')}
        </button>
      )}
    </div>
  );
}

/** What stops a menu from being saved, as a translation key, or null. */
export function layoutProblem(layout: MenuLayout): string | null {
  const names = layout.groups.map(group => group.name.trim().toLowerCase());
  if (names.some(name => !name)) return 'customMenu.problems.unnamed';
  if (new Set(names).size !== names.length) return 'customMenu.problems.duplicate';
  return null;
}

// =============================================================================
// VigaBSS 5.0 — tabs over the pages of a tab set
// =============================================================================
// Pages that belong together (nav/routes.ts → TABSETS) share one sidebar row;
// this strip, shown above each of them, moves between them. The tabs are
// links: every page keeps its own address. A long set shows its first tabs
// and puts the rest under "More"; a phone gets a drop-down instead.
// =============================================================================
import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { RouteDef, TabsetDef } from '@/nav/routes';
import { rememberTab } from '@/nav/lastTab';

/** Tabs shown before the rest go under "More". */
export const MAX_TABS = 7;

interface PageTabsProps {
  tabset: TabsetDef;
  /** The pages of the set this user can open, in order. */
  tabs: RouteDef[];
  /** The registered page the current address belongs to. */
  activePath: string;
}

export function PageTabs({ tabset, tabs, activePath }: PageTabsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const more = useRef<HTMLDivElement>(null);

  useEffect(() => { rememberTab(tabset.id, activePath); }, [tabset.id, activePath]);
  useEffect(() => { setOpen(false); }, [location.pathname]);
  useEffect(() => {
    if (!open) return undefined;
    const outside = (e: MouseEvent) => { if (!more.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);

  if (tabs.length < 2) return null;

  // The open page is always in the strip, even when it would fall under "More".
  let shown = tabs;
  let rest: RouteDef[] = [];
  if (tabs.length > MAX_TABS) {
    shown = tabs.slice(0, MAX_TABS - 1);
    const active = tabs.find(tab => tab.path === activePath);
    shown = active && !shown.includes(active) ? [...shown, active] : tabs.slice(0, MAX_TABS);
    rest = tabs.filter(tab => !shown.includes(tab));
  }
  const menuId = `page-tabs-more-${tabset.id}`;
  const link = (tab: RouteDef, className: string) => (
    <NavLink
      key={tab.path} to={tab.path} className={`${className}${tab.path === activePath ? ' active' : ''}`}
      aria-current={tab.path === activePath ? 'page' : undefined}
    >
      {t(tab.labelKey)}
    </NavLink>
  );

  return (
    <nav className="page-tabs" aria-label={t(tabset.labelKey)}>
      <div className="page-tabs-strip">
        {shown.map(tab => link(tab, 'page-tab'))}
        {rest.length > 0 && (
          <div className="page-tabs-more" ref={more}>
            <button type="button" className="page-tab" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(cur => !cur)}>
              {t('nav.tabs.more', { count: rest.length })}
            </button>
            {open && <div id={menuId} className="page-tabs-menu">{rest.map(tab => link(tab, 'page-tabs-item'))}</div>}
          </div>
        )}
      </div>
      <select className="page-tabs-select" aria-label={t(tabset.labelKey)} value={activePath} onChange={e => navigate(e.target.value)}>
        {tabs.map(tab => <option key={tab.path} value={tab.path}>{t(tab.labelKey)}</option>)}
      </select>
    </nav>
  );
}

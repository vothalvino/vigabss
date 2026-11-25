// =============================================================================
// VigaBSS 5.0 — tabs over the pages of a tab set
// =============================================================================
// Pages that belong together (nav/routes.ts → TABSETS) are shown as tabs
// above each of them. The tabs are links: every page keeps its own address.
// A set never has more tabs than fit a strip, so nothing is hidden; a narrow
// window wraps the strip and a phone gets a drop-down. The pages of a setup
// set also get a link back to the section's setup page.
// =============================================================================
import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { RouteDef, TabsetDef } from '@/nav/routes';
import { rememberTab } from '@/nav/lastTab';

interface PageTabsProps {
  tabset: TabsetDef;
  /** The pages of the set this user can open, in order. */
  tabs: RouteDef[];
  /** The registered page the current address belongs to. */
  activePath: string;
  /** The setup page this set is a card of, when the person has more than this on it. */
  back?: { path: string; labelKey: string } | null;
}

export function PageTabs({ tabset, tabs, activePath, back }: PageTabsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  useEffect(() => { rememberTab(tabset.id, activePath); }, [tabset.id, activePath]);

  if (tabs.length < 2 && !back) return null;

  return (
    <nav className="page-tabs" aria-label={t(tabset.labelKey)}>
      <div className="page-tabs-strip">
        {back && <Link to={back.path} className="page-tab page-tabs-back">‹ {t(back.labelKey)}</Link>}
        {tabs.map(tab => (
          <Link
            key={tab.path} to={tab.path} className={`page-tab${tab.path === activePath ? ' active' : ''}`}
            aria-current={tab.path === activePath ? 'page' : undefined}
            title={tab.tabLabelKey ? t(tab.labelKey) : undefined}
          >
            {t(tab.tabLabelKey ?? tab.labelKey)}
          </Link>
        ))}
      </div>
      <div className="page-tabs-phone">
        {back && <Link to={back.path} className="page-tabs-back">‹ {t(back.labelKey)}</Link>}
        {tabs.length > 1 && (
          <select className="page-tabs-select" aria-label={t(tabset.labelKey)} value={activePath} onChange={e => navigate(e.target.value)}>
            {tabs.map(tab => <option key={tab.path} value={tab.path}>{t(tab.tabLabelKey ?? tab.labelKey)}</option>)}
          </select>
        )}
      </div>
    </nav>
  );
}

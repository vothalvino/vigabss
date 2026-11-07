// =============================================================================
// Bolsas de efectivo (/cash-bags) — staff
// =============================================================================
// The ISP's numbered cash bags for resellers who collect cash on its behalf:
//   • Tablero (cash_bags.view): bags ready for pickup, on their way, recently
//     received and the count differences; register bags, hand them to a
//     carrier, receive (count) one, void or mark one lost;
//   • Transportistas (carriers.manage): carrier logins and the resellers
//     each one serves.
// A reseller's own bags are also on the reseller page's "Bolsas" tab.
// =============================================================================

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { styles } from '../crudStyles';
import { CarriersTab } from './CarriersTab';
import { CashBagBoard } from './CashBagBoard';

type Tab = 'board' | 'carriers';

const TABS: { key: Tab; labelKey: string; permission: string }[] = [
  { key: 'board', labelKey: 'cashBags.tabs.board', permission: 'cash_bags.view' },
  { key: 'carriers', labelKey: 'cashBags.tabs.carriers', permission: 'carriers.manage' },
];

export default function CashBagsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const tabs = TABS.filter(tab => can(user, tab.permission));
  const [active, setActive] = useState<Tab>(tabs[0]?.key ?? 'board');

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>{t('cashBags.title')}</h1>
      <div role="tablist" aria-label={t('cashBags.title')} style={{ display: 'flex', gap: 4, margin: '12px 0 20px', borderBottom: '2px solid var(--border)' }}>
        {tabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            onClick={() => setActive(tab.key)}
            style={{
              padding: '8px 16px', border: 'none', cursor: 'pointer', fontSize: 13, borderRadius: '4px 4px 0 0',
              background: active === tab.key ? 'var(--accent)' : 'transparent',
              color: active === tab.key ? '#fff' : 'var(--text-secondary)',
              fontWeight: active === tab.key ? 600 : 400,
            }}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>
      {tabs.length === 0 && <p style={styles.msg}>{t('cashBags.noAccess')}</p>}
      {active === 'board' && tabs.some(tab => tab.key === 'board') && <CashBagBoard />}
      {active === 'carriers' && tabs.some(tab => tab.key === 'carriers') && <CarriersTab />}
    </div>
  );
}

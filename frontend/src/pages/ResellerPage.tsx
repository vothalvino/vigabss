// =============================================================================
// VigaBSS 5.0 — Reseller Management Page (Section 19)
// =============================================================================
// A reseller is a commission agent ("Punto de Venta") who signs up clients as
// leads in the reseller app (/punto); a collector (migration 011) only takes
// payments. Two screens:
//   /resellers      — every reseller and collector, searchable by name,
//                     contact, city, email or phone, filtered by type and
//                     status, with its cash against its limit; create, edit,
//                     suspend and delete.
//   /resellers/:id  — one point: a header with its type, status and money,
//                     and the tabs that apply to it (?tab= keeps the choice):
//     Summary       contact details, its numbers and its sub-resellers
//     Movements     its cash account with the ISP (reseller_ledger.view)
//     Bags          its cash bags; "Assign bags" (cash_bags.view/.manage)
//     Commissions   what it earned (reseller_commissions.view; resellers)
//     Statements    its periodic statements (reseller_settlements.view)
//     Allowed plans the plans it may offer (resellers only)
//     Staff access  its logins and bindings
// A sub-reseller collects and earns on its top-level reseller's account, so
// its page shows Summary and Staff access and links the parent for the rest.
// Plan price overrides, network resources (IP pools, bandwidth quota, OLT
// ports), billing entities and branding are not part of the commission-agent
// model and are not shown; their API routes are unchanged.
// =============================================================================

import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/api/apiFetch';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { formatMoney } from '@/lib/money';
import { LoadingState } from '@/components/FetchStates';
import { styles } from './crudStyles';
import { ResellerUserBindingsTab } from './ResellerUserBindingsTab';
import { ResellerFormModal } from './resellers/ResellerFormModal';
import { ResellerAllowedPlansTab } from './resellers/ResellerAllowedPlansTab';
import { ResellerLedgerTab } from './resellers/ResellerLedgerTab';
import { ResellerBagsTab } from './resellers/ResellerBagsTab';
import { ResellerCommissionsTab } from './resellers/ResellerCommissionsTab';
import { ResellerStatementsTab } from './resellers/ResellerStatementsTab';
import { resellerDetailKey, resellerOptionKeys } from './resellers/resellerOptions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Reseller {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  contact_name: string | null;
  parent_id: number | null;
  parent_name?: string | null;
  level: number;
  status: string;
  commission_rate: number | string;
  notes: string | null;
  credit_limit?: number | string | null;
  effective_credit_limit?: number | string | null;
  balance?: number | string | null;
  in_bags?: number | string | null;
  cash_on_hand?: number | string | null;
  address?: string | null;
  city?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  /** 'collector' (migration 011): only takes payments, earns a fee per payment. */
  kind?: 'reseller' | 'collector';
  collection_fee_type?: 'none' | 'fixed' | 'percent';
  collection_fee_value?: number | string;
}

interface ResellerDashboard {
  reseller_id: number;
  subscriber_count: number;
  total_revenue: number;
  open_tickets: number;
  pending_commission: number;
}

interface ListMeta { total: number; page: number; limit: number }
interface ApiList<T> { data: T[]; meta: ListMeta }

type DetailTab = 'summary' | 'ledger' | 'bags' | 'commissions' | 'statements' | 'allowedPlans' | 'staffAccess';

const PAGE_SIZE = 25;
const isCollector = (r: Pick<Reseller, 'kind'>) => r.kind === 'collector';
const isTopLevel = (r: Pick<Reseller, 'parent_id'>) => r.parent_id === null || r.parent_id === undefined;

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, CSSProperties> = {
  active: { background: 'var(--success-soft)', color: 'var(--success)' },
  suspended: { background: 'var(--warning-soft, #fff4e5)', color: 'var(--warning)' },
  inactive: { background: 'var(--bg-subtle)', color: 'var(--text-secondary)' },
};
const chip: CSSProperties = { display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' };

function StatusChip({ value }: { value: string }) {
  const { t } = useTranslation();
  return <span style={{ ...chip, ...(STATUS_COLORS[value] ?? STATUS_COLORS.inactive) }}>{t(`resellerForm.statuses.${value}`, { defaultValue: value })}</span>;
}

function KindChip({ row }: { row: Reseller }) {
  const { t } = useTranslation();
  const label = isCollector(row) ? t('resellerAdmin.levelCollector') : isTopLevel(row) ? t('resellerAdmin.levelMaster') : t('resellerAdmin.levelSub');
  const tone = isCollector(row)
    ? { background: 'var(--accent-soft, #eef4ff)', color: 'var(--accent)' }
    : { background: 'var(--bg-subtle)', color: 'var(--text-primary)' };
  return <span style={{ ...chip, ...tone }}>{label}</span>;
}

/** A collector's fee per payment, or a reseller's commission rate. */
function EarningText({ row }: { row: Reseller }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  if (!isCollector(row)) return <>{t('resellerAdmin.commission', { rate: Number(row.commission_rate) })}</>;
  const value = Number(row.collection_fee_value ?? 0);
  if (row.collection_fee_type === 'fixed' && value > 0) return <>{t('resellerAdmin.feeFixed', { amount: formatMoney(value, user?.organization_currency || 'MXN') })}</>;
  if (row.collection_fee_type === 'percent' && value > 0) return <>{t('resellerAdmin.feePercent', { rate: value })}</>;
  return <>{t('resellerAdmin.feeNone')}</>;
}

/** Cash on hand against the limit, as text and a bar (top-level points only). */
function CashMeter({ row, compact = false }: { row: Reseller; compact?: boolean }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const currency = user?.organization_currency || 'MXN';
  if (!isTopLevel(row) || row.cash_on_hand === undefined || row.cash_on_hand === null) return <>—</>;
  const cash = Number(row.cash_on_hand);
  const limit = Number(row.effective_credit_limit ?? 0);
  const ratio = limit > 0 ? Math.min(1, Math.max(0, cash / limit)) : cash > 0 ? 1 : 0;
  const color = ratio >= 1 ? 'var(--danger)' : ratio >= 0.8 ? 'var(--warning)' : 'var(--success)';
  return (
    <div style={{ minWidth: compact ? 140 : 220 }}>
      <div style={{ fontSize: compact ? 13 : 15 }}>
        {t('resellerAdmin.cashOfLimit', { cash: formatMoney(cash, currency), limit: formatMoney(limit, currency) })}
      </div>
      <div role="presentation" style={{ height: 6, background: 'var(--bg-subtle)', borderRadius: 3, marginTop: 4, overflow: 'hidden' }}>
        <div style={{ width: `${Math.round(ratio * 100)}%`, height: '100%', background: color }} />
      </div>
    </div>
  );
}

/** Suspend/reactivate and delete, shared by the list and the detail page. */
function useResellerActions(onDone: (msg: string) => void, onError: (msg: string) => void) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refresh = (id: number) => {
    void qc.invalidateQueries({ queryKey: resellerOptionKeys.all });
    void qc.invalidateQueries({ queryKey: resellerOptionKeys.topLevel });
    void qc.invalidateQueries({ queryKey: resellerDetailKey(id) });
  };
  return {
    refresh,
    async suspend(r: Reseller) {
      try {
        const result = await apiFetch<{ data: { status: string } }>(`/resellers/${r.id}/suspend`, { method: 'POST' });
        onDone(t('resellerAdmin.statusChanged', { name: r.name, status: t(`resellerForm.statuses.${result.data.status}`, { defaultValue: result.data.status }) }));
        refresh(r.id);
      } catch {
        onError(t('reseller.errorSuspend'));
      }
    },
    async remove(r: Reseller): Promise<boolean> {
      if (!window.confirm(t('resellerAdmin.confirmDeleteNamed', { name: r.name }))) return false;
      try {
        await apiFetch(`/resellers/${r.id}`, { method: 'DELETE' });
        onDone(t('reseller.deleted'));
        refresh(r.id);
        return true;
      } catch {
        onError(t('reseller.errorDelete'));
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// /resellers — the list
// ---------------------------------------------------------------------------

function ResellerList() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const canSuspend = can(user, 'resellers.suspend');
  const canDelete = can(user, 'resellers.delete');
  const canCreate = can(user, 'resellers.create');
  const canEdit = can(user, 'resellers.update');
  const hasActions = canSuspend || canDelete || canEdit;
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; reseller: Reseller } | null>(null);
  const [rows, setRows] = useState<Reseller[]>([]);
  const [meta, setMeta] = useState<ListMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const actions = useResellerActions(m => { setMsg(m); setError(null); void load(); }, setError);

  // Search as the user types, a moment after the last key.
  useEffect(() => {
    const id = window.setTimeout(() => { setTerm(search.trim()); setPage(1); }, 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const q = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
      if (term) q.set('search', term);
      if (kind) q.set('kind', kind);
      if (status) q.set('status', status);
      const res = await apiFetch<ApiList<Reseller>>(`/resellers?${q.toString()}`);
      setRows(res.data); setMeta(res.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reseller.errorLoading'));
    } finally { setLoading(false); }
  }, [page, term, kind, status, t]);

  useEffect(() => { void load(); }, [load]);

  const pages = meta ? Math.max(1, Math.ceil(meta.total / meta.limit)) : 1;
  const filtered = Boolean(term || kind || status);
  const cols = 5 + (hasActions ? 1 : 0);

  return (
    <div style={styles.container}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <h1 style={styles.title}>{t('reseller.pageTitle')}</h1>
        {canCreate && <button type="button" style={styles.btnPrimary} onClick={() => setForm({ mode: 'create' })}>{t('resellerAdmin.newReseller')}</button>}
      </div>
      <p style={{ ...styles.msg, textAlign: 'left', padding: '4px 0 12px' }}>{t('resellerAdmin.listHelp')}</p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
        <label style={styles.filterLabel}>
          {t('resellerAdmin.search')}
          <input type="search" style={{ ...styles.input, minWidth: 240 }} value={search} placeholder={t('resellerAdmin.searchPlaceholder')} onChange={e => setSearch(e.target.value)} />
        </label>
        <label style={styles.filterLabel}>
          {t('resellerAdmin.type')}
          <select style={styles.filterSelect} value={kind} onChange={e => { setKind(e.target.value); setPage(1); }}>
            <option value="">{t('resellerAdmin.typeAll')}</option>
            <option value="reseller">{t('resellerAdmin.typeReseller')}</option>
            <option value="collector">{t('resellerAdmin.typeCollector')}</option>
          </select>
        </label>
        <label style={styles.filterLabel}>
          {t('resellerForm.status')}
          <select style={styles.filterSelect} value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
            <option value="">{t('resellerAdmin.statusAll')}</option>
            {['active', 'suspended', 'inactive'].map(s => <option key={s} value={s}>{t(`resellerForm.statuses.${s}`)}</option>)}
          </select>
        </label>
      </div>

      {error && <p role="alert" style={styles.msgError}>{error}</p>}
      {msg && <p role="status" style={{ color: 'var(--success)', margin: '0 0 8px' }}>{msg}</p>}

      <div style={{ ...styles.tableCard, overflowX: 'auto' }}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>{t('reseller.name')}</th>
              <th style={styles.th}>{t('resellerAdmin.type')}</th>
              <th style={styles.th}>{t('resellerForm.status')}</th>
              <th style={styles.th}>{t('resellerAdmin.cashColumn')}</th>
              <th style={styles.th}>{t('resellerAdmin.earnsColumn')}</th>
              {hasActions && <th style={styles.th}>{t('reseller.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && <tr><td colSpan={cols} style={styles.emptyCell}>{t('reseller.loading')}</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={cols} style={styles.emptyCell}>{filtered ? t('resellerAdmin.noMatches') : t('reseller.noResellers')}</td></tr>
            )}
            {rows.map(r => (
              <tr
                key={r.id}
                style={{ ...styles.tr, cursor: 'pointer' }}
                onClick={e => { if (!(e.target as HTMLElement).closest('a,button')) navigate(`/resellers/${r.id}`); }}
              >
                <td style={styles.td}>
                  <Link to={`/resellers/${r.id}`} style={{ fontWeight: 600 }}>{r.name}</Link>
                  {!isTopLevel(r) && r.parent_name && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('resellerAdmin.underParent', { name: r.parent_name })}</div>
                  )}
                  {(r.contact_name || r.city) && (
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{[r.contact_name, r.city].filter(Boolean).join(' · ')}</div>
                  )}
                </td>
                <td style={styles.td}><KindChip row={r} /></td>
                <td style={styles.td}><StatusChip value={r.status} /></td>
                <td style={styles.td}><CashMeter row={r} compact /></td>
                <td style={styles.td}><EarningText row={r} /></td>
                {hasActions && (
                  <td style={styles.td}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {canEdit && <button type="button" style={styles.actionBtn} onClick={() => setForm({ mode: 'edit', reseller: r })}>{t('resellerAdmin.edit')}</button>}
                      {canSuspend && (
                        <button type="button" style={styles.actionBtn} onClick={() => void actions.suspend(r)}>
                          {r.status === 'suspended' ? t('reseller.reactivate') : t('reseller.suspend')}
                        </button>
                      )}
                      {canDelete && <button type="button" style={{ ...styles.actionBtn, color: 'var(--danger)' }} onClick={() => void actions.remove(r)}>{t('reseller.delete')}</button>}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {meta && pages > 1 && (
        <div style={styles.pagination}>
          <button type="button" style={styles.pageBtn} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('punto.common.previous')}</button>
          <span style={styles.pageInfo}>{t('punto.common.pageOf', { page, pages })}</span>
          <button type="button" style={styles.pageBtn} disabled={page >= pages} onClick={() => setPage(p => p + 1)}>{t('punto.common.next')}</button>
        </div>
      )}
      {form && (
        <ResellerFormModal
          mode={form.mode}
          initial={form.mode === 'edit' ? form.reseller : undefined}
          onClose={() => setForm(null)}
          onSaved={() => {
            setMsg(t('resellerAdmin.saved'));
            void load();
            actions.refresh(form.mode === 'edit' ? form.reseller.id : 0);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// /resellers/:id — one point
// ---------------------------------------------------------------------------

function SummaryTab({ reseller }: { reseller: Reseller }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const currency = user?.organization_currency || 'MXN';
  const showNumbers = !isCollector(reseller);
  const dashboardQ = useQuery({
    queryKey: ['reseller-dashboard', reseller.id],
    enabled: showNumbers,
    queryFn: async () => (await apiFetch<{ data: ResellerDashboard }>(`/reseller-portal/${reseller.id}/dashboard`)).data,
    retry: false,
  });
  const subsQ = useQuery({
    queryKey: ['reseller-subs', reseller.id],
    enabled: !isCollector(reseller) && isTopLevel(reseller),
    queryFn: async () => (await apiFetch<ApiList<Reseller>>(`/resellers?parent_id=${reseller.id}&limit=100`)).data ?? [],
  });
  const d = dashboardQ.data;
  const details: [string, string | null | undefined][] = [
    [t('resellerForm.contactName'), reseller.contact_name],
    [t('resellerForm.phone'), reseller.phone],
    [t('resellerForm.email'), reseller.email],
    [t('resellerForm.address'), [reseller.address, reseller.city].filter(Boolean).join(', ')],
    [t('resellerForm.notes'), reseller.notes],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {showNumbers && d && (
        <section aria-label={t('resellerAdmin.numbers')} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
          {[
            { label: t('reseller.subscribers'), value: d.subscriber_count },
            { label: t('reseller.revenue'), value: formatMoney(d.total_revenue, currency) },
            { label: t('reseller.openTickets'), value: d.open_tickets },
            { label: t('reseller.pendingCommission'), value: formatMoney(d.pending_commission, currency) },
          ].map(card => (
            <div key={card.label} style={{ ...styles.tableCard, padding: '0.75rem 1rem' }}>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{card.label}</div>
              <div style={{ fontSize: '1.3rem', fontWeight: 700 }}>{card.value}</div>
            </div>
          ))}
        </section>
      )}
      <section aria-label={t('resellerAdmin.contact')} style={{ ...styles.tableCard, padding: '0.75rem 1rem' }}>
        <h3 style={{ margin: '0 0 8px', fontSize: '1rem' }}>{t('resellerAdmin.contact')}</h3>
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 16px', margin: 0 }}>
          {details.map(([label, value]) => (
            <div key={label} style={{ display: 'contents' }}>
              <dt style={{ color: 'var(--text-secondary)' }}>{label}</dt>
              <dd style={{ margin: 0 }}>{value || '—'}</dd>
            </div>
          ))}
        </dl>
      </section>
      {subsQ.data && subsQ.data.length > 0 && (
        <section aria-label={t('resellerAdmin.subResellers')} style={{ ...styles.tableCard, padding: '0.75rem 1rem' }}>
          <h3 style={{ margin: '0 0 8px', fontSize: '1rem' }}>{t('resellerAdmin.subResellers')}</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {subsQ.data.map(s => (
              <li key={s.id}><Link to={`/resellers/${s.id}`}>{s.name}</Link> <StatusChip value={s.status} /></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const DETAIL_TABS: { key: DetailTab; labelKey: string; permission?: string; topLevelOnly?: boolean; resellerOnly?: boolean }[] = [
  { key: 'summary', labelKey: 'resellerAdmin.tabSummary' },
  { key: 'ledger', labelKey: 'resellerLedger.tab', permission: 'reseller_ledger.view', topLevelOnly: true },
  { key: 'bags', labelKey: 'cashBags.resellerTab.tab', permission: 'cash_bags.view', topLevelOnly: true },
  { key: 'commissions', labelKey: 'reseller.tabCommissions', permission: 'reseller_commissions.view', topLevelOnly: true, resellerOnly: true },
  { key: 'statements', labelKey: 'resellerStatements.tab', permission: 'reseller_settlements.view', topLevelOnly: true },
  { key: 'allowedPlans', labelKey: 'resellerAdmin.tabAllowedPlans', topLevelOnly: true, resellerOnly: true },
  { key: 'staffAccess', labelKey: 'resellerAccess.tab' },
];

function ResellerDetail({ id }: { id: number }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resellerQ = useQuery({
    queryKey: resellerDetailKey(id),
    queryFn: async () => (await apiFetch<{ data: Reseller }>(`/resellers/${id}`)).data,
    retry: false,
  });
  const actions = useResellerActions(m => { setMsg(m); setError(null); }, setError);
  const r = resellerQ.data;

  if (resellerQ.isLoading) return <div style={styles.container}><LoadingState /></div>;
  if (resellerQ.isError || !r) {
    return (
      <div style={styles.container}>
        <p><Link to="/resellers">← {t('resellerAdmin.backToList')}</Link></p>
        <p role="alert" style={styles.msgError}>{t('resellerAdmin.notFound')}</p>
      </div>
    );
  }

  const tabs = DETAIL_TABS.filter(tab => (!tab.permission || can(user, tab.permission))
    && (!tab.topLevelOnly || isTopLevel(r))
    && (!tab.resellerOnly || !isCollector(r)));
  const wanted = params.get('tab') as DetailTab | null;
  const active: DetailTab = tabs.some(tab => tab.key === wanted) ? (wanted as DetailTab) : 'summary';
  const choose = (key: DetailTab) => setParams(p => { const next = new URLSearchParams(p); if (key === 'summary') next.delete('tab'); else next.set('tab', key); return next; }, { replace: true });

  return (
    <div style={styles.container}>
      <p style={{ margin: '0 0 8px' }}><Link to="/resellers">← {t('resellerAdmin.backToList')}</Link></p>
      <header style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ ...styles.title, margin: 0 }}>{r.name}</h1>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
            <KindChip row={r} />
            <StatusChip value={r.status} />
            <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}><EarningText row={r} /></span>
            {!isTopLevel(r) && r.parent_id && (
              <span style={{ fontSize: 13 }}>{t('resellerAdmin.underParentPrefix')} <Link to={`/resellers/${r.parent_id}`}>{r.parent_name ?? `#${r.parent_id}`}</Link></span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {can(user, 'resellers.update') && <button type="button" style={styles.btnSecondary} onClick={() => setEditing(true)}>{t('resellerAdmin.edit')}</button>}
          {can(user, 'resellers.suspend') && (
            <button type="button" style={styles.btnSecondary} onClick={() => void actions.suspend(r)}>
              {r.status === 'suspended' ? t('reseller.reactivate') : t('reseller.suspend')}
            </button>
          )}
          {can(user, 'resellers.delete') && (
            <button type="button" style={styles.btnSecondary} onClick={() => void actions.remove(r).then(ok => { if (ok) navigate('/resellers'); })}>{t('reseller.delete')}</button>
          )}
        </div>
      </header>
      {isTopLevel(r) && (
        <section aria-label={t('resellerAdmin.cashColumn')} style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-end', margin: '16px 0 4px' }}>
          <div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{t('resellerAdmin.cashColumn')}</div>
            <CashMeter row={r} />
          </div>
          {r.in_bags !== undefined && r.in_bags !== null && (
            <div>
              <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{t('cashBags.ledger.inBags')}</div>
              <div style={{ fontSize: 15 }}>{formatMoney(r.in_bags, user?.organization_currency || 'MXN')}</div>
            </div>
          )}
        </section>
      )}
      {!isTopLevel(r) && <p style={{ ...styles.msg, textAlign: 'left', padding: '8px 0 0' }}>{t('resellerAdmin.subAccountNote', { name: r.parent_name ?? `#${r.parent_id}` })}</p>}
      {error && <p role="alert" style={styles.msgError}>{error}</p>}
      {msg && <p role="status" style={{ color: 'var(--success)', margin: '8px 0 0' }}>{msg}</p>}

      <div role="tablist" aria-label={r.name} style={{ display: 'flex', gap: 4, margin: '16px 0 20px', borderBottom: '2px solid var(--border)', overflowX: 'auto' }}>
        {tabs.map(tab => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active === tab.key}
            onClick={() => choose(tab.key)}
            style={{
              padding: '8px 16px', border: 'none', cursor: 'pointer', fontSize: 13, borderRadius: '4px 4px 0 0', whiteSpace: 'nowrap',
              background: active === tab.key ? 'var(--accent)' : 'transparent',
              color: active === tab.key ? '#fff' : 'var(--text-secondary)',
              fontWeight: active === tab.key ? 600 : 400,
            }}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {active === 'summary' && <SummaryTab reseller={r} />}
        {active === 'ledger' && <ResellerLedgerTab resellerId={r.id} />}
        {active === 'bags' && <ResellerBagsTab resellerId={r.id} resellerName={r.name} />}
        {active === 'commissions' && <ResellerCommissionsTab resellerId={r.id} />}
        {active === 'statements' && <ResellerStatementsTab resellerId={r.id} />}
        {active === 'allowedPlans' && <ResellerAllowedPlansTab resellerId={r.id} />}
        {active === 'staffAccess' && <ResellerUserBindingsTab resellerId={r.id} />}
      </div>

      {editing && (
        <ResellerFormModal
          mode="edit"
          initial={r}
          onClose={() => setEditing(false)}
          onSaved={() => { setMsg(t('resellerAdmin.saved')); actions.refresh(r.id); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function ResellerPage() {
  const { id } = useParams<{ id?: string }>();
  const resellerId = id ? Number(id) : null;
  if (resellerId !== null && Number.isInteger(resellerId) && resellerId > 0) return <ResellerDetail key={resellerId} id={resellerId} />;
  return <ResellerList />;
}

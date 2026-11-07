// =============================================================================
// VigaBSS 5.0 — Reseller Management Page (Section 19)
// =============================================================================
// A reseller is a commission agent ("Punto de Venta") who signs up clients as
// leads in the reseller app (/punto). Tabs:
//   1. Resellers      — hierarchy list, create and edit
//   2. Allowed plans  — the plans a top-level reseller may offer
//   3. Movements      — the cash a reseller collected and handed in, its cash
//                       limit, and recording a hand-in (reseller_ledger.*)
//   4. Bags           — a reseller's cash bags, their history and the count
//                       differences (cash_bags.view)
//   5. Commissions    — commission earnings per reseller (read only)
//   6. Portal         — reseller dashboard numbers
//   7. Staff access   — reseller logins and bindings
// Plan price overrides, network resources (IP pools, bandwidth quota, OLT
// ports), billing entities and branding are not part of the commission-agent
// model and are not shown; their API routes are unchanged.
// =============================================================================

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/api/apiFetch';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { ResellerUserBindingsTab } from './ResellerUserBindingsTab';
import { ResellerFormModal } from './resellers/ResellerFormModal';
import { ResellerAllowedPlansTab } from './resellers/ResellerAllowedPlansTab';
import { ResellerLedgerTab } from './resellers/ResellerLedgerTab';
import { ResellerBagsTab } from './resellers/ResellerBagsTab';
import { ResellerListNotice, resellerOptionKeys, useResellerOptions } from './resellers/resellerOptions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tab = 'resellers' | 'allowedPlans' | 'ledger' | 'bags' | 'commissions' | 'portal' | 'staffAccess';

interface Reseller {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  contact_name: string | null;
  parent_id: number | null;
  parent_name: string | null;
  level: number;
  status: string;
  commission_rate: number | string;
  notes: string | null;
  credit_limit?: number | string | null;
  effective_credit_limit?: number | string | null;
  balance?: number | string | null;
  address?: string | null;
  city?: string | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
}

interface Commission {
  id: number;
  reseller_id: number;
  invoice_id: number;
  invoice_number: string | null;
  client_id: number | null;
  client_name: string | null;
  commission_rate: number;
  invoice_total: number;
  commission_amount: number;
  currency: string;
  status: string;
  created_at: string;
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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ value }: { value: string }) {
  const color: Record<string, string> = {
    active: '#2ecc71', paid: '#2ecc71', approved: '#27ae60',
    suspended: '#e67e22', inactive: '#95a5a6',
    pending: '#f39c12', cancelled: '#e74c3c',
  };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 10,
      fontSize: 11, fontWeight: 600, color: '#fff',
      background: color[value] ?? '#7f8c8d',
    }}>
      {value}
    </span>
  );
}

function ActionButton({ label, onClick, disabled, variant = 'primary' }:
  { label: string; onClick: () => void; disabled?: boolean; variant?: 'primary' | 'danger' | 'success' }) {
  const bg = variant === 'danger' ? '#e74c3c' : variant === 'success' ? '#2ecc71' : '#3498db';
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: '4px 10px', fontSize: 12, cursor: disabled ? 'not-allowed' : 'pointer',
      background: disabled ? '#ccc' : bg, color: '#fff', border: 'none', borderRadius: 4,
    }}>
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tab: Resellers List
// ---------------------------------------------------------------------------

function ResellersTab() {
  const { t } = useTranslation();
  // Write actions show only with the permission their route requires: a
  // reseller user holds resellers.view alone, and saw Suspend/Delete buttons
  // that could only answer 403.
  const { user } = useAuth();
  const canSuspend = can(user, 'resellers.suspend');
  const canDelete = can(user, 'resellers.delete');
  const canCreate = can(user, 'resellers.create');
  const canEdit = can(user, 'resellers.update');
  const hasActions = canSuspend || canDelete || canEdit;
  const [form, setForm] = useState<{ mode: 'create' } | { mode: 'edit'; reseller: Reseller } | null>(null);
  const [resellers, setResellers] = useState<Reseller[]>([]);
  const [meta, setMeta] = useState<ListMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [msg, setMsg] = useState<string | null>(null);
  const qc = useQueryClient();
  // The reseller pickers of the other tabs are cached; refresh them with the list.
  const refreshPickers = () => {
    void qc.invalidateQueries({ queryKey: resellerOptionKeys.all });
    void qc.invalidateQueries({ queryKey: resellerOptionKeys.topLevel });
  };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch<ApiList<Reseller>>(`/resellers?page=${page}&limit=25`);
      setResellers(res.data); setMeta(res.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reseller.errorLoading'));
    } finally { setLoading(false); }
  }, [page, t]);

  useEffect(() => { load(); }, [load]);

  async function handleSuspend(r: Reseller) {
    try {
      const result = await apiFetch<{ data: { status: string } }>(`/resellers/${r.id}/suspend`, { method: 'POST' });
      setMsg(t('resellerAdmin.statusChanged', { name: r.name, status: result.data.status }));
      load();
      refreshPickers();
    } catch {
      setError(t('reseller.errorSuspend'));
    }
  }

  async function handleDelete(r: Reseller) {
    if (!window.confirm(t('reseller.confirmDelete'))) return;
    try {
      await apiFetch(`/resellers/${r.id}`, { method: 'DELETE' });
      setMsg(t('reseller.deleted'));
      load();
      refreshPickers();
    } catch {
      setError(t('reseller.errorDelete'));
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h3>{t('reseller.resellerList')}</h3>
        {canCreate && <ActionButton label={t('resellerAdmin.newReseller')} onClick={() => setForm({ mode: 'create' })} />}
      </div>
      {error && <p style={{ color: '#e74c3c' }}>{error}</p>}
      {msg && <p style={{ color: '#2ecc71' }}>{msg}</p>}
      {loading ? <p>{t('reseller.loading')}</p> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f5f5f5' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #ddd' }}>{t('resellerAdmin.id')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #ddd' }}>{t('reseller.name')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #ddd' }}>{t('reseller.level')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #ddd' }}>{t('reseller.parent')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #ddd' }}>{t('reseller.commissionRate')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #ddd' }}>{t('reseller.status')}</th>
              {hasActions && <th style={{ padding: '6px 8px', border: '1px solid #ddd' }}>{t('reseller.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {resellers.length === 0 && (
              <tr><td colSpan={hasActions ? 7 : 6} style={{ padding: 8, textAlign: 'center', color: '#999' }}>{t('reseller.noResellers')}</td></tr>
            )}
            {resellers.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}>{r.id}</td>
                <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}>{r.name}</td>
                <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}>{r.level === 1 ? t('resellerAdmin.levelMaster') : t('resellerAdmin.levelSub')}</td>
                <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}>{r.parent_name ?? '—'}</td>
                <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}>{Number(r.commission_rate)}%</td>
                <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}><StatusBadge value={r.status} /></td>
                {hasActions && (
                  <td style={{ padding: '6px 8px', border: '1px solid #ddd', display: 'flex', gap: 4 }}>
                    {canEdit && <ActionButton label={t('resellerAdmin.edit')} onClick={() => setForm({ mode: 'edit', reseller: r })} />}
                    {canSuspend && <ActionButton label={r.status === 'suspended' ? t('reseller.reactivate') : t('reseller.suspend')} onClick={() => handleSuspend(r)} variant={r.status === 'suspended' ? 'success' : 'danger'} />}
                    {canDelete && <ActionButton label={t('reseller.delete')} onClick={() => handleDelete(r)} variant="danger" />}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {meta && (
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <ActionButton label="<" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} />
          <span>{t('reseller.page')} {page} / {Math.ceil(meta.total / meta.limit)}</span>
          <ActionButton label=">" onClick={() => setPage(p => p + 1)} disabled={page * meta.limit >= meta.total} />
        </div>
      )}
      {form && (
        <ResellerFormModal
          mode={form.mode}
          initial={form.mode === 'edit' ? form.reseller : undefined}
          onClose={() => setForm(null)}
          onSaved={() => { setMsg(t('resellerAdmin.saved')); load(); refreshPickers(); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Commissions
// ---------------------------------------------------------------------------

function CommissionsTab() {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [commissions, setCommissions] = useState<Commission[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resellersQ = useResellerOptions();
  const resellers = resellersQ.data?.rows ?? [];
  const listError = resellersQ.isError ? t('reseller.errorLoading') : null;

  const load = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true); setError(null);
    try {
      const res = await apiFetch<ApiList<Commission>>(`/resellers/${selectedId}/commissions?limit=50`);
      setCommissions(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reseller.errorLoading'));
    } finally { setLoading(false); }
  }, [selectedId, t]);

  useEffect(() => { load(); }, [load]);


  return (
    <div>
      <h3>{t('reseller.commissions')}</h3>
      <label htmlFor="commissions-reseller">{t('reseller.selectReseller')}: </label>
      <select id="commissions-reseller" value={selectedId ?? ''} onChange={e => setSelectedId(parseInt(e.target.value, 10) || null)} style={{ padding: '4px 8px', marginBottom: 12 }}>
        <option value="">— {t('reseller.select')} —</option>
        {resellers.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <ResellerListNotice list={resellersQ.data} />
      {(error ?? listError) && <p style={{ color: '#e74c3c' }}>{error ?? listError}</p>}
      {loading && <p>{t('reseller.loading')}</p>}
      {selectedId && !loading && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f5f5f5' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #ddd' }}>{t('reseller.invoice')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #ddd' }}>{t('reseller.client')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #ddd' }}>{t('reseller.rate')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #ddd' }}>{t('reseller.amount')}</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', border: '1px solid #ddd' }}>{t('reseller.status')}</th>
            </tr>
          </thead>
          <tbody>
            {commissions.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 8, textAlign: 'center', color: '#999' }}>{t('reseller.noCommissions')}</td></tr>
            )}
            {commissions.map((c) => (
              <tr key={c.id} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}>{c.invoice_number ?? c.invoice_id}</td>
                <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}>{c.client_name ?? c.client_id}</td>
                <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}>{c.commission_rate}%</td>
                <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}>{c.commission_amount} {c.currency}</td>
                <td style={{ padding: '6px 8px', border: '1px solid #ddd' }}><StatusBadge value={c.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Reseller Portal (dashboard + client list)
// ---------------------------------------------------------------------------

function PortalTab() {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [dashboard, setDashboard] = useState<ResellerDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resellersQ = useResellerOptions();
  const resellers = resellersQ.data?.rows ?? [];
  const listError = resellersQ.isError ? t('reseller.errorLoading') : null;

  const load = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true); setError(null);
    try {
      const res = await apiFetch<{ data: ResellerDashboard }>(`/reseller-portal/${selectedId}/dashboard`);
      setDashboard(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reseller.errorLoading'));
    } finally { setLoading(false); }
  }, [selectedId, t]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <h3>{t('reseller.portal')}</h3>
      <label htmlFor="portal-reseller">{t('reseller.selectReseller')}: </label>
      <select id="portal-reseller" value={selectedId ?? ''} onChange={e => setSelectedId(parseInt(e.target.value, 10) || null)} style={{ padding: '4px 8px', marginBottom: 12 }}>
        <option value="">— {t('reseller.select')} —</option>
        {resellers.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <ResellerListNotice list={resellersQ.data} />
      {(error ?? listError) && <p style={{ color: '#e74c3c' }}>{error ?? listError}</p>}
      {loading && <p>{t('reseller.loading')}</p>}
      {selectedId && !loading && dashboard && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 8 }}>
          {[
            { label: t('reseller.subscribers'), value: dashboard.subscriber_count },
            { label: t('reseller.revenue'), value: `$${dashboard.total_revenue.toFixed(2)}` },
            { label: t('reseller.openTickets'), value: dashboard.open_tickets },
            { label: t('reseller.pendingCommission'), value: `$${dashboard.pending_commission.toFixed(2)}` },
          ].map((card) => (
            <div key={card.label} style={{
              background: '#f8f9fa', border: '1px solid #dee2e6', borderRadius: 8,
              padding: 16, textAlign: 'center',
            }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#2c3e50' }}>{card.value}</div>
              <div style={{ fontSize: 12, color: '#7f8c8d', marginTop: 4 }}>{card.label}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

const TABS: { key: Tab; labelKey: string; permission?: string }[] = [
  { key: 'resellers', labelKey: 'reseller.tabResellers' },
  { key: 'allowedPlans', labelKey: 'resellerAdmin.tabAllowedPlans' },
  { key: 'ledger', labelKey: 'resellerLedger.tab', permission: 'reseller_ledger.view' },
  { key: 'bags', labelKey: 'cashBags.resellerTab.tab', permission: 'cash_bags.view' },
  { key: 'commissions', labelKey: 'reseller.tabCommissions' },
  { key: 'portal', labelKey: 'reseller.tabPortal' },
  { key: 'staffAccess', labelKey: 'resellerAccess.tab' },
];

export default function ResellerPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>('resellers');
  const tabs = TABS.filter(tab => !tab.permission || can(user, tab.permission));

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h2 style={{ marginBottom: 16, color: '#2c3e50' }}>{t('reseller.pageTitle')}</h2>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #dee2e6' }}>
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '8px 16px', border: 'none', cursor: 'pointer', fontSize: 13,
              background: activeTab === tab.key ? '#3498db' : 'transparent',
              color: activeTab === tab.key ? '#fff' : '#555',
              borderRadius: '4px 4px 0 0',
              fontWeight: activeTab === tab.key ? 600 : 400,
            }}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'resellers' && <ResellersTab />}
      {activeTab === 'allowedPlans' && <ResellerAllowedPlansTab />}
      {activeTab === 'ledger' && <ResellerLedgerTab />}
      {activeTab === 'bags' && <ResellerBagsTab />}
      {activeTab === 'commissions' && <CommissionsTab />}
      {activeTab === 'portal' && <PortalTab />}
      {activeTab === 'staffAccess' && <ResellerUserBindingsTab />}
    </div>
  );
}

// =============================================================================
// VigaBSS 5.0 — Plan Management
// =============================================================================
// Standalone page at /plans. Lists service plans with:
//   • Status filter
//   • Paginated table (name, speeds, price, cycle, status)
//   • "New Plan" create modal, per-row Edit and Delete (soft-delete)
// All mutations go through the typed `api` client + React Query, invalidating
// the ['plans'] query so the list refreshes automatically.
// =============================================================================

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { api } from '@/api/client';
import { useOrgCurrency } from '@/auth/useOrgCurrency';
import {
  styles,
  modalStyles,
  RequiredMark,
  fmtMoney,
  capitalize,
} from './crudStyles';
import { Pagination } from '@/components/Pagination';
import { StatusBadge, type StatusColors } from '@/components/ui/StatusBadge';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Plan {
  id: number;
  name: string;
  description: string | null;
  download_speed_mbps: number | null;
  upload_speed_mbps: number | null;
  price: string | number | null;
  currency: string | null;
  billing_cycle: string | null;
  data_cap_gb: string | number | null;
  status: string;
  radius_vendor?: string | null;
  radius_rate_limit_template?: string | null;
  fup_threshold_gb?: string | number | null;
  fup_threshold_percent?: number | null;
  fup_download_speed_mbps?: number | null;
  fup_upload_speed_mbps?: number | null;
  overage_mode?: string | null;
  overage_price_per_gb?: string | number | null;
  trial_days?: number | null;
  trial_price?: string | number | null;
  stack_type?: string | null;
}

interface PlansResponse {
  data: Plan[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

interface PlanBody {
  name: string;
  description?: string;
  download_speed_mbps: number;
  upload_speed_mbps: number;
  price: number;
  currency?: string;
  billing_cycle?: string;
  data_cap_gb?: number;
  status?: string;
  radius_vendor?: string;
  radius_rate_limit_template?: string;
  fup_threshold_gb?: number;
  fup_threshold_percent?: number;
  fup_download_speed_mbps?: number;
  fup_upload_speed_mbps?: number;
  overage_mode?: string;
  overage_price_per_gb?: number;
  trial_days?: number;
  trial_price?: number;
  stack_type?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BILLING_CYCLES = ['monthly', 'quarterly', 'semi_annual', 'annual'];
const STATUSES = ['active', 'inactive', 'archived'];
const STATUS_FILTER_OPTIONS = ['', ...STATUSES];
const RADIUS_VENDORS = ['', 'mikrotik', 'cisco', 'juniper'];
const OVERAGE_MODES = ['none', 'per_gb', 'upgrade_prompt'];
const STACK_TYPES = ['ipv4_only', 'ipv6_only', 'dual_stack'];

// ---------------------------------------------------------------------------
// Fetch / mutate helpers
// ---------------------------------------------------------------------------

async function fetchPlans(page: number, pageSize: number, statusFilter: string): Promise<PlansResponse> {
  const query: Record<string, string | number> = { page, limit: pageSize };
  if (statusFilter) query.status = statusFilter;
  const res = await api.GET('/plans', { params: { query: query } });
  if (res.error) throw new Error('Failed to load plans');
  return res.data as unknown as PlansResponse;
}

async function createPlan(body: PlanBody): Promise<void> {
  const res = await api.POST('/plans', { body: body as never });
  if (res.error) throw new Error('Failed to create plan');
}

async function updatePlan(id: number, body: Partial<PlanBody>): Promise<void> {
  const res = await api.PUT('/plans/{id}', {
    params: { path: { id } },
    body: body,
  });
  if (res.error) throw new Error('Failed to update plan');
}

async function deletePlan(id: number): Promise<void> {
  const res = await api.DELETE('/plans/{id}', { params: { path: { id } } });
  if (res.error) throw new Error('Failed to delete plan');
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_COLORS: StatusColors = {
  active:   { bg: '#d1fae5', color: '#065f46' },
  inactive: { bg: '#fef3c7', color: '#92400e' },
  archived: { bg: '#f3f4f6', color: '#6b7280' },
};

// ---------------------------------------------------------------------------
// Plan form modal (create + edit)
// ---------------------------------------------------------------------------

interface PlanModalProps {
  plan: Plan | null;
  onClose: () => void;
  onSaved: () => void;
}

function PlanModal({ plan, onClose, onSaved }: PlanModalProps) {
  const { t } = useTranslation();
  const isEdit = plan !== null;
  const [form, setForm] = useState({
    name: plan?.name ?? '',
    description: plan?.description ?? '',
    download_speed_mbps: plan?.download_speed_mbps != null ? String(plan.download_speed_mbps) : '',
    upload_speed_mbps: plan?.upload_speed_mbps != null ? String(plan.upload_speed_mbps) : '',
    price: plan?.price != null ? String(plan.price) : '',
    billing_cycle: plan?.billing_cycle ?? 'monthly',
    data_cap_gb: plan?.data_cap_gb != null ? String(plan.data_cap_gb) : '',
    status: plan?.status ?? 'active',
    radius_vendor: plan?.radius_vendor ?? '',
    radius_rate_limit_template: plan?.radius_rate_limit_template ?? '',
    fup_threshold_gb: plan?.fup_threshold_gb != null ? String(plan.fup_threshold_gb) : '',
    fup_threshold_percent: plan?.fup_threshold_percent != null ? String(plan.fup_threshold_percent) : '',
    fup_download_speed_mbps: plan?.fup_download_speed_mbps != null ? String(plan.fup_download_speed_mbps) : '',
    fup_upload_speed_mbps: plan?.fup_upload_speed_mbps != null ? String(plan.fup_upload_speed_mbps) : '',
    overage_mode: plan?.overage_mode ?? 'none',
    overage_price_per_gb: plan?.overage_price_per_gb != null ? String(plan.overage_price_per_gb) : '',
    trial_days: plan?.trial_days != null ? String(plan.trial_days) : '',
    trial_price: plan?.trial_price != null ? String(plan.trial_price) : '',
    stack_type: plan?.stack_type ?? 'dual_stack',
  });
  const [error, setError] = useState('');

  function setField(name: string, value: unknown) {
    setForm(prev => ({ ...prev, [name]: value }));
  }

  const mutation = useMutation({
    mutationFn: () => {
      const body: PlanBody = {
        name: form.name.trim(),
        download_speed_mbps: Number(form.download_speed_mbps),
        upload_speed_mbps: Number(form.upload_speed_mbps),
        price: Number(form.price),
        billing_cycle: form.billing_cycle,
        status: form.status,
        overage_mode: form.overage_mode || 'none',
        stack_type: form.stack_type || 'dual_stack',
      };
      if (form.description) body.description = form.description;
      if (form.data_cap_gb) body.data_cap_gb = Number(form.data_cap_gb);
      if (form.radius_vendor) body.radius_vendor = form.radius_vendor;
      if (form.radius_rate_limit_template) body.radius_rate_limit_template = form.radius_rate_limit_template;
      if (form.fup_threshold_gb) body.fup_threshold_gb = Number(form.fup_threshold_gb);
      if (form.fup_threshold_percent) body.fup_threshold_percent = Number(form.fup_threshold_percent);
      if (form.fup_download_speed_mbps) body.fup_download_speed_mbps = Number(form.fup_download_speed_mbps);
      if (form.fup_upload_speed_mbps) body.fup_upload_speed_mbps = Number(form.fup_upload_speed_mbps);
      if (form.overage_price_per_gb) body.overage_price_per_gb = Number(form.overage_price_per_gb);
      if (form.trial_days) body.trial_days = Number(form.trial_days);
      if (form.trial_price) body.trial_price = Number(form.trial_price);
      return isEdit ? updatePlan(plan.id, body) : createPlan(body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: () => setError('Failed to save plan. Check all fields and try again.'),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.download_speed_mbps || !form.upload_speed_mbps || !form.price) {
      setError('Name, download/upload speed, and price are required.');
      return;
    }
    setError('');
    mutation.mutate();
  }

  return (
    <div style={modalStyles.backdrop} onClick={onClose}>
      <div
        style={modalStyles.panel}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? `Edit plan ${plan.name}` : 'New plan'}
      >
        <div style={modalStyles.header}>
          <h2 style={modalStyles.title}>{isEdit ? `📝 Edit Plan #${plan.id}` : '📶 New Plan'}</h2>
          <button style={modalStyles.closeBtn} onClick={onClose} aria-label={t('ui.planList.close')}>✕</button>
        </div>

        <form onSubmit={handleSubmit} style={modalStyles.form}>
          <label style={modalStyles.label}>
            {t('ui.planList.name')}<RequiredMark />
            <input
              style={modalStyles.input}
              type="text"
              maxLength={200}
              value={form.name}
              onChange={e => setField('name', e.target.value)}
              required
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.description')}
            <input
              style={modalStyles.input}
              type="text"
              maxLength={1000}
              value={form.description}
              onChange={e => setField('description', e.target.value)}
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.downloadSpeedMbps')}<RequiredMark />
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              value={form.download_speed_mbps}
              onChange={e => setField('download_speed_mbps', e.target.value)}
              required
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.uploadSpeedMbps')}<RequiredMark />
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              value={form.upload_speed_mbps}
              onChange={e => setField('upload_speed_mbps', e.target.value)}
              required
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.price')}<RequiredMark />
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              step="0.01"
              value={form.price}
              onChange={e => setField('price', e.target.value)}
              required
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.billingCycle')}
            <select
              style={modalStyles.select}
              value={form.billing_cycle}
              onChange={e => setField('billing_cycle', e.target.value)}
            >
              {BILLING_CYCLES.map(c => (
                <option key={c} value={c}>{capitalize(c.replace('_', '-'))}</option>
              ))}
            </select>
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.dataCapGbLeaveBlank')}
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              step="0.01"
              value={form.data_cap_gb}
              onChange={e => setField('data_cap_gb', e.target.value)}
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.status')}
            <select
              style={modalStyles.select}
              value={form.status}
              onChange={e => setField('status', e.target.value)}
            >
              {STATUSES.map(s => <option key={s} value={s}>{capitalize(s)}</option>)}
            </select>
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.ipStackType')}
            <select
              style={modalStyles.select}
              value={form.stack_type}
              onChange={e => setField('stack_type', e.target.value)}
              aria-label={t('ui.planList.ipStackType2')}
            >
              {STACK_TYPES.map(st => (
                <option key={st} value={st}>{st.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>
              ))}
            </select>
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.radiusVendor')}
            <select
              style={modalStyles.select}
              value={form.radius_vendor}
              onChange={e => setField('radius_vendor', e.target.value)}
              aria-label={t('ui.planList.radiusVendor2')}
            >
              {RADIUS_VENDORS.map(v => (
                <option key={v} value={v}>{v ? capitalize(v) : 'Generic (WISPr)'}</option>
              ))}
            </select>
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.radiusRateLimitTemplate')}
            <input
              style={modalStyles.input}
              type="text"
              maxLength={200}
              value={form.radius_rate_limit_template}
              onChange={e => setField('radius_rate_limit_template', e.target.value)}
              placeholder={t('ui.planList.eG2m10mUpload')}
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.fupThresholdGb')}
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              step="0.01"
              value={form.fup_threshold_gb}
              onChange={e => setField('fup_threshold_gb', e.target.value)}
              aria-label={t('ui.planList.fupThresholdInGb')}
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.fupThreshold')}
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              max={100}
              value={form.fup_threshold_percent}
              onChange={e => setField('fup_threshold_percent', e.target.value)}
              aria-label={t('ui.planList.fupThresholdPercent')}
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.fupDownloadSpeedMbps')}
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              value={form.fup_download_speed_mbps}
              onChange={e => setField('fup_download_speed_mbps', e.target.value)}
              aria-label={t('ui.planList.fupThrottleDownloadSpeed')}
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.fupUploadSpeedMbps')}
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              value={form.fup_upload_speed_mbps}
              onChange={e => setField('fup_upload_speed_mbps', e.target.value)}
              aria-label={t('ui.planList.fupThrottleUploadSpeed')}
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.overageMode')}
            <select
              style={modalStyles.select}
              value={form.overage_mode}
              onChange={e => setField('overage_mode', e.target.value)}
              aria-label={t('ui.planList.overageMode2')}
            >
              {OVERAGE_MODES.map(m => (
                <option key={m} value={m}>{capitalize(m.replace('_', ' '))}</option>
              ))}
            </select>
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.overagePricePerGb')}
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              step="0.0001"
              value={form.overage_price_per_gb}
              onChange={e => setField('overage_price_per_gb', e.target.value)}
              aria-label={t('ui.planList.overagePricePerGb2')}
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.trialDays')}
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              value={form.trial_days}
              onChange={e => setField('trial_days', e.target.value)}
              aria-label={t('ui.planList.freeTrialDays')}
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.planList.trialPrice')}
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              step="0.01"
              value={form.trial_price}
              onChange={e => setField('trial_price', e.target.value)}
              aria-label={t('ui.planList.trialPeriodPrice')}
            />
          </label>

          {error && <p style={modalStyles.error}>{error}</p>}

          <div style={modalStyles.actions}>
            <button type="button" onClick={onClose} style={styles.btnSecondary} disabled={mutation.isPending}>
              {t('ui.planList.cancel')}
            </button>
            <button type="submit" style={styles.btnPrimary} disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Plan'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <div style={modalStyles.backdrop} onClick={onCancel}>
      <div
        style={{ ...modalStyles.panel, maxWidth: 380 }}
        onClick={e => e.stopPropagation()}
        role="alertdialog"
        aria-label={t('ui.planList.confirmAction')}
      >
        <p style={{ margin: '0 0 1.25rem', fontSize: '0.95rem', color: 'var(--text-primary)' }}>{message}</p>
        <div style={modalStyles.actions}>
          <button onClick={onCancel} style={styles.btnSecondary}>{t('ui.planList.noGoBack')}</button>
          <button onClick={onConfirm} style={styles.btnDanger}>{t('ui.planList.yesConfirm')}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PlanList component
// ---------------------------------------------------------------------------

export function PlanList() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const orgCurrency = useOrgCurrency();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [statusFilter, setStatusFilter] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [editPlan, setEditPlan] = useState<Plan | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const plansQ = useQuery({
    queryKey: ['plans', page, pageSize, statusFilter],
    queryFn: () => fetchPlans(page, pageSize, statusFilter),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deletePlan(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['plans'] }),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['plans'] });
  }

  function handleFilterChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  const plans = plansQ.data?.data ?? [];
  const meta = plansQ.data?.meta;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('ui.planList.plans')}</h1>
        {meta && <span style={styles.countBadge}>{meta.total} {t('ui.planList.total')}</span>}
        <button style={{ ...styles.btnPrimary, marginLeft: 'auto' }} onClick={() => setShowNew(true)}>
          {t('ui.planList.newPlan')}
        </button>
      </div>

      <div style={styles.filterRow}>
        <label style={styles.filterLabel}>{t('ui.planList.status2')}</label>
        <select
          style={styles.filterSelect}
          value={statusFilter}
          onChange={e => handleFilterChange(e.target.value)}
        >
          {STATUS_FILTER_OPTIONS.map(s => (
            <option key={s} value={s}>{s ? capitalize(s) : 'All'}</option>
          ))}
        </select>
        {statusFilter && (
          <button type="button" style={styles.btnSecondary} onClick={() => handleFilterChange('')}>
            {t('ui.planList.clearFilter')}
          </button>
        )}
      </div>

      {deleteMutation.isError && (
        <p style={{ color: '#ef4444', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
          {t('ui.planList.actionFailedPleaseTryAgain')}
        </p>
      )}

      <div style={styles.tableCard}>
        {plansQ.isLoading ? (
          <p style={styles.msg}>{t('ui.planList.loading')}</p>
        ) : plansQ.error ? (
          <p style={styles.msgError}>{t('ui.planList.failedToLoadPlans')}</p>
        ) : plans.length === 0 ? (
          <p style={styles.msg}>{t('ui.planList.noPlansFound')}{statusFilter ? ` with status "${statusFilter}"` : ''}.</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {['ID', 'Name', 'Down/Up (Mbps)', 'Price', 'Cycle', 'Data Cap', 'Status', 'Actions'].map(
                      h => <th key={h} style={styles.th}>{h}</th>,
                    )}
                  </tr>
                </thead>
                <tbody>
                  {plans.map(p => (
                    <tr key={p.id} style={styles.tr}>
                      <td style={styles.td}>#{p.id}</td>
                      <td style={{ ...styles.td, fontWeight: 500 }}>{p.name}</td>
                      <td style={styles.td}>{p.download_speed_mbps ?? '—'} / {p.upload_speed_mbps ?? '—'}</td>
                      <td style={styles.td}>{fmtMoney(p.price, p.currency ?? orgCurrency)}</td>
                      <td style={{ ...styles.td, textTransform: 'capitalize' }}>
                        {p.billing_cycle ? p.billing_cycle.replace('_', '-') : '—'}
                      </td>
                      <td style={styles.td}>{p.data_cap_gb != null ? `${p.data_cap_gb} GB` : 'Unlimited'}</td>
                      <td style={styles.td}><StatusBadge status={p.status} colors={STATUS_COLORS} /></td>
                      <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                        <button style={styles.actionBtn} onClick={() => setEditPlan(p)} title={t('ui.planList.editThisPlan')}>
                          {t('ui.planList.edit')}
                        </button>
                        <button
                          style={{ ...styles.actionBtn, color: '#991b1b' }}
                          onClick={() => setDeleteId(p.id)}
                          title={t('ui.planList.deleteThisPlan')}
                        >
                          {t('ui.planList.delete')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination
              page={page}
              totalPages={meta?.totalPages ?? 1}
              total={meta?.total}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
            />
          </>
        )}
      </div>

      {showNew && (
        <PlanModal plan={null} onClose={() => setShowNew(false)} onSaved={invalidate} />
      )}

      {editPlan && (
        <PlanModal plan={editPlan} onClose={() => setEditPlan(null)} onSaved={invalidate} />
      )}

      {deleteId !== null && (
        <ConfirmDialog
          message="Delete this plan? It will be soft-deleted and removed from the list."
          onConfirm={() => {
            deleteMutation.mutate(deleteId);
            setDeleteId(null);
          }}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  );
}

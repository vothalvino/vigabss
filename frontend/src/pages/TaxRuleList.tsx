// =============================================================================
// VigaBSS 5.0 — Tax Rule Management
// =============================================================================
// Standalone page at /tax-rules. Lists regional tax rules with a status filter,
// paginated table, and "New Tax Rule" create modal plus per-row Edit and Delete
// (soft-delete). All mutations go through the typed `api` client + React Query,
// invalidating the ['tax-rules'] query so the list refreshes.
// =============================================================================

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { api } from '@/api/client';
import { styles, modalStyles, RequiredMark, capitalize } from './crudStyles';
import { StatusBadge, type StatusColors } from '@/components/ui/StatusBadge';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaxRule {
  id: number;
  name: string;
  region: string | null;
  postal_codes: string | null;
  tax_type: string;
  rate: number | string;
  is_default: number | boolean;
  status: string;
}

interface TaxRuleResponse {
  data: TaxRule[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

interface TaxRuleBody {
  name: string;
  region?: string;
  postal_codes?: string;
  tax_type?: string;
  rate: number;
  is_default?: boolean;
  status?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 25;
const TAX_TYPES = ['vat', 'sales_tax', 'gst', 'other'];
const STATUSES = ['active', 'inactive'];
const STATUS_FILTER_OPTIONS = ['', ...STATUSES];

// ---------------------------------------------------------------------------
// Fetch / mutate helpers
// ---------------------------------------------------------------------------

async function fetchTaxRules(page: number, statusFilter: string): Promise<TaxRuleResponse> {
  const query: Record<string, string | number> = { page, limit: DEFAULT_PAGE_SIZE };
  if (statusFilter) query.status = statusFilter;
  const res = await api.GET('/tax-rules', { params: { query: query } });
  if (res.error) throw new Error('Failed to load tax rules');
  return res.data as unknown as TaxRuleResponse;
}

async function createTaxRule(body: TaxRuleBody): Promise<void> {
  const res = await api.POST('/tax-rules', { body: body as never });
  if (res.error) throw new Error('Failed to create tax rule');
}

async function updateTaxRule(id: number, body: Partial<TaxRuleBody>): Promise<void> {
  const res = await api.PUT('/tax-rules/{id}', { params: { path: { id } }, body: body });
  if (res.error) throw new Error('Failed to update tax rule');
}

async function deleteTaxRule(id: number): Promise<void> {
  const res = await api.DELETE('/tax-rules/{id}', { params: { path: { id } } });
  if (res.error) throw new Error('Failed to delete tax rule');
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

const STATUS_COLORS: StatusColors = {
  active: { bg: '#d1fae5', color: '#065f46' },
  inactive: { bg: '#f3f4f6', color: '#374151' },
};

function formatRate(rate: number | string): string {
  return `${(Number(rate) * 100).toFixed(2)}%`;
}

// ---------------------------------------------------------------------------
// Tax rule form modal (create + edit)
// ---------------------------------------------------------------------------

interface TaxRuleModalProps {
  taxRule: TaxRule | null;
  onClose: () => void;
  onSaved: () => void;
}

function TaxRuleModal({ taxRule, onClose, onSaved }: TaxRuleModalProps) {
  const { t } = useTranslation();
  const isEdit = taxRule !== null;
  const [form, setForm] = useState({
    name: taxRule?.name ?? '',
    region: taxRule?.region ?? '',
    postal_codes: taxRule?.postal_codes ?? '',
    tax_type: taxRule?.tax_type ?? 'sales_tax',
    rate: taxRule?.rate != null ? String(taxRule.rate) : '',
    is_default: taxRule ? Boolean(taxRule.is_default) : false,
    status: taxRule?.status ?? 'active',
  });
  const [error, setError] = useState('');

  function setField(name: string, value: unknown) {
    setForm(prev => ({ ...prev, [name]: value }));
  }

  const mutation = useMutation({
    mutationFn: () => {
      const body: TaxRuleBody = {
        name: form.name.trim(),
        tax_type: form.tax_type,
        rate: Number(form.rate),
        is_default: form.is_default,
        status: form.status,
      };
      if (form.region.trim()) body.region = form.region.trim();
      if (form.postal_codes.trim()) body.postal_codes = form.postal_codes.trim().replace(/\s+/g, '');
      return isEdit ? updateTaxRule(taxRule.id, body) : createTaxRule(body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: () => setError('Failed to save tax rule. Check all fields and try again.'),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Name is required.');
      return;
    }
    const rate = Number(form.rate);
    if (form.rate === '' || Number.isNaN(rate) || rate < 0 || rate > 1) {
      setError('Rate must be a decimal between 0 and 1 (e.g. 0.16 for 16%).');
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
        aria-label={isEdit ? `Edit tax rule ${taxRule.name}` : 'New tax rule'}
      >
        <div style={modalStyles.header}>
          <h2 style={modalStyles.title}>{isEdit ? `📝 Edit Tax Rule #${taxRule.id}` : '🧾 New Tax Rule'}</h2>
          <button style={modalStyles.closeBtn} onClick={onClose} aria-label={t('ui.taxRuleList.close')}>✕</button>
        </div>

        <form onSubmit={handleSubmit} style={modalStyles.form}>
          <label style={modalStyles.label}>
            {t('ui.taxRuleList.name')}<RequiredMark />
            <input
              style={modalStyles.input}
              type="text"
              maxLength={255}
              value={form.name}
              onChange={e => setField('name', e.target.value)}
              placeholder={t('ui.taxRuleList.eGStandardRateIva')}
              required
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.taxRuleList.region')}
            <input
              style={modalStyles.input}
              type="text"
              maxLength={100}
              value={form.region}
              onChange={e => setField('region', e.target.value)}
              placeholder={t('ui.taxRuleList.stateProvinceOrCountry')}
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.taxRuleList.postalCodes')}
            <input
              style={modalStyles.input}
              type="text"
              maxLength={2000}
              value={form.postal_codes}
              onChange={e => setField('postal_codes', e.target.value)}
              placeholder="21000-22999,32000-32699,88000"
            />
            <span style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4, display: 'block' }}>
              {t('ui.taxRuleList.codesRangesAndPrefixesComma')}
            </span>
          </label>

          <label style={modalStyles.label}>
            {t('ui.taxRuleList.taxType')}
            <select
              style={modalStyles.select}
              value={form.tax_type}
              onChange={e => setField('tax_type', e.target.value)}
            >
              {TAX_TYPES.map(t => <option key={t} value={t}>{capitalize(t.replace(/_/g, ' '))}</option>)}
            </select>
          </label>

          <label style={modalStyles.label}>
            {t('ui.taxRuleList.rateDecimalEG0')}<RequiredMark />
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              max={1}
              step="0.0001"
              value={form.rate}
              onChange={e => setField('rate', e.target.value)}
              required
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.taxRuleList.status')}
            <select
              style={modalStyles.select}
              value={form.status}
              onChange={e => setField('status', e.target.value)}
            >
              {STATUSES.map(s => <option key={s} value={s}>{capitalize(s)}</option>)}
            </select>
          </label>

          <label style={{ ...modalStyles.label, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={form.is_default}
              onChange={e => setField('is_default', e.target.checked)}
            />
            {t('ui.taxRuleList.defaultRuleAppliedWhenNo')}
          </label>

          {error && <p style={modalStyles.error}>{error}</p>}

          <div style={modalStyles.actions}>
            <button type="button" onClick={onClose} style={styles.btnSecondary} disabled={mutation.isPending}>
              {t('ui.taxRuleList.cancel')}
            </button>
            <button type="submit" style={styles.btnPrimary} disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Tax Rule'}
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
        aria-label={t('ui.taxRuleList.confirmAction')}
      >
        <p style={{ margin: '0 0 1.25rem', fontSize: '0.95rem', color: 'var(--text-primary)' }}>{message}</p>
        <div style={modalStyles.actions}>
          <button onClick={onCancel} style={styles.btnSecondary}>{t('ui.taxRuleList.noGoBack')}</button>
          <button onClick={onConfirm} style={styles.btnDanger}>{t('ui.taxRuleList.yesConfirm')}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TaxRuleList component
// ---------------------------------------------------------------------------

export function TaxRuleList() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [editTaxRule, setEditTaxRule] = useState<TaxRule | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const taxRulesQ = useQuery({
    queryKey: ['tax-rules', page, statusFilter],
    queryFn: () => fetchTaxRules(page, statusFilter),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteTaxRule(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tax-rules'] }),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['tax-rules'] });
  }

  function handleFilterChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  const taxRules = taxRulesQ.data?.data ?? [];
  const meta = taxRulesQ.data?.meta;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('ui.taxRuleList.taxRules')}</h1>
        {meta && <span style={styles.countBadge}>{meta.total} {t('ui.taxRuleList.total')}</span>}
        <button style={{ ...styles.btnPrimary, marginLeft: 'auto' }} onClick={() => setShowNew(true)}>
          {t('ui.taxRuleList.newTaxRule')}
        </button>
      </div>

      <div style={styles.filterRow}>
        <label style={styles.filterLabel}>{t('ui.taxRuleList.status2')}</label>
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
            {t('ui.taxRuleList.clearFilter')}
          </button>
        )}
      </div>

      {deleteMutation.isError && (
        <p style={{ color: '#ef4444', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
          {t('ui.taxRuleList.actionFailedPleaseTryAgain')}
        </p>
      )}

      <div style={styles.tableCard}>
        {taxRulesQ.isLoading ? (
          <p style={styles.msg}>{t('ui.taxRuleList.loading')}</p>
        ) : taxRulesQ.error ? (
          <p style={styles.msgError}>{t('ui.taxRuleList.failedToLoadTaxRules')}</p>
        ) : taxRules.length === 0 ? (
          <p style={styles.msg}>{t('ui.taxRuleList.noTaxRulesFound')}{statusFilter ? ` with status "${statusFilter}"` : ''}.</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {['ID', 'Name', 'Region', 'Postal codes', 'Type', 'Rate', 'Default', 'Status', 'Actions'].map(
                      h => <th key={h} style={styles.th}>{h}</th>,
                    )}
                  </tr>
                </thead>
                <tbody>
                  {taxRules.map(rule => (
                    <tr key={rule.id} style={styles.tr}>
                      <td style={styles.td}>#{rule.id}</td>
                      <td style={{ ...styles.td, fontWeight: 500 }}>{rule.name}</td>
                      <td style={styles.td}>{rule.region ?? '—'}</td>
                      <td style={{ ...styles.td, fontFamily: 'var(--mono, monospace)', fontSize: 12 }}
                          title={rule.postal_codes ?? ''}>
                        {rule.postal_codes
                          ? (rule.postal_codes.length > 28 ? `${rule.postal_codes.slice(0, 28)}…` : rule.postal_codes)
                          : '—'}
                      </td>
                      <td style={{ ...styles.td, textTransform: 'uppercase' }}>{rule.tax_type?.replace(/_/g, ' ')}</td>
                      <td style={styles.td}>{formatRate(rule.rate)}</td>
                      <td style={styles.td}>{rule.is_default ? '⭐' : '—'}</td>
                      <td style={styles.td}><StatusBadge status={rule.status} colors={STATUS_COLORS} /></td>
                      <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                        <button style={styles.actionBtn} onClick={() => setEditTaxRule(rule)} title={t('ui.taxRuleList.editThisTaxRule')}>
                          {t('ui.taxRuleList.edit')}
                        </button>
                        <button
                          style={{ ...styles.actionBtn, color: '#991b1b' }}
                          onClick={() => setDeleteId(rule.id)}
                          title={t('ui.taxRuleList.deleteThisTaxRule')}
                        >
                          {t('ui.taxRuleList.delete')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {meta && meta.totalPages > 1 && (
              <div style={styles.pagination}>
                <button style={styles.pageBtn} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                  {t('ui.taxRuleList.prev')}
                </button>
                <span style={styles.pageInfo}>{t('ui.taxRuleList.page')}{page} {t('ui.taxRuleList.of')}{meta.totalPages}</span>
                <button
                  style={styles.pageBtn}
                  onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))}
                  disabled={page === meta.totalPages}
                >
                  {t('ui.taxRuleList.next')}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {showNew && (
        <TaxRuleModal taxRule={null} onClose={() => setShowNew(false)} onSaved={invalidate} />
      )}
      {editTaxRule && (
        <TaxRuleModal taxRule={editTaxRule} onClose={() => setEditTaxRule(null)} onSaved={invalidate} />
      )}

      {deleteId !== null && (
        <ConfirmDialog
          message="Delete this tax rule? It will be soft-deleted and removed from the list."
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

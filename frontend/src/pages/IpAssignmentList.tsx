// =============================================================================
// VigaBSS 5.0 — IP Assignment Management
// =============================================================================
// Standalone page at /ip-assignments. Lists individual IP address assignments
// with a status filter, paginated table, and "New Assignment" create modal plus
// per-row Edit and Delete (soft-delete). All mutations go through the typed
// `api` client + React Query, invalidating the ['ip-assignments'] query so the
// list refreshes automatically.
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

interface IpAssignment {
  id: number;
  pool_id: number;
  contract_id: number | null;
  device_id: number | null;
  ip_address: string;
  prefix_len: number | null;
  type: string | null;
  notes: string | null;
  status: string;
}

interface IpAssignmentsResponse {
  data: IpAssignment[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

interface PoolOption {
  id: number;
  name: string;
}

interface IpAssignmentBody {
  pool_id: number;
  contract_id?: number;
  device_id?: number;
  ip_address: string;
  prefix_len?: number;
  type?: string;
  notes?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 25;
const TYPES = ['static', 'dynamic', 'reserved'];
const STATUSES = ['active', 'available', 'expired'];
const STATUS_FILTER_OPTIONS = ['', ...STATUSES];

// ---------------------------------------------------------------------------
// Fetch / mutate helpers
// ---------------------------------------------------------------------------

async function fetchIpAssignments(page: number, statusFilter: string): Promise<IpAssignmentsResponse> {
  const query: Record<string, string | number> = { page, limit: DEFAULT_PAGE_SIZE };
  if (statusFilter) query.status = statusFilter;
  const res = await api.GET('/ip-assignments', { params: { query: query } });
  if (res.error) throw new Error('Failed to load IP assignments');
  return res.data as unknown as IpAssignmentsResponse;
}

async function fetchPoolOptions(): Promise<PoolOption[]> {
  const res = await api.GET('/ip-pools', { params: { query: { limit: 500 } } });
  if (res.error) throw new Error('Failed to load IP pools');
  return (res.data as unknown as { data: PoolOption[] }).data;
}

async function createIpAssignment(body: IpAssignmentBody): Promise<void> {
  const res = await api.POST('/ip-assignments', { body: body as never });
  if (res.error) throw new Error('Failed to create IP assignment');
}

async function updateIpAssignment(id: number, body: Partial<IpAssignmentBody>): Promise<void> {
  const res = await api.PUT('/ip-assignments/{id}', { params: { path: { id } }, body: body });
  if (res.error) throw new Error('Failed to update IP assignment');
}

async function deleteIpAssignment(id: number): Promise<void> {
  const res = await api.DELETE('/ip-assignments/{id}', { params: { path: { id } } });
  if (res.error) throw new Error('Failed to delete IP assignment');
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_COLORS: StatusColors = {
  active: { bg: '#d1fae5', color: '#065f46' },
  available: { bg: '#dbeafe', color: '#1e40af' },
  expired: { bg: '#fee2e2', color: '#991b1b' },
};

// ---------------------------------------------------------------------------
// IP Assignment form modal (create + edit)
// ---------------------------------------------------------------------------

interface IpAssignmentModalProps {
  assignment: IpAssignment | null;
  pools: PoolOption[];
  onClose: () => void;
  onSaved: () => void;
}

function IpAssignmentModal({ assignment, pools, onClose, onSaved }: IpAssignmentModalProps) {
  const { t } = useTranslation();
  const isEdit = assignment !== null;
  const [form, setForm] = useState({
    pool_id: assignment?.pool_id != null ? String(assignment.pool_id) : '',
    contract_id: assignment?.contract_id != null ? String(assignment.contract_id) : '',
    device_id: assignment?.device_id != null ? String(assignment.device_id) : '',
    ip_address: assignment?.ip_address ?? '',
    prefix_len: assignment?.prefix_len != null ? String(assignment.prefix_len) : '',
    type: assignment?.type ?? 'dynamic',
    notes: assignment?.notes ?? '',
    status: assignment?.status ?? 'available',
  });
  const [error, setError] = useState('');

  function setField(name: string, value: unknown) {
    setForm(prev => ({ ...prev, [name]: value }));
  }

  const mutation = useMutation({
    mutationFn: () => {
      const body: IpAssignmentBody = {
        pool_id: Number(form.pool_id),
        ip_address: form.ip_address.trim(),
        type: form.type,
        status: form.status,
      };
      if (form.contract_id) body.contract_id = Number(form.contract_id);
      if (form.device_id) body.device_id = Number(form.device_id);
      if (form.prefix_len) body.prefix_len = Number(form.prefix_len);
      if (form.notes) body.notes = form.notes;
      return isEdit ? updateIpAssignment(assignment.id, body) : createIpAssignment(body);
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: () => setError('Failed to save IP assignment. Check all fields and try again.'),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.pool_id || !form.ip_address.trim()) {
      setError('Pool and IP address are required.');
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
        aria-label={isEdit ? `Edit IP assignment ${assignment.ip_address}` : 'New IP assignment'}
      >
        <div style={modalStyles.header}>
          <h2 style={modalStyles.title}>
            {isEdit ? `📝 Edit IP Assignment #${assignment.id}` : '🔢 New IP Assignment'}
          </h2>
          <button style={modalStyles.closeBtn} onClick={onClose} aria-label={t('ui.ipAssignmentList.close')}>✕</button>
        </div>

        <form onSubmit={handleSubmit} style={modalStyles.form}>
          <label style={modalStyles.label}>
            {t('ui.ipAssignmentList.ipPool')}<RequiredMark />
            <select
              style={modalStyles.select}
              value={form.pool_id}
              onChange={e => setField('pool_id', e.target.value)}
              required
            >
              <option value="">{t('ui.ipAssignmentList.selectAPool')}</option>
              {pools.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>

          <label style={modalStyles.label}>
            {t('ui.ipAssignmentList.ipAddress')}<RequiredMark />
            <input
              style={modalStyles.input}
              type="text"
              maxLength={45}
              value={form.ip_address}
              onChange={e => setField('ip_address', e.target.value)}
              placeholder="e.g. 10.0.0.5"
              required
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.ipAssignmentList.prefixLength')}
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              max={128}
              value={form.prefix_len}
              onChange={e => setField('prefix_len', e.target.value)}
              placeholder={t('ui.ipAssignmentList.forIpv6PrefixDelegation')}
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.ipAssignmentList.type')}
            <select
              style={modalStyles.select}
              value={form.type}
              onChange={e => setField('type', e.target.value)}
            >
              {TYPES.map(t => <option key={t} value={t}>{capitalize(t)}</option>)}
            </select>
          </label>

          <label style={modalStyles.label}>
            {t('ui.ipAssignmentList.contractId')}
            <input
              style={modalStyles.input}
              type="number"
              min={1}
              value={form.contract_id}
              onChange={e => setField('contract_id', e.target.value)}
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.ipAssignmentList.deviceId')}
            <input
              style={modalStyles.input}
              type="number"
              min={1}
              value={form.device_id}
              onChange={e => setField('device_id', e.target.value)}
            />
          </label>

          <label style={modalStyles.label}>
            {t('ui.ipAssignmentList.status')}
            <select
              style={modalStyles.select}
              value={form.status}
              onChange={e => setField('status', e.target.value)}
            >
              {STATUSES.map(s => <option key={s} value={s}>{capitalize(s)}</option>)}
            </select>
          </label>

          <label style={modalStyles.label}>
            {t('ui.ipAssignmentList.notes')}
            <textarea
              style={{ ...modalStyles.input, minHeight: 60, resize: 'vertical' }}
              maxLength={5000}
              value={form.notes}
              onChange={e => setField('notes', e.target.value)}
            />
          </label>

          {error && <p style={modalStyles.error}>{error}</p>}

          <div style={modalStyles.actions}>
            <button type="button" onClick={onClose} style={styles.btnSecondary} disabled={mutation.isPending}>
              {t('ui.ipAssignmentList.cancel')}
            </button>
            <button type="submit" style={styles.btnPrimary} disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Assignment'}
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
        aria-label={t('ui.ipAssignmentList.confirmAction')}
      >
        <p style={{ margin: '0 0 1.25rem', fontSize: '0.95rem', color: 'var(--text-primary)' }}>{message}</p>
        <div style={modalStyles.actions}>
          <button onClick={onCancel} style={styles.btnSecondary}>{t('ui.ipAssignmentList.noGoBack')}</button>
          <button onClick={onConfirm} style={styles.btnDanger}>{t('ui.ipAssignmentList.yesConfirm')}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IpAssignmentList component
// ---------------------------------------------------------------------------

export function IpAssignmentList() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [editAssignment, setEditAssignment] = useState<IpAssignment | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const assignmentsQ = useQuery({
    queryKey: ['ip-assignments', page, statusFilter],
    queryFn: () => fetchIpAssignments(page, statusFilter),
  });

  const poolsQ = useQuery({
    queryKey: ['ip-pools', 'options'],
    queryFn: fetchPoolOptions,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteIpAssignment(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ip-assignments'] }),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['ip-assignments'] });
  }

  function handleFilterChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  const assignments = assignmentsQ.data?.data ?? [];
  const meta = assignmentsQ.data?.meta;
  const pools = poolsQ.data ?? [];
  const poolName = (id: number | null) =>
    id == null ? '—' : pools.find(p => p.id === id)?.name ?? `#${id}`;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('ui.ipAssignmentList.ipAssignments')}</h1>
        {meta && <span style={styles.countBadge}>{meta.total} {t('ui.ipAssignmentList.total')}</span>}
        <button style={{ ...styles.btnPrimary, marginLeft: 'auto' }} onClick={() => setShowNew(true)}>
          {t('ui.ipAssignmentList.newAssignment')}
        </button>
      </div>

      <div style={styles.filterRow}>
        <label style={styles.filterLabel}>{t('ui.ipAssignmentList.status2')}</label>
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
            {t('ui.ipAssignmentList.clearFilter')}
          </button>
        )}
      </div>

      {deleteMutation.isError && (
        <p style={{ color: '#ef4444', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
          {t('ui.ipAssignmentList.actionFailedPleaseTryAgain')}
        </p>
      )}

      <div style={styles.tableCard}>
        {assignmentsQ.isLoading ? (
          <p style={styles.msg}>{t('ui.ipAssignmentList.loading')}</p>
        ) : assignmentsQ.error ? (
          <p style={styles.msgError}>{t('ui.ipAssignmentList.failedToLoadIpAssignments')}</p>
        ) : assignments.length === 0 ? (
          <p style={styles.msg}>{t('ui.ipAssignmentList.noIpAssignmentsFound')}{statusFilter ? ` with status "${statusFilter}"` : ''}.</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {['ID', 'IP Address', 'Pool', 'Type', 'Status', 'Actions'].map(
                      h => <th key={h} style={styles.th}>{h}</th>,
                    )}
                  </tr>
                </thead>
                <tbody>
                  {assignments.map(a => (
                    <tr key={a.id} style={styles.tr}>
                      <td style={styles.td}>#{a.id}</td>
                      <td style={{ ...styles.td, fontWeight: 500 }}>
                        {a.ip_address}{a.prefix_len != null ? `/${a.prefix_len}` : ''}
                      </td>
                      <td style={styles.td}>{poolName(a.pool_id)}</td>
                      <td style={{ ...styles.td, textTransform: 'capitalize' }}>{a.type ?? '—'}</td>
                      <td style={styles.td}><StatusBadge status={a.status} colors={STATUS_COLORS} /></td>
                      <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                        <button style={styles.actionBtn} onClick={() => setEditAssignment(a)} title={t('ui.ipAssignmentList.editThisAssignment')}>
                          {t('ui.ipAssignmentList.edit')}
                        </button>
                        <button
                          style={{ ...styles.actionBtn, color: '#991b1b' }}
                          onClick={() => setDeleteId(a.id)}
                          title={t('ui.ipAssignmentList.deleteThisAssignment')}
                        >
                          {t('ui.ipAssignmentList.delete')}
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
                  {t('ui.ipAssignmentList.prev')}
                </button>
                <span style={styles.pageInfo}>{t('ui.ipAssignmentList.page')}{page} {t('ui.ipAssignmentList.of')}{meta.totalPages}</span>
                <button
                  style={styles.pageBtn}
                  onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))}
                  disabled={page === meta.totalPages}
                >
                  {t('ui.ipAssignmentList.next')}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {showNew && (
        <IpAssignmentModal assignment={null} pools={pools} onClose={() => setShowNew(false)} onSaved={invalidate} />
      )}
      {editAssignment && (
        <IpAssignmentModal
          assignment={editAssignment}
          pools={pools}
          onClose={() => setEditAssignment(null)}
          onSaved={invalidate}
        />
      )}

      {deleteId !== null && (
        <ConfirmDialog
          message="Delete this IP assignment? It will be soft-deleted and removed from the list."
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

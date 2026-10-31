// =============================================================================
// VigaBSS 5.0 — Portal Service Requests (staff)
// =============================================================================
// Requests subscribers file from the customer portal (plan upgrade, PPPoE or
// Wi-Fi password change, static IP, cancellation, technician visit). There
// was no staff page and the API returned 500 (TNB-15), so every request sat
// pending. Staff with portal_service_requests.update can approve, reject, and
// mark manual requests (static IP, cancellation, visit) completed.
//
// Approving a plan upgrade or PPPoE password change applies it immediately;
// a Wi-Fi password change is queued to the CPE when one is managed.
// Requested passwords are never returned by the API (has_new_password).
// =============================================================================

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { styles } from './crudStyles';
import { extractApiError, overlay, modalBox, errorBox, labelStyle, inputStyle, submitBtn, cancelBtn } from '@/components/ClientFormModal';

interface ServiceRequest {
  id: number;
  client_id: number;
  client_name: string | null;
  request_type: string;
  status: string;
  payload: Record<string, unknown> | string | null;
  notes: string | null;
  created_at: string;
}

interface ListResponse {
  data: ServiceRequest[];
  meta: { total: number; page: number; limit: number; pages?: number };
}

const PAGE_SIZE = 25;
const STATUSES = ['pending', 'approved', 'rejected', 'completed', 'cancelled'] as const;
const TYPES = ['plan_upgrade', 'pppoe_password_change', 'wifi_password_change', 'static_ip_request', 'cancellation', 'visit_schedule'] as const;
// Types that stay 'approved' until someone does the work and completes them.
const MANUAL_TYPES = new Set(['static_ip_request', 'cancellation', 'visit_schedule']);

function payloadOf(req: ServiceRequest): Record<string, unknown> {
  if (!req.payload) return {};
  if (typeof req.payload === 'string') {
    try { return JSON.parse(req.payload) as Record<string, unknown>; } catch { return {}; }
  }
  return req.payload;
}

function fmt(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function Details({ req }: { req: ServiceRequest }) {
  const { t } = useTranslation();
  const p = payloadOf(req);
  const text = (key: string) => (p[key] === undefined || p[key] === null || p[key] === '' ? null : String(p[key]));
  switch (req.request_type) {
    case 'plan_upgrade':
      return <>{text('current_plan_name') ?? '—'} → {text('new_plan_name') ?? `#${text('new_plan_id') ?? '?'}`}</>;
    case 'pppoe_password_change':
    case 'wifi_password_change':
      return <>{p.has_new_password ? t('portalServiceRequests.details.passwordProvided') : t('portalServiceRequests.details.passwordMissing')}</>;
    case 'cancellation':
      return <>{text('reason') ?? '—'}</>;
    case 'visit_schedule':
      return <>{[text('preferred_date'), text('preferred_slot')].filter(Boolean).join(' · ') || '—'}</>;
    default:
      return <>{text('notes') ?? '—'}</>;
  }
}

type Action = 'approve' | 'reject' | 'complete';

function ActionModal({ req, action, onClose, onDone }: { req: ServiceRequest; action: Action; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const mutation = useMutation({
    mutationFn: async () => {
      const { error: e } = await api.POST(`/portal-service-requests/{id}/${action}` as never, {
        params: { path: { id: req.id } },
        body: (action === 'complete' ? {} : { notes: notes.trim() || undefined }) as never,
      } as never);
      if (e) throw new Error(extractApiError(e, t('portalServiceRequests.actionFailed')));
    },
    onSuccess: () => { onDone(); onClose(); },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : t('portalServiceRequests.actionFailed')),
  });

  const title = t(`portalServiceRequests.actions.${action}`);
  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={title}>
      <div style={{ ...modalBox, width: 480 }}>
        <h3 style={{ margin: '0 0 0.5rem' }}>{title} #{req.id}</h3>
        <p style={{ margin: '0 0 1rem', color: '#4b5563', fontSize: '0.9rem' }}>
          {t(`portalServiceRequests.types.${req.request_type}`)} · {req.client_name ?? `#${req.client_id}`}
        </p>
        {action === 'approve' && !MANUAL_TYPES.has(req.request_type) && (
          <p style={{ margin: '0 0 1rem', fontSize: '0.85rem' }}>{t('portalServiceRequests.approveApplies')}</p>
        )}
        {error && <div style={errorBox}>{error}</div>}
        <form onSubmit={e => { e.preventDefault(); setError(''); mutation.mutate(); }}>
          {action !== 'complete' && (
            <>
              <label style={labelStyle} htmlFor="psr-notes">{t('portalServiceRequests.notes')}</label>
              <textarea id="psr-notes" style={{ ...inputStyle, minHeight: 80 }} maxLength={2000} value={notes} onChange={e => setNotes(e.target.value)} />
            </>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: '1.25rem', justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={cancelBtn}>{t('common.cancel')}</button>
            <button type="submit" style={submitBtn} disabled={mutation.isPending}>
              {mutation.isPending ? t('common.saving') : title}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function PortalServiceRequestList() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('pending');
  const [typeFilter, setTypeFilter] = useState('');
  const [acting, setActing] = useState<{ req: ServiceRequest; action: Action } | null>(null);
  const canUpdate = can(user, 'portal_service_requests.update');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['portal-service-requests-staff', page, statusFilter, typeFilter],
    queryFn: async () => {
      const query: Record<string, unknown> = { page, limit: PAGE_SIZE };
      if (statusFilter) query.status = statusFilter;
      if (typeFilter) query.request_type = typeFilter;
      const res = await api.GET('/portal-service-requests' as never, { params: { query: query as never } } as never);
      if (res.error) throw new Error('Failed to load service requests');
      return res.data as unknown as ListResponse;
    },
  });

  const requests = data?.data ?? [];
  const meta = data?.meta;
  const totalPages = meta ? Math.max(1, meta.pages ?? Math.ceil(meta.total / meta.limit)) : 1;
  const refresh = () => qc.invalidateQueries({ queryKey: ['portal-service-requests-staff'] });

  const COLS = ['id', 'client', 'type', 'details', 'status', 'createdAt'].map(c => t(`portalServiceRequests.columns.${c}`));

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('portalServiceRequests.title')}</h1>
        {meta && <span style={styles.countBadge}>{meta.total}</span>}
        <select aria-label={t('portalServiceRequests.columns.type')} style={{ ...inputStyle, width: 200, marginLeft: 'auto' }}
          value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setPage(1); }}>
          <option value="">{t('portalServiceRequests.allTypes')}</option>
          {TYPES.map(v => <option key={v} value={v}>{t(`portalServiceRequests.types.${v}`)}</option>)}
        </select>
        <select aria-label={t('portalServiceRequests.columns.status')} style={{ ...inputStyle, width: 160 }}
          value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setPage(1); }}>
          <option value="">{t('portalServiceRequests.allStatuses')}</option>
          {STATUSES.map(v => <option key={v} value={v}>{t(`portalServiceRequests.status.${v}`)}</option>)}
        </select>
      </div>

      <div style={styles.tableCard}>
        {isLoading ? (
          <p style={styles.msg}>{t('common.loading')}</p>
        ) : isError ? (
          <p style={styles.msgError}>{t('common.loadError')}</p>
        ) : requests.length === 0 ? (
          <p style={styles.msg}>{t('portalServiceRequests.empty')}</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead><tr>{[...COLS, ''].map((h, i) => <th key={i} style={styles.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {requests.map(req => (
                    <tr key={req.id} style={styles.tr}>
                      <td style={styles.td}>#{req.id}</td>
                      <td style={styles.td}>{req.client_name ?? `#${req.client_id}`}</td>
                      <td style={styles.td}>{t(`portalServiceRequests.types.${req.request_type}`)}</td>
                      <td style={styles.td}><Details req={req} /></td>
                      <td style={styles.td}>{t(`portalServiceRequests.status.${req.status}`)}</td>
                      <td style={{ ...styles.td, color: '#6b7280' }}>{fmt(req.created_at)}</td>
                      <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                        {canUpdate && req.status === 'pending' && (
                          <>
                            <button type="button" style={styles.actionBtn} onClick={() => setActing({ req, action: 'approve' })}>{t('portalServiceRequests.actions.approve')}</button>
                            <button type="button" style={{ ...styles.actionBtn, color: 'var(--danger)' }} onClick={() => setActing({ req, action: 'reject' })}>{t('portalServiceRequests.actions.reject')}</button>
                          </>
                        )}
                        {canUpdate && req.status === 'approved' && (
                          <button type="button" style={styles.actionBtn} onClick={() => setActing({ req, action: 'complete' })}>{t('portalServiceRequests.actions.complete')}</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div style={styles.pagination}>
                <button type="button" style={styles.pageBtn} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>‹</button>
                <span>{page} / {totalPages}</span>
                <button type="button" style={styles.pageBtn} disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>›</button>
              </div>
            )}
          </>
        )}
      </div>

      {acting && <ActionModal req={acting.req} action={acting.action} onClose={() => setActing(null)} onDone={refresh} />}
    </div>
  );
}

export default PortalServiceRequestList;

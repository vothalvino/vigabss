// =============================================================================
// VigaBSS 5.0 — Message outbox (ASY-33)
// =============================================================================
// Every outgoing email, SMS, WhatsApp and push message, with its delivery
// state. Staff see what is waiting, what failed and what may not have
// arrived, and retry or cancel it. Backed by /message-outbox.
// =============================================================================

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { useMutation } from '@/api/useMutation';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { styles } from './crudStyles';
import { LoadingState } from '@/components/FetchStates';

type OutboxStatus = 'queued' | 'claimed' | 'sending' | 'sent' | 'skipped' | 'failed' | 'outcome_unknown' | 'cancelled';

interface OutboxMessage {
  id: number;
  client_id: number | null;
  channel: 'email' | 'sms' | 'whatsapp' | 'push';
  recipient: string | null;
  subject: string | null;
  source_type: string | null;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  sent_at: string | null;
  last_error_code: string | null;
  last_error: string | null;
  is_sensitive: number;
  created_at: string;
}

// A type alias, not an interface: it takes the response's index signature.
type OutboxPage = {
  data: OutboxMessage[];
  meta: { page: number; limit: number; total: number; totalPages: number };
};

interface SummaryRow { status: OutboxStatus; channel: string; count: number }

const PAGE_SIZE = 50;
const STATUSES: OutboxStatus[] = ['queued', 'sending', 'sent', 'skipped', 'failed', 'outcome_unknown', 'cancelled'];
const CHANNELS = ['email', 'sms', 'whatsapp', 'push'] as const;
// Needing attention first.
const ATTENTION: OutboxStatus[] = ['failed', 'outcome_unknown', 'queued'];
const RETRYABLE: OutboxStatus[] = ['failed', 'outcome_unknown', 'cancelled'];
const CANCELLABLE: OutboxStatus[] = ['queued', 'failed', 'outcome_unknown'];

const STATUS_COLORS: Record<OutboxStatus, string> = {
  queued: '#2563eb',
  claimed: '#2563eb',
  sending: '#2563eb',
  sent: '#16a34a',
  skipped: '#6b7280',
  failed: '#dc2626',
  outcome_unknown: '#d97706',
  cancelled: '#6b7280',
};

async function fetchOutbox(page: number, status: string, channel: string): Promise<OutboxPage> {
  const query: Record<string, string | number> = { page, limit: PAGE_SIZE };
  if (status) query.status = status;
  if (channel) query.channel = channel;
  const res = await api.GET('/message-outbox', { params: { query } });
  if ((res as { error?: unknown }).error) throw new Error('load failed');
  return (res.data as OutboxPage);
}

async function fetchSummary(): Promise<SummaryRow[]> {
  const res = await api.GET('/message-outbox/summary');
  if ((res as { error?: unknown }).error) throw new Error('load failed');
  return (res.data as { data: SummaryRow[] }).data;
}

function errorMessage(res: unknown, fallback: string): string {
  const e = (res as { error?: { error?: { message?: string } } }).error;
  return e?.error?.message || fallback;
}

export function MessageOutbox() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [channel, setChannel] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const canManage = can(user, 'message_outbox.manage');

  const listQ = useQuery({
    queryKey: ['message-outbox', page, status, channel],
    queryFn: () => fetchOutbox(page, status, channel),
  });
  const summaryQ = useQuery({ queryKey: ['message-outbox-summary'], queryFn: fetchSummary });

  const refresh = () => {
    setActionError(null);
    qc.invalidateQueries({ queryKey: ['message-outbox'] });
    qc.invalidateQueries({ queryKey: ['message-outbox-summary'] });
  };

  const retry = useMutation({
    mutationFn: async (m: OutboxMessage) => {
      const res = await api.POST('/message-outbox/{id}/retry', {
        params: { path: { id: m.id } },
        body: { confirm_possible_duplicate: m.status === 'outcome_unknown' },
      });
      if ((res as { error?: unknown }).error) throw new Error(errorMessage(res, t('messageOutbox.actionFailed')));
    },
    onSuccess: refresh,
    onError: (e: unknown) => setActionError(e instanceof Error ? e.message : t('messageOutbox.actionFailed')),
  });

  const cancel = useMutation({
    mutationFn: async (m: OutboxMessage) => {
      const res = await api.POST('/message-outbox/{id}/cancel', { params: { path: { id: m.id } } });
      if ((res as { error?: unknown }).error) throw new Error(errorMessage(res, t('messageOutbox.actionFailed')));
    },
    onSuccess: refresh,
    onError: (e: unknown) => setActionError(e instanceof Error ? e.message : t('messageOutbox.actionFailed')),
  });

  function onRetry(m: OutboxMessage) {
    // The provider may already have this one: say so before sending again.
    if (m.status === 'outcome_unknown' && !window.confirm(t('messageOutbox.confirmPossibleDuplicate'))) return;
    retry.mutate(m);
  }

  function onCancel(m: OutboxMessage) {
    if (!window.confirm(t('messageOutbox.confirmCancel'))) return;
    cancel.mutate(m);
  }

  const totals = new Map<OutboxStatus, number>();
  for (const row of summaryQ.data ?? []) totals.set(row.status, (totals.get(row.status) ?? 0) + row.count);
  const rows = listQ.data?.data ?? [];
  const meta = listQ.data?.meta;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('messageOutbox.title')}</h1>
        {meta && <span style={styles.countBadge}>{t('messageOutbox.total', { count: meta.total })}</span>}
      </div>
      <p style={{ margin: '0 0 12px', color: 'var(--text-muted)', fontSize: '0.875rem' }}>{t('messageOutbox.description')}</p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {ATTENTION.map(s => (
          <button
            key={s}
            type="button"
            onClick={() => { setStatus(s); setPage(1); }}
            aria-pressed={status === s}
            style={{
              border: `1px solid ${STATUS_COLORS[s]}`, color: STATUS_COLORS[s], background: status === s ? 'var(--bg-secondary, #f1f5f9)' : 'transparent',
              borderRadius: 999, padding: '4px 12px', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer',
            }}
          >
            {t(`messageOutbox.status.${s}`)}: {totals.get(s) ?? 0}
          </button>
        ))}
      </div>

      <div style={styles.filterRow}>
        <label style={styles.filterLabel}>
          {t('messageOutbox.filterStatus')}
          <select style={styles.filterSelect} value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>
            <option value="">{t('messageOutbox.all')}</option>
            {STATUSES.map(s => <option key={s} value={s}>{t(`messageOutbox.status.${s}`)}</option>)}
          </select>
        </label>
        <label style={styles.filterLabel}>
          {t('messageOutbox.filterChannel')}
          <select style={styles.filterSelect} value={channel} onChange={e => { setChannel(e.target.value); setPage(1); }}>
            <option value="">{t('messageOutbox.all')}</option>
            {CHANNELS.map(c => <option key={c} value={c}>{t(`messageOutbox.channel.${c}`)}</option>)}
          </select>
        </label>
      </div>

      {actionError && <p role="alert" style={styles.msgError}>{actionError}</p>}

      <div style={styles.tableCard}>
        {listQ.isLoading ? (
          <LoadingState />
        ) : listQ.isError ? (
          <p style={styles.msgError}>{t('messageOutbox.loadError')}</p>
        ) : rows.length === 0 ? (
          <p style={styles.msg}>{t('messageOutbox.empty')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>{t('messageOutbox.col.created')}</th>
                  <th style={styles.th}>{t('messageOutbox.col.channel')}</th>
                  <th style={styles.th}>{t('messageOutbox.col.recipient')}</th>
                  <th style={styles.th}>{t('messageOutbox.col.subject')}</th>
                  <th style={styles.th}>{t('messageOutbox.col.status')}</th>
                  <th style={styles.th}>{t('messageOutbox.col.attempts')}</th>
                  <th style={styles.th}>{t('messageOutbox.col.error')}</th>
                  {canManage && <th style={styles.th}>{t('messageOutbox.col.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map(m => (
                  <tr key={m.id} style={styles.tr}>
                    <td style={styles.td}>{new Date(m.created_at).toLocaleString()}</td>
                    <td style={styles.td}>{t(`messageOutbox.channel.${m.channel}`)}</td>
                    <td style={styles.tdMono}>{m.recipient ?? (m.client_id ? t('messageOutbox.clientDevices', { id: m.client_id }) : '—')}</td>
                    <td style={styles.td}>{m.subject ?? '—'}</td>
                    <td style={styles.td}>
                      <span style={{ color: STATUS_COLORS[m.status], fontWeight: 600 }}>{t(`messageOutbox.status.${m.status}`)}</span>
                    </td>
                    <td style={styles.td}>{m.attempts}/{m.max_attempts}</td>
                    <td style={{ ...styles.td, maxWidth: 280, whiteSpace: 'normal' }}>{m.last_error ?? '—'}</td>
                    {canManage && (
                      <td style={styles.td}>
                        {RETRYABLE.includes(m.status) && !m.is_sensitive && (
                          <button type="button" style={styles.actionBtn} disabled={retry.isPending} onClick={() => onRetry(m)}>
                            {t('messageOutbox.retry')}
                          </button>
                        )}
                        {CANCELLABLE.includes(m.status) && (
                          <button type="button" style={styles.actionBtn} disabled={cancel.isPending} onClick={() => onCancel(m)}>
                            {t('messageOutbox.cancel')}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {meta && meta.totalPages > 1 && (
          <div style={styles.pagination}>
            <button type="button" style={styles.pageBtn} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
              {t('messageOutbox.prev')}
            </button>
            <span style={styles.pageInfo}>{t('messageOutbox.pageOf', { page, total: meta.totalPages })}</span>
            <button type="button" style={styles.pageBtn} onClick={() => setPage(p => Math.min(meta.totalPages, p + 1))} disabled={page === meta.totalPages}>
              {t('messageOutbox.next')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

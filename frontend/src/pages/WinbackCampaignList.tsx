// =============================================================================
// VigaBSS 5.0 — Win-back Campaign Management — §1.2 Customer Lifecycle
// =============================================================================
// Full CRUD for win-back campaigns targeting cancelled customers. Each campaign
// defines:
//   • target_segment    — which cancelled cohort to reach (all / 30d / 90d / high value)
//   • offer_description  — the retention offer
//   • discount_percent   — optional discount sweetener
//   • start_date/end_date — campaign window
// A per-row "Targets" action previews the cancelled-customer cohort the
// campaign would reach (GET /winback-campaigns/{id}/targets).
// =============================================================================

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { styles } from './crudStyles';
import {
  extractApiError,
  overlay,
  modalBox,
  errorBox,
  labelStyle,
  inputStyle,
  submitBtn,
  cancelBtn,
  dangerBtn,
} from '@/components/ClientFormModal';
import { StatusBadge, type StatusColors } from '@/components/ui/StatusBadge';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WinbackCampaign {
  id: number;
  name: string;
  status: string;
  target_segment: string | null;
  offer_description: string | null;
  discount_percent: number | null;
  message_template_id: number | null;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
}

interface WinbackResponse {
  data: WinbackCampaign[];
  meta: { total: number; page: number; limit: number; totalPages?: number };
}

interface WinbackTarget {
  client_id: number;
  name: string;
  email: string | null;
  phone: string | null;
}

interface CampaignFormBody {
  name: string;
  status: string;
  target_segment: string;
  offer_description?: string;
  discount_percent?: number;
  start_date?: string;
  end_date?: string;
  notes?: string;
}

const DEFAULT_PAGE_SIZE = 50;
const STATUSES = ['draft', 'active', 'paused', 'completed'] as const;
const SEGMENTS = ['all_cancelled', 'cancelled_30d', 'cancelled_90d', 'high_value'] as const;

const SEGMENT_LABELS: Record<string, string> = {
  all_cancelled: 'All cancelled',
  cancelled_30d: 'Cancelled ≤ 30 days',
  cancelled_90d: 'Cancelled ≤ 90 days',
  high_value: 'High value',
};

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchCampaigns(page: number): Promise<WinbackResponse> {
  const res = await api.GET('/winback-campaigns', {
    params: { query: { page, limit: DEFAULT_PAGE_SIZE } },
  });
  if (res.error) throw new Error('Failed to load win-back campaigns');
  return res.data as unknown as WinbackResponse;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

const STATUS_COLORS: StatusColors = {
  draft:     { bg: '#f3f4f6', color: '#374151' },
  active:    { bg: '#d1fae5', color: '#065f46' },
  paused:    { bg: '#fef3c7', color: '#92400e' },
  completed: { bg: '#dbeafe', color: '#1e40af' },
};

// ---------------------------------------------------------------------------
// Form modal (create + edit)
// ---------------------------------------------------------------------------

function CampaignFormModal({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial?: WinbackCampaign;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<CampaignFormBody>({
    name: initial?.name ?? '',
    status: initial?.status ?? 'draft',
    target_segment: initial?.target_segment ?? 'all_cancelled',
    offer_description: initial?.offer_description ?? undefined,
    discount_percent: initial?.discount_percent ?? undefined,
    start_date: initial?.start_date ?? undefined,
    end_date: initial?.end_date ?? undefined,
    notes: initial?.notes ?? undefined,
  });
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async (body: CampaignFormBody) => {
      if (mode === 'create') {
        const { error } = await api.POST('/winback-campaigns', { body: body as never });
        if (error) throw new Error(extractApiError(error, 'Failed to create campaign'));
      } else {
        const { error } = await api.PUT('/winback-campaigns/{id}', {
          params: { path: { id: initial!.id } },
          body: body as never,
        });
        if (error) throw new Error(extractApiError(error, 'Failed to update campaign'));
      }
    },
    onSuccess: () => { onSaved(); onClose(); },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Failed to save campaign'),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setError('Name is required.'); return; }
    const body: CampaignFormBody = {
      name: form.name.trim(),
      status: form.status,
      target_segment: form.target_segment,
    };
    if (form.offer_description && form.offer_description.trim()) body.offer_description = form.offer_description.trim();
    if (form.discount_percent !== undefined && !Number.isNaN(Number(form.discount_percent))) {
      body.discount_percent = Number(form.discount_percent);
    }
    if (form.start_date) body.start_date = form.start_date;
    if (form.end_date) body.end_date = form.end_date;
    if (form.notes && form.notes.trim()) body.notes = form.notes.trim();
    setError('');
    mutation.mutate(body);
  }

  const title = mode === 'create' ? 'New Win-back Campaign' : `Edit Campaign: ${initial?.name ?? ''}`;

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={title}>
      <div style={{ ...modalBox, width: 540, maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 1rem' }}>{title}</h3>
        {error && <div style={errorBox}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <label style={labelStyle}>{t('ui.winbackCampaignList.campaignName')}</label>
          <input style={inputStyle} type="text" value={form.name} autoFocus required
            onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />

          <label style={labelStyle}>{t('ui.winbackCampaignList.status')}</label>
          <select style={inputStyle} value={form.status}
            onChange={e => setForm(p => ({ ...p, status: e.target.value }))}>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          <label style={labelStyle}>{t('ui.winbackCampaignList.targetSegment')}</label>
          <select style={inputStyle} value={form.target_segment}
            onChange={e => setForm(p => ({ ...p, target_segment: e.target.value }))}>
            {SEGMENTS.map(s => <option key={s} value={s}>{SEGMENT_LABELS[s]}</option>)}
          </select>

          <label style={labelStyle}>{t('ui.winbackCampaignList.offerDescription')}</label>
          <textarea style={{ ...inputStyle, minHeight: 64, resize: 'vertical' }} value={form.offer_description ?? ''}
            onChange={e => setForm(p => ({ ...p, offer_description: e.target.value }))} />

          <label style={labelStyle}>{t('ui.winbackCampaignList.discountPercentOptional')}</label>
          <input style={inputStyle} type="number" min={0} max={100} value={form.discount_percent ?? ''}
            onChange={e => setForm(p => ({ ...p, discount_percent: e.target.value ? Number(e.target.value) : undefined }))} />

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t('ui.winbackCampaignList.startDate')}</label>
              <input style={inputStyle} type="date" value={form.start_date ?? ''}
                onChange={e => setForm(p => ({ ...p, start_date: e.target.value || undefined }))} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t('ui.winbackCampaignList.endDate')}</label>
              <input style={inputStyle} type="date" value={form.end_date ?? ''}
                onChange={e => setForm(p => ({ ...p, end_date: e.target.value || undefined }))} />
            </div>
          </div>

          <label style={labelStyle}>{t('ui.winbackCampaignList.notes')}</label>
          <textarea style={{ ...inputStyle, minHeight: 48, resize: 'vertical' }} value={form.notes ?? ''}
            onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />

          <div style={{ display: 'flex', gap: 8, marginTop: '1.25rem', justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={cancelBtn}>{t('ui.winbackCampaignList.cancel')}</button>
            <button type="submit" style={submitBtn} disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete confirmation dialog
// ---------------------------------------------------------------------------

function DeleteConfirm({ campaign, onClose, onDeleted }: { campaign: WinbackCampaign; onClose: () => void; onDeleted: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState('');
  const mutation = useMutation({
    mutationFn: async () => {
      const { error } = await api.DELETE('/winback-campaigns/{id}', { params: { path: { id: campaign.id } } });
      if (error) throw new Error(extractApiError(error, 'Failed to delete campaign'));
    },
    onSuccess: () => { onDeleted(); onClose(); },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Delete failed'),
  });

  return (
    <div style={overlay} role="alertdialog" aria-modal="true">
      <div style={{ ...modalBox, width: 400 }}>
        <p style={{ margin: '0 0 1rem' }}>{t('ui.winbackCampaignList.deleteCampaign')}<strong>{campaign.name}</strong>{t('ui.winbackCampaignList.thisCannotBeUndone')}</p>
        {error && <div style={errorBox}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={cancelBtn} disabled={mutation.isPending}>{t('ui.winbackCampaignList.cancel')}</button>
          <button type="button" onClick={() => mutation.mutate()} style={dangerBtn} disabled={mutation.isPending}>
            {mutation.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Targets preview dialog
// ---------------------------------------------------------------------------

function TargetsModal({ campaign, onClose }: { campaign: WinbackCampaign; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useQuery({
    queryKey: ['winback-targets', campaign.id],
    queryFn: async () => {
      const res = await api.GET('/winback-campaigns/{id}/targets', { params: { path: { id: campaign.id } } });
      if (res.error) throw new Error('Failed to load targets');
      return res.data as unknown as { data: WinbackTarget[]; meta: { count: number; segment: string } };
    },
  });

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={t('ui.winbackCampaignList.campaignTargets')}>
      <div style={{ ...modalBox, width: 560, maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 0.25rem' }}>{t('ui.winbackCampaignList.targets')}{campaign.name}</h3>
        <p style={{ margin: '0 0 1rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {t('ui.winbackCampaignList.cancelledCustomerCohortMatchingSegment')}
          {' '}<strong>{SEGMENT_LABELS[campaign.target_segment ?? ''] ?? campaign.target_segment ?? '—'}</strong>.
        </p>
        {isLoading && <p>{t('ui.winbackCampaignList.loading')}</p>}
        {error && <div style={errorBox}>{(error as Error).message}</div>}
        {data && (
          <>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.82rem' }}>{data.meta.count} {t('ui.winbackCampaignList.matchingClientS')}</p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border-strong)' }}>
                  <th style={{ padding: '6px' }}>{t('ui.winbackCampaignList.client')}</th>
                  <th style={{ padding: '6px' }}>{t('ui.winbackCampaignList.name')}</th>
                  <th style={{ padding: '6px' }}>{t('ui.winbackCampaignList.email')}</th>
                  <th style={{ padding: '6px' }}>{t('ui.winbackCampaignList.phone')}</th>
                </tr>
              </thead>
              <tbody>
                {data.data.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: '0.75rem', color: 'var(--text-secondary)' }}>{t('ui.winbackCampaignList.noMatchingClients')}</td></tr>
                )}
                {data.data.map(t => (
                  <tr key={t.client_id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px', fontFamily: 'monospace' }}>#{t.client_id}</td>
                    <td style={{ padding: '6px' }}>{t.name}</td>
                    <td style={{ padding: '6px' }}>{t.email ?? '—'}</td>
                    <td style={{ padding: '6px' }}>{t.phone ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
          <button type="button" onClick={onClose} style={cancelBtn}>{t('ui.winbackCampaignList.close')}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WinbackCampaignList component
// ---------------------------------------------------------------------------

export function WinbackCampaignList() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [showCreate, setShowCreate] = useState(false);
  const [editCampaign, setEditCampaign] = useState<WinbackCampaign | null>(null);
  const [deleteCampaign, setDeleteCampaign] = useState<WinbackCampaign | null>(null);
  const [targetsCampaign, setTargetsCampaign] = useState<WinbackCampaign | null>(null);

  const canCreate = can(user, 'winback.create');
  const canUpdate = can(user, 'winback.update');
  const canDelete = can(user, 'winback.delete');

  const campaignsQ = useQuery({ queryKey: ['winback-campaigns', page], queryFn: () => fetchCampaigns(page) });
  const campaigns = campaignsQ.data?.data ?? [];
  const meta = campaignsQ.data?.meta;
  const totalPages = meta?.totalPages ?? (meta ? Math.max(1, Math.ceil(meta.total / meta.limit)) : 1);

  const refresh = () => qc.invalidateQueries({ queryKey: ['winback-campaigns'] });

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('ui.winbackCampaignList.winBackCampaigns')}</h1>
        {meta && <span style={styles.countBadge}>{meta.total} {t('ui.winbackCampaignList.total')}</span>}
        {canCreate && (
          <button type="button" style={{ ...styles.btnPrimary, marginLeft: 'auto' }}
            onClick={() => setShowCreate(true)}>{t('ui.winbackCampaignList.newCampaign')}</button>
        )}
      </div>

      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 1rem' }}>
        {t('ui.winbackCampaignList.reEngageCancelledCustomersWith')}
      </p>

      <div style={styles.tableCard}>
        {campaignsQ.isLoading ? (
          <p style={styles.msg}>{t('ui.winbackCampaignList.loading')}</p>
        ) : campaignsQ.error ? (
          <p style={styles.msgError}>{t('ui.winbackCampaignList.failedToLoadWinBack')}</p>
        ) : campaigns.length === 0 ? (
          <p style={styles.msg}>{t('ui.winbackCampaignList.noWinBackCampaignsYet')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {['ID', 'Name', 'Segment', 'Discount', 'Window', 'Status', 'Actions'].map(
                    h => <th key={h} style={styles.th}>{h}</th>,
                  )}
                </tr>
              </thead>
              <tbody>
                {campaigns.map(c => (
                  <tr key={c.id} style={styles.tr}>
                    <td style={styles.td}>#{c.id}</td>
                    <td style={{ ...styles.td, fontWeight: 500 }}>{c.name}</td>
                    <td style={styles.td}>{SEGMENT_LABELS[c.target_segment ?? ''] ?? c.target_segment ?? '—'}</td>
                    <td style={styles.td}>{c.discount_percent != null ? `${c.discount_percent}%` : '—'}</td>
                    <td style={styles.td}>
                      {c.start_date || c.end_date
                        ? `${c.start_date ?? '…'} → ${c.end_date ?? '…'}`
                        : '—'}
                    </td>
                    <td style={styles.td}><StatusBadge status={c.status} colors={STATUS_COLORS} /></td>
                    <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                      <button type="button"
                        style={{ ...cancelBtn, padding: '4px 10px', marginRight: 6 }}
                        onClick={() => setTargetsCampaign(c)}>{t('ui.winbackCampaignList.targets2')}</button>
                      {canUpdate && (
                        <button type="button"
                          style={{ ...cancelBtn, padding: '4px 10px', marginRight: 6 }}
                          onClick={() => setEditCampaign(c)}>{t('ui.winbackCampaignList.edit')}</button>
                      )}
                      {canDelete && (
                        <button type="button"
                          style={{ ...dangerBtn, padding: '4px 10px' }}
                          onClick={() => setDeleteCampaign(c)}>{t('ui.winbackCampaignList.delete')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: '1rem' }}>
          <button type="button" style={cancelBtn} disabled={page <= 1}
            onClick={() => setPage(p => Math.max(1, p - 1))}>{t('ui.winbackCampaignList.previous')}</button>
          <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{t('ui.winbackCampaignList.page')}{page} {t('ui.winbackCampaignList.of')}{totalPages}</span>
          <button type="button" style={cancelBtn} disabled={page >= totalPages}
            onClick={() => setPage(p => p + 1)}>{t('ui.winbackCampaignList.next')}</button>
        </div>
      )}

      {showCreate && (
        <CampaignFormModal mode="create" onClose={() => setShowCreate(false)} onSaved={refresh} />
      )}
      {editCampaign && (
        <CampaignFormModal mode="edit" initial={editCampaign} onClose={() => setEditCampaign(null)} onSaved={refresh} />
      )}
      {deleteCampaign && (
        <DeleteConfirm campaign={deleteCampaign} onClose={() => setDeleteCampaign(null)} onDeleted={refresh} />
      )}
      {targetsCampaign && (
        <TargetsModal campaign={targetsCampaign} onClose={() => setTargetsCampaign(null)} />
      )}
    </div>
  );
}

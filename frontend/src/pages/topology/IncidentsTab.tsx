// =============================================================================
// VigaBSS 5.0 — network incidents, for technicians
// =============================================================================
// One row per faulty line or piece of equipment of the network tree. An
// incident stays open when the fault clears by itself (a link that saturates
// every evening is fine at night): a technician closes it, and must say what
// was done. That comment is rewritten for the customers who reported the
// fault; where the assistant may not send by itself, the message waits here
// as a draft to read, edit and approve.
// =============================================================================
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { apiFetch } from '@/api/apiFetch';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { styles } from '../crudStyles';
import { HEALTH_COLOR, reasonText, type Reason, type TopClient } from './linkHealth';

interface Incident {
  id: number;
  device_name: string;
  device_type: string;
  site_name: string | null;
  part: 'equipment' | 'line';
  cause_code: string;
  worst_state: 'degraded' | 'off';
  status: 'open' | 'resolved';
  first_seen_at: string;
  last_seen_at: string;
  last_good_at: string | null;
  evidence: { reasons: Reason[]; top_clients?: TopClient[] };
  affected_contracts: number;
  reopened_count: number;
  closed_at: string | null;
  closed_by: string | null;
  closing_comment: string | null;
  customer_message: string | null;
  reports: number;
  drafts: number;
}
interface Report { id: number; client_name: string | null; contract_id: number; channel: string | null; reported_at: string; notice_status: 'none' | 'draft' | 'sent' | 'failed' | 'discarded'; notice_text: string | null }
interface Pattern { days_bad: number; days_window: number; bad_minutes: number; windows: Array<{ start: string; end: string }>; recurring: boolean; continuous: boolean; peak: number | null; kind: 'capacity' | 'repair' | 'equipment' }
type Detail = Omit<Incident, 'reports'> & { pattern: Pattern; reports: Report[] };

const LIST_KEY = ['network-incidents'];
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

function DraftRow({ incidentId, report, canAct }: { incidentId: number; report: Report; canAct: boolean }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const waiting = report.notice_status === 'draft' || report.notice_status === 'failed';
  // The reviewer reads the draft in their own language; the customer still
  // receives it in theirs.
  const lang = i18n.language || 'en';
  const { data: draft, isLoading: draftLoading } = useQuery({
    queryKey: ['network-incident-draft', incidentId, report.id, lang],
    queryFn: async () => (await apiFetch<{ data: { text: string; customer_text: string; translated: boolean } }>(`/network-incidents/${incidentId}/reports/${report.id}/draft?lang=${encodeURIComponent(lang)}`)).data,
    enabled: waiting && canAct,
  });
  const [edited, setEdited] = useState<string | null>(null);
  const text = edited ?? draft?.text ?? report.notice_text ?? '';
  const setText = setEdited;
  const refresh = () => { void qc.invalidateQueries({ queryKey: LIST_KEY }); void qc.invalidateQueries({ queryKey: ['network-incident', incidentId] }); };
  const send = useMutation({
    mutationFn: () => apiFetch(`/network-incidents/${incidentId}/reports/${report.id}/send`, { method: 'POST', body: JSON.stringify(draft?.translated ? { text, lang } : { text }) }),
    onSuccess: refresh,
  });
  const discard = useMutation({
    mutationFn: () => apiFetch(`/network-incidents/${incidentId}/reports/${report.id}/discard`, { method: 'POST' }),
    onSuccess: refresh,
  });
  return (
    <li style={{ padding: '6px 0', borderTop: '1px solid var(--border-color, #e2e8f0)' }}>
      <div>
        <strong>{report.client_name ?? t('incidentsBoard.customer')}</strong>
        <span style={{ marginLeft: 8, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {t('incidentsBoard.reportedOn', { when: when(report.reported_at) })}{report.channel ? ` · ${report.channel}` : ''} · {t(`incidentsBoard.notice.${report.notice_status}`)}
        </span>
      </div>
      {waiting && canAct && (
        <div style={{ marginTop: 6 }}>
          <textarea
            aria-label={t('incidentsBoard.messageFor', { name: report.client_name ?? t('incidentsBoard.customer') })}
            value={text} onChange={e => setText(e.target.value)} rows={3} maxLength={900} disabled={draftLoading}
            style={{ ...styles.input, width: '100%', boxSizing: 'border-box' }}
          />
          {draft?.translated && (
            <div style={{ margin: '4px 0', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
              <div>{edited !== null && edited !== draft.text ? t('incidentsBoard.willTranslate') : t('incidentsBoard.customerGets')}</div>
              {(edited === null || edited === draft.text) && <blockquote lang="und" style={{ margin: '2px 0 0', paddingLeft: 8, borderLeft: '3px solid var(--border-color, #cbd5e1)' }}>{draft.customer_text}</blockquote>}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button type="button" disabled={send.isPending || draftLoading || text.trim().length < 10} onClick={() => send.mutate()} style={{ cursor: 'pointer', fontWeight: 600 }}>{t('incidentsBoard.sendMessage')}</button>
            <button type="button" disabled={discard.isPending} onClick={() => discard.mutate()} style={{ cursor: 'pointer' }}>{t('incidentsBoard.dontSend')}</button>
          </div>
          {(send.isError || discard.isError) && <span role="alert" style={{ color: '#991b1b' }}>{((send.error ?? discard.error) as Error).message}</span>}
        </div>
      )}
      {!waiting && report.notice_text && report.notice_status === 'sent' && <p style={{ margin: '4px 0 0', fontSize: '0.85rem' }}>{report.notice_text}</p>}
    </li>
  );
}

function IncidentDetail({ id, canAct }: { id: number; canAct: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const { data, isLoading, isError } = useQuery({
    queryKey: ['network-incident', id],
    queryFn: async () => (await apiFetch<{ data: Detail }>(`/network-incidents/${id}`)).data,
  });
  const close = useMutation({
    mutationFn: () => apiFetch(`/network-incidents/${id}/close`, { method: 'POST', body: JSON.stringify({ comment }) }),
    onSuccess: () => { setComment(''); void qc.invalidateQueries({ queryKey: LIST_KEY }); void qc.invalidateQueries({ queryKey: ['network-incident', id] }); },
  });
  if (isLoading) return <p>{t('networkTree.loading')}</p>;
  if (isError || !data) return <p role="alert">{t('incidentsBoard.loadFailed')}</p>;
  const p = data.pattern;
  const shape = p.recurring ? 'recurring' : p.continuous ? 'continuous' : 'occasional';
  return (
    <div style={{ padding: '10px 0 4px 14px', fontSize: '0.88rem' }}>
      <p style={{ margin: '0 0 4px' }}>
        <strong>{t(`incidentsBoard.shape.${shape}`)}</strong>{' '}
        {t('incidentsBoard.patternDays', { days: p.days_bad, window: p.days_window, hours: (p.bad_minutes / 60).toFixed(1) })}
      </p>
      <p style={{ margin: '0 0 6px', color: 'var(--text-secondary)' }}>{t(`incidentsBoard.kind.${p.kind}`)}</p>
      {p.windows.length > 0 && (
        <ul aria-label={t('incidentsBoard.windows')} style={{ margin: '0 0 8px', paddingLeft: 18 }}>
          {p.windows.slice(-8).map(w => <li key={w.start}>{day(w.start)}, {clock(w.start)} – {clock(w.end)}</li>)}
        </ul>
      )}
      {data.evidence.top_clients && data.evidence.top_clients.length > 0 && (
        <p style={{ margin: '0 0 8px' }}>{t('linkHealth.topClients', { list: data.evidence.top_clients.map(c => `${c.name} ${c.mbps} Mbps`).join(', ') })}</p>
      )}

      <h4 style={{ margin: '10px 0 4px' }}>{t('incidentsBoard.reporters', { count: data.reports.length })}</h4>
      {data.reports.length === 0
        ? <p style={{ margin: 0 }}>{t('incidentsBoard.noReporters')}</p>
        : <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{data.reports.map(r => <DraftRow key={r.id} incidentId={id} report={r} canAct={canAct} />)}</ul>}

      {data.status === 'open' && canAct && (
        <form
          aria-label={t('incidentsBoard.closeTitle')}
          onSubmit={e => { e.preventDefault(); close.mutate(); }}
          style={{ marginTop: 12 }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <strong>{t('incidentsBoard.closeLabel')}</strong>
            <textarea value={comment} onChange={e => setComment(e.target.value)} rows={3} required style={{ ...styles.input, width: '100%', boxSizing: 'border-box' }} />
          </label>
          <p style={{ margin: '4px 0', color: 'var(--text-secondary)' }}>{t('incidentsBoard.closeHint')}</p>
          <button type="submit" disabled={close.isPending || comment.replace(/\s+/g, '').length < 5} style={{ ...styles.input, cursor: 'pointer', fontWeight: 600 }}>
            {close.isPending ? t('incidentsBoard.closing') : t('incidentsBoard.close')}
          </button>
          {close.isError && <span role="alert" style={{ color: '#991b1b', marginLeft: 10 }}>{(close.error as Error).message}</span>}
        </form>
      )}
      {data.status === 'resolved' && (
        <div style={{ marginTop: 10 }}>
          <p style={{ margin: '0 0 4px' }}><strong>{t('incidentsBoard.closedBy', { who: data.closed_by ?? '—', when: when(data.closed_at) })}</strong></p>
          <p style={{ margin: '0 0 4px' }}>{t('incidentsBoard.technicianSaid')} {data.closing_comment}</p>
          {data.customer_message && <p style={{ margin: 0 }}>{t('incidentsBoard.customersTold')} {data.customer_message}</p>}
        </div>
      )}
    </div>
  );
}

export function IncidentsTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canAct = can(user, 'devices.update');
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const [openId, setOpenId] = useState<number | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: [...LIST_KEY, status],
    queryFn: async () => (await apiFetch<{ data: Incident[] }>(`/network-incidents?status=${status}`)).data,
    refetchInterval: 60_000,
  });

  return (
    <div>
      <p style={{ marginTop: 0, color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{t('incidentsBoard.intro')}</p>
      <div role="group" aria-label={t('incidentsBoard.show')} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['open', 'resolved'] as const).map(s => (
          <button key={s} type="button" aria-pressed={status === s} onClick={() => { setStatus(s); setOpenId(null); }} style={{ ...styles.input, cursor: 'pointer', fontWeight: status === s ? 700 : 400 }}>
            {t(`incidentsBoard.status.${s}`)}
          </button>
        ))}
      </div>
      {isLoading && <p>{t('networkTree.loading')}</p>}
      {isError && <p role="alert">{t('incidentsBoard.loadFailed')}</p>}
      {data && data.length === 0 && <p>{t(status === 'open' ? 'incidentsBoard.noneOpen' : 'incidentsBoard.noneClosed')}</p>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {(data ?? []).map(incident => (
          <li key={incident.id} data-state={incident.worst_state} style={{ borderLeft: `5px solid ${HEALTH_COLOR[incident.worst_state]}`, padding: '8px 12px', marginBottom: 8, border: '1px solid var(--border-color, #e2e8f0)', borderLeftWidth: 5, borderLeftColor: HEALTH_COLOR[incident.worst_state], borderRadius: 6 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong>{incident.device_name}</strong>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {t(`incidentsBoard.part.${incident.part}`)}{incident.site_name ? ` · ${incident.site_name}` : ''}
              </span>
              {incident.drafts > 0 && <span style={{ fontSize: '0.78rem', fontWeight: 700, color: '#b45309' }}>{t('incidentsBoard.draftsWaiting', { count: incident.drafts })}</span>}
              <button type="button" aria-expanded={openId === incident.id} onClick={() => setOpenId(cur => (cur === incident.id ? null : incident.id))} style={{ marginLeft: 'auto', cursor: 'pointer' }}>
                {openId === incident.id ? t('incidentsBoard.hide') : t('incidentsBoard.details')}
              </button>
            </div>
            <div style={{ fontSize: '0.88rem', marginTop: 2 }}>
              {t(`linkHealth.states.${incident.worst_state}`)}: {incident.evidence.reasons.map(r => reasonText(t, r)).join('; ') || incident.cause_code}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 2 }}>
              {t('incidentsBoard.since', { when: when(incident.first_seen_at) })} · {t('incidentsBoard.lastSeen', { when: when(incident.last_seen_at) })}
              {' · '}{t('incidentsBoard.affected', { count: incident.affected_contracts })} · {t('incidentsBoard.reported', { count: incident.reports })}
              {incident.reopened_count > 0 ? ` · ${t('incidentsBoard.reopened', { count: incident.reopened_count })}` : ''}
              {incident.status === 'open' && incident.last_good_at && new Date(incident.last_good_at) > new Date(incident.last_seen_at) ? ` · ${t('incidentsBoard.fineNow')}` : ''}
            </div>
            {openId === incident.id && <IncidentDetail id={incident.id} canAct={canAct} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

// =============================================================================
// Reseller app (/punto) — phase 5b: Reportar falla and the signing link
// =============================================================================
//   • ReportFault (client page, reseller_app.tickets): describe the problem;
//     it becomes a ticket of the ISP (POST /reseller-app/tickets), listed
//     with its status (GET /reseller-app/tickets?client_id=).
//   • LeadSigning (Prospectos, reseller_app.signup): where the customer's
//     installation documents stand (GET /reseller-app/leads/:id/signing) and
//     "Enviar liga para firmar": the ISP sends the customer the link by email
//     or SMS to its contact on file (POST .../signing-link). The reseller
//     never sees the link; the customer signs on its own phone.
// =============================================================================

import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '@/api/apiFetch';
import { useMutation } from '@/api/useMutation';
import { ErrorState, LoadingState } from '@/components/FetchStates';
import {
  apiErrorCode, createPuntoTicket, fetchPuntoLeadSigning, fetchPuntoTickets, puntoKeys, sendPuntoSigningLink,
} from './puntoApi';
import { errorText, formatDateTime, mutedText } from './puntoUi';

const sectionTitle = { margin: '0 0 8px', fontSize: '1rem', fontWeight: 700 } as const;
const row = { display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' } as const;
const field = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.9rem' } as const;
const input = { padding: 10, fontSize: '1rem', borderRadius: 8, border: '1px solid var(--border-color, #d1d5db)' } as const;

function serverText(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError && err.status < 500 && err.message ? err.message : fallback;
}

export function ReportFault({ clientId }: { clientId: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const list = useQuery({ queryKey: puntoKeys.tickets(clientId), queryFn: () => fetchPuntoTickets(clientId) });
  const report = useMutation({
    mutationFn: () => createPuntoTicket({ client_id: clientId, subject: subject.trim(), description: description.trim() }),
    onSuccess: () => {
      setSubject(''); setDescription(''); setOpen(false); setSent(true);
      void qc.invalidateQueries({ queryKey: puntoKeys.tickets(clientId) });
    },
    onError: (err: unknown) => setError(apiErrorCode(err) === 'TOO_MANY_TICKETS' ? t('punto.fault.tooMany') : serverText(err, t('punto.fault.error'))),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (subject.trim().length < 3) { setError(t('punto.fault.subjectRequired')); return; }
    if (description.trim().length < 5) { setError(t('punto.fault.descriptionRequired')); return; }
    report.mutate();
  }

  return (
    <section className="punto-card" aria-labelledby="punto-fault-title">
      <h2 id="punto-fault-title" style={sectionTitle}>{t('punto.fault.title')}</h2>
      {sent && <p role="status" style={{ margin: '0 0 8px', color: 'var(--success)' }}>{t('punto.fault.sent')}</p>}
      {!open && (
        <button type="button" className="punto-btn-secondary" onClick={() => { setOpen(true); setSent(false); }}>{t('punto.fault.open')}</button>
      )}
      {open && (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={mutedText}>{t('punto.fault.help')}</p>
          <label style={field}>
            {t('punto.fault.subject')}
            <input style={input} value={subject} maxLength={150} onChange={e => setSubject(e.target.value)} />
          </label>
          <label style={field}>
            {t('punto.fault.description')}
            <textarea style={{ ...input, minHeight: 90 }} value={description} maxLength={2000} onChange={e => setDescription(e.target.value)} />
          </label>
          {error && <p role="alert" style={errorText}>{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="punto-btn-primary" disabled={report.isPending}>{report.isPending ? t('punto.fault.sending') : t('punto.fault.submit')}</button>
            <button type="button" className="punto-btn-secondary" onClick={() => { setOpen(false); setError(''); }}>{t('punto.fault.cancel')}</button>
          </div>
        </form>
      )}
      {list.isLoading && <LoadingState />}
      {list.isError && <ErrorState message={t('punto.fault.loadError')} onRetry={() => { void list.refetch(); }} />}
      {list.data && list.data.data.length > 0 && (
        <ul className="punto-list" style={{ marginTop: 10 }}>
          {list.data.data.map(tk => (
            <li key={tk.id} style={{ ...row, borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{tk.subject}</div>
                <div style={mutedText}>{t('punto.fault.reportedOn', { id: tk.id, date: formatDateTime(tk.created_at) })}</div>
              </div>
              <span style={{ fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
                {t(`punto.fault.status.${tk.status}`, { defaultValue: tk.status })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const SEND_REFUSALS: Record<string, string> = {
  NO_EMAIL: 'punto.signing.noEmail',
  NO_PHONE: 'punto.signing.noPhone',
  ORDER_NOT_SIGNABLE: 'punto.signing.notStarted',
  NO_PENDING_DOCUMENTS: 'punto.signing.nothingPending',
};

export function LeadSigning({ leadId }: { leadId: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const q = useQuery({ queryKey: puntoKeys.leadSigning(leadId), queryFn: () => fetchPuntoLeadSigning(leadId), enabled: open });
  const send = useMutation({
    mutationFn: (channel: 'email' | 'sms') => sendPuntoSigningLink(leadId, channel),
    onSuccess: (r: { link: { destination_masked: string | null }; message: { skipped: boolean; code: string | null } | null }) => {
      setError('');
      setNotice(r.message?.skipped ? t('punto.signing.blocked') : t('punto.signing.sent', { destination: r.link.destination_masked ?? '' }));
      void qc.invalidateQueries({ queryKey: puntoKeys.leadSigning(leadId) });
    },
    onError: (err: unknown) => {
      setNotice('');
      const key = SEND_REFUSALS[apiErrorCode(err) ?? ''];
      setError(key ? t(key) : serverText(err, t('punto.signing.error')));
    },
  });

  if (!open) {
    return <button type="button" className="punto-btn-secondary" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>{t('punto.signing.open')}</button>;
  }
  const s = q.data;
  return (
    <div style={{ marginTop: 8, borderTop: '1px solid var(--border-subtle)', paddingTop: 8 }}>
      <strong style={{ fontSize: '0.9rem' }}>{t('punto.signing.title')}</strong>
      {q.isLoading && <LoadingState />}
      {q.isError && <ErrorState message={t('punto.signing.loadError')} onRetry={() => { void q.refetch(); }} />}
      {s && (
        <>
          <p style={{ ...mutedText, margin: '4px 0' }}>
            {t(`punto.signing.state.${s.state}`, { pending: s.pending_documents, signed: s.signed_documents })}
          </p>
          {s.last_link && (
            <p style={{ ...mutedText, margin: '4px 0' }}>
              {s.last_link.completed_at
                ? t('punto.signing.lastCompleted')
                : t('punto.signing.lastSent', { destination: s.last_link.destination_masked ?? '', date: formatDateTime(s.last_link.created_at) })}
              {!s.last_link.completed_at && s.last_link.opened && ` ${t('punto.signing.opened')}`}
            </p>
          )}
          {s.state === 'pending' && (
            <>
              <p style={{ ...mutedText, margin: '4px 0' }}>{t('punto.signing.help')}</p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="punto-btn-secondary" disabled={send.isPending || !s.contacts?.email} onClick={() => send.mutate('email')}>{t('punto.signing.byEmail')}</button>
                <button type="button" className="punto-btn-secondary" disabled={send.isPending || !s.contacts?.phone} onClick={() => send.mutate('sms')}>{t('punto.signing.bySms')}</button>
              </div>
              {!s.can_send && <p style={{ ...mutedText, margin: '4px 0' }}>{t('punto.signing.noContact')}</p>}
            </>
          )}
        </>
      )}
      {notice && <p role="status" style={{ margin: '6px 0 0', color: 'var(--success)' }}>{notice}</p>}
      {error && <p role="alert" style={errorText}>{error}</p>}
    </div>
  );
}

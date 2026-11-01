// =============================================================================
// VigaBSS 5.0 — Portal Tickets
// =============================================================================
// Lists all support tickets for the authenticated client at /portal/tickets.
// =============================================================================

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { portalAuthedFetch } from '@/auth/PortalAuthContext';

const API_BASE = '/api/v1/portal';

interface Ticket {
  id: number;
  subject: string;
  priority: string;
  category: string | null;
  status: string;
  created_at: string;
}

interface TicketsResponse {
  data: Ticket[];
  meta: { page: number; limit: number; total: number; pages: number };
}

async function fetchPortalTickets(page: number, status: string): Promise<TicketsResponse> {
  const query = new URLSearchParams({ page: String(page), limit: '20' });
  if (status) query.set('status', status);
  const res = await portalAuthedFetch(`${API_BASE}/tickets?${query}`);
  if (!res.ok) throw new Error('Failed to load tickets');
  return res.json() as Promise<TicketsResponse>;
}

async function createTicket(body: { subject: string; description?: string; priority?: string; category?: string }): Promise<Ticket> {
  const res = await portalAuthedFetch(`${API_BASE}/tickets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? '');
  }
  return (await res.json() as { data: Ticket }).data;
}

const PRIORITY_COLORS: Record<string, React.CSSProperties> = {
  low: { background: '#f3f4f6', color: '#6b7280' },
  medium: { background: '#fef3c7', color: '#92400e' },
  high: { background: '#fee2e2', color: '#991b1b' },
  critical: { background: '#4b0082', color: '#fff' },
};

const STATUS_ICONS: Record<string, string> = {
  open: '🟢',
  in_progress: '🔵',
  waiting: '🟡',
  resolved: '✅',
  closed: '⬛',
};
const FILTER_STATUSES = ['open', 'in_progress', 'waiting', 'resolved', 'closed'];
const NEW_TICKET_PRIORITIES = ['low', 'medium', 'high'];

export function PortalTickets() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [showModal, setShowModal] = useState(false);

  // New ticket form state
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [formError, setFormError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ['portal-tickets', page, statusFilter],
    queryFn: () => fetchPortalTickets(page, statusFilter),
  });

  const createMutation = useMutation({
    mutationFn: createTicket,
    onSuccess: ticket => {
      queryClient.invalidateQueries({ queryKey: ['portal-tickets'] });
      setShowModal(false);
      resetForm();
      navigate(`/portal/tickets/${ticket.id}`);
    },
    onError: (err: Error) => setFormError(err.message || t('portalTickets.createFailed')),
  });

  function resetForm() {
    setSubject('');
    setDescription('');
    setPriority('medium');
    setFormError(null);
  }

  const tickets = data?.data ?? [];
  const meta = data?.meta;

  return (
    <div>
      <div style={styles.header}>
        <h1 style={styles.heading}>🎫 {t('portalTickets.title')}</h1>
        <div style={styles.headerActions}>
          <select
            value={statusFilter}
            onChange={e => { setStatusFilter(e.target.value); setPage(1); }}
            style={styles.select}
          >
            <option value="">{t('portalTickets.allStatuses')}</option>
            {FILTER_STATUSES.map(st => <option key={st} value={st}>{t(`portalCommon.ticketStatus.${st}`)}</option>)}
          </select>
          <button onClick={() => setShowModal(true)} style={styles.newBtn}>+ {t('portalTickets.newTicket')}</button>
        </div>
      </div>

      {isLoading && <p style={styles.info}>{t('portalTickets.loading')}</p>}
      {error && <p style={styles.errorTxt}>{t('portalTickets.error')}</p>}

      {!isLoading && tickets.length === 0 && (
        <p style={styles.info}>{t('portalTickets.noTickets')} <button onClick={() => setShowModal(true)} style={styles.inlineBtn}>{t('portalTickets.openOne')} →</button></p>
      )}

      {tickets.length > 0 && (
        <div style={styles.card}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('portalTickets.table.subject')}</th>
                <th style={styles.th}>{t('portalTickets.table.priority')}</th>
                <th style={styles.th}>{t('portalTickets.table.status')}</th>
                <th style={styles.th}>{t('portalTickets.table.created')}</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map(tk => (
                <tr key={tk.id} style={{ cursor: 'pointer' }}>
                  <td style={styles.td}>
                    <Link to={`/portal/tickets/${tk.id}`} style={styles.link}>{tk.subject}</Link>
                  </td>
                  <td style={styles.td}>
                    <span style={{ ...styles.badge, ...(PRIORITY_COLORS[tk.priority] ?? {}) }}>{t(`portalCommon.ticketPriority.${tk.priority}`, { defaultValue: tk.priority })}</span>
                  </td>
                  <td style={styles.td}>{STATUS_ICONS[tk.status] ? `${STATUS_ICONS[tk.status]} ` : ''}{t(`portalCommon.ticketStatus.${tk.status}`, { defaultValue: tk.status })}</td>
                  <td style={styles.td}>{tk.created_at.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {meta && meta.pages > 1 && (
        <div style={styles.pagination}>
          <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} style={styles.pageBtn}>‹ {t('portalCommon.prev')}</button>
          <span style={styles.pageInfo}>{t('portalCommon.pageOf', { page, pages: meta.pages })}</span>
          <button onClick={() => setPage(p => Math.min(meta.pages, p + 1))} disabled={page === meta.pages} style={styles.pageBtn}>{t('portalCommon.next')} ›</button>
        </div>
      )}

      {/* New Ticket Modal */}
      {showModal && (
        <div style={styles.overlay}>
          <div style={styles.modal}>
            <h2 style={styles.modalTitle}>{t('portalTickets.modalTitle')}</h2>
            {formError && <p style={styles.errorTxt}>{formError}</p>}

            <label style={styles.label}>
              {t('portalTickets.table.subject')} *
              <input
                value={subject}
                onChange={e => setSubject(e.target.value)}
                style={styles.input}
                placeholder={t('portalTickets.subjectPlaceholder')}
                maxLength={300}
              />
            </label>

            <label style={styles.label}>
              {t('portalTickets.description')}
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                style={{ ...styles.input, minHeight: 100, resize: 'vertical' as const }}
                placeholder={t('portalTickets.descriptionPlaceholder')}
                maxLength={5000}
              />
            </label>

            <label style={styles.label}>
              {t('portalTickets.table.priority')}
              <select value={priority} onChange={e => setPriority(e.target.value)} style={styles.input}>
                {NEW_TICKET_PRIORITIES.map(pr => <option key={pr} value={pr}>{t(`portalCommon.ticketPriority.${pr}`)}</option>)}
              </select>
            </label>

            <div style={styles.modalActions}>
              <button
                onClick={() => { setShowModal(false); resetForm(); }}
                style={styles.cancelBtn}
              >
                {t('portalTickets.cancel')}
              </button>
              <button
                onClick={() => {
                  if (!subject.trim()) { setFormError(t('portalTickets.subjectRequired')); return; }
                  createMutation.mutate({ subject, description: description || undefined, priority });
                }}
                disabled={createMutation.isPending}
                style={styles.submitBtn}
              >
                {createMutation.isPending ? t('portalTickets.submitting') : t('portalTickets.submit')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem', flexWrap: 'wrap' as const, gap: '0.5rem' },
  heading: { margin: 0, fontSize: '1.4rem', color: 'var(--text-primary)' },
  headerActions: { display: 'flex', gap: '0.5rem', alignItems: 'center' },
  select: { padding: '0.4rem 0.6rem', border: '1px solid var(--input-border)', borderRadius: 4, fontSize: '0.9rem' },
  newBtn: { padding: '0.45rem 1rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem' },
  info: { color: 'var(--text-muted)' },
  errorTxt: { color: '#b91c1c', fontSize: '0.875rem', margin: '0.5rem 0' },
  inlineBtn: { background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontWeight: 600, fontSize: 'inherit', padding: 0 },
  card: { background: 'var(--bg-card)', borderRadius: 8, boxShadow: '0 0 0 1px var(--border)', overflow: 'auto' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem' },
  th: { textAlign: 'left' as const, padding: '0.6rem 0.75rem', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '2px solid var(--border-subtle)' },
  td: { padding: '0.6rem 0.75rem', borderBottom: '1px solid #f9fafb', color: 'var(--text-secondary)' },
  link: { color: 'var(--link)', textDecoration: 'none', fontWeight: 500 },
  badge: { display: 'inline-block', padding: '0.2rem 0.5rem', borderRadius: 12, fontSize: '0.78rem', fontWeight: 600 },
  pagination: { display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '1rem', justifyContent: 'center' },
  pageBtn: { padding: '0.4rem 0.8rem', border: '1px solid var(--border-strong)', borderRadius: 4, cursor: 'pointer', background: 'var(--bg-card)', fontSize: '0.875rem' },
  pageInfo: { color: 'var(--text-muted)', fontSize: '0.875rem' },
  overlay: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modal: { background: 'var(--bg-card)', borderRadius: 8, padding: '1.5rem', width: '100%', maxWidth: 500, boxShadow: '0 8px 32px rgba(0,0,0,.2)', display: 'flex', flexDirection: 'column' as const, gap: '1rem' },
  modalTitle: { margin: 0, fontSize: '1.1rem', color: 'var(--text-primary)' },
  label: { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: '0.875rem', color: 'var(--text-secondary)' },
  input: { padding: '0.5rem 0.75rem', border: '1px solid var(--input-border)', borderRadius: 4, fontSize: '0.9rem', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' as const },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' },
  cancelBtn: { padding: '0.5rem 1rem', border: '1px solid var(--border-strong)', borderRadius: 4, background: 'var(--bg-card)', cursor: 'pointer', fontSize: '0.875rem' },
  submitBtn: { padding: '0.5rem 1.25rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem' },
};

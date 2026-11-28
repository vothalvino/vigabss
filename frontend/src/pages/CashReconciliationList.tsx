// =============================================================================
// VigaBSS 5.0 — Cash Reconciliation (§1.3 Billing+)
// =============================================================================
// The Cashier page: one line per person, with what their drawer holds and a
// dot, green when all is well and red when something needs a look. A line
// opens that person's page (pages/cashier/CashierPersonPage.tsx).
//
// CashierSessionsTable, used by that page, is the table of a person's
// cashiers: expand for the cash payments and pickups, close an open one
// (cash_reconciliation.update), approve or dispute a count that did not match
// (cash_reconciliation.approve).
// =============================================================================

import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { unwrapList } from '@/api/envelope';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { CashierReviewDialog, type CashierDecision } from '@/pages/cashier/CashierReviewDialog';
import { CashierOpenDialog } from '@/pages/cashier/CashierOpenDialog';
import { CashierPickupsRow } from '@/pages/cashier/CashierPickups';
import { CashierRulesBox } from '@/pages/cashier/CashierRulesBox';
import { CASHIER_ATTENTION_KEY, CASHIER_STAFF_KEY, MY_CASHIER_KEY } from '@/components/cashierReminderData';
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
} from '@/components/ClientFormModal';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconciliationSession {
  id: number;
  agent_user_id: number;
  status: string;
  opened_at: string;
  closed_at: string | null;
  expected_total: string | null;
  counted_total: string | null;
  variance: string | null;
  notes: string | null;
  approved_by?: number | null;
  review_note?: string | null;
  /** Who owns the cashier and who reviewed it, by name. */
  agent_name?: string | null;
  approved_by_name?: string | null;
  /** The cash counted when opening, and what the drawer should have held. */
  opening_total?: string | null;
  opening_expected?: string | null;
  pickups_total?: string | null;
}

/** One person's line, from GET /cash-reconciliation/staff. */
export type CashierReason = 'closing_difference' | 'opening_difference' | 'over_limit' | 'open_too_long';
export interface CashierPerson {
  user_id: number;
  name: string | null;
  open: boolean;
  /** Live for an open cashier; the last count for a closed one; null when never counted. */
  cash_on_hand: number | null;
  last_session_id: number;
  last_closed_at: string | null;
  current: {
    session_id: number; opened_at: string; hours_open: number;
    opening_total: number; opening_expected: number | null; opening_difference: number;
    collected_total: number; pickups_total: number; pending_pickups: number; pending_pickups_total: number;
  } | null;
  awaiting_review: number;
  disputed: number;
  status: 'ok' | 'mismatch';
  reasons: CashierReason[];
}

interface CashPayment {
  id: number;
  client_id: number;
  amount: string;
  payment_date: string | null;
  reference_number: string | null;
}

interface SessionDetail {
  id: number;
  payments: CashPayment[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DATE_TIME: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };

// The same date and money formats as the rest of the page.
function fmt(dateStr: string | null | undefined): string {
  return formatDate(dateStr, DATE_TIME);
}

function fmtAmount(amount: string | null | undefined): string {
  return formatMoney(amount);
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

function SessionStatusBadge({ status, automatic = false }: { status: string; automatic?: boolean }) {
  const { t } = useTranslation();
  const map: Record<string, { bg: string; color: string }> = {
    open:     { bg: 'var(--info-soft)', color: 'var(--info)' },
    closed:   { bg: 'var(--warning-soft)', color: 'var(--warning)' },
    approved: { bg: 'var(--success-soft)', color: 'var(--success)' },
    disputed: { bg: 'var(--danger-soft)', color: 'var(--danger)' },
  };
  const s = map[status] ?? { bg: 'var(--bg-subtle)', color: 'var(--text-secondary)' };
  return (
    <span style={{ background: s.bg, color: s.color, padding: '2px 8px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 600, textTransform: 'capitalize' }}>
      {automatic ? t('cashReconciliation.status.approvedAuto') : t(`cashReconciliation.status.${status}`, status)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Close Session Modal
// ---------------------------------------------------------------------------

function CloseSessionModal({
  sessionId,
  onClose,
  onClosed,
}: {
  sessionId: number;
  onClose: () => void;
  onClosed: () => void;
}) {
  const { t } = useTranslation();
  const [countedTotal, setCountedTotal] = useState('');
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: e } = await api.POST(
        '/cash-reconciliation/sessions/{id}/close',
        { params: { path: { id: sessionId } }, body: { counted_total: parseFloat(countedTotal) } },
      );
      if (e) throw new Error(extractApiError(e, 'Failed to close session'));
    },
    onSuccess: () => { onClosed(); onClose(); },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Failed to close session'),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const n = parseFloat(countedTotal);
    if (!countedTotal || Number.isNaN(n)) { setError('Enter a valid counted total.'); return; }
    setError('');
    mutation.mutate();
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={t('cashReconciliation.close')}>
      <div style={{ ...modalBox, width: 400 }}>
        <h3 style={{ margin: '0 0 1rem' }}>{t('cashReconciliation.close')}</h3>
        {error && <div style={errorBox}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <label style={labelStyle}>{t('cashReconciliation.countedTotal')} *</label>
          <input style={inputStyle} type="number" min={0} step={0.01} value={countedTotal} required autoFocus
            onChange={e => setCountedTotal(e.target.value)} />
          <div style={{ display: 'flex', gap: 8, marginTop: '1.25rem', justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={cancelBtn}>{t('common.cancel')}</button>
            <button type="submit" style={submitBtn} disabled={mutation.isPending}>
              {mutation.isPending ? t('common.saving') : t('cashReconciliation.close')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cash Payments (inline expand)
// ---------------------------------------------------------------------------

function CashPaymentsRow({ sessionId, colSpan }: { sessionId: number; colSpan: number }) {
  const { t } = useTranslation();

  const { data, isLoading, error } = useQuery({
    queryKey: ['cash-session-detail', sessionId],
    queryFn: async () => {
      const res = await api.GET(
        '/cash-reconciliation/sessions/{id}',
        { params: { path: { id: sessionId } } },
      );
      if (res.error) throw new Error('Failed to load session detail');
      return (res.data as { data: SessionDetail }).data;
    },
  });

  const payments = data?.payments ?? [];

  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: '8px 20px 12px', background: 'var(--bg-subtle)' }}>
        {isLoading && <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)' }}>{t('common.loading')}</p>}
        {error && <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--danger)' }}>{t('ui.cashReconciliationList.failedToLoadPayments')}</p>}
        {!isLoading && !error && (
          <>
            <p style={{ margin: '0 0 8px', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
              {t('cashReconciliation.cashPayments')}
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr>
                  {['ID', 'Client ID', 'Amount', 'Date', 'Reference'].map(h => (
                    <th key={h} style={{ textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {payments.length === 0 && (
                  <tr><td colSpan={5} style={{ padding: '8px', color: 'var(--text-muted)' }}>{t('ui.cashReconciliationList.noCashPaymentsInThis')}</td></tr>
                )}
                {payments.map(p => (
                  <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '4px 8px' }}>#{p.id}</td>
                    <td style={{ padding: '4px 8px' }}>{p.client_id}</td>
                    <td style={{ padding: '4px 8px', fontVariantNumeric: 'tabular-nums' }}>{fmtAmount(p.amount)}</td>
                    <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>{fmt(p.payment_date)}</td>
                    <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>{p.reference_number || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// The dot: green when all is well, red when something needs a look
// ---------------------------------------------------------------------------

export function CashierStatusDot({ status }: { status: 'ok' | 'mismatch' }) {
  const { t } = useTranslation();
  const label = t(`cashierStaff.dot.${status}`);
  return (
    <span role="img" aria-label={label} title={label} data-status={status}
      style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: status === 'ok' ? 'var(--success)' : 'var(--danger)' }} />
  );
}

/** What is wrong, in words; nothing when all is well. */
export function CashierReasons({ person }: { person: CashierPerson }) {
  const { t } = useTranslation();
  if (!person.reasons.length) return <span style={{ color: 'var(--text-muted)' }}>{t('cashierStaff.allGood')}</span>;
  return (
    <span style={{ color: 'var(--danger)' }}>
      {person.reasons.map((reason) => t(`cashierStaff.reasons.${reason}`, {
        count: person.awaiting_review + person.disputed,
        amount: formatMoney(person.current?.opening_difference ?? 0),
        hours: person.current?.hours_open ?? 0,
      })).join(' · ')}
    </span>
  );
}

// ---------------------------------------------------------------------------
// A person's cashiers
// ---------------------------------------------------------------------------

export function CashierSessionsTable({ sessions, onChanged }: { sessions: ReconciliationSession[]; onChanged: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [closingId, setClosingId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const canUpdate = can(user, 'cash_reconciliation.update');
  const canApprove = can(user, 'cash_reconciliation.approve');

  // A count that did not match waits here for a supervisor's decision.
  const [review, setReview] = useState<{ id: number; decision: CashierDecision; variance: string | null } | null>(null);

  const COLS = [
    t('cashReconciliation.columns.id'),
    t('cashReconciliation.columns.agent'),
    t('cashReconciliation.columns.status'),
    t('cashReconciliation.columns.openedAt'),
    t('cashReconciliation.columns.closedAt'),
    t('cashReconciliation.columns.expected'),
    t('cashReconciliation.columns.counted'),
    t('cashReconciliation.columns.variance'),
    '',
  ];

  if (sessions.length === 0) return <p style={styles.msg}>{t('ui.cashReconciliationList.noSessionsFound')}</p>;

  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={styles.table}>
          <thead>
            <tr>{COLS.map((h, i) => <th key={i} style={styles.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
                  {sessions.map(session => {
                    const variance = session.variance != null ? parseFloat(session.variance) : null;
                    const varianceColor = variance == null ? 'var(--text-secondary)' : variance < 0 ? 'var(--danger)' : 'var(--success)';

                    return (
                      <React.Fragment key={session.id}>
                        <tr
                          style={{ ...styles.tr, cursor: 'pointer' }}
                          onClick={() => setExpandedId(expandedId === session.id ? null : session.id)}
                        >
                          <td style={styles.td}>#{session.id}</td>
                          <td style={styles.td}>
                            {session.agent_name
                              ? <>{session.agent_name} <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>#{session.agent_user_id}</span></>
                              : <>#{session.agent_user_id}</>}
                          </td>
                          <td style={styles.td}>
                            <SessionStatusBadge status={session.status} automatic={session.status === 'approved' && (session.approved_by === null || session.approved_by === undefined)} />
                          </td>
                          <td style={{ ...styles.td, color: 'var(--text-muted)' }}>{fmt(session.opened_at)}</td>
                          <td style={{ ...styles.td, color: 'var(--text-muted)' }}>{fmt(session.closed_at)}</td>
                          <td style={{ ...styles.td, fontVariantNumeric: 'tabular-nums' }}>{fmtAmount(session.expected_total)}</td>
                          <td style={{ ...styles.td, fontVariantNumeric: 'tabular-nums' }}>{fmtAmount(session.counted_total)}</td>
                          <td style={{ ...styles.td, fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: varianceColor }}>
                            {variance != null ? fmtAmount(session.variance) : '—'}
                          </td>
                          <td style={{ ...styles.td, whiteSpace: 'nowrap' }} onClick={e => e.stopPropagation()}>
                            {canUpdate && session.status === 'open' && (
                              <button
                                type="button"
                                style={{ padding: '3px 10px', background: 'var(--warning-soft)', color: 'var(--warning)', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600, marginRight: 6 }}
                                onClick={() => setClosingId(session.id)}
                              >
                                {t('cashReconciliation.close')}
                              </button>
                            )}
                            {canApprove && ['closed', 'disputed'].includes(session.status) && (
                              // Nobody reviews their own cashier, except the company's admin (the owner).
                              Number(session.agent_user_id) === Number(user?.id) && user?.role !== 'admin' ? (
                                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('cashReconciliation.review.ownCashier')}</span>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    style={{ padding: '3px 10px', background: 'var(--success-soft)', color: 'var(--success)', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600, marginRight: 6 }}
                                    onClick={() => setReview({ id: session.id, decision: 'approve', variance: session.variance })}
                                  >
                                    {t('cashReconciliation.approve')}
                                  </button>
                                  {session.status === 'closed' && (
                                    <button
                                      type="button"
                                      style={{ padding: '3px 10px', background: 'var(--danger-soft)', color: 'var(--danger)', border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: '0.75rem', fontWeight: 600 }}
                                      onClick={() => setReview({ id: session.id, decision: 'dispute', variance: session.variance })}
                                    >
                                      {t('cashReconciliation.dispute')}
                                    </button>
                                  )}
                                </>
                              )
                            )}
                          </td>
                        </tr>
                        {expandedId === session.id && session.review_note && (
                          <tr>
                            <td colSpan={COLS.length} style={{ padding: '8px 20px 0', background: 'var(--bg-subtle)', fontSize: '0.82rem' }}>
                              <strong>{t('cashReconciliation.review.noteShown')}</strong> {session.review_note}
                              {session.approved_by_name && <span style={{ color: 'var(--text-muted)' }}> — {session.approved_by_name}</span>}
                              {session.approved_by != null && Number(session.approved_by) === Number(session.agent_user_id) && (
                                <span style={{ color: 'var(--warning)', fontWeight: 600 }}> · {t('cashReconciliation.review.selfReviewed')}</span>
                              )}
                            </td>
                          </tr>
                        )}
                        {expandedId === session.id && (
                          <CashierPickupsRow
                            session={session}
                            colSpan={COLS.length}
                            userId={user?.id ?? null}
                            canTake={canApprove && (Number(session.agent_user_id) !== Number(user?.id) || user?.role === 'admin')}
                          />
                        )}
                        {expandedId === session.id && (
                          <CashPaymentsRow sessionId={session.id} colSpan={COLS.length} />
                        )}
                      </React.Fragment>
                    );
                  })}
          </tbody>
        </table>
      </div>

      {closingId !== null && (
        <CloseSessionModal
          sessionId={closingId}
          onClose={() => setClosingId(null)}
          onClosed={onChanged}
        />
      )}
      {review && (
        <CashierReviewDialog
          sessionId={review.id}
          decision={review.decision}
          variance={review.variance}
          onClose={() => setReview(null)}
          onDone={() => { setReview(null); onChanged(); }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// CashReconciliationList: one line per person
// ---------------------------------------------------------------------------

export function CashReconciliationList() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [showOpen, setShowOpen] = useState(false);

  const canCreate = can(user, 'cash_reconciliation.create');
  const canApprove = can(user, 'cash_reconciliation.approve');

  const { data: people = [], isLoading, isError } = useQuery({
    queryKey: [...CASHIER_STAFF_KEY, 'list'],
    queryFn: async () => {
      const res = await api.GET('/cash-reconciliation/staff');
      if (res.error) throw new Error('Failed to load cashiers');
      return unwrapList<CashierPerson>(res.data);
    },
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: CASHIER_STAFF_KEY });
    void qc.invalidateQueries({ queryKey: MY_CASHIER_KEY });
    void qc.invalidateQueries({ queryKey: CASHIER_ATTENTION_KEY });
  };

  const mine = people.find((p) => p.user_id === Number(user?.id));
  const needLook = people.filter((p) => p.status === 'mismatch').length;

  const COLS = ['', t('cashierStaff.columns.person'), t('cashierStaff.columns.cashier'), t('cashierStaff.columns.cash'), t('cashierStaff.columns.look'), ''];

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('cashReconciliation.title')}</h1>
        {people.length > 0 && (
          <span style={styles.countBadge}>
            {needLook > 0 ? t('cashierStaff.needLook', { count: needLook }) : t('cashierStaff.allGood')}
          </span>
        )}
        {canCreate && !mine?.open && (
          <button type="button" style={{ ...styles.btnPrimary, marginLeft: 'auto' }}
            onClick={() => setShowOpen(true)}>
            + {t('cashReconciliation.openSession')}
          </button>
        )}
      </div>

      <CashierRulesBox canEdit={canApprove} />

      <div style={styles.tableCard}>
        {isLoading ? (
          <p style={styles.msg}>{t('common.loading')}</p>
        ) : isError ? (
          <p style={styles.msgError}>{t('ui.cashReconciliationList.failedToLoadReconciliationSessions')}</p>
        ) : people.length === 0 ? (
          <p style={styles.msg}>{t('cashierStaff.nobody')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={styles.table}>
              <thead>
                <tr>{COLS.map((h, i) => <th key={i} style={styles.th}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {people.map((person) => (
                  <tr key={person.user_id} style={styles.tr} data-testid={`cashier-person-${person.user_id}`}>
                    <td style={{ ...styles.td, width: 24 }}><CashierStatusDot status={person.status} /></td>
                    <td style={styles.td}>
                      <Link to={`/cash-reconciliation/staff/${person.user_id}`} style={{ fontWeight: 600 }}>
                        {person.name || `#${person.user_id}`}
                      </Link>
                    </td>
                    <td style={{ ...styles.td, color: 'var(--text-muted)' }}>
                      {person.open
                        ? t('cashierStaff.openSince', { when: formatDate(person.current?.opened_at, DATE_TIME) })
                        : t('cashierStaff.closedAt', { when: formatDate(person.last_closed_at, DATE_TIME) })}
                    </td>
                    <td style={{ ...styles.td, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{formatMoney(person.cash_on_hand)}</td>
                    <td style={styles.td}><CashierReasons person={person} /></td>
                    <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                      <Link to={`/cash-reconciliation/staff/${person.user_id}`}>{t('cashierStaff.view')}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showOpen && <CashierOpenDialog onClose={() => setShowOpen(false)} onOpened={refresh} />}
    </div>
  );
}

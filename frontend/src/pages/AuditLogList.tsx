// =============================================================================
// VigaBSS 5.0 — Audit Log Viewer
// =============================================================================
// Standalone read-only page at /audit-logs. Lists audit trail entries with
// filters (action or category, user, date range) and pagination. The action
// filter lists the actions that actually occur in the scope (GET
// /audit-logs/actions), grouped by category (src/utils/auditActions.js on the
// server); a label comes from auditLogs.actions.<action>, or is built from the
// action itself when nobody translated it yet. Data is fetched through
// the typed `api` client + React Query. Audit logs are immutable, so there are
// no create/edit/delete actions.
// =============================================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { styles, fmtDate } from './crudStyles';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AuditLog {
  id: number;
  user_id: number | null;
  action: string;
  entity_type: string;
  entity_id: number | null;
  summary: string | null;
  ip_address: string | null;
  new_values?: Record<string, unknown> | string | null;
  created_at: string;
}

interface ActionEntry {
  action: string;
  category: string;
  count: number;
}

interface AuditLogsResponse {
  data: AuditLog[];
  meta: { total: number; page: number; limit: number };
}

interface Filters {
  /** An action, or `category:<name>` for every action of a category. */
  action: string;
  user_id: string;
  date_from: string;
  date_to: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 50;
const CATEGORY_PREFIX = 'category:';

// Badge colours by category (the server decides the category).
const CATEGORY_STYLE: Record<string, { bg: string; color: string }> = {
  records: { bg: '#dbeafe', color: '#1e40af' },
  sign_in: { bg: '#ede9fe', color: '#5b21b6' },
  security: { bg: '#fee2e2', color: '#991b1b' },
  billing: { bg: '#d1fae5', color: '#065f46' },
  resellers: { bg: '#fef3c7', color: '#92400e' },
  cash_bags: { bg: '#ffedd5', color: '#9a3412' },
  service: { bg: '#cffafe', color: '#155e75' },
  network: { bg: '#e0e7ff', color: '#3730a3' },
  compliance: { bg: '#fce7f3', color: '#9d174d' },
  data: { bg: '#fef9c3', color: '#854d0e' },
  other: { bg: '#f3f4f6', color: '#374151' },
};
// Failures stand out whatever their category.
const ALERT_ACTIONS = new Set([
  'login_failed', 'login_mfa_failed', 'account_locked', 'portal_login_failed', 'portal_account_locked',
  'login_ip_auto_blocked', 'login_ip_blocked',
]);

/** "cash_bag_seal" -> "Cash bag seal", "transition:done" -> "Transition: done". */
export function humanizeAction(action: string): string {
  const text = action.replace(/:/g, ': ').replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : action;
}

/** The IP of an entry: the column, or a sign-in event's new_values.ip. */
function entryIp(l: AuditLog): string | null {
  if (l.ip_address) return l.ip_address;
  let values = l.new_values;
  if (typeof values === 'string') {
    try { values = JSON.parse(values) as Record<string, unknown>; } catch { values = null; }
  }
  const ip = values && typeof values === 'object' ? values.ip : null;
  return typeof ip === 'string' && ip ? ip : null;
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

type Scope = 'organization' | 'install';

interface ChainVerification {
  intact: boolean;
  checked: number;
  last_seq: number;
  unchained: number;
  problems: { id: number | null; chain_seq: number; problem: string }[];
}

async function fetchAuditLogs(page: number, filters: Filters, scope: Scope): Promise<AuditLogsResponse> {
  const query: Record<string, string | number> = { page, limit: DEFAULT_PAGE_SIZE };
  if (scope === 'install') query.scope = 'install';
  if (filters.action.startsWith(CATEGORY_PREFIX)) query.category = filters.action.slice(CATEGORY_PREFIX.length);
  else if (filters.action) query.action = filters.action;
  if (filters.user_id) query.user_id = filters.user_id;
  if (filters.date_from) query.date_from = filters.date_from;
  if (filters.date_to) query.date_to = filters.date_to;
  const res = await api.GET('/audit-logs', { params: { query: query } });
  if (res.error) throw new Error('Failed to load audit logs');
  return res.data as unknown as AuditLogsResponse;
}

async function fetchActions(scope: Scope): Promise<ActionEntry[]> {
  const res = await api.GET('/audit-logs/actions', { params: { query: { scope } } });
  if (res.error || !res.data) throw new Error('Failed to load audit actions');
  return res.data.data;
}

// ASY-38: recompute the hash chain the database keeps over the audit rows.
async function verifyChain(scope: Scope): Promise<ChainVerification> {
  const res = await api.GET('/audit-logs/verify', { params: { query: { scope } } });
  if (res.error || !res.data) throw new Error('Failed to verify the audit log');
  return res.data.data;
}

// ---------------------------------------------------------------------------
// Action badge
// ---------------------------------------------------------------------------

function ActionBadge({ action, category, label }: { action: string; category: string; label: string }) {
  const s = ALERT_ACTIONS.has(action) ? CATEGORY_STYLE.security : (CATEGORY_STYLE[category] ?? CATEGORY_STYLE.other);
  return (
    <span
      title={action}
      data-category={category}
      style={{
        background: s.bg,
        color: s.color,
        padding: '2px 8px',
        borderRadius: 12,
        fontSize: '0.72rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// AuditLogList component
// ---------------------------------------------------------------------------

const EMPTY_FILTERS: Filters = { action: '', user_id: '', date_from: '', date_to: '' };

export function AuditLogList() {
  const { t } = useTranslation();
  const { user } = useAuth();
  // Events with no organization are visible to the install operator only
  // (the backend 403s everyone else).
  const isOperator = user?.is_install_operator === true;
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [scope, setScope] = useState<Scope>('organization');

  const logsQ = useQuery({
    queryKey: ['audit-logs', page, filters, scope],
    queryFn: () => fetchAuditLogs(page, filters, scope),
  });
  const actionsQ = useQuery({
    queryKey: ['audit-log-actions', scope],
    queryFn: () => fetchActions(scope),
    staleTime: 60_000,
  });
  const verify = useMutation({ mutationFn: () => verifyChain(scope) });

  // ':' and '.' would split an i18next key (transition:done), so they become '_'.
  const actionLabel = (action: string) => t(`auditLogs.actions.${action.replace(/[:.]/g, '_')}`, { defaultValue: humanizeAction(action) });
  const categoryLabel = (category: string) => t(`auditLogs.categories.${category}`, { defaultValue: humanizeAction(category) });
  const actionEntries = (actionsQ.data ?? [])
    .filter(a => typeof a?.action === 'string' && a.action !== '')
    .map(a => ({ ...a, category: a.category || 'other' }));
  const categoryOfAction = new Map(actionEntries.map(a => [a.action, a.category]));
  // Category order as the server lists them; actions by label within each.
  const grouped: { category: string; actions: ActionEntry[] }[] = [];
  for (const entry of actionEntries) {
    let group = grouped.find(g => g.category === entry.category);
    if (!group) { group = { category: entry.category, actions: [] }; grouped.push(group); }
    group.actions.push(entry);
  }
  for (const g of grouped) g.actions.sort((a, b) => actionLabel(a.action).localeCompare(actionLabel(b.action)));
  grouped.sort((a, b) => categoryLabel(a.category).localeCompare(categoryLabel(b.category)));

  function changeScope(next: Scope) {
    setScope(next);
    setPage(1);
    // The other scope has its own actions.
    setFilters(prev => ({ ...prev, action: '' }));
    verify.reset();
  }

  function setFilter(name: keyof Filters, value: string) {
    setFilters(prev => ({ ...prev, [name]: value }));
    setPage(1);
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    setPage(1);
  }

  const logs = logsQ.data?.data ?? [];
  const meta = logsQ.data?.meta;
  const totalPages = meta ? Math.max(1, Math.ceil(meta.total / meta.limit)) : 1;
  const hasFilters = Boolean(filters.action || filters.user_id || filters.date_from || filters.date_to);

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('ui.auditLogList.auditLogs')}</h1>
        {meta && <span style={styles.countBadge}>{meta.total} {t('ui.auditLogList.total')}</span>}
        <button type="button" style={styles.btnSecondary} disabled={verify.isPending} onClick={() => verify.mutate()}>
          {verify.isPending ? t('auditLogs.verifying') : t('auditLogs.verify')}
        </button>
      </div>

      {isOperator && (
        <label style={{ ...styles.filterLabel, display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={scope === 'install'}
            onChange={e => changeScope(e.target.checked ? 'install' : 'organization')}
          />
          {t('auditLogs.installScope')}
        </label>
      )}

      {verify.isError && <p role="alert" style={styles.msgError}>{t('auditLogs.verifyFailed')}</p>}
      {verify.data && (
        <div role="status" style={verify.data.intact ? styles.msg : styles.msgError}>
          {verify.data.intact
            ? t('auditLogs.intact', { count: verify.data.checked })
            : t('auditLogs.broken', { count: verify.data.problems.length })}
          {verify.data.unchained > 0 && ` ${t('auditLogs.unchained', { count: verify.data.unchained })}`}
          {!verify.data.intact && (
            <ul>
              {verify.data.problems.map(p => (
                <li key={`${p.chain_seq}-${p.problem}`}>
                  {p.id != null ? `#${p.id} ` : ''}({t('auditLogs.position', { seq: p.chain_seq })}): {p.problem}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div style={{ ...styles.filterRow, flexWrap: 'wrap' }}>
        <label style={styles.filterLabel}>{t('ui.auditLogList.action')}</label>
        <select
          style={styles.filterSelect}
          value={filters.action}
          onChange={e => setFilter('action', e.target.value)}
        >
          <option value="">{t('ui.auditLogList.all')}</option>
          {grouped.map(g => (
            <optgroup key={g.category} label={categoryLabel(g.category)}>
              <option value={`${CATEGORY_PREFIX}${g.category}`}>
                {t('auditLogs.allInCategory', { category: categoryLabel(g.category) })}
              </option>
              {g.actions.map(a => (
                <option key={a.action} value={a.action}>{`${actionLabel(a.action)} (${a.count})`}</option>
              ))}
            </optgroup>
          ))}
        </select>

        <label style={styles.filterLabel}>{t('ui.auditLogList.userId')}</label>
        <input
          style={{ ...styles.filterSelect, width: 90 }}
          type="number"
          min={1}
          value={filters.user_id}
          onChange={e => setFilter('user_id', e.target.value)}
          placeholder={t('ui.auditLogList.any')}
        />

        <label style={styles.filterLabel}>{t('ui.auditLogList.from')}</label>
        <input
          style={styles.filterSelect}
          type="date"
          value={filters.date_from}
          onChange={e => setFilter('date_from', e.target.value)}
        />

        <label style={styles.filterLabel}>{t('ui.auditLogList.to')}</label>
        <input
          style={styles.filterSelect}
          type="date"
          value={filters.date_to}
          onChange={e => setFilter('date_to', e.target.value)}
        />

        {hasFilters && (
          <button type="button" style={styles.btnSecondary} onClick={clearFilters}>
            {t('ui.auditLogList.clearFilters')}
          </button>
        )}
      </div>

      <div style={styles.tableCard}>
        {logsQ.isLoading ? (
          <p style={styles.msg}>{t('ui.auditLogList.loading')}</p>
        ) : logsQ.error ? (
          <p style={styles.msgError}>{t('ui.auditLogList.failedToLoadAuditLogs')}</p>
        ) : logs.length === 0 ? (
          <p style={styles.msg}>{t('ui.auditLogList.noAuditLogEntriesFound')}{hasFilters ? ' for the selected filters' : ''}.</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {['Time', 'User', 'Action', 'Entity', 'Entity ID', 'Summary', 'IP'].map(
                      h => <th key={h} style={styles.th}>{h}</th>,
                    )}
                  </tr>
                </thead>
                <tbody>
                  {logs.map(l => (
                    <tr key={l.id} style={styles.tr}>
                      <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>{fmtDate(l.created_at)}</td>
                      <td style={styles.td}>{l.user_id != null ? `#${l.user_id}` : 'System'}</td>
                      <td style={styles.td}>
                        <ActionBadge action={l.action} category={categoryOfAction.get(l.action) ?? 'other'} label={actionLabel(l.action)} />
                      </td>
                      <td style={styles.td}>{l.entity_type}</td>
                      <td style={styles.td}>{l.entity_id != null ? `#${l.entity_id}` : '—'}</td>
                      <td style={{ ...styles.td, maxWidth: 320, overflowWrap: 'anywhere' }}>{l.summary ?? '—'}</td>
                      <td style={styles.td}>{entryIp(l) ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div style={styles.pagination}>
                <button style={styles.pageBtn} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                  {t('ui.auditLogList.prev')}
                </button>
                <span style={styles.pageInfo}>{t('ui.auditLogList.page')}{page} {t('ui.auditLogList.of')}{totalPages}</span>
                <button
                  style={styles.pageBtn}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  {t('ui.auditLogList.next')}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

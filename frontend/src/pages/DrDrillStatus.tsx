// =============================================================================
// VigaBSS 5.0 — Disaster-Recovery Drill Status
// =============================================================================
// Admin page at /dr-drill. Read-only view of the latest automated DR drill
// result via GET /dr-drill/status: when it last ran, whether it passed, how
// many days have elapsed, and whether a new drill is overdue (> 90 days or the
// last run did not pass) — plus the full DR runbook document (served by
// GET /dr-drill/runbook; this page is where the DrDrillBanner modal's
// "Open DR runbook" link lands). Data is fetched through the typed `api`
// client + React Query and can be refreshed on demand. This is a status view,
// so there are no mutations.
// =============================================================================

import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { styles, fmtDate } from './crudStyles';
import { useTranslation } from 'react-i18next';

// Markdown renderer loads only on this page (own chunk), not with the app shell.
const MarkdownView = lazy(() => import('@/components/MarkdownView'));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DrDrillStatus {
  last_run_at: string | null;
  status: string | null;
  days_since_drill: number | null;
  overdue: boolean;
  last_error: string | null;
  /** A drill started by hand is still going. */
  running?: boolean;
  duration_ms?: number | null;
  backup_size_bytes?: number | null;
  /** Whether the backup was restored into a scratch database and checked. */
  restore?: {
    performed: boolean; ok: boolean | null; reason: string | null; restore_ms: number | null;
    tables_live: number | null; tables_restored: number | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function fetchStatus(): Promise<DrDrillStatus> {
  const res = await api.GET('/dr-drill/status', {});
  if (res.error) throw new Error('Failed to load DR drill status');
  return (res.data as unknown as { data: DrDrillStatus }).data;
}

async function fetchRunbook(): Promise<string> {
  const res = await api.GET('/dr-drill/runbook', {});
  if (res.error) throw new Error('Failed to load DR runbook');
  return (res.data as unknown as { data: { markdown: string } }).data.markdown;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function ResultBadge({ status }: { status: string | null }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    pass: { bg: 'var(--success-soft)', color: 'var(--success)', label: 'Pass' },
    fail: { bg: 'var(--danger-soft)', color: 'var(--danger)', label: 'Fail' },
    error: { bg: 'var(--warning-soft)', color: 'var(--warning)', label: 'Error' },
  };
  const s = map[status ?? ''] ?? { bg: 'var(--bg-subtle)', color: 'var(--text-secondary)', label: status ?? 'Never run' };
  return (
    <span style={{ background: s.bg, color: s.color, padding: '2px 10px', borderRadius: 12, fontSize: '0.78rem', fontWeight: 600 }}>
      {s.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// DrDrillStatus component
// ---------------------------------------------------------------------------

export function DrDrillStatus() {
  const { t } = useTranslation();
  const statusQ = useQuery({
    queryKey: ['dr-drill-status'],
    queryFn: fetchStatus,
    // While a drill runs, ask again every few seconds until it is done.
    refetchInterval: (query) => (query.state.data?.running ? 3000 : false),
  });
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  async function runNow() {
    if (!window.confirm(t('drDrillRun.confirm'))) return;
    setStarting(true);
    setRunError(null);
    const res = await api.POST('/dr-drill/run', {});
    setStarting(false);
    const failure: unknown = res.error;
    if (failure) {
      const message = (failure as { error?: { message?: string } }).error?.message;
      setRunError(message || t('drDrillRun.failed'));
      return;
    }
    void statusQ.refetch();
  }

  // The runbook document only changes with a code deploy — cache it long.
  const runbookQ = useQuery({
    queryKey: ['dr-drill-runbook'],
    queryFn: fetchRunbook,
    staleTime: 60 * 60 * 1000,
  });

  const status = statusQ.data;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('ui.drDrillStatus.disasterRecoveryDrill')}</h1>
        {status && (
          <span style={{ ...styles.countBadge, ...(status.overdue ? { background: 'var(--danger-soft)', color: 'var(--danger)' } : { background: 'var(--success-soft)', color: 'var(--success)' }) }}>
            {status.overdue ? 'Overdue' : 'Up to date'}
          </span>
        )}
        <button
          type="button"
          style={{ ...styles.btnPrimary, marginLeft: 'auto' }}
          onClick={() => void runNow()}
          disabled={starting || Boolean(status?.running)}
        >
          {status?.running ? t('drDrillRun.running') : t('drDrillRun.runNow')}
        </button>
        <button
          style={styles.btnSecondary}
          onClick={() => statusQ.refetch()}
          disabled={statusQ.isFetching}
        >
          {statusQ.isFetching ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: 'var(--text-secondary)', maxWidth: 720 }}>
        {t('drDrillRun.what')}
      </p>
      {status?.running && <p role="status" style={{ margin: '0 0 1rem', fontSize: '0.9rem' }}>{t('drDrillRun.inProgress')}</p>}
      {runError && <p role="alert" style={{ ...styles.msgError, textAlign: 'left', padding: 0, margin: '0 0 1rem' }}>{runError}</p>}

      <div style={styles.tableCard}>
        {statusQ.isLoading ? (
          <p style={styles.msg}>{t('ui.drDrillStatus.loading')}</p>
        ) : statusQ.error ? (
          <p style={styles.msgError}>{t('ui.drDrillStatus.failedToLoadDrDrill')}</p>
        ) : !status || status.last_run_at === null ? (
          <p style={styles.msg}>{t('ui.drDrillStatus.noDrillHasBeenRun')}</p>
        ) : (
          <table style={styles.table}>
            <tbody>
              <tr style={styles.tr}>
                <td style={{ ...styles.td, fontWeight: 500, width: 220 }}>{t('ui.drDrillStatus.lastResult')}</td>
                <td style={styles.td}><ResultBadge status={status.status} /></td>
              </tr>
              <tr style={styles.tr}>
                <td style={{ ...styles.td, fontWeight: 500 }}>{t('ui.drDrillStatus.lastRun')}</td>
                <td style={styles.td}>{fmtDate(status.last_run_at)}</td>
              </tr>
              <tr style={styles.tr}>
                <td style={{ ...styles.td, fontWeight: 500 }}>{t('ui.drDrillStatus.daysSinceDrill')}</td>
                <td style={styles.td}>{status.days_since_drill ?? '—'}</td>
              </tr>
              <tr style={styles.tr}>
                <td style={{ ...styles.td, fontWeight: 500 }}>{t('ui.drDrillStatus.overdue')}</td>
                <td style={{ ...styles.td, color: status.overdue ? 'var(--danger)' : 'var(--success)', fontWeight: 600 }}>
                  {status.overdue ? 'Yes' : 'No'}
                </td>
              </tr>
              <tr style={styles.tr}>
                <td style={{ ...styles.td, fontWeight: 500 }}>{t('drDrillRun.restoreTest')}</td>
                <td style={{ ...styles.td, color: status.restore?.performed ? (status.restore.ok ? 'var(--success)' : 'var(--danger)') : 'var(--warning)', fontWeight: 600 }}>
                  {!status.restore
                    ? t('drDrillRun.restoreNone')
                    : !status.restore.performed
                      ? t('drDrillRun.restoreSkipped')
                      : status.restore.ok
                        ? t('drDrillRun.restoreOk', { seconds: Math.max(1, Math.round((status.restore.restore_ms ?? 0) / 1000)), tables: status.restore.tables_restored })
                        : t('drDrillRun.restoreBad', { restored: status.restore.tables_restored, live: status.restore.tables_live })}
                </td>
              </tr>
              {status.backup_size_bytes != null && (
                <tr style={styles.tr}>
                  <td style={{ ...styles.td, fontWeight: 500 }}>{t('drDrillRun.backupSize')}</td>
                  <td style={styles.td}>{t('drDrillRun.megabytes', { mb: (status.backup_size_bytes / 1048576).toFixed(1) })}</td>
                </tr>
              )}
              {status.last_error && (
                <tr style={styles.tr}>
                  <td style={{ ...styles.td, fontWeight: 500 }}>{t('ui.drDrillStatus.lastError')}</td>
                  <td style={{ ...styles.td, color: 'var(--danger)' }}>{status.last_error}</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Full runbook document (docs/dr-drill.md served by the backend) */}
      <div style={{ ...styles.tableCard, marginTop: '1rem', padding: '1rem 1.25rem' }} id="runbook">
        <h2 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>{t('ui.drDrillStatus.drRunbook')}</h2>
        {runbookQ.isLoading ? (
          <p style={styles.msg}>{t('ui.drDrillStatus.loadingRunbook')}</p>
        ) : runbookQ.error || !runbookQ.data ? (
          <p style={styles.msgError}>{t('ui.drDrillStatus.failedToLoadTheRunbook')}</p>
        ) : (
          <Suspense fallback={<p style={styles.msg}>{t('ui.drDrillStatus.loading')}</p>}>
            <MarkdownView markdown={runbookQ.data} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

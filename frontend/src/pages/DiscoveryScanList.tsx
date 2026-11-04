// =============================================================================
// VigaBSS 5.0 — Discovery Scan Management
// =============================================================================
// Standalone page at /discovery-scans. Lists discovery scans with a paginated
// table, "New Discovery Scan" create modal, and per-row Delete (scans are
// immutable once created — no edit action).
// =============================================================================

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { styles, modalStyles, RequiredMark, capitalize } from './crudStyles';
import { LoadingState } from '@/components/FetchStates';
import { extractApiError } from '@/components/ClientFormModal';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiscoveryScan {
  id: number;
  name: string;
  cidr_ranges: string;
  snmp_version: string;
  has_snmp_community?: boolean;
  snmp_port: number;
  status: string;
  total_hosts: number | null;
  scanned_hosts: number;
  discovered_hosts: number;
  error_message?: string | null;
  created_at: string;
}

interface DiscoveryResult {
  id: number;
  ip_address: string;
  hostname: string | null;
  manufacturer: string | null;
  model: string | null;
  device_type: string | null;
  suggested_profile_name?: string | null;
  status: 'pending_review' | 'onboarded' | 'ignored';
}

interface DiscoveryScansResponse {
  data: DiscoveryScan[];
  meta: { total: number; page: number; limit: number };
}

interface DiscoveryScanBody {
  name: string;
  cidr_ranges: string[];
  snmp_version?: string;
  snmp_community?: string;
  snmp_port?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25;
const SNMP_VERSIONS = ['v1', 'v2c', 'v3'];

// ---------------------------------------------------------------------------
// Fetch / mutate helpers
// ---------------------------------------------------------------------------

async function fetchScans(page: number): Promise<DiscoveryScansResponse> {
  const query: Record<string, string | number> = { page, limit: PAGE_SIZE };
  const res = await api.GET('/discovery-scans', { params: { query: query } });
  if ((res as { error?: unknown }).error) throw new Error('Failed to load discovery scans');
  return (res as { data: unknown }).data as unknown as DiscoveryScansResponse;
}

async function createScan(body: DiscoveryScanBody): Promise<void> {
  const res = await api.POST('/discovery-scans', { body: body as never });
  const error = (res as { error?: unknown }).error;
  // A refused range (loopback, too large) says which one.
  if (error) throw new Error(extractApiError(error, 'Failed to create discovery scan'));
}

async function cancelScan(id: number): Promise<void> {
  const res = await api.POST('/discovery-scans/{id}/cancel', { params: { path: { id } } });
  const error = (res as { error?: unknown }).error;
  if (error) throw new Error(extractApiError(error, 'Failed to cancel discovery scan'));
}

async function fetchResults(id: number): Promise<DiscoveryResult[]> {
  const res = await api.GET('/discovery-scans/{id}/results', { params: { path: { id } } });
  if ((res as { error?: unknown }).error) throw new Error('Failed to load results');
  return ((res.data as { data: DiscoveryResult[] })?.data) ?? [];
}

async function resolveResult(scanId: number, resultId: number, action: 'onboard' | 'ignore'): Promise<void> {
  const params = { params: { path: { id: scanId, resultId } } };
  const res = action === 'onboard'
    ? await api.POST('/discovery-scans/{id}/results/{resultId}/onboard', params)
    : await api.POST('/discovery-scans/{id}/results/{resultId}/ignore', params);
  const error = (res as { error?: unknown }).error;
  if (error) throw new Error(extractApiError(error, `Failed to ${action} the device`));
}

const RUNNING = ['pending', 'running'];

async function deleteScan(id: number): Promise<void> {
  const res = await api.DELETE('/discovery-scans/{id}', { params: { path: { id } } });
  if ((res as { error?: unknown }).error) throw new Error('Failed to delete discovery scan');
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; color: string }> = {
    pending:   { bg: '#fef9c3', color: '#854d0e' },
    running:   { bg: '#dbeafe', color: '#1e40af' },
    completed: { bg: '#d1fae5', color: '#065f46' },
    failed:    { bg: '#fee2e2', color: '#991b1b' },
  };
  const c = colors[status] ?? { bg: '#f3f4f6', color: '#374151' };
  return (
    <span style={{ background: c.bg, color: c.color, padding: '2px 8px', borderRadius: 12, fontSize: '0.72rem', fontWeight: 600, textTransform: 'capitalize' }}>
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Discovery scan form modal
// ---------------------------------------------------------------------------

interface ScanFormProps {
  onSave: (body: DiscoveryScanBody) => void;
  onClose: () => void;
  saving: boolean;
}

function ScanForm({ onSave, onClose, saving }: ScanFormProps) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [cidrRangesRaw, setCidrRangesRaw] = useState('');
  const [snmpVersion, setSnmpVersion] = useState('v2c');
  const [snmpCommunity, setSnmpCommunity] = useState('');
  const [snmpPort, setSnmpPort] = useState<string>('161');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const cidrRanges = cidrRangesRaw
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
    const body: DiscoveryScanBody = { name, cidr_ranges: cidrRanges, snmp_version: snmpVersion };
    if (snmpCommunity) body.snmp_community = snmpCommunity;
    if (snmpPort) body.snmp_port = Number(snmpPort);
    onSave(body);
  }

  const inp: React.CSSProperties = { ...modalStyles.input, width: '100%', boxSizing: 'border-box' as const };

  return (
    <div style={modalStyles.backdrop} onClick={onClose}>
      <div style={{ ...modalStyles.panel, maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div style={modalStyles.header}>
          <h3 style={modalStyles.title}>{t('discovery_scans.new', 'New Discovery Scan')}</h3>
          <button style={modalStyles.closeBtn} onClick={onClose} aria-label="Close">x</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '0.75rem' }}>
            <label style={modalStyles.label}>{t('discovery_scans.name', 'Scan Name')}<RequiredMark /></label>
            <input style={inp} value={name} onChange={e => setName(e.target.value)} required />
          </div>

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={modalStyles.label}>{t('discovery_scans.cidr_ranges', 'CIDR Ranges')}<RequiredMark /></label>
            <textarea
              style={{ ...inp, minHeight: 72, resize: 'vertical' as const }}
              value={cidrRangesRaw}
              onChange={e => setCidrRangesRaw(e.target.value)}
              placeholder={t('discovery_scans.cidr_ranges_hint', 'Comma-separated, e.g. 192.168.1.0/24, 10.0.0.0/8')}
              required
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem', marginBottom: '1rem' }}>
            <div>
              <label style={modalStyles.label}>{t('discovery_scans.snmp_version', 'SNMP Version')}</label>
              <select style={inp} value={snmpVersion} onChange={e => setSnmpVersion(e.target.value)}>
                {SNMP_VERSIONS.map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </div>
            <div>
              <label style={modalStyles.label}>{t('discovery_scans.snmp_community', 'Community String')}</label>
              <input style={inp} value={snmpCommunity} onChange={e => setSnmpCommunity(e.target.value)} placeholder="public" />
            </div>
            <div>
              <label style={modalStyles.label}>{t('discovery_scans.snmp_port', 'Port')}</label>
              <input style={inp} type="number" min={1} max={65535} value={snmpPort} onChange={e => setSnmpPort(e.target.value)} />
            </div>
          </div>

          <div style={modalStyles.actions}>
            <button type="button" style={styles.btnSecondary} onClick={onClose}>Cancel</button>
            <button type="submit" style={styles.btnPrimary} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export function DiscoveryScanList() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  const [resultsFor, setResultsFor] = useState<DiscoveryScan | null>(null);
  const scansQ = useQuery({
    queryKey: ['discovery-scans', page],
    queryFn: () => fetchScans(page),
    // A scan runs in the background (NET-26): follow it until it finishes.
    refetchInterval: q => ((q.state.data as DiscoveryScansResponse | undefined)?.data ?? []).some(s => RUNNING.includes(s.status)) ? 5000 : false,
  });

  const scans = scansQ.data?.data ?? [];
  const meta = scansQ.data?.meta;

  function showMsg(type: 'ok' | 'err', msg: string) {
    setFeedback({ type, msg });
    setTimeout(() => setFeedback(null), 4000);
  }

  const createMut = useMutation({
    mutationFn: createScan,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['discovery-scans'] });
      setShowForm(false);
      showMsg('ok', t('discovery_scans.create_success', 'Discovery scan created.'));
    },
    onError: (e: Error) => showMsg('err', e.message || t('discovery_scans.create_error', 'Failed to create discovery scan.')),
  });

  const cancelMut = useMutation({
    mutationFn: cancelScan,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['discovery-scans'] }),
    onError: (e: Error) => showMsg('err', e.message),
  });

  const deleteMut = useMutation({
    mutationFn: deleteScan,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['discovery-scans'] });
      setDeleteConfirm(null);
      showMsg('ok', t('discovery_scans.delete_success', 'Discovery scan deleted.'));
    },
    onError: () => showMsg('err', t('discovery_scans.delete_error', 'Failed to delete discovery scan.')),
  });

  const totalPages = meta ? Math.ceil(meta.total / PAGE_SIZE) : 1;

  function formatCidrRanges(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as string[];
      return Array.isArray(parsed) ? parsed.join(', ') : raw;
    } catch {
      return raw;
    }
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('discovery_scans.title', 'Discovery Scans')}</h1>
        {meta && <span style={styles.countBadge}>{meta.total} total</span>}
        <button style={{ ...styles.btnPrimary, marginLeft: 'auto' }} onClick={() => setShowForm(true)}>
          + {t('discovery_scans.new', 'New Discovery Scan')}
        </button>
      </div>

      {feedback && (
        <div style={{ padding: '0.6rem 1rem', borderRadius: 6, marginBottom: '1rem', background: feedback.type === 'ok' ? '#d1fae5' : '#fee2e2', color: feedback.type === 'ok' ? '#065f46' : '#991b1b', fontSize: '0.85rem' }}>
          {feedback.msg}
        </div>
      )}

      <div style={styles.tableCard}>
        {scansQ.isLoading ? (
          <LoadingState />
        ) : scansQ.error ? (
          <p style={styles.msgError}>{t('discovery_scans.error', 'Failed to load discovery scans.')}</p>
        ) : scans.length === 0 ? (
          <p style={styles.msg}>{t('discovery_scans.empty', 'No discovery scans found.')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Name</th>
                  <th style={styles.th}>CIDR Ranges</th>
                  <th style={styles.th}>SNMP</th>
                  <th style={styles.th}>{t('discovery_scans.scanned', 'Scanned')}</th>
                  <th style={styles.th}>{t('discovery_scans.discovered', 'Discovered')}</th>
                  <th style={styles.th}>{t('discovery_scans.status', 'Status')}</th>
                  <th style={styles.th}>Created</th>
                  <th style={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {scans.map(s => (
                  <tr key={s.id} style={styles.tr}>
                    <td style={styles.td}><strong>{s.name}</strong></td>
                    <td style={{ ...styles.tdMono, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{formatCidrRanges(s.cidr_ranges)}</td>
                    <td style={styles.td}>{capitalize(s.snmp_version)} / port {s.snmp_port}</td>
                    <td style={styles.td}>{s.scanned_hosts}{s.total_hosts !== null && s.total_hosts !== undefined ? ` / ${s.total_hosts}` : ''}</td>
                    <td style={styles.td}>{s.discovered_hosts}</td>
                    <td style={styles.td} title={s.error_message ?? undefined}><StatusBadge status={s.status} /></td>
                    <td style={styles.td}>{formatDate(s.created_at)}</td>
                    <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                      <button style={{ ...styles.btnSecondary, fontSize: '0.78rem', padding: '0.25rem 0.6rem', marginRight: 6 }} onClick={() => setResultsFor(s)}>
                        {t('discovery_scans.results', 'Results')}
                      </button>
                      {RUNNING.includes(s.status) && (
                        <button style={{ ...styles.btnSecondary, fontSize: '0.78rem', padding: '0.25rem 0.6rem', marginRight: 6 }} disabled={cancelMut.isPending} onClick={() => cancelMut.mutate(s.id)}>
                          {t('discovery_scans.cancel_scan', 'Cancel scan')}
                        </button>
                      )}
                      <button style={{ ...styles.btnDanger, fontSize: '0.78rem', padding: '0.25rem 0.6rem' }} onClick={() => setDeleteConfirm(s.id)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div style={styles.pagination}>
          <button style={styles.pageBtn} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>&larr; Prev</button>
          <span style={styles.pageInfo}>Page {page} of {totalPages}</span>
          <button style={styles.pageBtn} disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next &rarr;</button>
        </div>
      )}

      {showForm && (
        <ScanForm
          onSave={body => createMut.mutate(body)}
          onClose={() => setShowForm(false)}
          saving={createMut.isPending}
        />
      )}

      {deleteConfirm !== null && (
        <div style={modalStyles.backdrop} onClick={() => setDeleteConfirm(null)}>
          <div style={{ ...modalStyles.panel, maxWidth: 380 }} onClick={e => e.stopPropagation()}>
            <p style={{ marginBottom: '1.5rem' }}>{t('discovery_scans.delete_confirm', 'Delete this discovery scan?')}</p>
            <div style={modalStyles.actions}>
              <button style={styles.btnSecondary} onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button style={styles.btnDanger} onClick={() => deleteMut.mutate(deleteConfirm)} disabled={deleteMut.isPending}>Delete</button>
            </div>
          </div>
        </div>
      )}
      {resultsFor && <ResultsPanel scan={resultsFor} onClose={() => setResultsFor(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Results of one scan: onboard a responder as a device, or ignore it
// ---------------------------------------------------------------------------

function ResultsPanel({ scan, onClose }: { scan: DiscoveryScan; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const resultsQ = useQuery({
    queryKey: ['discovery-scans', scan.id, 'results'],
    queryFn: () => fetchResults(scan.id),
    refetchInterval: RUNNING.includes(scan.status) ? 5000 : false,
  });
  const resolveMut = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'onboard' | 'ignore' }) => resolveResult(scan.id, id, action),
    onSuccess: () => { setErr(''); qc.invalidateQueries({ queryKey: ['discovery-scans', scan.id, 'results'] }); },
    onError: (e: Error) => setErr(e.message),
  });
  const results = resultsQ.data ?? [];

  return (
    <div style={modalStyles.backdrop}>
      <div style={{ ...modalStyles.panel, maxWidth: 900, width: '95%' }} role="dialog" aria-modal="true" aria-labelledby="discovery-results-title">
        <h2 id="discovery-results-title" style={modalStyles.title}>{t('discovery_scans.results_title', 'Discovered devices')}: {scan.name}</h2>
        {err && <p role="alert" style={styles.msgError}>{err}</p>}
        {resultsQ.isLoading ? <LoadingState /> : results.length === 0 ? (
          <p style={styles.msg}>{t('discovery_scans.results_empty', 'No device has answered yet.')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>{t('discovery_scans.ip_address', 'IP address')}</th>
                  <th style={styles.th}>{t('discovery_scans.hostname', 'Hostname')}</th>
                  <th style={styles.th}>{t('discovery_scans.vendor', 'Vendor / model')}</th>
                  <th style={styles.th}>{t('discovery_scans.device_type', 'Type')}</th>
                  <th style={styles.th}>{t('discovery_scans.status', 'Status')}</th>
                  <th style={styles.th} />
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.id} style={styles.tr}>
                    <td style={styles.tdMono}>{r.ip_address}</td>
                    <td style={styles.td}>{r.hostname ?? '—'}</td>
                    <td style={styles.td}>{[r.manufacturer, r.model].filter(Boolean).join(' ') || '—'}</td>
                    <td style={styles.td}>{r.device_type ?? '—'}</td>
                    <td style={styles.td}><StatusBadge status={r.status} /></td>
                    <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                      {r.status === 'pending_review' && (
                        <>
                          <button style={{ ...styles.btnPrimary, fontSize: '0.78rem', padding: '0.25rem 0.6rem', marginRight: 6 }} disabled={resolveMut.isPending} onClick={() => resolveMut.mutate({ id: r.id, action: 'onboard' })}>
                            {t('discovery_scans.onboard', 'Onboard')}
                          </button>
                          <button style={{ ...styles.btnSecondary, fontSize: '0.78rem', padding: '0.25rem 0.6rem' }} disabled={resolveMut.isPending} onClick={() => resolveMut.mutate({ id: r.id, action: 'ignore' })}>
                            {t('discovery_scans.ignore', 'Ignore')}
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={modalStyles.actions}>
          <button style={styles.btnSecondary} onClick={onClose}>{t('common.close', 'Close')}</button>
        </div>
      </div>
    </div>
  );
}

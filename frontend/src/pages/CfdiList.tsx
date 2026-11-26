// =============================================================================
// VigaBSS 5.0 — CFDI Management
// =============================================================================
// Page at /cfdi. Shows all CFDI documents for the org with:
//   • Filtering by status and type (I=Ingreso, E=Egreso, P=Pago)
//   • Paginated table with UUID, RFC, amounts, status
//   • Per-row actions: Stamp (timbrar), Cancel, Download XML, Download PDF
//   • Cancel modal with SAT reason codes and optional replacement UUID
// =============================================================================

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authedFetch, tokenStore } from '@/api/client';
import { SandboxCfdiBadge, SandboxEnvironmentBanner } from '@/components/SandboxFiscal';
import { formatMoney } from '@/lib/money';
import { useTableSort, SortableTh } from '@/components/SortableTh';
import { UnpaidPpdPanel } from '@/components/UnpaidPpdPanel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CfdiDocument {
  id: number;
  uuid: string | null;
  serie: string | null;
  folio: string | null;
  tipo_comprobante: string | null;
  stamp_date: string | null;
  emisor_rfc: string | null;
  emisor_nombre: string | null;
  receptor_rfc: string | null;
  receptor_nombre: string | null;
  subtotal: string;
  total: string;
  moneda: string | null;
  sat_status: string;
  stamp_error?: string | null;
  stamp_ambiguous?: number | boolean | null;
  cancelled_at: string | null;
  pac_provider: string | null;
  pac_environment?: 'sandbox' | 'production' | null;
  invoice_id?: number | null;
  created_at: string;
}

// Friendly label for the PAC that stamped a document (cfdi_documents.pac_provider).
// Null for documents stamped before provider recording existed, or not yet stamped.
const PAC_LABELS: Record<string, string> = {
  finkok: 'Finkok', sw_sapien: 'SW Sapien', simulator: 'Simulator', dev_placeholder: 'Dev',
};
function pacLabel(p: string | null): string {
  if (!p) return '—';
  return PAC_LABELS[p] ?? p;
}

interface CfdiListResponse {
  data: CfdiDocument[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ---------------------------------------------------------------------------
// Fetch / action helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25;
const API_BASE = '/api/v1';

function authHeaders(): Record<string, string> {
  const token = tokenStore.getAccess();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchCfdi(
  page: number, statusFilter: string, typeFilter: string, orderBy: string, order: 'ASC' | 'DESC',
): Promise<CfdiListResponse> {
  const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), order_by: orderBy, order });
  if (statusFilter) params.set('sat_status', statusFilter);
  if (typeFilter) params.set('tipo_comprobante', typeFilter);
  const res = await authedFetch(`${API_BASE}/cfdi-documents?${params}`, { headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to load CFDI documents');
  return res.json() as Promise<CfdiListResponse>;
}

async function stampCfdi(id: number): Promise<void> {
  const res = await authedFetch(`${API_BASE}/cfdi/stamp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cfdi_document_id: id }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? 'Failed to stamp CFDI');
  }
}

interface CancelResult {
  status: string;
  error_message?: string | null;
}

async function cancelCfdi(id: number, reason: string, replacementUuid?: string): Promise<CancelResult> {
  const body: Record<string, unknown> = { cfdi_document_id: id, reason };
  if (replacementUuid) body.replacement_uuid = replacementUuid;
  const res = await authedFetch(`${API_BASE}/cfdi/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const resBody = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(resBody.error?.message ?? 'Failed to cancel CFDI');
  }
  const resBody = await res.json().catch(() => ({})) as { data?: CancelResult };
  return resBody.data ?? { status: 'cancel_pending' };
}

// Substitute a vigente invoice CFDI (BIL-33): the server stamps a replacement
// for the same invoice (TipoRelacion 04), then cancels this one with motivo 01.
interface SubstituteResult {
  stamped: boolean;
  uuid: string | null;
  stamp_error?: string;
  cancel_error?: string;
  original_cancellation: CancelResult | null;
}
async function substituteCfdi(id: number): Promise<SubstituteResult> {
  const res = await authedFetch(`${API_BASE}/cfdi-documents/${id}/substitute`, { method: 'POST' });
  const resBody = await res.json().catch(() => ({})) as { data?: SubstituteResult; error?: { message?: string } };
  if (!res.ok || !resBody.data) throw new Error(resBody.error?.message ?? 'Failed to substitute the CFDI');
  return resBody.data;
}

// Delete an unstamped draft. The server refuses while the last stamp attempt
// may have been registered at SAT (retry it first).
async function discardDraft(id: number): Promise<void> {
  const res = await authedFetch(`${API_BASE}/cfdi-documents/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const resBody = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(resBody.error?.message ?? 'Failed to discard the draft');
  }
}

// Ask SAT (through the PAC) where a pending cancellation stands. SAT answers
// 201 when it only registered the request; a CFDI that needs the receptor's
// acceptance stays pending for up to 72 hours.
async function checkCancellationStatus(id: number): Promise<CancelResult> {
  const res = await authedFetch(`${API_BASE}/cfdi/${id}/cancellation-status`);
  const resBody = await res.json().catch(() => ({})) as { data?: CancelResult; error?: { message?: string } };
  if (!res.ok) throw new Error(resBody.error?.message ?? 'Failed to check the cancellation status');
  return resBody.data ?? { status: 'pending' };
}

function downloadFile(url: string, filename: string) {
  const token = tokenStore.getAccess();
  fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then(res => {
      if (!res.ok) throw new Error(`Download failed (${res.status})`);
      return res.blob();
    })
    .then(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    })
    .catch(err => {
      alert(err instanceof Error ? err.message : 'Download failed');
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('es-MX', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function tipoLabel(tipo: string | null): string {
  const map: Record<string, string> = { I: 'Ingreso', E: 'Egreso', T: 'Traslado', N: 'Nómina', P: 'Pago' };
  return tipo ? (map[tipo] ?? tipo) : '—';
}

// cfdi_documents.sat_status is ENUM('draft','vigente','cancelado','cancel_pending')
// — the real column. (The page previously read a non-existent `status` field
// against an imagined 'generated'/'stamped' vocabulary, so the badge and the
// stamp/cancel buttons never worked.)
const STATUS_META: Record<string, { label: string; bg: string; color: string }> = {
  draft:          { label: 'Draft', bg: 'var(--bg-subtle)', color: 'var(--text-muted)' },
  vigente:        { label: 'Vigente', bg: 'var(--success-soft)', color: 'var(--success)' },
  cancelado:      { label: 'Cancelado', bg: 'var(--danger-soft)', color: 'var(--danger)' },
  cancel_pending: { label: 'Cancel pending', bg: 'var(--warning-soft)', color: 'var(--warning)' },
};

function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? { label: status || '—', bg: 'var(--bg-subtle)', color: 'var(--text-secondary)' };
  return (
    <span style={{
      background: m.bg, color: m.color,
      padding: '2px 8px', borderRadius: 12,
      fontSize: '0.72rem', fontWeight: 600,
    }}>
      {m.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Cancel Modal
// ---------------------------------------------------------------------------

const CANCEL_REASONS = [
  { code: '01', label: '01 — Comprobante emitido con errores con relación' },
  { code: '02', label: '02 — Comprobante emitido con errores sin relación' },
  { code: '03', label: '03 — No se llevó a cabo la operación' },
  { code: '04', label: '04 — Operación nominativa relacionada en CFDI global' },
];

interface CancelModalProps {
  doc: CfdiDocument;
  onClose: () => void;
  onCancelled: () => void;
}

function CancelModal({ doc, onClose, onCancelled }: CancelModalProps) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('02');
  const [replacementUuid, setReplacementUuid] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const result = await cancelCfdi(doc.id, reason, reason === '01' ? replacementUuid : undefined);
      onCancelled();
      if (result.status === 'rejected') {
        // SAT refused the request (e.g. 205 UUID not found, 3xx signature
        // problems); the CFDI stays as it was.
        setError(`SAT refused the cancellation: ${result.error_message ?? 'no reason given'}`);
        return;
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel CFDI');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={overlay}>
      <div style={modalBox}>
        <h3 style={{ margin: '0 0 0.25rem' }}>{t('ui.cfdiList.cancelCfdi')}</h3>
        <p style={{ margin: '0 0 1rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
          UUID: {doc.uuid ?? `#${doc.id}`}
        </p>
        {error && <div style={errorBox}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <label style={labelStyle}>{t('ui.cfdiList.cancellationReasonSat')}</label>
          <select
            style={inputStyle}
            value={reason}
            onChange={e => setReason(e.target.value)}
            required
          >
            {CANCEL_REASONS.map(r => (
              <option key={r.code} value={r.code}>{r.label}</option>
            ))}
          </select>

          {reason === '01' && (
            <>
              <label style={labelStyle}>{t('ui.cfdiList.replacementUuidRequiredForReason')}</label>
              <input
                style={inputStyle}
                type="text"
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                value={replacementUuid}
                onChange={e => setReplacementUuid(e.target.value)}
                required
              />
            </>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: '1rem', justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={cancelBtn} disabled={submitting}>{t('ui.cfdiList.dismiss')}</button>
            <button type="submit" style={dangerBtn} disabled={submitting}>
              {submitting ? 'Cancelling…' : 'Cancel CFDI'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stamp confirmation modal
// ---------------------------------------------------------------------------

interface StampModalProps {
  doc: CfdiDocument;
  onClose: () => void;
  onStamped: () => void;
}

function StampModal({ doc, onClose, onStamped }: StampModalProps) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleConfirm() {
    setSubmitting(true);
    setError('');
    try {
      await stampCfdi(doc.id);
      onStamped();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stamp CFDI');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={overlay}>
      <div style={modalBox}>
        <h3 style={{ margin: '0 0 0.25rem' }}>{t('ui.cfdiList.stampTimbrarCfdi')}</h3>
        <p style={{ margin: '0 0 1rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
          {t('ui.cfdiList.document')}{doc.id} — {doc.serie ?? ''}{doc.folio ? ` Folio ${doc.folio}` : ''}<br />
          {t('ui.cfdiList.receptor')}{doc.receptor_rfc ?? '—'} — {doc.receptor_nombre ?? '—'}<br />
          {t('ui.cfdiList.total')}{formatMoney(doc.total, doc.moneda)}
        </p>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          {t('ui.cfdiList.thisWillSubmitTheDocument')}
        </p>
        {error && <div style={errorBox}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: '1rem', justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={cancelBtn} disabled={submitting}>{t('ui.cfdiList.cancel')}</button>
          <button type="button" onClick={handleConfirm} style={submitBtn} disabled={submitting}>
            {submitting ? 'Stamping…' : 'Stamp now'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

const STATUS_OPTIONS = ['', 'draft', 'vigente', 'cancelado', 'cancel_pending'];
// Column headers, and the server column each one sorts by (none for Actions).
const COLUMNS: Array<{ label: string; col?: string }> = [
  { label: 'UUID / ID', col: 'id' }, { label: 'Type', col: 'tipo_comprobante' },
  { label: 'Receptor', col: 'receptor_rfc' }, { label: 'Total', col: 'total' },
  { label: 'Date', col: 'created_at' }, { label: 'Status', col: 'sat_status' },
  { label: 'PAC', col: 'pac_provider' }, { label: 'Actions' },
];
const thStyle: React.CSSProperties = {
  padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', whiteSpace: 'nowrap',
};
const TYPE_OPTIONS   = ['', 'I', 'E', 'P', 'T', 'N'];

export function CfdiList() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [stampTarget, setStampTarget] = useState<CfdiDocument | null>(null);
  const [cancelTarget, setCancelTarget] = useState<CfdiDocument | null>(null);
  const qc = useQueryClient();
  // Newest first by default; a click on a column header sorts the whole list
  // on the server, not just the page shown.
  const sort = useTableSort('id', 'DESC');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['cfdi', page, statusFilter, typeFilter, sort.order_by, sort.order],
    queryFn: () => fetchCfdi(page, statusFilter, typeFilter, sort.order_by, sort.order),
    placeholderData: prev => prev,
  });

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['cfdi'] });
  }

  const [statusNotice, setStatusNotice] = useState('');
  async function handleDiscard(doc: CfdiDocument) {
    if (!window.confirm(`Discard draft CFDI #${doc.id}? It was never stamped; its invoice can then be edited, voided or stamped again.`)) return;
    setStatusNotice('');
    try {
      await discardDraft(doc.id);
      setStatusNotice(`Draft CFDI #${doc.id} discarded.`);
      refresh();
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : 'Failed to discard the draft');
    }
  }
  async function handleSubstitute(doc: CfdiDocument) {
    if (!window.confirm(t('cfdiSubstitution.confirm', { uuid: doc.uuid }))) return;
    setStatusNotice('');
    try {
      const result = await substituteCfdi(doc.id);
      if (!result.stamped) {
        setStatusNotice(t('cfdiSubstitution.notStamped', { uuid: doc.uuid, error: result.stamp_error ?? '' }));
      } else if (result.cancel_error) {
        setStatusNotice(t('cfdiSubstitution.cancelFailed', { replacement: result.uuid, uuid: doc.uuid, error: result.cancel_error }));
      } else {
        setStatusNotice(t('cfdiSubstitution.done', { replacement: result.uuid, uuid: doc.uuid, status: result.original_cancellation?.status ?? 'requested' }));
      }
      refresh();
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : t('cfdiSubstitution.failed'));
    }
  }
  async function handleCheckStatus(doc: CfdiDocument) {
    setStatusNotice('');
    try {
      const result = await checkCancellationStatus(doc.id);
      setStatusNotice(result.status === 'pending'
        ? `CFDI ${doc.uuid ?? doc.id}: still waiting for the receptor (SAT allows up to 72 hours).`
        : `CFDI ${doc.uuid ?? doc.id}: cancellation ${result.status}${result.error_message ? ` — ${result.error_message}` : ''}.`);
      refresh();
    } catch (err) {
      setStatusNotice(err instanceof Error ? err.message : 'Failed to check the cancellation status');
    }
  }

  function handleFilterChange(newStatus: string) {
    setStatusFilter(newStatus);
    setPage(1);
  }

  function handleTypeChange(newType: string) {
    setTypeFilter(newType);
    setPage(1);
  }

  // A sort applies to the whole list, so it starts again from the first page.
  const sortFromFirstPage = { ...sort, toggle: (col: string) => { sort.toggle(col); setPage(1); } };
  // An empty result has no pages; the pager still reads "1 / 1".
  const totalPages = Math.max(1, data?.meta?.totalPages ?? 1);
  const total = data?.meta?.total ?? 0;

  return (
    <div style={{ padding: '1.5rem' }}>
      <SandboxEnvironmentBanner />
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 700 }}>{t('ui.cfdiList.cfdiManagement')}</h1>
      </div>

      <UnpaidPpdPanel
        onCancel={row => setCancelTarget({
          id: row.id, uuid: row.uuid ?? null, serie: row.serie ?? null, folio: row.folio == null ? null : String(row.folio),
          tipo_comprobante: 'I', stamp_date: row.stamp_date ?? null, emisor_rfc: null, emisor_nombre: null,
          receptor_rfc: row.receptor_rfc ?? null, receptor_nombre: row.receptor_nombre ?? null,
          subtotal: String(row.total ?? 0), total: String(row.total ?? 0), moneda: row.moneda ?? null,
          sat_status: 'vigente', cancelled_at: null, pac_provider: null, invoice_id: row.invoice_id ?? null, created_at: '',
        })}
      />

      {/* Filters row */}
      <div style={{ display: 'flex', gap: 16, marginBottom: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Status filter */}
        <div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>{t('ui.cfdiList.status')}</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {STATUS_OPTIONS.map(s => (
              <button
                key={s || 'all'}
                onClick={() => handleFilterChange(s)}
                style={{
                  padding: '3px 10px', borderRadius: 20, border: '1px solid var(--border-strong)',
                  background: statusFilter === s ? 'var(--accent)' : 'var(--bg-card)',
                  color: statusFilter === s ? '#fff' : 'var(--text-secondary)',
                  cursor: 'pointer', fontSize: '0.78rem', fontWeight: 500,
                }}
              >
                {s ? (STATUS_META[s]?.label ?? s) : 'All'}
              </button>
            ))}
          </div>
        </div>

        {/* Type filter */}
        <div>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: 4, display: 'block' }}>{t('ui.cfdiList.type')}</span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {TYPE_OPTIONS.map(t => (
              <button
                key={t || 'all'}
                onClick={() => handleTypeChange(t)}
                style={{
                  padding: '3px 10px', borderRadius: 20, border: '1px solid var(--border-strong)',
                  background: typeFilter === t ? 'var(--accent)' : 'var(--bg-card)',
                  color: typeFilter === t ? '#fff' : 'var(--text-secondary)',
                  cursor: 'pointer', fontSize: '0.78rem', fontWeight: 500,
                }}
              >
                {t ? tipoLabel(t) : 'All'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Table */}
      {isLoading && <p style={{ color: 'var(--text-muted)' }}>{t('ui.cfdiList.loading')}</p>}
      {isError && <p style={{ color: 'var(--accent)' }}>{t('ui.cfdiList.failedToLoadCfdiDocuments')}</p>}
      {statusNotice && <p role="status" style={{ fontSize: '0.85rem' }}>{statusNotice}</p>}
      {data && (
        <>
          <div style={{ background: 'var(--bg-card)', borderRadius: 8, boxShadow: '0 0 0 1px var(--border)', overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.855rem' }}>
              <thead>
                <tr style={{ background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border)' }}>
                  {COLUMNS.map(c => (c.col
                    ? <SortableTh key={c.label} label={c.label} col={c.col} sort={sortFromFirstPage} style={thStyle} />
                    : <th key={c.label} style={thStyle}>{c.label}</th>))}
                </tr>
              </thead>
              <tbody>
                {data.data.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-faint)' }}>
                      {t('ui.cfdiList.noCfdiDocumentsFound')}
                    </td>
                  </tr>
                )}
                {data.data.map((doc, idx) => (
                  <tr key={doc.id} style={{ borderBottom: '1px solid var(--border-subtle)', background: idx % 2 === 0 ? 'var(--bg-card)' : 'var(--bg-muted)' }}>
                    {/* UUID / ID */}
                    <td style={{ padding: '9px 12px', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                      {doc.uuid
                        ? <span title={doc.uuid}>{doc.uuid.substring(0, 8)}…</span>
                        : <span style={{ color: 'var(--text-faint)' }}>#{doc.id}</span>
                      }
                    </td>

                    {/* Type */}
                    <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                      <span style={{
                        background: 'var(--bg-subtle)', color: 'var(--text-secondary)',
                        padding: '2px 7px', borderRadius: 10, fontSize: '0.75rem', fontWeight: 600,
                      }}>
                        {tipoLabel(doc.tipo_comprobante)}
                      </span>
                    </td>

                    {/* Receptor */}
                    <td style={{ padding: '9px 12px' }}>
                      <div style={{ fontWeight: 500 }}>{doc.receptor_rfc ?? '—'}</div>
                      {doc.receptor_nombre && (
                        <div style={{ fontSize: '0.77rem', color: 'var(--text-muted)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {doc.receptor_nombre}
                        </div>
                      )}
                    </td>

                    {/* Total */}
                    <td style={{ padding: '9px 12px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {formatMoney(doc.total, doc.moneda)}
                    </td>

                    {/* Date */}
                    <td style={{ padding: '9px 12px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                      {fmt(doc.stamp_date || doc.created_at)}
                    </td>

                    {/* Status */}
                    <td style={{ padding: '9px 12px' }}>
                      <StatusBadge status={doc.sat_status} />
                      <SandboxCfdiBadge doc={doc} />
                    </td>

                    {/* PAC that stamped it */}
                    <td style={{ padding: '9px 12px', color: doc.pac_provider ? 'var(--text-secondary)' : 'var(--text-faint)', whiteSpace: 'nowrap', fontSize: '0.82rem' }}>
                      {pacLabel(doc.pac_provider)}
                    </td>

                    {/* Actions */}
                    <td style={{ padding: '9px 12px' }}>
                      <div style={{ display: 'flex', gap: 5, flexWrap: 'nowrap' }}>
                        {/* Stamp — only available for draft docs without a UUID */}
                        {doc.sat_status === 'draft' && !doc.uuid && (
                          <button
                            onClick={() => setStampTarget(doc)}
                            style={actionBtn}
                            title={t('ui.cfdiList.stampTimbrarThisCfdiWith')}
                          >
                            {t('ui.cfdiList.stamp')}
                          </button>
                        )}

                        {/* Discard — an unstamped draft whose stamp was definitely refused */}
                        {doc.sat_status === 'draft' && !doc.uuid && !Number(doc.stamp_ambiguous) && (
                          <button
                            onClick={() => { void handleDiscard(doc); }}
                            style={{ ...actionBtn, color: 'var(--danger)', borderColor: '#fca5a5' }}
                            title={doc.stamp_error ? `Last stamp attempt: ${doc.stamp_error}` : 'Delete this unstamped draft'}
                          >
                            {t('ui.cfdiList.discard')}
                          </button>
                        )}

                        {/* Cancel — for stamped (vigente) docs; a pending one may be retried */}
                        {(doc.sat_status === 'vigente' || doc.sat_status === 'cancel_pending') && (
                          <button
                            onClick={() => setCancelTarget(doc)}
                            style={{ ...actionBtn, color: 'var(--danger)', borderColor: '#fca5a5' }}
                            title={t('ui.cfdiList.requestCancellationViaSatPac')}
                          >
                            {doc.sat_status === 'cancel_pending' ? '✕ Retry cancel' : '✕ Cancel'}
                          </button>
                        )}

                        {/* Substitute — replace an invoice CFDI issued with errors (BIL-33) */}
                        {doc.sat_status === 'vigente' && doc.tipo_comprobante === 'I' && doc.invoice_id && (
                          <button
                            onClick={() => { void handleSubstitute(doc); }}
                            style={actionBtn}
                            title={t('cfdiSubstitution.buttonTitle')}
                          >
                            ⇄ {t('cfdiSubstitution.button')}
                          </button>
                        )}

                        {/* Pending cancellation — ask SAT where it stands */}
                        {doc.sat_status === 'cancel_pending' && (
                          <button
                            onClick={() => { void handleCheckStatus(doc); }}
                            style={actionBtn}
                            title={t('ui.cfdiList.askSatWhetherTheReceptor')}
                          >
                            {t('ui.cfdiList.checkStatus')}
                          </button>
                        )}

                        {/* Download XML */}
                        {doc.uuid && (
                          <button
                            onClick={() => downloadFile(
                              `${API_BASE}/cfdi/${doc.id}/xml`,
                              `CFDI-${doc.uuid}.xml`,
                            )}
                            style={actionBtn}
                            title={t('ui.cfdiList.downloadXml')}
                          >
                            ↓ XML
                          </button>
                        )}

                        {/* Download PDF */}
                        <button
                          onClick={() => downloadFile(
                            `${API_BASE}/cfdi/${doc.id}/pdf`,
                            `CFDI-${doc.uuid ?? doc.id}.pdf`,
                          )}
                          style={actionBtn}
                          title={t('ui.cfdiList.downloadPdf')}
                        >
                          ↓ PDF
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            <span>{total} {t('ui.cfdiList.document2')}{total !== 1 ? 's' : ''}</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button style={pageBtn} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t('ui.cfdiList.prev')}</button>
              <span style={{ padding: '4px 8px' }}>{t('ui.cfdiList.page')}{page} / {totalPages}</span>
              <button style={pageBtn} disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>{t('ui.cfdiList.next')}</button>
            </div>
          </div>
        </>
      )}

      {/* Stamp modal */}
      {stampTarget && (
        <StampModal
          doc={stampTarget}
          onClose={() => setStampTarget(null)}
          onStamped={refresh}
        />
      )}

      {/* Cancel modal */}
      {cancelTarget && (
        <CancelModal
          doc={cancelTarget}
          onClose={() => setCancelTarget(null)}
          onCancelled={refresh}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared styles
// ---------------------------------------------------------------------------

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
};
const modalBox: React.CSSProperties = {
  background: 'var(--bg-card)', color: 'var(--text-primary)', borderRadius: 10, padding: '1.5rem',
  width: 460, maxWidth: '92vw', boxShadow: '0 8px 32px rgba(0,0,0,.18)',
};
const errorBox: React.CSSProperties = {
  background: 'var(--danger-soft)', color: 'var(--danger)', padding: '8px 12px',
  borderRadius: 6, marginBottom: '0.75rem', fontSize: '0.85rem',
};
const labelStyle: React.CSSProperties = {
  display: 'block', fontWeight: 600, fontSize: '0.8rem',
  color: 'var(--text-secondary)', marginBottom: 4, marginTop: 12,
};
const inputStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '7px 10px',
  border: '1px solid var(--border-strong)', borderRadius: 6, fontSize: '0.875rem',
  background: 'var(--input-bg)', color: 'var(--text-primary)',
};
const submitBtn: React.CSSProperties = {
  background: 'var(--accent)', color: '#fff', border: 'none',
  padding: '7px 18px', borderRadius: 6, cursor: 'pointer',
  fontWeight: 600, fontSize: '0.875rem',
};
const dangerBtn: React.CSSProperties = {
  background: '#dc2626', color: '#fff', border: 'none',
  padding: '7px 18px', borderRadius: 6, cursor: 'pointer',
  fontWeight: 600, fontSize: '0.875rem',
};
const cancelBtn: React.CSSProperties = {
  background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)',
  padding: '7px 18px', borderRadius: 6, cursor: 'pointer',
  fontWeight: 600, fontSize: '0.875rem',
};
const actionBtn: React.CSSProperties = {
  background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)',
  padding: '3px 9px', borderRadius: 5, cursor: 'pointer',
  fontSize: '0.78rem', fontWeight: 500, whiteSpace: 'nowrap',
};
const pageBtn: React.CSSProperties = {
  padding: '4px 10px', border: '1px solid var(--border-strong)', borderRadius: 4,
  background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.8rem',
};

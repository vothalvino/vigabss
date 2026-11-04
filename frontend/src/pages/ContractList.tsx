// =============================================================================
// VigaBSS 5.0 — Contract Management
// =============================================================================
// Standalone page at /contracts. Shows all contracts across all clients with:
//   • Filtering by status
//   • Paginated table with client name, plan, type, dates, status
//   • Per-row actions: Renew (→ active), Suspend, Cancel
//   • "New Contract" button opens an inline modal form
// =============================================================================

import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { useTranslation } from 'react-i18next';
import { api, authedFetch } from '@/api/client';
import type { ContractRow } from '@/api/rows';
import { useAuth } from '@/auth/AuthContext';
import { MxRegisteredContractSourceField } from '@/components/MxRegisteredContractSourceField';
import {
  MxContractEnvironmentBadge,
  MxSandboxDocumentBanner,
  type MxContractEnvironment,
} from '@/components/MxContractEnvironment';
import { extractApiError } from '@/components/ClientFormModal';
import { useTableSort, SortableTh } from '@/components/SortableTh';
import { Pagination } from '@/components/Pagination';
import { ClientPicker } from '@/components/ClientPicker';
import { useClientNames } from '@/api/clientNames';
import { queryKeys } from '@/api/queryKeys';
import { localToday } from '@/lib/dates';
import { StatusBadge, type StatusColors } from '@/components/ui/StatusBadge';
import { EditContractModal, type Plan } from './contracts/EditContractModal';
import { modalStyles, styles } from './contracts/contractListStyles';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Contract = ContractRow;

// A provisioned PPPoE / RADIUS account belonging to a contract.  The base
// endpoint (GET /radius/contract/{contractId}, requires devices.view) never
// includes `password` — it is layered on separately from the /credentials
// endpoint (requires radius.credentials.view) so staff who provision routers
// keep seeing it, while a pure view-only role does not.  A contract may have
// 0 or several accounts.
interface RadiusAccount {
  id: number;
  username: string;
  password?: string;
  ip_address: string | null;
  ipv6_address: string | null;
  status: string | null;
  auth_method: string | null;
  mac_address: string | null;
  vlan_id: number | string | null;
  profile: string | null;
  nas_id: number | null;
}

interface ContractsResponse {
  data: Contract[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}


interface CreateContractBody {
  client_id: number;
  plan_id: number;
  connection_type?: string;
  start_date: string;
  billing_day?: number;
  price_override?: number;
  ip_address?: string;
  status?: string;
  facturar?: boolean;
  contract_template_mx_id?: number;
}

// ---------------------------------------------------------------------------
// Fetch / mutate helpers
// ---------------------------------------------------------------------------

const API_BASE = '/api/v1';

async function fetchContracts(
  page: number,
  pageSize: number,
  statusFilter: string,
  orderBy: string,
  order: string,
): Promise<ContractsResponse> {
  const query: Record<string, string | number> = { page, limit: pageSize, order_by: orderBy, order };
  if (statusFilter) query.status = statusFilter;
  const res = await api.GET('/contracts', {
    params: { query: query },
  });
  if (res.error) throw new Error('Failed to load contracts');
  return res.data;
}

// Sentinel thrown by fetchRadiusByContract so the UI can show a tailored
// "insufficient permission" message.  This endpoint requires `devices.view`
// (NOT `contracts.view`), so a viewer who can see contracts may still get 403.
const RADIUS_FORBIDDEN = 'radius_forbidden';

async function fetchRadiusByContract(id: number): Promise<RadiusAccount[]> {
  const res = await api.GET('/radius/contract/{contractId}', {
    params: { path: { contractId: id } },
  });
  // These endpoints are typed loosely, so the success/error union collapses to
  // `never` on the error branch — read `response.status` through an explicit
  // cast rather than relying on narrowing.
  const { error, response } = res as unknown as {
    error: unknown;
    response: { status: number };
  };
  if (error) {
    if (response?.status === 401 || response?.status === 403) {
      throw new Error(RADIUS_FORBIDDEN);
    }
    throw new Error('Failed to load RADIUS accounts');
  }
  return (res.data as unknown as { data: RadiusAccount[] }).data;
}

// Sentinel thrown by fetchRadiusCredentials — distinct from RADIUS_FORBIDDEN
// above because a user can legitimately see that an account exists
// (devices.view) while lacking radius.credentials.view for the cleartext
// password specifically; the UI shows the account with the password field
// replaced by an "insufficient permission" note instead of hiding everything.
const RADIUS_CREDENTIALS_FORBIDDEN = 'radius_credentials_forbidden';

async function fetchRadiusCredentials(id: number): Promise<RadiusAccount[]> {
  const res = await api.GET('/radius/contract/{contractId}/credentials', {
    params: { path: { contractId: id } },
  });
  const { error, response } = res as unknown as {
    error: unknown;
    response: { status: number };
  };
  if (error) {
    if (response?.status === 401 || response?.status === 403) {
      throw new Error(RADIUS_CREDENTIALS_FORBIDDEN);
    }
    throw new Error('Failed to load RADIUS credentials');
  }
  return (res.data as unknown as { data: RadiusAccount[] }).data;
}

async function fetchPlans(): Promise<Plan[]> {
  const res = await api.GET('/plans', {
    params: { query: { limit: 200 } },
  });
  if (res.error) throw new Error('Failed to load plans');
  return (res.data as unknown as { data: Plan[] }).data;
}

async function patchContractStatus(
  id: number,
  status: string,
  endDate?: string | null,
): Promise<void> {
  const body: Record<string, unknown> = { status };
  if (endDate !== undefined) body.end_date = endDate;
  // PATCH is not in the generated OpenAPI schema yet; use raw fetch with authedFetch.
  const res = await authedFetch(`${API_BASE}/contracts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Failed to update contract');
}

async function cancelPendingActivation(id: number): Promise<void> {
  const res = await authedFetch(`${API_BASE}/contracts/${id}/activation/cancel`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to cancel contract activation');
}

interface ContractActionResult {
  status?: string;
  activation_required?: boolean;
  network_activation?: {
    nas_pushed?: boolean;
    nas_push_error?: string | null;
  } | null;
}

async function postContractAction(
  id: number,
  action: 'suspend' | 'unsuspend' | 'renew' | 'terminate',
  extra?: Record<string, unknown>,
): Promise<ContractActionResult> {
  const res = await authedFetch(`${API_BASE}/contracts/${id}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(extra ?? {}),
  });
  if (!res.ok) throw new Error(`Failed to ${action} contract`);
  const payload = await res.json().catch(() => ({})) as {
    data?: ContractActionResult;
    network_activation?: ContractActionResult['network_activation'];
  };
  return { ...(payload.data ?? {}), network_activation: payload.network_activation ?? null };
}

async function createContract(body: CreateContractBody): Promise<number> {
  const res = await api.POST('/contracts', { body: body as never }) as unknown as {
    data?: unknown;
    error?: unknown;
  };
  if (res.error) throw new Error(extractApiError(res.error, 'Failed to create contract'));
  return Number((res.data as unknown as { data: { id: number } }).data.id);
}

async function deleteContract(id: number): Promise<void> {
  const res = await api.DELETE('/contracts/{id}', { params: { path: { id } } });
  if (res.error) throw new Error('Failed to delete contract');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('es-MX', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function capitalizeStatus(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Copy `text` to the clipboard, guarding for non-secure contexts (http / older
// browsers) where navigator.clipboard is undefined.  Falls back to a hidden
// textarea + execCommand and resolves false if even that is unavailable so the
// caller never throws.
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

const STATUS_COLORS: StatusColors = {
  active:     { bg: '#d1fae5', color: '#065f46' },
  pending:    { bg: '#ede9fe', color: '#5b21b6' },
  suspended:  { bg: '#fef3c7', color: '#92400e' },
  cancelled:  { bg: '#fee2e2', color: '#991b1b' },
  terminated: { bg: '#f3f4f6', color: '#6b7280' },
  expired:    { bg: '#fde68a', color: '#78350f' },
};

// ---------------------------------------------------------------------------
// New Contract Modal
// ---------------------------------------------------------------------------

const TODAY = localToday();

interface NewContractModalProps {
  plans: Plan[];
  isMxOrg: boolean;
  onClose: () => void;
  onCreated: (contractId: number) => void;
}

function NewContractModal({ plans, isMxOrg, onClose, onCreated }: NewContractModalProps) {
  const [form, setForm] = useState({
    client_id: '',
    plan_id: '',
    connection_type: 'pppoe',
    start_date: TODAY,
    billing_day: '1',
    ip_address: '',
    price_override: '',
    facturar: false,
    contract_template_mx_id: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  function setField(name: string, value: unknown) {
    setForm(prev => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.client_id || !form.plan_id || !form.start_date) {
      setError('Client, Plan, and Start Date are required.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const body: CreateContractBody = {
        client_id: Number(form.client_id),
        plan_id: Number(form.plan_id),
        connection_type: form.connection_type,
        start_date: form.start_date,
        billing_day: form.billing_day ? Math.min(28, Math.max(1, Number(form.billing_day))) : undefined,
        ip_address: form.ip_address || undefined,
        price_override: form.price_override ? Number(form.price_override) : undefined,
      };
      // `facturar` is an MX fiscal option. Omitting it outside MX keeps the
      // global contract payload free from SAT/CFDI-only fields.
      if (isMxOrg) {
        body.facturar = form.facturar;
        if (form.contract_template_mx_id) {
          body.contract_template_mx_id = Number(form.contract_template_mx_id);
        }
      }
      const contractId = await createContract(body);
      onCreated(contractId);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : 'Failed to create contract. Check all fields and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={modalStyles.backdrop} onClick={onClose}>
      <div
        style={modalStyles.panel}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <div style={modalStyles.header}>
          <h2 id="modal-title" style={modalStyles.title}>📄 New Contract</h2>
          <button
            style={modalStyles.closeBtn}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} style={modalStyles.form}>
          {/* Client */}
          {/* Search, not a <select>: the list returns at most 100 clients (FE-04). */}
          <ClientPicker
            label="Client"
            value={form.client_id ? Number(form.client_id) : ''}
            onChange={id => setField('client_id', id ? String(id) : '')}
          />

          {/* Plan */}
          <label style={modalStyles.label}>
            Plan <span style={{ color: '#ef4444' }}>*</span>
            <select
              style={modalStyles.select}
              value={form.plan_id}
              onChange={e => setField('plan_id', e.target.value)}
              required
            >
              <option value="">— select plan —</option>
              {plans.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>

          {/* Connection type */}
          <label style={modalStyles.label}>
            Connection Type
            <select
              style={modalStyles.select}
              value={form.connection_type}
              onChange={e => setField('connection_type', e.target.value)}
            >
              <option value="pppoe">PPPoE</option>
              <option value="pppoe_dual">PPPoE Dual</option>
              <option value="static">Static</option>
              <option value="dual">Dual</option>
            </select>
          </label>

          {/* Start date */}
          <label style={modalStyles.label}>
            Start Date <span style={{ color: '#ef4444' }}>*</span>
            <input
              style={modalStyles.input}
              type="date"
              value={form.start_date}
              onChange={e => setField('start_date', e.target.value)}
              required
            />
          </label>

          {/* Billing day */}
          <label style={modalStyles.label}>
            Billing Day (1–28)
            <input
              style={modalStyles.input}
              type="number"
              min={1}
              max={28}
              value={form.billing_day}
              onChange={e => setField('billing_day', e.target.value)}
              placeholder="e.g. 1"
            />
          </label>

          {/* IP address */}
          <label style={modalStyles.label}>
            IP Address
            <input
              style={modalStyles.input}
              type="text"
              value={form.ip_address}
              onChange={e => setField('ip_address', e.target.value)}
              placeholder="e.g. 192.168.1.100"
              maxLength={45}
            />
          </label>

          {/* Price override */}
          <label style={modalStyles.label}>
            Price Override (leave blank for plan default)
            <input
              style={modalStyles.input}
              type="number"
              min={0}
              step="0.01"
              value={form.price_override}
              onChange={e => setField('price_override', e.target.value)}
              placeholder="e.g. 350.00"
            />
          </label>

          {isMxOrg && (
            <MxRegisteredContractSourceField
              value={form.contract_template_mx_id}
              onChange={value => setField('contract_template_mx_id', value)}
              required={false}
              labelStyle={modalStyles.label}
              selectStyle={modalStyles.select}
            />
          )}

          {/* CFDI belongs to the MX jurisdiction only. */}
          {isMxOrg && (
            <label style={modalStyles.checkboxLabel}>
              <input
                type="checkbox"
                checked={form.facturar}
                onChange={e => setField('facturar', e.target.checked)}
              />
              Generate CFDI invoice automatically
            </label>
          )}

          {error && <p style={modalStyles.error}>{error}</p>}

          <div style={modalStyles.actions}>
            <button
              type="button"
              onClick={onClose}
              style={styles.btnSecondary}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              style={styles.btnPrimary}
              disabled={submitting}
            >
              {submitting ? 'Creating…' : 'Create Contract'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

interface ConfirmDialogProps {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div style={modalStyles.backdrop} onClick={onCancel}>
      <div
        style={{ ...modalStyles.panel, maxWidth: 380 }}
        onClick={e => e.stopPropagation()}
        role="alertdialog"
      >
        <p style={{ margin: '0 0 1.25rem', fontSize: '0.95rem', color: '#111827' }}>
          {message}
        </p>
        <div style={modalStyles.actions}>
          <button onClick={onCancel} style={styles.btnSecondary}>No, go back</button>
          <button onClick={onConfirm} style={styles.btnDanger}>Yes, confirm</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Renew modal (set new end date + activate)
// ---------------------------------------------------------------------------

interface RenewModalProps {
  contractId: number;
  contractEnvironment?: MxContractEnvironment | null;
  onClose: () => void;
  onRenewed: (result: ContractActionResult) => void;
}

function RenewModal({ contractId, contractEnvironment, onClose, onRenewed }: RenewModalProps) {
  const [endDate, setEndDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      // Use the dedicated /renew endpoint — PATCH {status:'active'} is blocked by
      // the DB FSM trigger for suspended/expired/cancelled contracts.
      const result = await postContractAction(contractId, 'renew', { end_date: endDate || null });
      onRenewed(result);
      onClose();
    } catch {
      setError('Failed to renew contract. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={modalStyles.backdrop} onClick={onClose}>
      <div
        style={{ ...modalStyles.panel, maxWidth: 380 }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="renew-title"
      >
        <div style={modalStyles.header}>
          <h2 id="renew-title" style={modalStyles.title}>🔄 Renew Contract</h2>
          {contractEnvironment && <MxContractEnvironmentBadge environment={contractEnvironment} />}
          <button style={modalStyles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>
        <form onSubmit={handleSubmit} style={modalStyles.form}>
          <MxSandboxDocumentBanner environment={contractEnvironment} />
          <label style={modalStyles.label}>
            New End Date (leave blank for month-to-month)
            <input
              style={modalStyles.input}
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
            />
          </label>
          {error && <p style={modalStyles.error}>{error}</p>}
          <div style={modalStyles.actions}>
            <button type="button" onClick={onClose} style={styles.btnSecondary} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" style={styles.btnPrimary} disabled={submitting}>
              {submitting ? 'Renewing…' : 'Renew'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit Contract Modal
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Contract Detail Modal — summary + PPPoE / RADIUS credentials
// ---------------------------------------------------------------------------

interface ContractDetailModalProps {
  contract: Contract;
  plans: Plan[];
  onClose: () => void;
}

/** One labelled value row with an optional Copy button. */
function CredentialRow({
  label,
  value,
  copyable,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  copyable?: string | null;
  mono?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!copyable) return;
    const ok = await copyToClipboard(copyable);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div style={detailStyles.credRow}>
      <span style={detailStyles.credLabel}>{label}</span>
      <span style={{ ...detailStyles.credValue, ...(mono ? detailStyles.mono : {}) }}>
        {value}
      </span>
      {copyable != null && copyable !== '' && (
        <button type="button" style={detailStyles.copyBtn} onClick={handleCopy} title={t('contractList.copy')}>
          {copied ? '✓' : `⧉ ${t('contractList.copy')}`}
        </button>
      )}
    </div>
  );
}

/**
 * A single PPPoE/RADIUS account block with a password reveal toggle.
 *
 * `passwordForbidden` is true when the caller has `devices.view` (so the
 * account itself is visible) but not `radius.credentials.view` — the
 * password field is replaced with an "insufficient permission" note instead
 * of hiding the whole account.
 */
function RadiusAccountCard({ account, passwordForbidden }: { account: RadiusAccount; passwordForbidden?: boolean }) {
  const { t } = useTranslation();
  const [showPw, setShowPw] = useState(false);

  const assignedIp = [account.ip_address, account.ipv6_address].filter(Boolean).join(' / ') || '—';
  const macVlan = [
    account.mac_address ? `MAC ${account.mac_address}` : null,
    account.vlan_id != null && account.vlan_id !== '' ? `VLAN ${account.vlan_id}` : null,
  ].filter(Boolean).join(' · ') || '—';

  return (
    <div style={detailStyles.accountCard}>
      <CredentialRow label={t('contractList.username')} value={account.username || '—'} copyable={account.username} mono />
      <CredentialRow
        label={t('contractList.password')}
        value={
          passwordForbidden ? (
            <span style={detailStyles.mono}>{t('contractList.passwordForbidden')}</span>
          ) : (
            <span style={detailStyles.mono}>
              {account.password == null
                ? '—'
                : showPw
                  ? account.password
                  : '•'.repeat(Math.min(12, Math.max(6, account.password.length)))}
              {account.password != null && (
                <button
                  type="button"
                  style={detailStyles.toggleBtn}
                  onClick={() => setShowPw(s => !s)}
                >
                  {showPw ? t('contractList.hidePassword') : t('contractList.showPassword')}
                </button>
              )}
            </span>
          )
        }
        copyable={passwordForbidden ? undefined : account.password}
      />
      <CredentialRow label={t('contractList.assignedIp')} value={assignedIp} copyable={assignedIp !== '—' ? assignedIp : null} mono />
      <CredentialRow label={t('contractList.table.status')} value={account.status ? <StatusBadge status={account.status} colors={STATUS_COLORS} /> : '—'} />
      <CredentialRow label={t('contractList.authMethod')} value={account.auth_method || '—'} />
      <CredentialRow label="MAC / VLAN" value={macVlan} mono />
      <CredentialRow label={t('contractList.table.plan')} value={account.profile || '—'} />
    </div>
  );
}

function ContractDetailModal({ contract, plans, onClose }: ContractDetailModalProps) {
  const { t } = useTranslation();
  const plan = plans.find(p => p.id === contract.plan_id);

  const radiusQ = useQuery({
    queryKey: ['radius-contract', contract.id],
    queryFn: () => fetchRadiusByContract(contract.id),
  });

  const accounts = radiusQ.data ?? [];
  const forbidden = radiusQ.error instanceof Error && radiusQ.error.message === RADIUS_FORBIDDEN;

  // Layered on top of the base (password-free) fetch above: only requested
  // once we know at least one account exists, so a caller without
  // radius.credentials.view doesn't take an extra guaranteed-403 round trip
  // when there's nothing to show credentials for anyway.
  const credentialsQ = useQuery({
    queryKey: ['radius-contract-credentials', contract.id],
    queryFn: () => fetchRadiusCredentials(contract.id),
    enabled: accounts.length > 0,
  });
  const credentialsForbidden = credentialsQ.error instanceof Error && credentialsQ.error.message === RADIUS_CREDENTIALS_FORBIDDEN;
  const passwordById = new Map((credentialsQ.data ?? []).map(c => [c.id, c.password]));

  return (
    <div style={modalStyles.backdrop} onClick={onClose}>
      <div
        style={modalStyles.panel}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="contract-detail-title"
      >
        <div style={modalStyles.header}>
          <h2 id="contract-detail-title" style={modalStyles.title}>
            🔑 {t('contractList.credentials')} — #{contract.id}
          </h2>
          {contract.mx_contract_environment && (
            <MxContractEnvironmentBadge environment={contract.mx_contract_environment} />
          )}
          <button style={modalStyles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <MxSandboxDocumentBanner environment={contract.mx_contract_environment} />

        {/* Contract summary */}
        <div style={detailStyles.summary}>
          <CredentialRow label={t('contractList.table.plan')} value={plan ? plan.name : `Plan #${contract.plan_id}`} />
          <CredentialRow label={t('contractList.table.type')} value={contract.connection_type || '—'} />
          <CredentialRow label={t('contractList.table.status')} value={<StatusBadge status={contract.status} colors={STATUS_COLORS} />} />
          <CredentialRow label={t('contractList.table.start')} value={fmt(contract.start_date)} />
          <CredentialRow label={t('contractList.table.end')} value={fmt(contract.end_date)} />
          <CredentialRow label={t('contractList.table.billingDay')} value={contract.billing_day ?? '—'} />
        </div>

        <h3 style={detailStyles.sectionTitle}>{t('contractList.credentials')}</h3>

        {radiusQ.isLoading ? (
          <p style={styles.msg}>{t('contractList.loading')}</p>
        ) : forbidden ? (
          <p style={modalStyles.error}>{t('contractList.credentialsForbidden')}</p>
        ) : radiusQ.error ? (
          <p style={modalStyles.error}>{t('contractList.credentialsError')}</p>
        ) : accounts.length === 0 ? (
          <p style={styles.msg}>{t('contractList.noRadius')}</p>
        ) : (
          accounts.map(acc => (
            <RadiusAccountCard
              key={acc.id}
              account={passwordById.has(acc.id) ? { ...acc, password: passwordById.get(acc.id) } : acc}
              passwordForbidden={credentialsForbidden && !passwordById.has(acc.id)}
            />
          ))
        )}

        <div style={modalStyles.actions}>
          <button type="button" onClick={onClose} style={styles.btnSecondary}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContractList component
// ---------------------------------------------------------------------------

type ConfirmAction =
  | { type: 'suspend'; contractId: number }
  | { type: 'terminate'; contractId: number }
  | { type: 'cancel'; contractId: number; pending: boolean }
  | { type: 'delete'; contractId: number };

const STATUS_OPTIONS = ['', 'active', 'pending', 'suspended', 'cancelled', 'terminated', 'expired'];

export function ContractList() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [statusFilter, setStatusFilter] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [renewContract, setRenewContract] = useState<Contract | null>(null);
  const [editContract, setEditContract] = useState<Contract | null>(null);
  const [detailContract, setDetailContract] = useState<Contract | null>(null);
  const [renewNetworkWarning, setRenewNetworkWarning] = useState<{ contractId: number; message: string } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const sort = useTableSort('created_at', 'DESC');
  const isMxOrg = user?.organization_locale === 'MX';

  useEffect(() => { setPage(1); }, [sort.sortBy, sort.sortDir]);

  // Mutation for terminate (uses dedicated endpoint)
  const terminateMutation = useMutation({
    mutationFn: ({ id }: { id: number }) =>
      postContractAction(id, 'terminate'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contracts.all });
    },
  });

  // Contracts query
  const contractsQ = useQuery({
    queryKey: queryKeys.contracts.list(page, pageSize, statusFilter, sort.sortBy, sort.sortDir),
    queryFn: () => fetchContracts(page, pageSize, statusFilter, sort.order_by, sort.order),
  });

  // Plans + clients (needed for new contract form)
  const plansQ = useQuery({
    queryKey: ['plans-lookup'],
    queryFn: fetchPlans,
    staleTime: 60_000,
  });


  // Mutation for suspend (uses dedicated CoA-disconnect endpoint)
  const suspendMutation = useMutation({
    mutationFn: ({ id }: { id: number }) =>
      postContractAction(id, 'suspend'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contracts.all });
    },
  });

  // Pending cancellation owns a linked activation SO/WO and temporary network
  // state, so it must use the canonical fail-closed activation command.
  const cancelMutation = useMutation({
    mutationFn: ({ id, pending }: { id: number; pending: boolean }) =>
      pending ? cancelPendingActivation(id) : patchContractStatus(id, 'cancelled'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contracts.all });
    },
  });

  // Mutation for soft-delete
  const deleteMutation = useMutation({
    mutationFn: ({ id }: { id: number }) => deleteContract(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contracts.all });
    },
  });

  function handleFilterChange(value: string) {
    setStatusFilter(value);
    setPage(1);
  }

  function handleConfirm() {
    if (!confirm) return;
    if (confirm.type === 'suspend') {
      suspendMutation.mutate({ id: confirm.contractId });
    } else if (confirm.type === 'terminate') {
      terminateMutation.mutate({ id: confirm.contractId });
    } else if (confirm.type === 'delete') {
      deleteMutation.mutate({ id: confirm.contractId });
    } else {
      cancelMutation.mutate({ id: confirm.contractId, pending: confirm.pending });
    }
    setConfirm(null);
  }

  const contracts = contractsQ.data?.data ?? [];
  const meta = contractsQ.data?.meta;
  // Names for the clients on this page (FE-04).
  const clientMap = useClientNames(contracts.map(c => c.client_id));

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>📄 {t('contractList.title')}</h1>
        {meta && <span style={styles.countBadge}>{meta.total} total</span>}
        <button
          style={{ ...styles.btnPrimary, marginLeft: 'auto' }}
          onClick={() => setShowNew(true)}
        >
          {t('contractList.newContract')}
        </button>
      </div>

      {/* Filters */}
      <div style={styles.filterRow}>
        <label style={styles.filterLabel}>{t('contractList.filterStatus')}</label>
        <select
          style={styles.filterSelect}
          value={statusFilter}
          onChange={e => handleFilterChange(e.target.value)}
        >
          {STATUS_OPTIONS.map(s => (
            <option key={s} value={s}>{s ? capitalizeStatus(s) : t('contractList.filterAll')}</option>
          ))}
        </select>
        {statusFilter && (
          <button
            type="button"
            style={styles.btnSecondary}
            onClick={() => handleFilterChange('')}
          >
            {t('contractList.clearFilter')}
          </button>
        )}
      </div>

      {/* Mutation error banner */}
      {(suspendMutation.isError || cancelMutation.isError || terminateMutation.isError || deleteMutation.isError) && (
        <p style={{ color: '#ef4444', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
          {t('contractList.actionFailed')}
        </p>
      )}
      {renewNetworkWarning && (
        <p style={{ color: '#92400e', marginBottom: '0.75rem', fontSize: '0.85rem' }} role="alert">
          {t('contractList.renewNetworkWarning', { warning: renewNetworkWarning.message })}{' '}
          <Link to={`/contracts/${renewNetworkWarning.contractId}`}>{t('contractList.openContractRetry')}</Link>
        </p>
      )}

      {/* Table */}
      <div style={styles.tableCard}>
        {contractsQ.isLoading ? (
          <p style={styles.msg}>{t('contractList.loading')}</p>
        ) : contractsQ.error ? (
          <p style={styles.msgError}>{t('contractList.error')}</p>
        ) : contracts.length === 0 ? (
          <p style={styles.msg}>{t('contractList.noContracts')}</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <SortableTh label={t('contractList.table.id')} col="id" sort={sort} style={styles.th} />
                    {/* Client name (non-sortable — from a JOIN); narrow ID column sorts by client_id */}
                    <th style={styles.th}>{t('contractList.table.client')}</th>
                    <th style={{ ...styles.th, width: 40 }}>{t('contractList.table.clientId')}</th>
                    {/* plan name comes from a JOIN → non-sortable; plan_id is real but less useful */}
                    <th style={styles.th}>{t('contractList.table.plan')}</th>
                    <SortableTh label={t('contractList.table.type')} col="connection_type" sort={sort} style={styles.th} />
                    <SortableTh label={t('contractList.table.start')} col="start_date" sort={sort} style={styles.th} />
                    <SortableTh label={t('contractList.table.end')} col="end_date" sort={sort} style={styles.th} />
                    <SortableTh label={t('contractList.table.billingDay')} col="billing_day" sort={sort} style={styles.th} />
                    <th style={styles.th}>{t('contractList.table.ip')}</th>
                    <th style={styles.th}>{t('contractList.table.environment')}</th>
                    <SortableTh label={t('contractList.table.status')} col="status" sort={sort} style={styles.th} />
                    <th style={styles.th}>{t('contractList.table.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map(c => (
                    <ContractRow
                      key={c.id}
                      contract={c}
                      plans={plansQ.data ?? []}
                      clientName={clientMap.get(c.client_id) ?? null}
                      onSuspend={() => setConfirm({ type: 'suspend', contractId: c.id })}
                      onTerminate={() => setConfirm({ type: 'terminate', contractId: c.id })}
                      onCancel={() => setConfirm({ type: 'cancel', contractId: c.id, pending: c.status === 'pending' })}
                      onRenew={() => setRenewContract(c)}
                      onEdit={() => setEditContract(c)}
                      onDelete={() => setConfirm({ type: 'delete', contractId: c.id })}
                      onCredentials={() => setDetailContract(c)}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <Pagination
              page={page}
              totalPages={meta?.totalPages ?? 1}
              total={meta?.total}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
            />
          </>
        )}
      </div>

      {/* Modals */}
      {showNew && plansQ.data && (
        <NewContractModal
          plans={plansQ.data}
          isMxOrg={isMxOrg}
          onClose={() => setShowNew(false)}
          onCreated={(contractId) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.contracts.all });
            navigate(`/contracts/${contractId}`);
          }}
        />
      )}

      {renewContract && (
        <RenewModal
          contractId={renewContract.id}
          contractEnvironment={renewContract.mx_contract_environment}
          onClose={() => setRenewContract(null)}
          onRenewed={(result) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.contracts.all });
            if (result.activation_required) navigate(`/contracts/${renewContract.id}`);
            else if (result.network_activation?.nas_push_error) {
              setRenewNetworkWarning({
                contractId: renewContract.id,
                message: result.network_activation.nas_push_error,
              });
            }
          }}
        />
      )}

      {editContract && plansQ.data && (
        <EditContractModal
          contract={editContract}
          plans={plansQ.data}
          isMxOrg={isMxOrg}
          onClose={() => setEditContract(null)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: queryKeys.contracts.all })}
        />
      )}

      {detailContract && (
        <ContractDetailModal
          contract={detailContract}
          plans={plansQ.data ?? []}
          onClose={() => setDetailContract(null)}
        />
      )}

      {confirm && (
        <ConfirmDialog
          message={
            confirm.type === 'suspend'
              ? 'Suspend this contract? The client will lose service.'
              : confirm.type === 'terminate'
                ? 'Terminate this contract? This permanently ends service and cannot be undone.'
              : confirm.type === 'delete'
                  ? 'Delete this contract? It will be soft-deleted and removed from the list.'
                  : confirm.pending
                    ? t('contractActivation.cancelActivationConfirm')
                    : 'Cancel this contract? This action is difficult to reverse.'
          }
          onConfirm={handleConfirm}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContractRow
// ---------------------------------------------------------------------------

interface ContractRowProps {
  contract: Contract;
  plans: Plan[];
  clientName: string | null;
  onSuspend: () => void;
  onTerminate: () => void;
  onCancel: () => void;
  onRenew: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onCredentials: () => void;
}

function ContractRow({ contract: c, plans, clientName, onSuspend, onTerminate, onCancel, onRenew, onEdit, onDelete, onCredentials }: ContractRowProps) {
  const { t } = useTranslation();
  const plan = plans.find(p => p.id === c.plan_id);

  const canSuspend = c.status === 'active';
  const canTerminate = c.status === 'active' || c.status === 'suspended';
  const canCancel = c.status !== 'cancelled' && c.status !== 'terminated' && c.status !== 'expired';
  const canRenew = c.status === 'suspended' || c.status === 'cancelled' || c.status === 'expired' || c.status === 'terminated';
  const canDelete = c.status === 'cancelled' || c.status === 'terminated' || c.status === 'expired';
  const isSandbox = c.mx_contract_environment === 'sandbox';

  return (
    <tr
      style={{ ...styles.tr, ...(isSandbox ? { background: '#fffbeb' } : {}) }}
      data-contract-environment={c.mx_contract_environment ?? undefined}
    >
      <td style={styles.td}>
        <Link
          to={`/contracts/${c.id}`}
          style={styles.idLink}
          title={t('contractList.view')}
        >
          #{c.id}
        </Link>
      </td>
      <td style={styles.td}>
        <Link
          to={`/clients/${c.client_id}`}
          style={{ color: 'var(--link)', textDecoration: 'none', fontWeight: 500 }}
        >
          {clientName ?? String(c.client_id)}
        </Link>
      </td>
      <td style={{ ...styles.td, color: 'var(--text-muted)', fontSize: '0.8rem', whiteSpace: 'nowrap', width: 40 }}>
        {c.client_id}
      </td>
      <td style={styles.td}>{plan ? plan.name : `Plan #${c.plan_id}`}</td>
      <td style={{ ...styles.td, textTransform: 'capitalize' }}>{c.connection_type || '—'}</td>
      <td style={styles.td}>{fmt(c.start_date)}</td>
      <td style={styles.td}>{fmt(c.end_date)}</td>
      <td style={styles.td}>{c.billing_day ?? '—'}</td>
      <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: '0.78rem' }}>{c.ip_address || '—'}</td>
      <td style={styles.td}>
        {c.mx_contract_environment
          ? <MxContractEnvironmentBadge environment={c.mx_contract_environment} />
          : '—'}
      </td>
      <td style={styles.td}><StatusBadge status={c.status} colors={STATUS_COLORS} /></td>
      <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
        <button
          style={styles.actionBtn}
          onClick={onCredentials}
          title={t('contractList.credentials')}
        >
          🔑 {t('contractList.credentials')}
        </button>
        <button
          style={styles.actionBtn}
          onClick={onEdit}
          title="Edit this contract"
        >
          ✏️ Edit
        </button>
        {c.status === 'pending' && (
          <Link
            to={`/contracts/${c.id}`}
            style={{ ...styles.actionBtn, display: 'inline-block', textDecoration: 'none', color: 'var(--accent)' }}
            title={t('contractList.activateHint')}
          >
            ▶ {t('contractList.activate')}
          </Link>
        )}
        {canRenew && (
          <button
            style={styles.actionBtn}
            onClick={onRenew}
            title="Reactivate this contract"
          >
            🔄 Renew
          </button>
        )}
        {canSuspend && (
          <button
            style={{ ...styles.actionBtn, color: '#92400e' }}
            onClick={onSuspend}
            title="Suspend this contract"
          >
            ⏸ Suspend
          </button>
        )}
        {canTerminate && (
          <button
            style={{ ...styles.actionBtn, color: '#991b1b' }}
            onClick={onTerminate}
            title="Permanently terminate this contract"
          >
            🚫 Terminate
          </button>
        )}
        {canCancel && (
          <button
            style={{ ...styles.actionBtn, color: '#991b1b' }}
            onClick={onCancel}
            title="Cancel this contract"
          >
            ✕ Cancel
          </button>
        )}
        {canDelete && (
          <button
            style={{ ...styles.actionBtn, color: '#991b1b' }}
            onClick={onDelete}
            title="Delete this contract"
          >
            🗑 Delete
          </button>
        )}
      </td>
    </tr>
  );
}


// Styles specific to the Contract Detail / credentials modal.
const detailStyles = {
  summary: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.35rem',
    paddingBottom: '0.75rem',
    borderBottom: '1px solid var(--border-subtle)',
    marginBottom: '0.75rem',
  },
  sectionTitle: {
    margin: '0 0 0.75rem',
    fontSize: '0.9rem',
    fontWeight: 700,
    color: 'var(--text-primary)',
  },
  accountCard: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.35rem',
    padding: '0.75rem',
    border: '1px solid var(--border-subtle)',
    borderRadius: 8,
    marginBottom: '0.75rem',
    background: 'var(--input-bg)',
  },
  credRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.5rem',
    flexWrap: 'wrap' as const,
    fontSize: '0.82rem',
  },
  credLabel: {
    minWidth: 110,
    color: 'var(--text-muted)',
    fontWeight: 600,
  },
  credValue: {
    color: 'var(--text-primary)',
    wordBreak: 'break-all' as const,
  },
  mono: {
    fontFamily: 'monospace',
    fontSize: '0.8rem',
  },
  copyBtn: {
    background: 'transparent',
    border: '1px solid var(--border-strong)',
    borderRadius: 5,
    cursor: 'pointer',
    fontSize: '0.72rem',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    padding: '1px 8px',
    marginLeft: 'auto',
  },
  toggleBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    fontSize: '0.72rem',
    fontWeight: 600,
    color: 'var(--link)',
    padding: '0 0 0 8px',
  },
};

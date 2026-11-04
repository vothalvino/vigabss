// =============================================================================
// VigaBSS 5.0 — PAC Providers
// =============================================================================
// Page at /pac-providers (MX orgs). Lists the PAC (Proveedor Autorizado de
// Certificación) configurations and lets an operator create/edit them —
// provider, environment, endpoint, credentials, status. Credentials are
// WRITE-ONLY: the API redacts them on read (has_username/has_password flags
// only), so the edit form shows "saved — leave blank to keep" and an empty
// field never overwrites a stored secret (same three-state pattern as the
// org Mail tab / BackupSettings).
// =============================================================================

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { api } from '@/api/client';
import { styles, capitalize, fmtDate, RequiredMark } from './crudStyles';
import { StatusBadge, type StatusColors } from '@/components/ui/StatusBadge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PacProvider {
  id: number;
  provider_name: string;
  label: string | null;
  environment: string;
  api_url: string | null;
  is_default: number | boolean;
  status: string;
  last_stamp_at: string | null;
  has_username?: boolean;
  has_password?: boolean;
  has_token?: boolean;
}

interface PacResponse {
  data: PacProvider[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

const DEFAULT_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

async function fetchProviders(page: number): Promise<PacResponse> {
  const query = { page, limit: DEFAULT_PAGE_SIZE };
  const res = await api.GET('/pac-providers', { params: { query: query } });
  if (res.error) throw new Error('Failed to load PAC providers');
  return res.data as unknown as PacResponse;
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

const STATUS_COLORS: StatusColors = {
  active: { bg: '#d1fae5', color: '#065f46' },
  inactive: { bg: '#f3f4f6', color: '#374151' },
};

function EnvBadge({ env }: { env: string }) {
  const isProd = env === 'production';
  return (
    <span
      style={{
        background: isProd ? '#fee2e2' : '#dbeafe',
        color: isProd ? '#991b1b' : '#1e40af',
        padding: '2px 8px',
        borderRadius: 12,
        fontSize: '0.72rem',
        fontWeight: 600,
        textTransform: 'capitalize',
      }}
    >
      {env}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Create / edit modal
// ---------------------------------------------------------------------------

const PROVIDERS = ['finkok', 'sw_sapien', 'digicel', 'comercio_digital', 'facturapi', 'other', 'simulator'];
// Known endpoints per provider+environment — prefilled, still editable.
const API_URL_PRESETS: Record<string, { sandbox?: string; production?: string }> = {
  sw_sapien: { sandbox: 'https://services.test.sw.com.mx', production: 'https://services.sw.com.mx' },
  finkok: { sandbox: 'https://demo-facturacion.finkok.com/servicios/soap', production: 'https://facturacion.finkok.com/servicios/soap' },
  simulator: { sandbox: 'https://simulator.invalid' },
};

interface PacModalProps {
  existing: PacProvider | null; // null = create
  onClose: () => void;
  onSaved: () => void;
}

function PacModal({ existing, onClose, onSaved }: PacModalProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState({
    provider_name: existing?.provider_name ?? 'sw_sapien',
    label: existing?.label ?? '',
    environment: existing?.environment ?? 'sandbox',
    seal_mode: (existing as { seal_mode?: string } | null)?.seal_mode ?? 'pac',
    priority: String((existing as { priority?: number } | null)?.priority ?? 100),
    api_url: existing?.api_url ?? API_URL_PRESETS.sw_sapien.sandbox ?? '',
    username: '',
    password: '',
    token: '',
    status: existing?.status ?? 'active',
  });
  const [error, setError] = useState('');
  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  // Changing provider/environment refreshes the endpoint preset — but never
  // clobbers a URL the operator already typed by hand for that combo.
  function applyPreset(provider: string, environment: string) {
    const preset = API_URL_PRESETS[provider]?.[environment as 'sandbox' | 'production'];
    if (preset) set('api_url', preset);
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, string | number> = {
        provider_name: form.provider_name,
        label: form.label.trim(),
        environment: form.environment,
        seal_mode: form.provider_name === 'finkok' ? 'local' : form.seal_mode,
        // priority is a NUMBER column — validate() does not coerce strings, so
        // sending form.priority verbatim 422s every save (review-confirmed).
        priority: Number.parseInt(form.priority, 10) || 100,
        api_url: form.api_url.trim(),
        status: form.status,
      };
      // Write-only three-state: blank = keep the stored credential.
      // The server encrypts these into the *_encrypted columns.
      if (form.username.trim()) body.username = form.username.trim();
      if (form.password.trim()) body.password = form.password.trim();
      if (form.token.trim()) body.token = form.token.trim();

      const res = existing
        ? await api.PUT('/pac-providers/{id}', { params: { path: { id: existing.id } }, body: body })
        : await api.POST('/pac-providers', { body: body });
      if ((res as { error?: { error?: { message?: string } } }).error) {
        const err = (res as { error?: { error?: { message?: string } } }).error;
        throw new Error(err?.error?.message ?? 'Save failed');
      }
    },
    onSuccess: () => { onSaved(); onClose(); },
    onError: (err: Error) => setError(err.message),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!form.label.trim() || !form.api_url.trim()) {
      setError('Label and API URL are required.');
      return;
    }
    if (form.provider_name === 'simulator' && form.environment !== 'sandbox') {
      setError("The simulator only runs with environment 'sandbox' — it never produces fiscally valid CFDIs.");
      return;
    }
    mutation.mutate();
  }

  const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 };
  const box: React.CSSProperties = { background: 'var(--bg-card, #fff)', borderRadius: 10, padding: '1.25rem 1.5rem', width: 520, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto' };
  const label: React.CSSProperties = { display: 'block', fontSize: '0.8rem', fontWeight: 600, margin: '0.6rem 0 0.2rem' };
  const input: React.CSSProperties = { width: '100%', padding: '6px 8px', border: '1px solid var(--border-color, #d1d5db)', borderRadius: 6, background: 'var(--bg-primary, #fff)', color: 'inherit', fontSize: '0.85rem' };

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={existing ? 'Edit PAC provider' : 'New PAC provider'}>
      <div style={box}>
        <h3 style={{ margin: '0 0 0.75rem' }}>{existing ? `Edit PAC provider #${existing.id}` : 'New PAC provider'}</h3>
        {error && <p style={{ ...styles.msgError, textAlign: 'left' }}>{error}</p>}
        <form onSubmit={submit}>
          <label style={label} htmlFor="pac-provider">{t('ui.pacProviderList.provider')}<RequiredMark /></label>
          <select id="pac-provider" style={input} value={form.provider_name}
            onChange={e => { set('provider_name', e.target.value); applyPreset(e.target.value, form.environment); }}>
            {PROVIDERS.map(p => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}
          </select>

          <label style={label} htmlFor="pac-label">{t('ui.pacProviderList.label')}<RequiredMark /></label>
          <input id="pac-label" style={input} maxLength={100} placeholder={t('ui.pacProviderList.swSapienSandbox')} value={form.label} onChange={e => set('label', e.target.value)} />

          <label style={label} htmlFor="pac-env">{t('ui.pacProviderList.environment')}<RequiredMark /></label>
          <select id="pac-env" style={input} value={form.environment}
            onChange={e => { set('environment', e.target.value); applyPreset(form.provider_name, e.target.value); }}>
            <option value="sandbox">{t('ui.pacProviderList.sandbox')}</option>
            <option value="production">{t('ui.pacProviderList.production')}</option>
          </select>

          <label style={label} htmlFor="pac-seal">{t('ui.pacProviderList.sealing')}</label>
          <select id="pac-seal" style={input} value={form.seal_mode} onChange={e => set('seal_mode', e.target.value)}>
            <option value="pac">{t('ui.pacProviderList.pacSealsEmisionCsdIn')}</option>
            <option value="local">{t('ui.pacProviderList.localSealingWeSealStamp')}</option>
          </select>
          {form.seal_mode === 'local' && (
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '4px 0 8px' }}>
              {t('ui.pacProviderList.vigabssSignsTheInvoiceWith')}<code>{t('ui.pacProviderList.cancelCsd')}</code>{t('ui.pacProviderList.finkokCerKeySoThe')}
            </p>
          )}

          <label style={label} htmlFor="pac-priority">{t('ui.pacProviderList.failoverPriority')}</label>
          <input id="pac-priority" style={input} type="number" min={0} max={1000} value={form.priority}
            onChange={e => set('priority', e.target.value)} />
          <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '2px 0 8px' }}>
            {t('ui.pacProviderList.lowerIsTriedFirstWith')}
          </p>

          <label style={label} htmlFor="pac-url">API URL <RequiredMark /></label>
          <input id="pac-url" style={{ ...input, fontFamily: 'monospace' }} maxLength={500} value={form.api_url} onChange={e => set('api_url', e.target.value)} />

          <label style={label} htmlFor="pac-user">{t('ui.pacProviderList.username')}</label>
          <input id="pac-user" style={input} maxLength={500} autoComplete="off"
            placeholder={existing?.has_username ? 'saved — leave blank to keep' : ''}
            value={form.username} onChange={e => set('username', e.target.value)} />

          <label style={label} htmlFor="pac-pass">{t('ui.pacProviderList.password')}</label>
          <input id="pac-pass" type="password" style={input} maxLength={500} autoComplete="new-password"
            placeholder={existing?.has_password ? 'saved — leave blank to keep' : ''}
            value={form.password} onChange={e => set('password', e.target.value)} />

          <label style={label} htmlFor="pac-token">{t('ui.pacProviderList.accessToken')}</label>
          <input id="pac-token" type="password" style={input} maxLength={2000} autoComplete="off"
            placeholder={existing?.has_token ? 'saved — leave blank to keep' : 'alternative to username + password'}
            value={form.token} onChange={e => set('token', e.target.value)} />
          <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: '2px 0 0' }}>
            {t('ui.pacProviderList.useEitherAnAccessToken')}
          </p>

          <label style={label} htmlFor="pac-status">{t('ui.pacProviderList.status')}</label>
          <select id="pac-status" style={input} value={form.status} onChange={e => set('status', e.target.value)}>
            <option value="active">{t('ui.pacProviderList.active')}</option>
            <option value="inactive">{t('ui.pacProviderList.inactive')}</option>
          </select>
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.4rem 0 0' }}>
            {t('ui.pacProviderList.stampingUsesTheNewest')}<strong>{t('ui.pacProviderList.active')}</strong> {t('ui.pacProviderList.providerForTheOrganization')}
          </p>

          <div style={{ display: 'flex', gap: 8, marginTop: '1.1rem', justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} disabled={mutation.isPending}
              style={{ background: 'var(--bg-card)', color: 'var(--text-secondary)', border: '1px solid var(--border-strong, #d1d5db)', padding: '7px 18px', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem' }}>
              {t('ui.pacProviderList.cancel')}
            </button>
            <button type="submit" disabled={mutation.isPending}
              style={{ background: 'var(--accent, #ea580c)', color: '#fff', border: 'none', padding: '7px 18px', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem' }}>
              {mutation.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fiscal environment switch — the single control that decides which PAC rows
// (sandbox vs production, each with its own credentials) actually stamp and
// cancel. Backed by /pac-providers/environment (org-scoped).
// ---------------------------------------------------------------------------

function FiscalEnvironmentBar() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);

  const envQ = useQuery({
    queryKey: ['pac-environment'],
    queryFn: async () => {
      const res = await api.GET('/pac-providers/environment');
      if ((res as { error?: unknown }).error) throw new Error('load failed');
      const data = (res.data as { data: { pac_environment: string; sandbox_vigente_count?: number } })?.data;
      return { env: data?.pac_environment ?? 'sandbox', sandboxVigente: Number(data?.sandbox_vigente_count ?? 0) };
    },
  });

  const setEnv = useMutation({
    mutationFn: async (value: string) => {
      const res = await api.PUT('/pac-providers/environment', { body: { pac_environment: value } });
      const e = (res as { error?: { error?: { message?: string } } }).error;
      if (e) throw new Error(e.error?.message || 'Could not change the fiscal environment.');
    },
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['pac-environment'] }); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : 'Could not change the fiscal environment.'),
  });

  const env = envQ.data?.env ?? 'sandbox';
  const sandboxVigente = envQ.data?.sandboxVigente ?? 0;
  const isProd = env === 'production';

  function onSelect(value: string) {
    if (value === env) return;
    // Guard the jump to live SAT stamping behind an explicit confirmation.
    // Sandbox CFDIs stamped so far stay sandbox: say how many (CFD-13).
    if (value === 'production' && !window.confirm(
      'Switch to PRODUCTION? CFDIs will be stamped against the real SAT with legal validity. '
      + 'Make sure your production PAC entries have real credentials and your active CSD is a real (non-test) certificate.'
      + (sandboxVigente > 0
        ? `\n\n${sandboxVigente} sandbox CFDI(s) still show as vigente. They were never registered at SAT: they stay marked sandbox, `
          + 'are left out of tax reports, do not block voiding their invoice, and are cancelled through a sandbox PAC.'
        : ''),
    )) return;
    setEnv.mutate(value);
  }

  return (
    <div style={{ background: isProd ? '#fffbeb' : 'var(--bg-secondary, #f8fafc)', border: `1px solid ${isProd ? '#fde68a' : 'var(--border-color, #e2e8f0)'}`, borderRadius: 8, padding: '10px 14px', margin: '4px 0 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{t('ui.pacProviderList.fiscalEnvironment')}</span>
        <select
          value={env}
          disabled={envQ.isLoading || setEnv.isPending}
          onChange={e => onSelect(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid var(--border-color, #d1d5db)', borderRadius: 6, background: 'var(--bg-primary, #fff)', color: 'inherit', fontSize: '0.85rem', fontWeight: 600 }}
        >
          <option value="sandbox">{t('ui.pacProviderList.sandboxTesting')}</option>
          <option value="production">{t('ui.pacProviderList.productionLiveSat')}</option>
        </select>
        <span style={{ fontSize: '0.8rem', color: isProd ? '#92400e' : 'var(--text-muted)' }}>
          {setEnv.isPending ? 'Saving…' : isProd
            ? 'Live: stamping real, legally-valid CFDIs against the SAT.'
            : 'Testing: CFDIs are not fiscally valid.'}
        </span>
      </div>
      <p style={{ margin: '8px 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        {t('ui.pacProviderList.onlyProvidersWhose')}<strong>{t('ui.pacProviderList.environment2')}</strong> {t('ui.pacProviderList.matchesThisSettingStampAnd')}{' '}
        <strong>{t('ui.pacProviderList.failoverPriority2')}</strong> {t('ui.pacProviderList.firstTheRestAsBackups')}
      </p>
      {err && <p style={{ margin: '6px 0 0', fontSize: '0.8rem', color: '#991b1b' }}>{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Automatic stamping (BIL-33): the scheduled billing run stamps each invoice
// it generates. Off by default. Backed by /pac-providers/auto-stamp.
// ---------------------------------------------------------------------------

function AutoStampBar() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['cfdi-auto-stamp'],
    queryFn: async () => {
      const res = await api.GET('/pac-providers/auto-stamp');
      if ((res as { error?: unknown }).error) throw new Error('load failed');
      return Boolean((res.data as { data: { cfdi_auto_stamp: boolean } })?.data?.cfdi_auto_stamp);
    },
  });
  const save = useMutation({
    mutationFn: async (value: boolean) => {
      const res = await api.PUT('/pac-providers/auto-stamp', { body: { cfdi_auto_stamp: value } });
      const e = (res as { error?: { error?: { message?: string } } }).error;
      if (e) throw new Error(e.error?.message || t('cfdiAutoStamp.saveFailed'));
    },
    onSuccess: () => { setErr(null); qc.invalidateQueries({ queryKey: ['cfdi-auto-stamp'] }); },
    onError: (e: unknown) => setErr(e instanceof Error ? e.message : t('cfdiAutoStamp.saveFailed')),
  });
  const on = q.data ?? false;
  return (
    <div style={{ border: '1px solid var(--border-color, #e2e8f0)', borderRadius: 8, padding: '10px 14px', margin: '0 0 12px' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={on}
          disabled={q.isLoading || save.isPending}
          onChange={e => save.mutate(e.target.checked)}
        />
        {t('cfdiAutoStamp.label')}
      </label>
      <p style={{ margin: '6px 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>{t('cfdiAutoStamp.hint')}</p>
      {err && <p style={{ margin: '6px 0 0', fontSize: '0.8rem', color: '#991b1b' }}>{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PacProviderList component
// ---------------------------------------------------------------------------

export function PacProviderList() {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<{ open: boolean; existing: PacProvider | null }>({ open: false, existing: null });
  const qc = useQueryClient();

  const providersQ = useQuery({
    queryKey: ['pac-providers', page],
    queryFn: () => fetchProviders(page),
  });

  const providers = providersQ.data?.data ?? [];
  const meta = providersQ.data?.meta;
  const totalPages = meta?.totalPages ?? 1;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('ui.pacProviderList.pacProviders')}</h1>
        {meta && <span style={styles.countBadge}>{meta.total} {t('ui.pacProviderList.total')}</span>}
        <button
          onClick={() => setModal({ open: true, existing: null })}
          style={{ marginLeft: 'auto', background: 'var(--accent, #ea580c)', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem' }}
        >
          {t('ui.pacProviderList.newProvider')}
        </button>
      </div>

      <FiscalEnvironmentBar />
      <AutoStampBar />

      <div style={styles.tableCard}>
        {providersQ.isLoading ? (
          <p style={styles.msg}>{t('ui.pacProviderList.loading')}</p>
        ) : providersQ.error ? (
          <p style={styles.msgError}>{t('ui.pacProviderList.failedToLoadPacProviders')}</p>
        ) : providers.length === 0 ? (
          <p style={styles.msg}>{t('ui.pacProviderList.noPacProvidersConfiguredAdd')}</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    {['ID', 'Provider', 'Label', 'Environment', 'API URL', 'Default', 'Status', 'Last Stamp', ''].map(
                      h => <th key={h} style={styles.th}>{h}</th>,
                    )}
                  </tr>
                </thead>
                <tbody>
                  {providers.map(p => (
                    <tr key={p.id} style={styles.tr}>
                      <td style={styles.td}>#{p.id}</td>
                      <td style={{ ...styles.td, fontWeight: 500, textTransform: 'capitalize' }}>
                        {p.provider_name?.replace(/_/g, ' ')}
                      </td>
                      <td style={styles.td}>{p.label ?? '—'}</td>
                      <td style={styles.td}><EnvBadge env={p.environment} /></td>
                      <td style={{ ...styles.td, maxWidth: 280, overflowWrap: 'anywhere', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                        {p.api_url ?? '—'}
                      </td>
                      <td style={styles.td}>{p.is_default ? '⭐' : '—'}</td>
                      <td style={styles.td}><StatusBadge status={p.status} colors={STATUS_COLORS} /></td>
                      <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>{p.last_stamp_at ? fmtDate(p.last_stamp_at) : '—'}</td>
                      <td style={styles.td}>
                        <button
                          onClick={() => setModal({ open: true, existing: p })}
                          style={{ background: 'transparent', border: '1px solid var(--border-strong, #d1d5db)', borderRadius: 6, padding: '3px 12px', cursor: 'pointer', fontSize: '0.78rem', color: 'var(--text-secondary)' }}
                        >
                          {t('ui.pacProviderList.edit')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div style={styles.pagination}>
                <button style={styles.pageBtn} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                  {t('ui.pacProviderList.prev')}
                </button>
                <span style={styles.pageInfo}>{t('ui.pacProviderList.page')}{page} {t('ui.pacProviderList.of')}{totalPages}</span>
                <button
                  style={styles.pageBtn}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  {t('ui.pacProviderList.next')}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <p style={{ ...styles.msg, textAlign: 'left', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        {capitalize('credentials are write-only: they are encrypted at rest and never shown again after saving.')}
      </p>

      {modal.open && (
        <PacModal
          existing={modal.existing}
          onClose={() => setModal({ open: false, existing: null })}
          onSaved={() => qc.invalidateQueries({ queryKey: ['pac-providers'] })}
        />
      )}
    </div>
  );
}

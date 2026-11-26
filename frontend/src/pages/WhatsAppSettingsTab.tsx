// =============================================================================
// VigaBSS 5.0 — WhatsApp connection settings (a tab of AI Support → Settings)
// =============================================================================
// The Meta WhatsApp Cloud API connection: which number sends, the token it
// sends with, the secret that authenticates Meta's webhook calls and the token
// for Meta's verification handshake. It also shows the webhook URL to paste
// into Meta. Install operator only — the API answers 403 to anyone else and
// this tab says so.
//
// Secrets are write-only. The server reports whether each is set and where it
// comes from; a blank field leaves the stored value as it is.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch, ApiRequestError } from '@/api/apiFetch';
import { VoiceNotesStatus } from './aiSettings/VoiceNotesStatus';

type Source = 'settings' | 'environment' | null;

interface WhatsAppView {
  phone_number_id: string;
  business_number: string;
  has_access_token: boolean;
  has_app_secret: boolean;
  has_verify_token: boolean;
  sources: Record<string, Source>;
  webhook_url: string;
  graph_version: string;
  can_receive: boolean;
  can_send: boolean;
  /** The last reply Meta refused, while replies are failing. */
  send_failure?: { message: string; auth: boolean; since: string; last: string; count: number } | null;
}

interface TestResult {
  ok: boolean;
  display_phone_number?: string | null;
  verified_name?: string | null;
  error?: string;
}

const SECRET_FIELDS = ['access_token', 'app_secret', 'verify_token'] as const;
type SecretField = typeof SECRET_FIELDS[number];
const HAS: Record<SecretField, 'has_access_token' | 'has_app_secret' | 'has_verify_token'> = {
  access_token: 'has_access_token', app_secret: 'has_app_secret', verify_token: 'has_verify_token',
};

const EMPTY_SECRETS: Record<SecretField, string> = { access_token: '', app_secret: '', verify_token: '' };

export function WhatsAppSettingsTab() {
  const { t } = useTranslation();
  const [view, setView] = useState<WhatsAppView | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [businessNumber, setBusinessNumber] = useState('');
  const [secrets, setSecrets] = useState(EMPTY_SECRETS);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [copied, setCopied] = useState(false);

  const show = useCallback((v: WhatsAppView) => {
    setView(v);
    setPhoneNumberId(v.phone_number_id || '');
    setBusinessNumber(v.business_number || '');
    setSecrets(EMPTY_SECRETS);
  }, []);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ data: WhatsAppView }>('/whatsapp-settings')
      .then((res) => { if (!cancelled) show(res.data); })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiRequestError && err.status === 403) setForbidden(true);
        else setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, [show]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!view) return;
    setSaving(true); setSaveError(''); setSaved(false); setTestResult(null);
    // Only what changed: a blank secret means "keep the one that is set".
    const body: Record<string, string> = {};
    if (phoneNumberId.trim() !== (view.phone_number_id || '')) body.phone_number_id = phoneNumberId.trim();
    if (businessNumber.trim() !== (view.business_number || '')) body.business_number = businessNumber.trim();
    for (const field of SECRET_FIELDS) if (secrets[field].trim()) body[field] = secrets[field].trim();
    try {
      const res = await apiFetch<{ data: WhatsAppView }>('/whatsapp-settings', { method: 'PUT', body: JSON.stringify(body) });
      show(res.data);
      setSaved(true);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true); setTestResult(null);
    try {
      const res = await apiFetch<{ data: TestResult }>('/whatsapp-settings/test', { method: 'POST' });
      setTestResult(res.data);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  async function copyWebhookUrl() {
    if (!view) return;
    try {
      await navigator.clipboard.writeText(view.webhook_url);
      setCopied(true);
    } catch { /* clipboard unavailable: the URL is selectable */ }
  }

  if (forbidden) return <p style={sty.muted}>{t('whatsappSettings.operatorOnly')}</p>;
  if (loadError) return <p role="alert" style={sty.error}>{loadError}</p>;
  if (!view) return <p style={sty.muted}>{t('whatsappSettings.loading')}</p>;

  const sourceNote = (field: string) => (view.sources[field] === 'environment'
    ? <span style={sty.hint}> {t('whatsappSettings.fromEnvironment')}</span> : null);

  return (
    <form onSubmit={handleSave} style={sty.form}>
      <h3 style={sty.title}>{t('whatsappSettings.title')}</h3>
      <p style={sty.muted}>{t('whatsappSettings.intro')}</p>

      {view.send_failure && (
        <div role="alert" style={sty.failure}>
          <strong>{t('whatsappSettings.sendFailure.title')}</strong>{' '}
          {t('whatsappSettings.sendFailure.detail', {
            count: view.send_failure.count,
            since: new Date(view.send_failure.since).toLocaleString(),
            message: view.send_failure.message,
          })}{' '}
          {view.send_failure.auth && t('whatsappSettings.sendFailure.authHint')}
        </div>
      )}
      <VoiceNotesStatus />
      <div style={sty.statusRow}>
        <span style={{ ...sty.pill, background: view.can_receive ? '#16a34a' : '#b45309' }}>
          {view.can_receive ? t('whatsappSettings.status.canReceive') : t('whatsappSettings.status.cannotReceive')}
        </span>
        <span style={{ ...sty.pill, background: view.can_send ? '#16a34a' : '#b45309' }}>
          {view.can_send ? t('whatsappSettings.status.canSend') : t('whatsappSettings.status.cannotSend')}
        </span>
      </div>

      <fieldset style={sty.fieldset}>
        <legend style={sty.legend}>{t('whatsappSettings.webhook.legend')}</legend>
        <p style={sty.muted}>{t('whatsappSettings.webhook.help')}</p>
        <div style={sty.inline}>
          <code style={sty.code} data-testid="whatsapp-webhook-url">{view.webhook_url}</code>
          <button type="button" style={sty.btnGhost} onClick={copyWebhookUrl}>
            {copied ? t('whatsappSettings.webhook.copied') : t('whatsappSettings.webhook.copy')}
          </button>
        </div>
      </fieldset>

      <label style={sty.label}>
        <span>{t('whatsappSettings.fields.phoneNumberId')}{sourceNote('phone_number_id')}</span>
        <input style={sty.input} inputMode="numeric" autoComplete="off" value={phoneNumberId}
          onChange={e => setPhoneNumberId(e.target.value)} />
        <span style={sty.hint}>{t('whatsappSettings.fields.phoneNumberIdHelp')}</span>
      </label>

      <label style={sty.label}>
        <span>{t('whatsappSettings.fields.businessNumber')}{sourceNote('business_number')}</span>
        <input style={sty.input} inputMode="tel" autoComplete="off" value={businessNumber}
          onChange={e => setBusinessNumber(e.target.value)} />
        <span style={sty.hint}>{t('whatsappSettings.fields.businessNumberHelp')}</span>
      </label>

      {SECRET_FIELDS.map(field => (
        <label key={field} style={sty.label}>
          <span>
            {t(`whatsappSettings.fields.${field}`)}
            <span style={sty.hint}>
              {' '}{view[HAS[field]] ? t('whatsappSettings.secretSet') : t('whatsappSettings.secretNotSet')}
            </span>
            {sourceNote(field)}
          </span>
          <input style={sty.input} type="password" autoComplete="new-password" value={secrets[field]}
            placeholder={view[HAS[field]] ? t('whatsappSettings.secretKeep') : ''}
            onChange={e => setSecrets(prev => ({ ...prev, [field]: e.target.value }))} />
          <span style={sty.hint}>{t(`whatsappSettings.fields.${field}Help`)}</span>
        </label>
      ))}

      {saveError && <p role="alert" style={sty.error}>{saveError}</p>}
      {saved && <p role="status" style={sty.success}>{t('whatsappSettings.saved')}</p>}

      <div style={sty.actions}>
        <button type="submit" style={sty.btnPrimary} disabled={saving}>
          {saving ? t('whatsappSettings.saving') : t('whatsappSettings.save')}
        </button>
        <button type="button" style={sty.btnGhost} onClick={handleTest} disabled={testing || !view.can_send}>
          {testing ? t('whatsappSettings.testing') : t('whatsappSettings.test')}
        </button>
      </div>

      {testResult && (
        <p role="status" style={testResult.ok ? sty.success : sty.error}>
          {testResult.ok
            ? t('whatsappSettings.testOk', {
              name: testResult.verified_name || '—', number: testResult.display_phone_number || '—',
            })
            : t('whatsappSettings.testFailed', { reason: testResult.error || '' })}
        </p>
      )}
      <p style={sty.hint}>{t('whatsappSettings.testNote')}</p>
    </form>
  );
}

const sty = {
  form: { display: 'flex', flexDirection: 'column' as const, gap: 14, maxWidth: 640 },
  title: { margin: 0, fontSize: '1rem', fontWeight: 600 },
  muted: { margin: 0, color: 'var(--text-muted)', fontSize: '0.875rem' },
  hint: { fontWeight: 400, color: 'var(--text-faint)', fontSize: '0.8rem' },
  label: { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' },
  input: { padding: '0.45rem 0.65rem', border: '1px solid var(--input-border)', borderRadius: 6, fontSize: '0.875rem', width: '100%', boxSizing: 'border-box' as const },
  fieldset: { border: '1px solid var(--border-subtle)', borderRadius: 6, padding: '0.75rem 1rem', margin: 0, display: 'flex', flexDirection: 'column' as const, gap: 8 },
  legend: { fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', padding: '0 4px' },
  inline: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const },
  code: { background: 'var(--bg-subtle)', padding: '4px 8px', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.82rem', wordBreak: 'break-all' as const },
  statusRow: { display: 'flex', gap: 8, flexWrap: 'wrap' as const },
  pill: { padding: '2px 10px', borderRadius: 10, fontSize: '0.75rem', fontWeight: 600, color: '#fff' },
  actions: { display: 'flex', gap: 8, flexWrap: 'wrap' as const },
  btnPrimary: { padding: '0.4rem 1rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.875rem' },
  btnGhost: { padding: '0.4rem 1rem', background: 'var(--bg-body)', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer', fontSize: '0.875rem' },
  error: { color: 'var(--danger)', fontSize: '0.85rem', margin: 0 },
  failure: { background: 'var(--danger-soft)', color: 'var(--danger)', border: '1px solid var(--danger-border)', borderRadius: 6, padding: '0.6rem 0.8rem', fontSize: '0.875rem', lineHeight: 1.5 },
  success: { color: '#16a34a', fontSize: '0.85rem', margin: 0 },
};

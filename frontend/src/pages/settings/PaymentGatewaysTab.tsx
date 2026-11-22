// =============================================================================
// VigaBSS 5.0 — Settings: Payment Gateways tab
// =============================================================================
// CRUD on payment gateways via /api/v1/payment-gateways. Whether the install
// takes test or live keys is the server's PAYMENT_MODE, shown here as a banner;
// a Stripe gateway's environment is read from its key by the server.
// =============================================================================

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/api/apiFetch';
import { gatewayPayload, type GatewayForm } from '../paymentGatewayPayload';
import { sty, Modal, ConfirmDialog, channelBadge, statusBadge } from './shared';

const API_BASE = '/api/v1';
const PROVIDERS = ['stripe', 'conekta', 'openpay', 'mercadopago', 'paypal', 'manual', 'other'];
const ENVIRONMENTS = ['sandbox', 'production'];

interface PaymentGateway {
  id: number;
  provider: string;
  name: string;
  environment: string;
  public_key: string | null;
  // Secrets are write-only: the API only says whether one is stored.
  has_secret_key: boolean;
  has_webhook_secret: boolean;
  status: string;
  organization_id?: number | null;
  created_at: string;
}

const testBanner = {
  background: '#fef3c7', color: '#92400e', border: '1px solid #f59e0b', borderRadius: 6,
  padding: '0.5rem 0.75rem', fontSize: '0.875rem', fontWeight: 600, margin: '0 0 1rem',
};
const okText = { color: '#16a34a', fontSize: '0.85rem', margin: '0 0 0.75rem' };

const EMPTY_GW: GatewayForm = {
  provider: 'stripe', name: '', environment: 'sandbox',
  public_key: '', secret_key: '', webhook_secret: '', status: 'active',
};

export function PaymentGatewaysTab() {
  const { t } = useTranslation();
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<PaymentGateway | null>(null);
  const [form, setForm] = useState({ ...EMPTY_GW });
  const [formError, setFormError] = useState('');
  const [copied, setCopied] = useState<null | 'ok' | 'fail'>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<{ id: number; ok: boolean; mode?: string; error?: string } | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const qc = useQueryClient();

  // Whether this install takes test or live keys (PAYMENT_MODE on the server).
  const { data: modeData } = useQuery({
    queryKey: ['payment-gateways', 'mode'],
    queryFn: () => apiFetch<{ data: { payment_mode: 'test' | 'live' } }>(`${API_BASE}/payment-gateways/mode`),
  });
  const testMode = modeData?.data.payment_mode === 'test';
  const keyPrefix = testMode ? 'sk_test_…' : 'sk_live_…';

  async function handleTest(id: number) {
    setTestingId(id); setTestResult(null);
    try {
      const res = await apiFetch<{ data: { ok: boolean; mode?: string; error?: string } }>(
        `${API_BASE}/payment-gateways/${id}/test`, { method: 'POST' });
      setTestResult({ id, ...res.data });
    } catch (err) {
      setTestResult({ id, ok: false, error: (err as Error).message });
    } finally { setTestingId(null); }
  }

  const { data, isLoading, error } = useQuery({
    queryKey: ['payment-gateways'],
    queryFn: () =>
      apiFetch<{ data: PaymentGateway[]; meta: { total: number } }>(`${API_BASE}/payment-gateways?limit=100`),
  });

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, string>) =>
      editing
        ? apiFetch(`${API_BASE}/payment-gateways/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) })
        : apiFetch(`${API_BASE}/payment-gateways`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payment-gateways'] }); closeModal(); },
    onError: (err: Error) => setFormError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`${API_BASE}/payment-gateways/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['payment-gateways'] }); setDeleteId(null); },
  });

  function openNew() { setEditing(null); setForm({ ...EMPTY_GW }); setFormError(''); setShowModal(true); }
  function openEdit(gw: PaymentGateway) {
    setEditing(gw);
    setForm({
      provider: gw.provider, name: gw.name ?? '', environment: gw.environment,
      public_key: gw.public_key ?? '', secret_key: '',
      webhook_secret: '', status: gw.status,
    });
    setFormError(''); setShowModal(true);
  }
  function closeModal() { setShowModal(false); setEditing(null); }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError('');
    saveMutation.mutate(gatewayPayload(form));
  }

  const gateways = data?.data ?? [];

  return (
    <div>
      <div style={sty.tabBar}>
        <h3 style={sty.sectionTitle}>{t('ui.settings.paymentGateways')}</h3>
        <button style={sty.btnPrimary} onClick={openNew}>{t('ui.settings.addGateway')}</button>
      </div>

      {testMode && <p role="status" style={testBanner}>{t('paymentMode.testBanner')}</p>}
      {testResult && (
        <p role="status" style={testResult.ok ? okText : sty.errorText}>
          {testResult.ok
            ? t('paymentMode.testOk', { mode: t(testResult.mode === 'live' ? 'paymentMode.live' : 'paymentMode.test') })
            : t('paymentMode.testFailed', { error: testResult.error ?? '' })}
        </p>
      )}
      {isLoading && <p style={sty.muted}>{t('ui.settings.loadingGateways')}</p>}
      {error && <p style={sty.errorText}>{t('ui.settings.failedToLoadPaymentGateways')}</p>}
      {!isLoading && gateways.length === 0 && <p style={sty.muted}>{t('ui.settings.noPaymentGatewaysConfigured')}</p>}

      {gateways.length > 0 && (
        <table style={sty.table}>
          <thead>
            <tr>{['Provider', 'Name', 'Environment', 'Secret key', 'Webhook secret', 'Status', ''].map(h => <th key={h} style={sty.th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {gateways.map(gw => (
              <tr key={gw.id}>
                <td style={sty.td}><span style={channelBadge(gw.provider)}>{gw.provider}</span></td>
                <td style={sty.td}>{gw.name}</td>
                <td style={sty.td}>
                  {gw.provider === 'stripe'
                    ? <span style={{ ...sty.badge, background: gw.environment === 'sandbox' ? '#b45309' : '#16a34a' }}>
                        {t(gw.environment === 'sandbox' ? 'paymentMode.test' : 'paymentMode.live')}
                      </span>
                    : gw.environment}
                </td>
                <td style={sty.td}>{gw.has_secret_key ? 'Set' : <em style={sty.muted}>{t('ui.settings.notSet')}</em>}</td>
                <td style={sty.td}>{gw.has_webhook_secret ? 'Set' : <em style={sty.muted}>{t('ui.settings.notSet')}</em>}</td>
                <td style={sty.td}><span style={statusBadge(gw.status)}>{gw.status}</span></td>
                <td style={sty.td}>
                  <span style={sty.rowActions}>
                    {gw.provider === 'stripe' && gw.has_secret_key && (
                      <button style={sty.btnGhost} onClick={() => handleTest(gw.id)} disabled={testingId === gw.id}>
                        {testingId === gw.id ? t('paymentMode.testing') : t('paymentMode.testConnection')}
                      </button>
                    )}
                    <button style={sty.btnGhost} onClick={() => openEdit(gw)}>{t('ui.settings.edit')}</button>
                    <button style={sty.btnDanger} onClick={() => setDeleteId(gw.id)}>{t('ui.settings.delete')}</button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showModal && (
        <Modal title={editing ? 'Edit Gateway' : 'Add Payment Gateway'} onClose={closeModal}>
          <form onSubmit={handleSubmit} style={sty.form}>
            <div style={sty.row2}>
              <label style={sty.label}>{t('ui.settings.provider')}
                <select style={sty.select} value={form.provider} disabled={!!editing}
                  onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}>
                  {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                {editing && <span style={sty.hint}>{t('ui.settings.providerIsFixedForAn')}</span>}
              </label>
              <label style={sty.label}>{t('ui.settings.name')}
                <input style={sty.input} value={form.name} placeholder={t('ui.settings.eGStripeMx')} required maxLength={100}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </label>
            </div>
            <div style={sty.row2}>
              {form.provider === 'stripe' ? (
                // A Stripe key says whether it is test or live: nothing to choose.
                <div style={sty.label}>{t('ui.settings.environment')}
                  <span style={sty.hint}>{t('paymentMode.envFromKey')}</span>
                </div>
              ) : (
                <label style={sty.label}>{t('ui.settings.environment')}
                  <select style={sty.select} value={form.environment} onChange={e => setForm(f => ({ ...f, environment: e.target.value }))}>
                    {ENVIRONMENTS.map(env => <option key={env} value={env}>{env}</option>)}
                  </select>
                </label>
              )}
              <label style={sty.label}>{t('ui.settings.status')}
                <select style={sty.select} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                  <option value="active">{t('ui.settings.active')}</option>
                  <option value="inactive">{t('ui.settings.inactive')}</option>
                </select>
              </label>
            </div>
            <label style={sty.label}>{t('ui.settings.publicKey')}
              <input style={sty.input} value={form.public_key} placeholder={t('ui.settings.pkLive')}
                onChange={e => setForm(f => ({ ...f, public_key: e.target.value }))} />
            </label>
            <label style={sty.label}>
              {t('ui.settings.secretKey')}{editing?.has_secret_key && <span style={sty.hint}>{t('ui.settings.leaveBlankToKeepExisting')}</span>}
              <input style={sty.input} type="password" value={form.secret_key} autoComplete="new-password"
                placeholder={editing?.has_secret_key ? '••••••••' : form.provider === 'stripe' ? keyPrefix : ''}
                onChange={e => setForm(f => ({ ...f, secret_key: e.target.value }))} />
            </label>
            <label style={sty.label}>
              {form.provider === 'conekta' ? 'Webhook Public Key (PEM)' : 'Webhook Secret'}
              {editing?.has_webhook_secret && <span style={sty.hint}> {t('ui.settings.leaveBlankToKeepExisting2')}</span>}
              {form.provider === 'conekta' ? (
                // Conekta signs webhooks with RSA; the verifier needs the
                // multi-line public key from POST /webhook_keys.
                <textarea style={{ ...sty.input, minHeight: 96, fontFamily: 'monospace' }} value={form.webhook_secret}
                  placeholder={editing?.has_webhook_secret ? '••••••••' : '-----BEGIN PUBLIC KEY-----'}
                  onChange={e => setForm(f => ({ ...f, webhook_secret: e.target.value }))} />
              ) : (
                <input style={sty.input} type="password" value={form.webhook_secret} autoComplete="new-password"
                  placeholder={editing?.has_webhook_secret ? '••••••••' : 'whsec_…'}
                  onChange={e => setForm(f => ({ ...f, webhook_secret: e.target.value }))} />
              )}
            </label>
            {editing && (editing.provider === 'stripe' || editing.provider === 'conekta') && (() => {
              // Organization-scoped URL: the event is processed in this
              // organization's own database when it has one (WHK-11).
              const webhookUrl = editing.organization_id
                ? `${window.location.origin}/api/v1/payment-webhooks/${editing.provider}/${editing.organization_id}/${editing.id}`
                : `${window.location.origin}/api/v1/payment-webhooks/${editing.provider}/${editing.id}`;
              return (
                <div style={sty.label}>
                  <span>{t('ui.settings.webhookUrl')}<span style={sty.hint}>{t('ui.settings.pasteIntoYour')}{editing.provider} {t('ui.settings.dashboard')}</span></span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <code style={{ ...sty.code, flex: 1, overflowX: 'auto', whiteSpace: 'nowrap' }}>{webhookUrl}</code>
                    <button type="button" style={sty.btnGhost} onClick={async () => {
                      try {
                        if (!navigator.clipboard) throw new Error('clipboard unavailable');
                        await navigator.clipboard.writeText(webhookUrl);
                        setCopied('ok');
                      } catch {
                        setCopied('fail');  // e.g. plain-HTTP admin panel — the URL above is selectable
                      }
                      setTimeout(() => setCopied(null), 2000);
                    }}>{copied === 'ok' ? 'Copied!' : copied === 'fail' ? 'Select it ↑' : 'Copy'}</button>
                  </div>
                  <span style={sty.hint}>{t('ui.settings.setThisAsTheWebhook')}{editing.provider}{t('ui.settings.thenPasteTheSigningSecret')}</span>
                  <span style={sty.hint}>
                    {t('ui.settings.subscribeItTo')}{editing.provider === 'stripe'
                      ? 'checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed, checkout.session.expired, payment_intent.succeeded, payment_intent.payment_failed, charge.refunded, charge.dispute.created, charge.dispute.closed'
                      : 'order.paid, order.payment_failed, charge.refunded, charge.chargeback.created'}
                  </span>
                </div>
              );
            })()}
            {formError && <p style={sty.errorText}>{formError}</p>}
            <div style={sty.modalFooter}>
              <button type="button" style={sty.btnGhost} onClick={closeModal}>{t('ui.settings.cancel')}</button>
              <button type="submit" style={sty.btnPrimary} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? 'Saving…' : editing ? 'Update' : 'Create'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {deleteId !== null && (
        <ConfirmDialog
          message="Delete this payment gateway? Existing transactions linked to it will be preserved."
          onConfirm={() => deleteMutation.mutate(deleteId!)}
          onCancel={() => setDeleteId(null)}
          loading={deleteMutation.isPending}
        />
      )}
    </div>
  );
}

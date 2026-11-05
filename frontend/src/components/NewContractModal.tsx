// =============================================================================
// VigaBSS 5.0 — New Contract Modal (client-scoped)
// =============================================================================
// A focused "create a contract for THIS client" modal used from the client
// detail page. The client is locked (passed in), so there is no client picker.
// Creating a PPPoE contract triggers backend RADIUS provisioning + IP checks.
// =============================================================================

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { MxRegisteredContractSourceField } from '@/components/MxRegisteredContractSourceField';
import { localToday } from '@/lib/dates';
import {
  overlay, modalBox, errorBox, labelStyle, inputStyle, submitBtn, cancelBtn,
  extractApiError,
} from '@/components/ClientFormModal';
import { useTranslation } from 'react-i18next';

interface Plan { id: number; name: string; }

interface CreateContractBody {
  client_id: number;
  plan_id: number;
  connection_type: string;
  start_date: string;
  billing_day?: number;
  ip_address?: string;
  price_override?: number;
  facturar?: boolean;
  contract_template_mx_id?: number;
}

async function fetchPlans(): Promise<Plan[]> {
  const res = await api.GET('/plans', { params: { query: { limit: 200 } } });
  if (res.error) throw new Error('Failed to load plans');
  return (res.data as unknown as { data: Plan[] }).data ?? [];
}

async function createContract(body: CreateContractBody): Promise<number> {
  const { data, error } = await api.POST('/contracts', { body: body as never });
  if (error) throw new Error(extractApiError(error, 'Failed to create contract'));
  return Number((data as unknown as { data: { id: number } }).data.id);
}

export interface NewContractModalProps {
  lockedClientId: number;
  lockedClientName?: string;
  onClose: () => void;
  onCreated: (contractId: number) => void;
}

export function NewContractModal({ lockedClientId, lockedClientName, onClose, onCreated }: NewContractModalProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isMxOrg = user?.organization_locale === 'MX';
  const TODAY = localToday();
  const [form, setForm] = useState({
    plan_id: '', connection_type: 'pppoe', start_date: TODAY,
    billing_day: '1', ip_address: '', price_override: '', facturar: false,
    contract_template_mx_id: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const { data: plans = [], isError: plansError } = useQuery({ queryKey: ['plans-lookup'], queryFn: fetchPlans, staleTime: 60_000 });

  function setField(name: string, value: unknown) {
    setForm(prev => ({ ...prev, [name]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.plan_id || !form.start_date) { setError('Plan and Start Date are required.'); return; }
    setSubmitting(true);
    setError('');
    try {
      const body: CreateContractBody = {
        client_id: lockedClientId,
        plan_id: Number(form.plan_id),
        connection_type: form.connection_type,
        start_date: form.start_date,
        billing_day: form.billing_day ? Math.min(28, Math.max(1, Number(form.billing_day))) : undefined,
        ip_address: form.ip_address || undefined,
        price_override: form.price_override ? Number(form.price_override) : undefined,
      };
      // `facturar` controls an MX/CFDI flow. Global organizations should not
      // see it and should not send the jurisdiction-specific field at all.
      if (isMxOrg) {
        body.facturar = form.facturar;
        // The server derives the one active registered source when this user
        // cannot inspect legal configuration. Preserve an explicit verified
        // choice when the optional picker is available.
        if (form.contract_template_mx_id) {
          body.contract_template_mx_id = Number(form.contract_template_mx_id);
        }
      }
      const contractId = await createContract(body);
      onCreated(contractId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create contract');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={t('ui.newContractModal.newContract')}>
      <div style={{ ...modalBox, maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 1rem' }}>{t('ui.newContractModal.newContract')}</h3>
        {error && <div style={errorBox}>{error}</div>}
        {plansError && <div style={errorBox}>{t('ui.newContractModal.failedToLoadPlansReopen')}</div>}
        <form onSubmit={handleSubmit}>
          <label style={labelStyle}>{t('ui.newContractModal.client')}</label>
          <input style={{ ...inputStyle, background: 'var(--bg-body)', color: 'var(--text-muted)' }}
            value={lockedClientName ?? `Client #${lockedClientId}`} disabled />

          <label style={labelStyle}>{t('ui.newContractModal.plan')}</label>
          <select style={inputStyle} value={form.plan_id} onChange={e => setField('plan_id', e.target.value)} required>
            <option value="">{plans.length ? '— select plan —' : '— no plans available —'}</option>
            {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
            <div>
              <label style={labelStyle}>{t('ui.newContractModal.connectionType')}</label>
              <select style={inputStyle} value={form.connection_type} onChange={e => setField('connection_type', e.target.value)}>
                <option value="pppoe">PPPoE</option>
                <option value="pppoe_dual">{t('ui.newContractModal.pppoeDual')}</option>
                <option value="static">{t('ui.newContractModal.static')}</option>
                <option value="dual">{t('ui.newContractModal.dual')}</option>
              </select>
            </div>
            <div>
              <label style={labelStyle}>{t('ui.newContractModal.startDate')}</label>
              <input type="date" style={inputStyle} value={form.start_date} onChange={e => setField('start_date', e.target.value)} required />
            </div>
            <div>
              <label style={labelStyle}>{t('ui.newContractModal.billingDay128')}</label>
              <input type="number" min={1} max={28} style={inputStyle} value={form.billing_day}
                onChange={e => setField('billing_day', e.target.value)} placeholder="e.g. 1" />
            </div>
            <div>
              <label style={labelStyle}>{t('ui.newContractModal.ipAddress')}</label>
              <input type="text" maxLength={45} style={inputStyle} value={form.ip_address}
                onChange={e => setField('ip_address', e.target.value)} placeholder="e.g. 192.168.1.100" />
            </div>
          </div>

          <label style={labelStyle}>{t('ui.newContractModal.priceOverrideBlankPlanDefault')}</label>
          <input type="number" min={0} step="0.01" style={inputStyle} value={form.price_override}
            onChange={e => setField('price_override', e.target.value)} placeholder="e.g. 350.00" />

          {isMxOrg && (
            <MxRegisteredContractSourceField
              value={form.contract_template_mx_id}
              onChange={value => setField('contract_template_mx_id', value)}
              required={false}
              labelStyle={labelStyle}
              selectStyle={inputStyle}
            />
          )}

          {isMxOrg && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: '0.85rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.facturar} onChange={e => setField('facturar', e.target.checked)} />
              {t('ui.newContractModal.generateCfdiInvoiceAutomatically')}
            </label>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: '1.25rem' }}>
            <button type="button" onClick={onClose} style={cancelBtn}>{t('ui.newContractModal.cancel')}</button>
            <button
              type="submit"
              style={submitBtn}
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

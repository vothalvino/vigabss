// =============================================================================
// Reseller create / edit form (POST /resellers, PUT /resellers/:id)
// =============================================================================
// A reseller is a commission agent ("Punto de Venta"). The form holds what
// the reseller app uses: contact details, an optional parent (a top-level
// reseller, create only: PUT does not move a reseller), the commission
// percentage, the cash limit (how much collected cash it may hold before
// handing it in; blank = the organization default, sent as null on an edit),
// status and notes. Branding and portal fields are not edited here.
// =============================================================================

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/api/apiFetch';
import { useMutation } from '@/api/useMutation';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { formatMoney } from '@/lib/money';
import {
  cancelBtn, errorBox, extractApiError, inputStyle, labelStyle, modalBox, overlay, submitBtn, twoCol,
} from '@/components/ClientFormModal';

export interface ResellerFormInitial {
  id: number;
  name: string;
  email: string | null;
  phone?: string | null;
  contact_name: string | null;
  parent_id: number | null;
  parent_name?: string | null;
  commission_rate: number | string;
  status: string;
  notes?: string | null;
  /** The reseller's own cash limit; null means the organization default. */
  credit_limit?: number | string | null;
  effective_credit_limit?: number | string | null;
}

export interface ResellerBody {
  name: string;
  contact_name?: string;
  email?: string;
  phone?: string;
  parent_id?: number;
  commission_rate: number;
  status: string;
  notes?: string;
  credit_limit?: number | null;
}

const ORG_DEFAULT_KEY = 'reseller_default_credit_limit';
const MONEY = /^\d+(\.\d{1,2})?$/;

const STATUSES = ['active', 'suspended', 'inactive'] as const;

interface Props {
  mode: 'create' | 'edit';
  initial?: ResellerFormInitial;
  onClose: () => void;
  onSaved: () => void;
}

export function ResellerFormModal({ mode, initial, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const initialLimit = initial?.credit_limit === null || initial?.credit_limit === undefined ? '' : String(Number(initial.credit_limit));
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    contact_name: initial?.contact_name ?? '',
    email: initial?.email ?? '',
    phone: initial?.phone ?? '',
    parent_id: initial?.parent_id ? String(initial.parent_id) : '',
    commission_rate: initial ? String(Number(initial.commission_rate)) : '0',
    status: initial?.status ?? 'active',
    notes: initial?.notes ?? '',
    credit_limit: initialLimit,
  });
  const [parents, setParents] = useState<{ id: number; name: string }[]>([]);
  // The organization default, for the placeholder of a blank cash limit. A
  // reseller already on the default shows it as its effective limit; else it
  // comes from GET /settings when the caller may read settings.
  const knownDefault = initial && initialLimit === '' && initial.effective_credit_limit != null ? String(initial.effective_credit_limit) : null;
  const [orgDefault, setOrgDefault] = useState<string | null>(knownDefault);
  const canReadSettings = can(user, 'settings.view');

  useEffect(() => {
    if (knownDefault !== null || !canReadSettings) return;
    apiFetch<{ data: { key: string; value: string | null }[] }>('/settings')
      .then(res => {
        const row = Array.isArray(res?.data) ? res.data.find(s => s.key === ORG_DEFAULT_KEY) : undefined;
        if (row?.value) setOrgDefault(row.value);
      })
      .catch(() => {});
  }, [knownDefault, canReadSettings]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (mode !== 'create') return;
    apiFetch<{ data: { id: number; name: string }[] }>('/resellers?parent_id=null&limit=100')
      .then(res => setParents(res.data ?? []))
      .catch(() => setParents([]));
  }, [mode]);

  const save = useMutation({
    mutationFn: async (body: ResellerBody) => {
      const path = mode === 'create' ? '/resellers' : `/resellers/${initial?.id}`;
      await apiFetch(path, { method: mode === 'create' ? 'POST' : 'PUT', body: JSON.stringify(body) });
    },
    onSuccess: () => { onSaved(); onClose(); },
    onError: (err: unknown) => setError(extractApiError(err, t('resellerForm.saveError'))),
  });

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm(p => ({ ...p, [key]: e.target.value }));

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const name = form.name.trim();
    if (!name) { setError(t('resellerForm.nameRequired')); return; }
    const rate = Number(form.commission_rate);
    if (form.commission_rate.trim() === '' || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      setError(t('resellerForm.rateInvalid'));
      return;
    }
    const limit = form.credit_limit.trim();
    if (limit !== '' && !MONEY.test(limit)) {
      setError(t('resellerForm.creditLimitInvalid'));
      return;
    }
    const body: ResellerBody = { name, commission_rate: rate, status: form.status };
    // Blank means the organization default: left out on a create, null on an
    // edit that clears an own limit.
    if (limit !== '') body.credit_limit = Number(limit);
    else if (mode === 'edit' && initialLimit !== '') body.credit_limit = null;
    for (const key of ['contact_name', 'email', 'phone', 'notes'] as const) {
      const value = form[key].trim();
      // An edit sends a cleared field as '' so it is cleared; a create leaves it out.
      if (value || (mode === 'edit' && (initial?.[key] ?? '') !== '')) body[key] = value;
    }
    if (mode === 'create' && form.parent_id) body.parent_id = Number(form.parent_id);
    save.mutate(body);
  }

  const title = mode === 'create' ? t('resellerForm.createTitle') : t('resellerForm.editTitle', { name: initial?.name ?? '' });
  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-labelledby="reseller-form-title">
      <form onSubmit={handleSubmit} noValidate style={{ ...modalBox, width: 520, maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 id="reseller-form-title" style={{ margin: '0 0 0.75rem' }}>{title}</h3>
        {error && <div role="alert" style={errorBox}>{error}</div>}

        <label style={labelStyle} htmlFor="rf-name">{t('resellerForm.name')} *</label>
        <input id="rf-name" style={inputStyle} maxLength={255} value={form.name} onChange={set('name')} />

        <label style={labelStyle} htmlFor="rf-contact">{t('resellerForm.contactName')}</label>
        <input id="rf-contact" style={inputStyle} maxLength={255} value={form.contact_name} onChange={set('contact_name')} />

        <div style={twoCol}>
          <div>
            <label style={labelStyle} htmlFor="rf-email">{t('resellerForm.email')}</label>
            <input id="rf-email" type="email" style={inputStyle} maxLength={255} value={form.email} onChange={set('email')} />
          </div>
          <div>
            <label style={labelStyle} htmlFor="rf-phone">{t('resellerForm.phone')}</label>
            <input id="rf-phone" type="tel" style={inputStyle} maxLength={30} value={form.phone} onChange={set('phone')} />
          </div>
        </div>

        {mode === 'create' ? (
          <>
            <label style={labelStyle} htmlFor="rf-parent">{t('resellerForm.parent')}</label>
            <select id="rf-parent" style={inputStyle} value={form.parent_id} onChange={set('parent_id')}>
              <option value="">{t('resellerForm.noParent')}</option>
              {parents.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </>
        ) : initial?.parent_name ? (
          <p style={{ ...labelStyle, fontWeight: 400 }}>{t('resellerForm.parentFixed', { name: initial.parent_name })}</p>
        ) : null}

        <div style={twoCol}>
          <div>
            <label style={labelStyle} htmlFor="rf-rate">{t('resellerForm.commissionRate')}</label>
            <input id="rf-rate" type="number" min={0} max={100} step="0.01" style={inputStyle} value={form.commission_rate} onChange={set('commission_rate')} />
          </div>
          <div>
            <label style={labelStyle} htmlFor="rf-status">{t('resellerForm.status')}</label>
            <select id="rf-status" style={inputStyle} value={form.status} onChange={set('status')}>
              {STATUSES.map(s => <option key={s} value={s}>{t(`resellerForm.statuses.${s}`)}</option>)}
            </select>
          </div>
        </div>

        <label style={labelStyle} htmlFor="rf-credit-limit">{t('resellerForm.creditLimit')}</label>
        <input
          id="rf-credit-limit"
          inputMode="decimal"
          style={inputStyle}
          value={form.credit_limit}
          onChange={set('credit_limit')}
          aria-describedby="rf-credit-limit-help"
          placeholder={orgDefault !== null ? t('resellerForm.creditLimitDefault', { amount: formatMoney(orgDefault, user?.organization_currency) }) : t('resellerForm.creditLimitDefaultUnknown')}
        />
        <p id="rf-credit-limit-help" style={{ ...labelStyle, fontWeight: 400, marginTop: 4 }}>{t('resellerForm.creditLimitHelp')}</p>

        <label style={labelStyle} htmlFor="rf-notes">{t('resellerForm.notes')}</label>
        <textarea id="rf-notes" rows={3} style={inputStyle} value={form.notes} onChange={set('notes')} />

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: '1rem' }}>
          <button type="button" style={cancelBtn} onClick={onClose}>{t('resellerForm.cancel')}</button>
          <button type="submit" style={submitBtn} disabled={save.isPending}>
            {save.isPending ? t('resellerForm.saving') : t('resellerForm.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

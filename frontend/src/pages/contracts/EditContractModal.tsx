// =============================================================================
// Edit contract modal
// =============================================================================
// Moved out of ContractList.tsx, which is past the 1,500-line page limit
// (src/test/pageSize.test.ts), when the plan change gained its proration
// choice.
// =============================================================================

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import type { ContractRow } from '@/api/rows';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { MxRegisteredContractSourceField } from '@/components/MxRegisteredContractSourceField';
import { extractApiError } from '@/components/ClientFormModal';
import { queryKeys } from '@/api/queryKeys';
import { modalStyles, styles } from './contractListStyles';

type Contract = ContractRow;

export interface Plan {
  id: number;
  name: string;
  price: string;
}

// A type alias, not an interface: the request body type has an index signature.
type UpdateContractBody = {
  plan_id?: number;
  contract_template_mx_id?: number;
  connection_type?: string;
  start_date?: string;
  end_date?: string | null;
  billing_day?: number;
  price_override?: number;
  ip_address?: string;
  facturar?: boolean;
  escalation_enabled?: boolean;
  escalate_on_disconnect?: boolean;
  // Migration 388 — always sent explicitly (including `null`, never
  // omitted) so a blank input can clear a previously-set override back to
  // "use default"; omitting the key would leave the DB column unchanged.
  optical_min_dbm?: number | null;
  wireless_signal_min_dbm?: number | null;
  wireless_link_capacity_min_mbps?: number | null;
  /** With a plan change: bill the rest of the invoiced period (server default true). */
  prorate?: boolean;
};

async function updateContract(id: number, body: UpdateContractBody): Promise<void> {
  const { error } = await api.PUT('/contracts/{id}', { params: { path: { id } }, body });
  if (error) throw new Error(extractApiError(error, 'Failed to update contract'));
}

interface EditContractModalProps {
  contract: Contract;
  plans: Plan[];
  isMxOrg: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function EditContractModal({ contract, plans, isMxOrg, onClose, onSaved }: EditContractModalProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const mayResolveMxSource = can(user, 'document_templates.view')
    && can(user, 'contract_templates_mx.view');
  const connectionOptions = ['pppoe', 'pppoe_dual'].includes(contract.connection_type ?? '')
    ? [
      { value: 'pppoe', label: 'PPPoE' },
      { value: 'pppoe_dual', label: 'PPPoE Dual' },
    ]
    : [
      { value: 'static', label: 'Static' },
      { value: 'dual', label: 'Dual' },
    ];
  const [form, setForm] = useState({
    plan_id: String(contract.plan_id),
    connection_type: contract.connection_type || 'pppoe',
    start_date: contract.start_date ? contract.start_date.split('T')[0] : '',
    end_date: contract.end_date ? contract.end_date.split('T')[0] : '',
    billing_day: contract.billing_day != null ? String(contract.billing_day) : '',
    ip_address: contract.ip_address || '',
    price_override: contract.price_override != null ? String(contract.price_override) : '',
    facturar: !!contract.facturar,
    contract_template_mx_id: contract.contract_template_mx_id == null
      ? '' : String(contract.contract_template_mx_id),
    // Migration 387: default ON (matches the DB column default) unless the
    // contract explicitly has it off; escalate_on_disconnect defaults OFF.
    escalation_enabled: contract.escalation_enabled == null ? true : !!contract.escalation_enabled,
    escalate_on_disconnect: !!contract.escalate_on_disconnect,
    // Migration 388 — rare-case per-contract overrides; blank = use default.
    optical_min_dbm: contract.optical_min_dbm != null ? String(contract.optical_min_dbm) : '',
    wireless_signal_min_dbm: contract.wireless_signal_min_dbm != null ? String(contract.wireless_signal_min_dbm) : '',
    wireless_link_capacity_min_mbps: contract.wireless_link_capacity_min_mbps != null ? String(contract.wireless_link_capacity_min_mbps) : '',
    prorate: true,
  });
  const changesPlan = form.plan_id !== String(contract.plan_id);
  const [error, setError] = useState('');
  const [mxSourceAvailable, setMxSourceAvailable] = useState(false);

  function setField(name: string, value: unknown) {
    setForm(prev => ({ ...prev, [name]: value }));
  }

  const mutation = useMutation({
    mutationFn: () => {
      const body: UpdateContractBody = {
        plan_id: Number(form.plan_id),
        connection_type: form.connection_type,
        escalation_enabled: form.escalation_enabled,
        escalate_on_disconnect: form.escalate_on_disconnect,
        end_date: form.end_date || null,
        // Migration 388: always send these 3 keys explicitly (never omit),
        // converting a blank input to `null` — this is a deliberate
        // departure from the "omit if blank" convention every other field
        // on this form uses (e.g. price_override below). These fields exist
        // specifically to toggle between "explicit value" and "inherit
        // default", and omitting the key on blank would leave a
        // previously-set override stuck forever (validate()/BaseModel.update
        // treat undefined as "don't touch", but forward an explicit null
        // through to SET column = NULL).
        optical_min_dbm: form.optical_min_dbm === '' ? null : Number(form.optical_min_dbm),
        wireless_signal_min_dbm: form.wireless_signal_min_dbm === '' ? null : Number(form.wireless_signal_min_dbm),
        wireless_link_capacity_min_mbps: form.wireless_link_capacity_min_mbps === '' ? null : Number(form.wireless_link_capacity_min_mbps),
      };
      // Contract state is changed only by the dedicated lifecycle actions.
      // The generic Edit form must never be an activation/suspension bypass.
      if (isMxOrg) {
        body.facturar = form.facturar;
        if (contract.status === 'pending' && mayResolveMxSource) {
          body.contract_template_mx_id = Number(form.contract_template_mx_id);
        }
      }
      if (form.start_date) body.start_date = form.start_date;
      if (form.billing_day) body.billing_day = Math.min(28, Math.max(1, Number(form.billing_day)));
      if (form.ip_address) body.ip_address = form.ip_address;
      if (form.price_override) body.price_override = Number(form.price_override);
      if (changesPlan) body.prorate = form.prorate;
      return updateContract(contract.id, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contracts.all });
      onSaved();
      onClose();
    },
    onError: (cause) => setError(cause instanceof Error
      ? cause.message
      : 'Failed to update contract. Check all fields and try again.'),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (isMxOrg && contract.status === 'pending' && mayResolveMxSource
        && (!mxSourceAvailable || !form.contract_template_mx_id)) {
      setError(t('mxContractSource.required'));
      return;
    }
    mutation.mutate();
  }

  return (
    <div style={modalStyles.backdrop} onClick={onClose}>
      <div
        style={modalStyles.panel}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-contract-title"
      >
        <div style={modalStyles.header}>
          <h2 id="edit-contract-title" style={modalStyles.title}>📝 Edit Contract #{contract.id}</h2>
          <button style={modalStyles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form onSubmit={handleSubmit} style={modalStyles.form}>
          <label style={modalStyles.label}>
            Plan
            <select style={modalStyles.select} value={form.plan_id} onChange={e => setField('plan_id', e.target.value)}>
              {/* If the contract runs on an archived plan (absent from the active
                  list), keep it shown + selectable so the selection stays correct
                  and the contract isn't silently moved off it. */}
              {!plans.some(p => p.id === contract.plan_id) && (
                <option value={contract.plan_id}>Archived plan (#{contract.plan_id})</option>
              )}
              {plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {changesPlan && contract.status === 'active' && (
            <>
              <label style={modalStyles.checkboxLabel}>
                <input type="checkbox" checked={form.prorate} onChange={e => setField('prorate', e.target.checked)} />
                {t('contractList.editModal.prorate')}
              </label>
              <p style={modalStyles.hint}>{t('contractList.editModal.prorateHint')}</p>
            </>
          )}

          <label style={modalStyles.label}>
            Connection Type
            <select style={modalStyles.select} value={form.connection_type} onChange={e => setField('connection_type', e.target.value)}>
              {!connectionOptions.some(option => option.value === form.connection_type) && (
                <option value={form.connection_type}>{form.connection_type}</option>
              )}
              {connectionOptions.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <p style={modalStyles.hint}>{t('contractList.editModal.connectionFamilyHelp')}</p>

          <label style={modalStyles.label}>
            Start Date
            <input style={modalStyles.input} type="date" value={form.start_date} onChange={e => setField('start_date', e.target.value)} />
          </label>

          <label style={modalStyles.label}>
            End Date (leave blank for month-to-month)
            <input style={modalStyles.input} type="date" value={form.end_date} onChange={e => setField('end_date', e.target.value)} />
          </label>

          <label style={modalStyles.label}>
            Billing Day (1–28)
            <input style={modalStyles.input} type="number" min={1} max={28} value={form.billing_day} onChange={e => setField('billing_day', e.target.value)} />
          </label>

          <label style={modalStyles.label}>
            IP Address
            <input style={modalStyles.input} type="text" maxLength={45} value={form.ip_address} onChange={e => setField('ip_address', e.target.value)} />
          </label>

          <label style={modalStyles.label}>
            Price Override (leave blank for plan default)
            <input style={modalStyles.input} type="number" min={0} step="0.01" value={form.price_override} onChange={e => setField('price_override', e.target.value)} />
          </label>

          {isMxOrg && contract.status === 'pending' && mayResolveMxSource && (
            <MxRegisteredContractSourceField
              value={form.contract_template_mx_id}
              onChange={value => setField('contract_template_mx_id', value)}
              onAvailabilityChange={setMxSourceAvailable}
              frozenEnvironment={contract.mx_contract_environment}
              disabled={mutation.isPending}
              labelStyle={modalStyles.label}
              selectStyle={modalStyles.select}
            />
          )}
          {isMxOrg && contract.status === 'pending' && !mayResolveMxSource && (
            <p style={modalStyles.hint}>{t('mxContractSource.preservedOnEditHint')}</p>
          )}

          {isMxOrg && (
            <label style={modalStyles.checkboxLabel}>
              <input type="checkbox" checked={form.facturar} onChange={e => setField('facturar', e.target.checked)} />
              Generate CFDI invoice automatically
            </label>
          )}

          <label style={modalStyles.checkboxLabel}>
            <input
              type="checkbox"
              checked={form.escalation_enabled}
              onChange={e => setField('escalation_enabled', e.target.checked)}
            />
            {t('contractList.editModal.escalationEnabled')}
          </label>
          <p style={modalStyles.hint}>{t('contractList.editModal.escalationEnabledHint')}</p>

          <label style={modalStyles.checkboxLabel}>
            <input
              type="checkbox"
              checked={form.escalate_on_disconnect}
              onChange={e => setField('escalate_on_disconnect', e.target.checked)}
            />
            {t('contractList.editModal.escalateOnDisconnect')}
          </label>
          <p style={modalStyles.hint}>{t('contractList.editModal.escalateOnDisconnectHint')}</p>

          {/* Migration 388 — rare-case per-client threshold overrides. Blank
              = use the serving sector's default, else the org-wide code
              constant (link-capacity has no org-wide default at all). */}
          <label style={modalStyles.label}>
            {t('contractList.editModal.opticalMinDbm')}
            <input
              style={modalStyles.input}
              type="number"
              step="1"
              min={-100}
              max={0}
              placeholder="-27"
              value={form.optical_min_dbm}
              onChange={e => setField('optical_min_dbm', e.target.value)}
            />
          </label>
          <p style={modalStyles.hint}>{t('contractList.editModal.opticalMinDbmHint')}</p>

          <label style={modalStyles.label}>
            {t('contractList.editModal.wirelessSignalMinDbm')}
            <input
              style={modalStyles.input}
              type="number"
              step="1"
              min={-100}
              max={0}
              placeholder="-75"
              value={form.wireless_signal_min_dbm}
              onChange={e => setField('wireless_signal_min_dbm', e.target.value)}
            />
          </label>
          <p style={modalStyles.hint}>{t('contractList.editModal.wirelessSignalMinDbmHint')}</p>

          <label style={modalStyles.label}>
            {t('contractList.editModal.wirelessLinkCapacityMinMbps')}
            <input
              style={modalStyles.input}
              type="number"
              step="0.1"
              min={0.1}
              max={10000}
              placeholder={t('contractList.editModal.wirelessLinkCapacityPlaceholder')}
              value={form.wireless_link_capacity_min_mbps}
              onChange={e => setField('wireless_link_capacity_min_mbps', e.target.value)}
            />
          </label>
          <p style={modalStyles.hint}>{t('contractList.editModal.wirelessLinkCapacityMinMbpsHint')}</p>

          {error && <p style={modalStyles.error}>{error}</p>}

          <div style={modalStyles.actions}>
            <button type="button" onClick={onClose} style={styles.btnSecondary} disabled={mutation.isPending}>Cancel</button>
            <button
              type="submit"
              style={styles.btnPrimary}
              disabled={mutation.isPending || (isMxOrg && contract.status === 'pending' && mayResolveMxSource
                && (!mxSourceAvailable || !form.contract_template_mx_id))}
            >
              {mutation.isPending ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

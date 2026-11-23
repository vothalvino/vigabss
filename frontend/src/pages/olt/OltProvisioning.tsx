// =============================================================================
// VigaBSS 5.0 — provisioning ONUs from the Live OLT tab
// =============================================================================
// Settings a new ONU is provisioned with, authorising a waiting ONU for a
// contract, and the ONUs VigaBSS manages (change speed, switch off or on,
// remove). Every change is previewed first: the exact commands are shown, and
// nothing is sent to the OLT until "Send to the OLT" is pressed.
// =============================================================================

import { useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@/api/useMutation';
import { apiFetch, ApiRequestError } from '@/api/apiFetch';

interface Command { command: string; note?: string }
interface Plan { applied: boolean; commands: Command[]; [key: string]: unknown }
export interface ProvisioningSettings {
  line_profile_id: number | null; srv_profile_id: number | null; service_vlan: number | null; user_vlan: number | null;
  gem_port: number | null; native_vlan_eth_port: number | null; traffic_table_base: number;
}
interface ManagedOnu {
  id: number; port: string; ont_id: number; serial_number: string; contract_id: number | null; description: string;
  service_port_index: number | null; up_kbps: number; down_kbps: number; active: boolean;
}

const mbps = (kbps: number) => `${kbps / 1000} Mbps`;
const refused = (err: unknown) => {
  const body = err instanceof ApiRequestError ? (err.body as { error?: { transcript?: Array<{ command: string; output: string; failed?: string }> } } | null) : null;
  return body?.error?.transcript ?? null;
};

/**
 * Shows the commands of a change and sends them only when confirmed.
 * `request(apply)` is called with false for the preview and true to apply.
 */
function PlannedChange({ label, request, onDone, children }: {
  label: string; request: (apply: boolean) => Promise<{ data: Plan }>; onDone: () => void; children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<Plan | null>(null);
  const preview = useMutation({ mutationFn: () => request(false), onSuccess: (res) => setPlan(res.data) });
  const apply = useMutation({ mutationFn: () => request(true), onSuccess: () => { setPlan(null); onDone(); } });
  const transcript = apply.isError ? refused(apply.error) : null;

  if (!plan) {
    return (
      <div style={s.inline}>
        {children}
        <button type="button" style={s.secondary} onClick={() => preview.mutate()} disabled={preview.isPending}>
          {preview.isPending ? t('oltProvisioning.preparing') : label}
        </button>
        {preview.isError && <p style={s.error} role="alert">{(preview.error as Error).message}</p>}
      </div>
    );
  }
  return (
    <div style={s.plan} role="group" aria-label={label}>
      <p style={s.planTitle}>{t('oltProvisioning.willSend')}</p>
      <ol style={s.commands}>
        {plan.commands.map((c, i) => <li key={`${i}-${c.command}`}><code>{c.command}</code>{c.note ? <span style={s.note}> {c.note}</span> : null}</li>)}
      </ol>
      {apply.isError && <p style={s.error} role="alert">{(apply.error as Error).message}</p>}
      {transcript && (
        <pre style={s.raw}>{transcript.map(line => `${line.command}\n${line.failed ? `  ! ${line.failed}` : line.output}`).join('\n')}</pre>
      )}
      <div style={s.row}>
        <button type="button" style={s.primary} onClick={() => apply.mutate()} disabled={apply.isPending}>
          {apply.isPending ? t('oltProvisioning.sending') : t('oltProvisioning.send')}
        </button>
        <button type="button" style={s.secondary} onClick={() => { setPlan(null); apply.reset(); }} disabled={apply.isPending}>{t('oltProvisioning.cancel')}</button>
      </div>
    </div>
  );
}

const FIELDS: Array<[keyof ProvisioningSettings, boolean]> = [
  ['line_profile_id', true], ['srv_profile_id', true], ['service_vlan', true], ['gem_port', true],
  ['user_vlan', false], ['native_vlan_eth_port', false], ['traffic_table_base', true],
];

export function ProvisioningSettingsForm({ oltId, settings }: { oltId: number; settings: ProvisioningSettings }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>(
    Object.fromEntries(FIELDS.map(([f]) => [f, settings[f] === null || settings[f] === undefined ? '' : String(settings[f])])),
  );
  const save = useMutation({
    mutationFn: () => apiFetch(`/olt-management/${oltId}/provisioning`, {
      method: 'PUT',
      body: JSON.stringify(Object.fromEntries(FIELDS.map(([f]) => [f, form[f] === '' ? null : Number(form[f])]))),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['olt-connection', oltId] }),
  });
  function submit(e: FormEvent) { e.preventDefault(); save.mutate(); }
  return (
    <section style={s.card}>
      <h3 style={s.h3}>{t('oltProvisioning.settingsTitle')}</h3>
      <p style={s.hint}>{t('oltProvisioning.settingsHint')}</p>
      <form onSubmit={submit} style={s.grid}>
        {FIELDS.map(([field, required]) => (
          <label key={field} style={s.label}>{t(`oltProvisioning.field.${field}`)}
            <input style={s.input} type="number" min={0} value={form[field]} required={required} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))} />
          </label>
        ))}
        <div style={{ gridColumn: '1 / -1' }}>
          <button type="submit" style={s.primary} disabled={save.isPending}>{save.isPending ? t('oltProvisioning.saving') : t('oltProvisioning.save')}</button>
          {save.isSuccess && <span style={s.saved} role="status"> {t('oltProvisioning.saved')}</span>}
        </div>
      </form>
      {save.isError && <p style={s.error} role="alert">{(save.error as Error).message}</p>}
    </section>
  );
}

/** Authorise one waiting ONU: for a contract (its plan gives the speeds) or with speeds typed in. */
export function AuthoriseOnu({ oltId, port, serial, onDone }: { oltId: number; port: string; serial: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [contract, setContract] = useState('');
  const [down, setDown] = useState('');
  const [up, setUp] = useState('');
  if (!open) return <button type="button" style={s.secondary} onClick={() => setOpen(true)}>{t('oltProvisioning.authorise')}</button>;
  const ready = contract !== '' || (down !== '' && up !== '');
  return (
    <div style={s.form}>
      <div style={s.row}>
        <label style={s.label}>{t('oltProvisioning.contract')}
          <input style={{ ...s.input, width: 110 }} type="number" min={1} value={contract} onChange={e => setContract(e.target.value)} />
        </label>
        <label style={s.label}>{t('oltProvisioning.down')}
          <input style={{ ...s.input, width: 110 }} type="number" min={1} value={down} onChange={e => setDown(e.target.value)} />
        </label>
        <label style={s.label}>{t('oltProvisioning.up')}
          <input style={{ ...s.input, width: 110 }} type="number" min={1} value={up} onChange={e => setUp(e.target.value)} />
        </label>
      </div>
      <p style={s.hint}>{t('oltProvisioning.authoriseHint')}</p>
      {ready && (
        <PlannedChange
          label={t('oltProvisioning.preview')}
          onDone={() => { setOpen(false); onDone(); }}
          request={(apply) => apiFetch<{ data: Plan }>(`/olt-management/${oltId}/managed-onus`, {
            method: 'POST',
            body: JSON.stringify({
              port, serial_number: serial, apply,
              ...(contract !== '' ? { contract_id: Number(contract) } : {}),
              ...(down !== '' && up !== '' ? { down_kbps: Math.round(Number(down) * 1000), up_kbps: Math.round(Number(up) * 1000) } : {}),
            }),
          })}
        />
      )}
      <button type="button" style={s.link} onClick={() => setOpen(false)}>{t('oltProvisioning.close')}</button>
    </div>
  );
}

function SpeedChange({ oltId, onu, onDone }: { oltId: number; onu: ManagedOnu; onDone: () => void }) {
  const { t } = useTranslation();
  const [down, setDown] = useState(String(onu.down_kbps / 1000));
  const [up, setUp] = useState(String(onu.up_kbps / 1000));
  return (
    <PlannedChange
      label={t('oltProvisioning.changeSpeed')}
      onDone={onDone}
      request={(apply) => apiFetch<{ data: Plan }>(`/olt-management/${oltId}/managed-onus/${onu.id}/speed`, {
        method: 'POST', body: JSON.stringify({ down_kbps: Math.round(Number(down) * 1000), up_kbps: Math.round(Number(up) * 1000), apply }),
      })}
    >
      <input style={{ ...s.input, width: 80 }} type="number" min={1} value={down} onChange={e => setDown(e.target.value)} aria-label={t('oltProvisioning.down')} />
      <input style={{ ...s.input, width: 80 }} type="number" min={1} value={up} onChange={e => setUp(e.target.value)} aria-label={t('oltProvisioning.up')} />
    </PlannedChange>
  );
}

export function ManagedOnus({ oltId }: { oltId: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['olt-managed-onus', oltId], queryFn: () => apiFetch<{ data: ManagedOnu[] }>(`/olt-management/${oltId}/managed-onus`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['olt-managed-onus', oltId] });
  const onus = q.data?.data ?? [];
  return (
    <section style={s.card}>
      <h3 style={s.h3}>{t('oltProvisioning.managedTitle')}</h3>
      <p style={s.hint}>{t('oltProvisioning.managedHint')}</p>
      {q.isError && <p style={s.error} role="alert">{(q.error as Error).message}</p>}
      {q.data && onus.length === 0 && <p style={s.hint}>{t('oltProvisioning.managedEmpty')}</p>}
      {onus.map(onu => (
        <div key={onu.id} style={s.onu}>
          <p style={s.onuTitle}>
            {t('oltProvisioning.position', { port: onu.port, ont: onu.ont_id })}{' · '}<code>{onu.serial_number}</code>
            {onu.contract_id ? ` · ${t('oltProvisioning.contractNo', { id: onu.contract_id })}` : ''}
            {' · '}{mbps(onu.down_kbps)} / {mbps(onu.up_kbps)}
            {!onu.active && <strong style={{ color: 'var(--danger)' }}> · {t('oltProvisioning.off')}</strong>}
          </p>
          <div style={s.actions}>
            <SpeedChange oltId={oltId} onu={onu} onDone={refresh} />
            <PlannedChange
              label={onu.active ? t('oltProvisioning.switchOff') : t('oltProvisioning.switchOn')}
              onDone={refresh}
              request={(apply) => apiFetch<{ data: Plan }>(`/olt-management/${oltId}/managed-onus/${onu.id}/active`, { method: 'POST', body: JSON.stringify({ active: !onu.active, apply }) })}
            />
            <PlannedChange
              label={t('oltProvisioning.remove')}
              onDone={refresh}
              request={(apply) => apiFetch<{ data: Plan }>(`/olt-management/${oltId}/managed-onus/${onu.id}/remove`, { method: 'POST', body: JSON.stringify({ apply }) })}
            />
          </div>
        </div>
      ))}
    </section>
  );
}

const btn: CSSProperties = { padding: '0.4rem 0.8rem', borderRadius: 6, fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer' };
const s: Record<string, CSSProperties> = {
  card: { border: '1px solid var(--border-color)', borderRadius: 8, padding: '1rem', marginBottom: '1rem', background: 'var(--bg-secondary)' },
  h3: { margin: '0 0 0.35rem', fontSize: '1rem', color: 'var(--text-primary)' },
  hint: { margin: '0.4rem 0', fontSize: '0.82rem', color: 'var(--text-secondary)' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.75rem', marginTop: '0.5rem' },
  label: { display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.8rem', color: 'var(--text-secondary)' },
  input: { padding: '0.4rem 0.55rem', border: '1px solid var(--input-border)', borderRadius: 6, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '0.88rem' },
  primary: { ...btn, background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none' },
  secondary: { ...btn, background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)' },
  link: { background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: '0.8rem', textDecoration: 'underline', alignSelf: 'flex-start' },
  error: { margin: '0.4rem 0 0', fontSize: '0.84rem', color: 'var(--danger)' },
  saved: { fontSize: '0.82rem', color: 'var(--success)' },
  inline: { display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' },
  row: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' },
  form: { display: 'flex', flexDirection: 'column', gap: '0.4rem', padding: '0.5rem 0' },
  plan: { border: '1px solid var(--info-border)', background: 'var(--info-soft)', borderRadius: 6, padding: '0.6rem 0.8rem', width: '100%' },
  planTitle: { margin: '0 0 0.4rem', fontSize: '0.85rem', fontWeight: 600, color: 'var(--info-text)' },
  commands: { margin: '0 0 0.6rem', paddingLeft: '1.3rem', fontSize: '0.78rem', color: 'var(--text-primary)', overflowX: 'auto' },
  note: { color: 'var(--text-secondary)' },
  raw: { margin: '0.4rem 0', padding: '0.5rem', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: '0.74rem', overflowX: 'auto', color: 'var(--text-primary)' },
  onu: { borderTop: '1px solid var(--border-color)', padding: '0.6rem 0' },
  onuTitle: { margin: '0 0 0.4rem', fontSize: '0.86rem', color: 'var(--text-primary)' },
  actions: { display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-start' },
};

// =============================================================================
// VigaBSS 5.0 — an OLT's command line: saved login and live reads
// =============================================================================
// Huawei MA5800 / EA5800 over SSH. This tab saves how VigaBSS logs in to an
// OLT and asks it read-only questions: software version and boards, ONUs that
// are plugged in but not authorised yet, and the ONUs of one PON port with
// their optical power. Nothing here changes the OLT.
//
// Every answer keeps the text the OLT actually printed ("Show what the OLT
// printed"), because the driver has not yet met every software release.
// =============================================================================

import { useState, type CSSProperties, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@/api/useMutation';
import { apiFetch } from '@/api/apiFetch';
import { AuthoriseOnu, ManagedOnus, ProvisioningSettingsForm, type ProvisioningSettings } from './OltProvisioning';

interface OltDevice { id: number; name: string; model: string | null; ip_address: string | null }
interface Connection {
  configured: boolean; driver?: string; host?: string; port?: number; username?: string;
  has_password?: boolean; legacy_algorithms?: boolean; host_key_fingerprint?: string | null;
  last_checked_at?: string | null; last_check_ok?: boolean | null; last_check_message?: string | null;
  provisioning?: ProvisioningSettings;
}
interface Board { slot: number; board: string; status: string; kind: string }
interface TestResult {
  system: { version: string | null; patch: string | null; product: string | null; uptime: string | null; raw: string };
  boards: Board[]; boards_raw: string; connection: Connection;
}
interface FoundOnu { port: string; serial_number: string; model?: string | null; vendor_id?: string | null; found_at?: string | null }
interface PortOnu {
  ont_id: number; state?: string; serial_number?: string; model?: string | null; distance_m?: number | null;
  rx_power_dbm?: number | null; tx_power_dbm?: number | null; description?: string | null; last_down_cause?: string | null;
  last_distance_m?: number | null;
}
interface Fault {
  verdict: 'no_onus' | 'healthy' | 'no_fibre_fault' | 'whole_port' | 'branch' | 'single_onu';
  total: number; online: number; lost_signal: number; lost_power: number; offline_other: number;
  affected: number[]; nearest_affected_m: number | null; farthest_affected_m: number | null; affected_without_distance: number;
}

/** Is the fibre cut, and how far away? Judged from who lost signal and how far each ONU was. */
function FibreCheck({ fault }: { fault: Fault }) {
  const { t } = useTranslation();
  const broken = fault.verdict === 'whole_port' || fault.verdict === 'branch' || fault.verdict === 'single_onu';
  const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m} m`);
  return (
    <div role="status" style={{ ...s.fault, ...(broken ? s.faultBad : s.faultOk) }}>
      <strong>{t(`oltLive.fault.${fault.verdict}`, { count: fault.lost_signal, total: fault.total })}</strong>
      {broken && fault.nearest_affected_m !== null && (
        <p style={s.faultLine}>{t('oltLive.fault.distance', { distance: metres(fault.nearest_affected_m) })}</p>
      )}
      {broken && fault.nearest_affected_m !== null && fault.farthest_affected_m !== null && fault.farthest_affected_m !== fault.nearest_affected_m && (
        <p style={s.faultLine}>{t('oltLive.fault.range', { nearest: metres(fault.nearest_affected_m), farthest: metres(fault.farthest_affected_m) })}</p>
      )}
      {broken && fault.nearest_affected_m === null && <p style={s.faultLine}>{t('oltLive.fault.noDistance')}</p>}
      {broken && <p style={s.faultLine}>{t('oltLive.fault.affected', { ids: fault.affected.join(', ') })}</p>}
      {fault.lost_power > 0 && <p style={s.faultLine}>{t('oltLive.fault.power', { count: fault.lost_power })}</p>}
      {broken && <p style={s.faultNote}>{t('oltLive.fault.note')}</p>}
    </div>
  );
}

function Raw({ text }: { text?: string }) {
  const { t } = useTranslation();
  if (!text) return null;
  return (
    <details style={{ marginTop: '0.5rem' }}>
      <summary style={s.rawSummary}>{t('oltLive.showRaw')}</summary>
      <pre style={s.raw}>{text}</pre>
    </details>
  );
}

function ConnectionForm({ oltId, connection }: { oltId: number; connection: Connection }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    host: connection.host ?? '', port: String(connection.port ?? 22), username: connection.username ?? '',
    password: '', legacy_algorithms: Boolean(connection.legacy_algorithms),
  });
  const [test, setTest] = useState<TestResult | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['olt-connection', oltId] });

  const save = useMutation({
    mutationFn: () => apiFetch<{ data: Connection }>(`/olt-management/${oltId}/connection`, {
      method: 'PUT',
      body: JSON.stringify({
        host: form.host.trim(), port: Number(form.port) || 22, username: form.username.trim(),
        legacy_algorithms: form.legacy_algorithms, ...(form.password ? { password: form.password } : {}),
      }),
    }),
    onSuccess: () => { setForm(f => ({ ...f, password: '' })); refresh(); },
  });
  const run = useMutation({
    mutationFn: () => apiFetch<{ data: TestResult }>(`/olt-management/${oltId}/connection/test`, { method: 'POST' }),
    onSuccess: (res) => { setTest(res.data); refresh(); },
    onError: () => { setTest(null); refresh(); },
  });
  const forget = useMutation({
    mutationFn: () => apiFetch(`/olt-management/${oltId}/connection/host-key`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  function submit(e: FormEvent) { e.preventDefault(); save.mutate(); }
  const set = (k: keyof typeof form, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));

  return (
    <section style={s.card}>
      <h3 style={s.h3}>{t('oltLive.loginTitle')}</h3>
      <p style={s.hint}>{t('oltLive.loginHint')}</p>
      <form onSubmit={submit} style={s.grid}>
        <label style={s.label}>{t('oltLive.host')}
          <input style={s.input} value={form.host} onChange={e => set('host', e.target.value)} placeholder="10.20.0.5" required />
        </label>
        <label style={s.label}>{t('oltLive.port')}
          <input style={s.input} type="number" min={1} max={65535} value={form.port} onChange={e => set('port', e.target.value)} />
        </label>
        <label style={s.label}>{t('oltLive.username')}
          <input style={s.input} value={form.username} onChange={e => set('username', e.target.value)} autoComplete="off" required />
        </label>
        <label style={s.label}>{t('oltLive.password')}
          <input
            style={s.input} type="password" value={form.password} onChange={e => set('password', e.target.value)}
            autoComplete="new-password" required={!connection.has_password}
            placeholder={connection.has_password ? t('oltLive.passwordKept') : ''}
          />
        </label>
        <label style={{ ...s.label, flexDirection: 'row', alignItems: 'center', gap: '0.5rem', gridColumn: '1 / -1' }}>
          <input type="checkbox" checked={form.legacy_algorithms} onChange={e => set('legacy_algorithms', e.target.checked)} />
          {t('oltLive.legacy')}
        </label>
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="submit" style={s.primary} disabled={save.isPending}>{save.isPending ? t('oltLive.saving') : t('oltLive.save')}</button>
          <button type="button" style={s.secondary} disabled={!connection.configured || run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? t('oltLive.testing') : t('oltLive.test')}
          </button>
        </div>
      </form>
      {save.isError && <p style={s.error} role="alert">{(save.error as Error).message}</p>}
      {run.isError && <p style={s.error} role="alert">{(run.error as Error).message}</p>}

      {connection.configured && (
        <p style={s.hint}>
          {connection.host_key_fingerprint
            ? <>{t('oltLive.pinned')} <code>{connection.host_key_fingerprint}</code>{' '}
              <button type="button" style={s.link} onClick={() => forget.mutate()} disabled={forget.isPending}>{t('oltLive.forgetKey')}</button></>
            : t('oltLive.notPinned')}
          {connection.last_checked_at && (
            <> · {connection.last_check_ok ? t('oltLive.lastOk') : t('oltLive.lastFailed', { message: connection.last_check_message ?? '' })}</>
          )}
        </p>
      )}

      {test && (
        <div role="status">
          <p style={s.ok}>{t('oltLive.connected', { product: test.system.product ?? '?', version: test.system.version ?? '?' })}</p>
          <table style={s.table}>
            <thead><tr><th style={s.th}>{t('oltLive.slot')}</th><th style={s.th}>{t('oltLive.board')}</th><th style={s.th}>{t('oltLive.status')}</th></tr></thead>
            <tbody>
              {test.boards.map(b => (
                <tr key={b.slot}><td style={s.td}>{b.slot}</td><td style={s.td}>{b.board}</td><td style={s.td}>{b.status}</td></tr>
              ))}
            </tbody>
          </table>
          <Raw text={`${test.system.raw}\n\n${test.boards_raw}`} />
        </div>
      )}
    </section>
  );
}

function Unregistered({ oltId }: { oltId: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['olt-unregistered', oltId],
    queryFn: () => apiFetch<{ data: { onus: FoundOnu[]; raw: string } }>(`/olt-management/${oltId}/live/unregistered-onus`),
    enabled: false, retry: false,
  });
  return (
    <section style={s.card}>
      <h3 style={s.h3}>{t('oltLive.unregisteredTitle')}</h3>
      <p style={s.hint}>{t('oltLive.unregisteredHint')}</p>
      <button style={s.secondary} onClick={() => q.refetch()} disabled={q.isFetching}>{q.isFetching ? t('oltLive.reading') : t('oltLive.readNow')}</button>
      {q.isError && <p style={s.error} role="alert">{(q.error as Error).message}</p>}
      {q.data && (q.data.data.onus.length === 0
        ? <p style={s.hint}>{t('oltLive.noneUnregistered')}</p>
        : (
          <table style={s.table}>
            <thead><tr><th style={s.th}>{t('oltLive.ponPort')}</th><th style={s.th}>{t('oltLive.serial')}</th><th style={s.th}>{t('oltLive.model')}</th><th style={s.th}>{t('oltLive.foundAt')}</th><th style={s.th} /></tr></thead>
            <tbody>
              {q.data.data.onus.map(o => (
                <tr key={`${o.port}-${o.serial_number}`}><td style={s.td}>{o.port}</td><td style={{ ...s.td, fontFamily: 'monospace' }}>{o.serial_number}</td><td style={s.td}>{o.model ?? '—'}</td><td style={s.td}>{o.found_at ?? '—'}</td><td style={s.td}><AuthoriseOnu oltId={oltId} port={o.port} serial={o.serial_number} onDone={() => { void q.refetch(); void qc.invalidateQueries({ queryKey: ['olt-managed-onus', oltId] }); }} /></td></tr>
              ))}
            </tbody>
          </table>
        ))}
      <Raw text={q.data?.data.raw} />
    </section>
  );
}

function PortOnus({ oltId }: { oltId: number }) {
  const { t } = useTranslation();
  const [port, setPort] = useState('0/1/0');
  const [asked, setAsked] = useState('');
  const q = useQuery({
    queryKey: ['olt-port-onus', oltId, asked],
    queryFn: () => apiFetch<{ data: { port: string; onus: PortOnu[]; reported_total: number | null; reported_online: number | null; fault?: Fault; raw: string } }>(
      `/olt-management/${oltId}/live/onus?port=${encodeURIComponent(asked)}`),
    enabled: asked !== '', retry: false,
  });
  const valid = /^\d{1,2}\/\d{1,2}\/\d{1,3}$/.test(port.trim());
  const power = (v?: number | null) => (v === null || v === undefined ? '—' : `${v.toFixed(2)} dBm`);
  return (
    <section style={s.card}>
      <h3 style={s.h3}>{t('oltLive.portTitle')}</h3>
      <form onSubmit={(e) => { e.preventDefault(); if (valid) { if (asked === port.trim()) void q.refetch(); else setAsked(port.trim()); } }} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={s.label}>{t('oltLive.ponPortInput')}
          <input style={{ ...s.input, width: 120 }} value={port} onChange={e => setPort(e.target.value)} placeholder="0/1/0" aria-invalid={!valid} />
        </label>
        <button type="submit" style={s.secondary} disabled={!valid || q.isFetching}>{q.isFetching ? t('oltLive.reading') : t('oltLive.readNow')}</button>
      </form>
      {q.isError && <p style={s.error} role="alert">{(q.error as Error).message}</p>}
      {q.data && (
        <>
          <p style={s.hint}>{t('oltLive.portCount', { total: q.data.data.reported_total ?? q.data.data.onus.length, online: q.data.data.reported_online ?? '?' })}</p>
          {q.data.data.fault && <FibreCheck fault={q.data.data.fault} />}
          {q.data.data.onus.length > 0 && (
            <table style={s.table}>
              <thead><tr>
                <th style={s.th}>{t('oltLive.ontId')}</th><th style={s.th}>{t('oltLive.state')}</th><th style={s.th}>{t('oltLive.serial')}</th><th style={s.th}>{t('oltLive.model')}</th>
                <th style={s.th}>{t('oltLive.rx')}</th><th style={s.th}>{t('oltLive.distance')}</th><th style={s.th}>{t('oltLive.description')}</th>
              </tr></thead>
              <tbody>
                {q.data.data.onus.map(o => (
                  <tr key={o.ont_id}>
                    <td style={s.td}>{o.ont_id}</td>
                    <td style={{ ...s.td, color: o.state === 'online' ? 'var(--success)' : 'var(--danger)' }}>{o.state ?? '—'}{o.state !== 'online' && o.last_down_cause ? ` (${o.last_down_cause})` : ''}</td>
                    <td style={{ ...s.td, fontFamily: 'monospace' }}>{o.serial_number ?? '—'}</td>
                    <td style={s.td}>{o.model ?? '—'}</td>
                    <td style={s.td}>{power(o.rx_power_dbm)}</td>
                    <td style={s.td}>{o.distance_m !== null && o.distance_m !== undefined ? `${o.distance_m} m` : o.last_distance_m ? t('oltLive.lastDistance', { distance: o.last_distance_m }) : '—'}</td>
                    <td style={s.td}>{o.description ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Raw text={q.data.data.raw} />
        </>
      )}
    </section>
  );
}

interface Monitoring { available: boolean; enabled: boolean; last_run_at: string | null; last_status: string | null; can_change: boolean }
interface PortStatus extends Fault { port: string; read_at: string }

/** The scheduled SNMP read of every OLT: the install-wide switch. */
function MonitoringSwitch() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['olt-monitoring'], queryFn: () => apiFetch<{ data: Monitoring }>('/olt-management/monitoring') });
  const change = useMutation({
    mutationFn: (enabled: boolean) => apiFetch<{ data: Monitoring }>('/olt-management/monitoring', { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: (res) => qc.setQueryData(['olt-monitoring'], res),
  });
  const data = status.data?.data;
  if (!data || !data.available) return null;
  return (
    <section style={s.card}>
      <label style={{ ...s.label, flexDirection: 'row', alignItems: 'center', gap: '0.5rem', color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.9rem' }}>
        <input type="checkbox" checked={data.enabled} disabled={!data.can_change || change.isPending} onChange={e => change.mutate(e.target.checked)} />
        {t('oltLive.monitoring')}
      </label>
      <p style={s.hint}>
        {t('oltLive.monitoringHint')}
        {!data.can_change && ` ${t('oltLive.operatorOnly')}`}
        {data.last_run_at && ` ${t('oltLive.monitoringLast', { when: new Date(data.last_run_at).toLocaleString() })}`}
      </p>
      {change.isError && <p style={s.error} role="alert">{(change.error as Error).message}</p>}
    </section>
  );
}

/** Every PON port judged from what was last read. Reads nothing from the OLT. */
function FibreStatus({ oltId }: { oltId: number }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['olt-fibre-status', oltId],
    queryFn: () => apiFetch<{ data: PortStatus[] }>(`/olt-management/${oltId}/fibre-status`),
  });
  const ports = q.data?.data ?? [];
  const broken = (v: string) => v === 'whole_port' || v === 'branch' || v === 'single_onu';
  const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m} m`);
  return (
    <section style={s.card}>
      <h3 style={s.h3}>{t('oltLive.statusTitle')}</h3>
      <p style={s.hint}>{t('oltLive.statusHint')}</p>
      {q.isError && <p style={s.error} role="alert">{(q.error as Error).message}</p>}
      {q.data && ports.length === 0 && <p style={s.hint}>{t('oltLive.statusEmpty')}</p>}
      {ports.length > 0 && (
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>{t('oltLive.ponPort')}</th><th style={s.th}>{t('oltLive.statusFibre')}</th>
            <th style={s.th}>{t('oltLive.statusOnline')}</th><th style={s.th}>{t('oltLive.statusBreak')}</th><th style={s.th}>{t('oltLive.statusRead')}</th>
          </tr></thead>
          <tbody>
            {ports.map(p => (
              <tr key={p.port}>
                <td style={s.td}>{p.port}</td>
                <td style={{ ...s.td, color: broken(p.verdict) ? 'var(--danger)' : 'var(--success)', fontWeight: 600 }}>{t(`oltLive.short.${p.verdict}`)}</td>
                <td style={s.td}>{p.online} / {p.total}</td>
                <td style={s.td}>{broken(p.verdict) && p.nearest_affected_m !== null ? t('oltLive.statusWithin', { distance: metres(p.nearest_affected_m) }) : '—'}</td>
                <td style={s.td}>{new Date(p.read_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * Add an OLT without leaving this page. An OLT is a device of type "olt";
 * this creates it, with SNMP settings so automatic monitoring can read it.
 */
function NewOlt({ onCreated, open: startOpen = false }: { onCreated: (id: number) => void; open?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(startOpen);
  const [form, setForm] = useState({ name: '', model: '', ip_address: '', snmp_enabled: true, snmp_community: '' });
  const create = useMutation({
    mutationFn: () => apiFetch<{ data: { id: number } }>('/devices', {
      method: 'POST',
      body: JSON.stringify({
        name: form.name.trim(), type: 'olt', manufacturer: 'Huawei',
        ...(form.model.trim() ? { model: form.model.trim() } : {}),
        ...(form.ip_address.trim() ? { ip_address: form.ip_address.trim() } : {}),
        snmp_enabled: form.snmp_enabled,
        ...(form.snmp_enabled && form.snmp_community ? { snmp_community: form.snmp_community, snmp_version: 'v2c' } : {}),
      }),
    }),
    onSuccess: (res) => { setOpen(false); setForm({ name: '', model: '', ip_address: '', snmp_enabled: true, snmp_community: '' }); onCreated(res.data.id); },
  });
  const set = (k: keyof typeof form, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));
  function submit(e: FormEvent) { e.preventDefault(); if (form.name.trim()) create.mutate(); }

  if (!open) return <button type="button" style={s.primary} onClick={() => setOpen(true)}>{t('oltLive.newOlt')}</button>;
  return (
    <section style={s.card}>
      <h3 style={s.h3}>{t('oltLive.newOltTitle')}</h3>
      <p style={s.hint}>{t('oltLive.newOltHint')}</p>
      <form onSubmit={submit} style={s.grid}>
        <label style={s.label}>{t('oltLive.oltName')}
          <input style={s.input} value={form.name} onChange={e => set('name', e.target.value)} required />
        </label>
        <label style={s.label}>{t('oltLive.model')}
          <input style={s.input} value={form.model} onChange={e => set('model', e.target.value)} />
        </label>
        <label style={s.label}>{t('oltLive.host')}
          <input style={s.input} value={form.ip_address} onChange={e => set('ip_address', e.target.value)} placeholder="10.20.0.5" />
        </label>
        <label style={s.label}>{t('oltLive.snmpCommunity')}
          <input style={s.input} type="password" value={form.snmp_community} onChange={e => set('snmp_community', e.target.value)} disabled={!form.snmp_enabled} autoComplete="new-password" />
        </label>
        <label style={{ ...s.label, flexDirection: 'row', alignItems: 'center', gap: '0.5rem', gridColumn: '1 / -1' }}>
          <input type="checkbox" checked={form.snmp_enabled} onChange={e => set('snmp_enabled', e.target.checked)} />
          {t('oltLive.snmpEnabled')}
        </label>
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="submit" style={s.primary} disabled={create.isPending}>{create.isPending ? t('oltLive.saving') : t('oltLive.addOlt')}</button>
          <button type="button" style={s.secondary} onClick={() => setOpen(false)} disabled={create.isPending}>{t('oltLive.cancelNew')}</button>
        </div>
      </form>
      {create.isError && <p style={s.error} role="alert">{(create.error as Error).message}</p>}
    </section>
  );
}

export function OltLiveTab() {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<number | null>(null);
  const olts = useQuery({
    queryKey: ['olt-devices'],
    queryFn: () => apiFetch<{ data: OltDevice[] }>('/devices?type=olt&limit=200'),
  });
  const list = (olts.data?.data ?? []);
  const oltId = selected ?? list[0]?.id ?? null;
  const connection = useQuery({
    queryKey: ['olt-connection', oltId],
    queryFn: () => apiFetch<{ data: Connection }>(`/olt-management/${oltId as number}/connection`),
    enabled: oltId !== null,
  });

  const qc = useQueryClient();
  const created = (id: number) => { setSelected(id); void qc.invalidateQueries({ queryKey: ['olt-devices'] }); };

  if (olts.isLoading) return <p style={s.hint}>{t('oltLive.loading')}</p>;
  if (list.length === 0) {
    return (
      <div>
        <p style={s.hint}>{t('oltLive.noOlts')}</p>
        <NewOlt open onCreated={created} />
      </div>
    );
  }

  return (
    <div>
      <p style={s.notice}>{t('oltLive.notice')}</p>
      <MonitoringSwitch />
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <label style={{ ...s.label, minWidth: 260 }}>{t('oltLive.chooseOlt')}
          <select style={s.input} value={oltId ?? ''} onChange={e => setSelected(Number(e.target.value))}>
            {list.map(o => <option key={o.id} value={o.id}>{o.name}{o.model ? ` (${o.model})` : ''}</option>)}
          </select>
        </label>
        <NewOlt onCreated={created} />
      </div>
      {oltId !== null && connection.data && (
        <>
          <ConnectionForm key={`${oltId}-${connection.data.data.host ?? ''}`} oltId={oltId} connection={connection.data.data} />
          <FibreStatus key={`f-${oltId}`} oltId={oltId} />
          {connection.data.data.configured && connection.data.data.provisioning && (
            <ProvisioningSettingsForm key={`s-${oltId}`} oltId={oltId} settings={connection.data.data.provisioning} />
          )}
          {connection.data.data.configured && <Unregistered key={`u-${oltId}`} oltId={oltId} />}
          {connection.data.data.configured && <ManagedOnus key={`m-${oltId}`} oltId={oltId} />}
          {connection.data.data.configured && <PortOnus key={`p-${oltId}`} oltId={oltId} />}
        </>
      )}
    </div>
  );
}

const btn: CSSProperties = { padding: '0.45rem 0.9rem', borderRadius: 6, fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer' };
const s: Record<string, CSSProperties> = {
  card: { border: '1px solid var(--border-color)', borderRadius: 8, padding: '1rem', marginBottom: '1rem', background: 'var(--bg-secondary)' },
  h3: { margin: '0 0 0.35rem', fontSize: '1rem', color: 'var(--text-primary)' },
  hint: { margin: '0.4rem 0', fontSize: '0.82rem', color: 'var(--text-secondary)' },
  notice: { margin: '0 0 1rem', padding: '0.6rem 0.8rem', borderRadius: 6, fontSize: '0.82rem', background: 'var(--info-soft)', color: 'var(--info-text)', border: '1px solid var(--info-border)' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginTop: '0.5rem' },
  label: { display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.82rem', color: 'var(--text-secondary)' },
  input: { padding: '0.45rem 0.6rem', border: '1px solid var(--input-border)', borderRadius: 6, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '0.9rem' },
  primary: { ...btn, background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none' },
  secondary: { ...btn, background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)' },
  link: { background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', fontSize: '0.82rem', textDecoration: 'underline' },
  error: { margin: '0.5rem 0 0', fontSize: '0.85rem', color: 'var(--danger)' },
  ok: { margin: '0.6rem 0 0.4rem', fontSize: '0.88rem', color: 'var(--success)', fontWeight: 600 },
  table: { width: '100%', borderCollapse: 'collapse', marginTop: '0.5rem', fontSize: '0.85rem' },
  th: { textAlign: 'left', padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)', fontWeight: 600 },
  td: { padding: '0.35rem 0.5rem', borderBottom: '1px solid var(--border-color)', color: 'var(--text-primary)' },
  fault: { margin: '0.5rem 0', padding: '0.7rem 0.9rem', borderRadius: 6, fontSize: '0.88rem', border: '1px solid var(--border-color)', color: 'var(--text-primary)' },
  faultOk: { borderColor: 'var(--success)', background: 'var(--success-soft)' },
  faultBad: { borderColor: 'var(--danger)', background: 'var(--danger-soft)' },
  faultLine: { margin: '0.3rem 0 0', fontSize: '0.85rem' },
  faultNote: { margin: '0.4rem 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)' },
  rawSummary: { cursor: 'pointer', fontSize: '0.8rem', color: 'var(--text-secondary)' },
  raw: { margin: '0.4rem 0 0', padding: '0.6rem', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: '0.75rem', overflowX: 'auto', color: 'var(--text-primary)' },
};

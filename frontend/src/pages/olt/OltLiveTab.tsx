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

interface OltDevice { id: number; name: string; model: string | null; ip_address: string | null }
interface Connection {
  configured: boolean; driver?: string; host?: string; port?: number; username?: string;
  has_password?: boolean; legacy_algorithms?: boolean; host_key_fingerprint?: string | null;
  last_checked_at?: string | null; last_check_ok?: boolean | null; last_check_message?: string | null;
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
            <thead><tr><th style={s.th}>{t('oltLive.ponPort')}</th><th style={s.th}>{t('oltLive.serial')}</th><th style={s.th}>{t('oltLive.model')}</th><th style={s.th}>{t('oltLive.foundAt')}</th></tr></thead>
            <tbody>
              {q.data.data.onus.map(o => (
                <tr key={`${o.port}-${o.serial_number}`}><td style={s.td}>{o.port}</td><td style={{ ...s.td, fontFamily: 'monospace' }}>{o.serial_number}</td><td style={s.td}>{o.model ?? '—'}</td><td style={s.td}>{o.found_at ?? '—'}</td></tr>
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
    queryFn: () => apiFetch<{ data: { port: string; onus: PortOnu[]; reported_total: number | null; reported_online: number | null; raw: string } }>(
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
                    <td style={s.td}>{o.distance_m === null || o.distance_m === undefined ? '—' : `${o.distance_m} m`}</td>
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

  if (olts.isLoading) return <p style={s.hint}>{t('oltLive.loading')}</p>;
  if (list.length === 0) return <p style={s.hint}>{t('oltLive.noOlts')}</p>;

  return (
    <div>
      <p style={s.notice}>{t('oltLive.notice')}</p>
      <label style={{ ...s.label, maxWidth: 360, marginBottom: '1rem' }}>{t('oltLive.chooseOlt')}
        <select style={s.input} value={oltId ?? ''} onChange={e => setSelected(Number(e.target.value))}>
          {list.map(o => <option key={o.id} value={o.id}>{o.name}{o.model ? ` (${o.model})` : ''}</option>)}
        </select>
      </label>
      {oltId !== null && connection.data && (
        <>
          <ConnectionForm key={`${oltId}-${connection.data.data.host ?? ''}`} oltId={oltId} connection={connection.data.data} />
          {connection.data.data.configured && <Unregistered key={`u-${oltId}`} oltId={oltId} />}
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
  rawSummary: { cursor: 'pointer', fontSize: '0.8rem', color: 'var(--text-secondary)' },
  raw: { margin: '0.4rem 0 0', padding: '0.6rem', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 6, fontSize: '0.75rem', overflowX: 'auto', color: 'var(--text-primary)' },
};

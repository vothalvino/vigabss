// =============================================================================
// VigaBSS 5.0 — Blocked IPs at sign-in (migration 013)
// =============================================================================
// Part of Security & Access Control → User security. The app blocks an IP on
// its own after too many failed sign-ins (staff, 2FA and portal); staff can
// block one by hand and lift any block. A block covers the whole install, so
// the API serves it to the install operator only; everyone else gets 403 and
// this section shows nothing.
// =============================================================================

import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { apiFetch, ApiRequestError } from '@/api/apiFetch';
import type { paths } from '@/api/schema';

type ListResponse = paths['/security-admin/login-ip-blocks']['get']['responses'][200]['content']['application/json'];
type Block = ListResponse['data'][number];

const QUERY_KEY = ['login-ip-blocks'];

const cell = { padding: '6px 8px', borderBottom: '1px solid #eee' } as const;
const head = { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ccc' } as const;

function fmt(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function LoginIpBlocksSection() {
  const { t } = useTranslation();
  const k = (key: string, opts?: Record<string, unknown>) => t(`securityAccessControl.loginIpBlocks.${key}`, opts);
  const queryClient = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const [ip, setIp] = useState('');
  const [hours, setHours] = useState('24');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const listQ = useQuery({
    queryKey: [...QUERY_KEY, showAll],
    queryFn: () => apiFetch<ListResponse>(`/security-admin/login-ip-blocks?limit=100${showAll ? '' : '&active=true'}`),
    retry: false,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });

  const block = useMutation({
    mutationFn: () => apiFetch('/security-admin/login-ip-blocks', {
      method: 'POST',
      body: JSON.stringify({ ip: ip.trim(), hours: hours === 'forever' ? null : Number(hours), ...(note.trim() ? { note: note.trim() } : {}) }),
    }),
    onSuccess: async () => { setIp(''); setNote(''); setError(null); await refresh(); },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const lift = useMutation({
    mutationFn: (id: number) => apiFetch(`/security-admin/login-ip-blocks/${id}/lift`, { method: 'POST' }),
    onSuccess: async () => { setError(null); await refresh(); },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  // Not the install operator (or no permission): nothing to show.
  if (listQ.error instanceof ApiRequestError && listQ.error.status === 403) return null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    block.mutate();
  }

  const settings = listQ.data?.settings;
  const rows: Block[] = listQ.data?.data ?? [];
  const busy = block.isPending || lift.isPending;

  return (
    <section aria-labelledby="login-ip-blocks" style={{ marginTop: 28 }}>
      <h2 id="login-ip-blocks">{k('title')}</h2>
      <p role="note">
        {settings && settings.enabled
          ? k('explainOn', { threshold: settings.threshold, minutes: settings.window_minutes, hours: settings.hours })
          : settings ? k('explainOff') : null}
        {' '}{k('explainPrivate')}
      </p>
      {listQ.data?.your_ip && (
        <p>{k('yourIp')}: <code>{listQ.data.your_ip}</code></p>
      )}

      <form onSubmit={submit} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
        <label>
          <span style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>{k('ip')}</span>
          <input required value={ip} onChange={e => setIp(e.target.value)} placeholder="203.0.113.5" style={{ padding: '8px 10px', width: 220 }} />
        </label>
        <label>
          <span style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>{k('duration')}</span>
          <select value={hours} onChange={e => setHours(e.target.value)} style={{ padding: '8px 10px' }}>
            <option value="1">{k('hours', { count: 1 })}</option>
            <option value="24">{k('hours', { count: 24 })}</option>
            <option value="168">{k('days', { count: 7 })}</option>
            <option value="720">{k('days', { count: 30 })}</option>
            <option value="forever">{k('untilLifted')}</option>
          </select>
        </label>
        <label style={{ flex: '1 1 200px' }}>
          <span style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>{k('note')}</span>
          <input value={note} maxLength={255} onChange={e => setNote(e.target.value)} style={{ padding: '8px 10px', width: '100%' }} />
        </label>
        <button type="submit" disabled={busy} style={{ padding: '8px 14px' }}>{k('block')}</button>
      </form>

      <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
        {k('showHistory')}
      </label>

      {error && <p role="alert" style={{ color: '#b91c1c' }}>{error}</p>}
      {listQ.isLoading ? <p>{t('common.loading')}</p>
        : listQ.error ? <p role="alert" style={{ color: '#b91c1c' }}>{k('loadFailed')}</p>
          : rows.length === 0 ? <p>{showAll ? k('noneEver') : k('none')}</p>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={head}>{k('ip')}</th>
                      <th style={head}>{k('source')}</th>
                      <th style={head}>{k('since')}</th>
                      <th style={head}>{k('until')}</th>
                      <th style={head}>{k('refused')}</th>
                      <th style={head}>{k('note')}</th>
                      <th style={head}>{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(b => (
                      <tr key={b.id}>
                        <td style={{ ...cell, fontFamily: 'monospace' }}>{b.ip_address}</td>
                        <td style={cell}>
                          {b.source === 'auto' ? k('auto', { count: b.failures }) : k('manual')}
                        </td>
                        <td style={cell}>{fmt(b.created_at)}</td>
                        <td style={cell}>
                          {b.lifted_at ? k('liftedAt', { at: fmt(b.lifted_at) })
                            : b.blocked_until ? (b.active ? fmt(b.blocked_until) : k('expiredAt', { at: fmt(b.blocked_until) }))
                              : k('untilLifted')}
                        </td>
                        <td style={cell}>{b.refused_count}</td>
                        <td style={{ ...cell, maxWidth: 260, overflowWrap: 'anywhere' }}>{b.note ?? '—'}</td>
                        <td style={cell}>
                          {b.active && (
                            <button type="button" disabled={busy} onClick={() => lift.mutate(b.id)}>{k('lift')}</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
    </section>
  );
}

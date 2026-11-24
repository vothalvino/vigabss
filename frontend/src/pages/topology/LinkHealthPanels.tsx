// =============================================================================
// VigaBSS 5.0 — settings behind the tree's colours
// =============================================================================
// UplinkForm: which polled port of a piece of equipment faces its parent, and
// what that line can carry. Traffic, optical power and port-down are read
// from that port.
// HealthLimits: the limits past which a line or equipment turns yellow.
// =============================================================================
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { apiFetch } from '@/api/apiFetch';
import { styles } from '../crudStyles';
import { HEALTH_COLOR, HEALTH_QUERY_KEY, HEALTH_STATES } from './linkHealth';

interface PortList {
  uplink_interface: string | null;
  uplink_capacity_mbps: number | null;
  ports: Array<{ interface: string; up: boolean | null; rate_mbps: number | null }>;
}

export function UplinkForm({ deviceId, name, onDone }: { deviceId: number; name: string; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [port, setPort] = useState<string | null>(null);
  const [capacity, setCapacity] = useState<string | null>(null);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['topology-health-ports', deviceId],
    queryFn: async () => (await apiFetch<{ data: PortList }>(`/topology/health/devices/${deviceId}/ports`)).data,
  });
  const save = useMutation({
    mutationFn: (body: { uplink_interface: string | null; uplink_capacity_mbps: number | null }) => apiFetch(`/topology/health/devices/${deviceId}/uplink`, {
      method: 'PUT', body: JSON.stringify(body),
    }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: HEALTH_QUERY_KEY }); void qc.invalidateQueries({ queryKey: ['topology-health-ports', deviceId] }); onDone(); },
  });
  if (isLoading) return <p>{t('networkTree.loading')}</p>;
  if (isError || !data) return <p role="alert">{t('linkHealth.portsFailed')}</p>;

  const chosenPort = port ?? data.uplink_interface ?? '';
  const chosenCapacity = capacity ?? (data.uplink_capacity_mbps === null ? '' : String(data.uplink_capacity_mbps));
  // A port saved earlier that the poller no longer reports stays selectable.
  const known = data.ports.some(p => p.interface === chosenPort);
  return (
    <form
      aria-label={t('linkHealth.uplinkTitle', { name })}
      onSubmit={e => { e.preventDefault(); save.mutate({ uplink_interface: chosenPort || null, uplink_capacity_mbps: chosenCapacity === '' ? null : Number(chosenCapacity) }); }}
      style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '6px 0' }}
    >
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        {t('linkHealth.port')}
        <select value={chosenPort} onChange={e => setPort(e.target.value)} style={styles.input}>
          <option value="">{t('linkHealth.noPort')}</option>
          {chosenPort && !known && <option value={chosenPort}>{t('linkHealth.portLabel', { port: chosenPort })}</option>}
          {data.ports.map(p => (
            <option key={p.interface} value={p.interface}>
              {t('linkHealth.portLabel', { port: p.interface })}
              {p.up === false ? ` · ${t('linkHealth.portIsDown')}` : ''}
              {p.rate_mbps !== null ? ` · ${p.rate_mbps} Mbps` : ''}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        {t('linkHealth.capacity')}
        <input type="number" min={1} step={1} value={chosenCapacity} onChange={e => setCapacity(e.target.value)} style={{ ...styles.input, width: 110 }} />
      </label>
      <button type="submit" disabled={save.isPending} style={{ ...styles.input, cursor: 'pointer', fontWeight: 600 }}>{t('networkTree.save')}</button>
      <button type="button" onClick={onDone} style={{ ...styles.input, cursor: 'pointer' }}>{t('networkTree.cancel')}</button>
      {data.ports.length === 0 && <span>{t('linkHealth.noPorts')}</span>}
      {save.isError && <span role="alert" style={{ color: '#991b1b' }}>{(save.error as Error).message}</span>}
    </form>
  );
}

export function HealthLegend() {
  const { t } = useTranslation();
  return (
    <p style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: '0.82rem', margin: '0 0 10px' }}>
      {HEALTH_STATES.map(state => (
        <span key={state} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span aria-hidden="true" style={{ display: 'inline-block', width: 18, height: 4, borderRadius: 2, background: HEALTH_COLOR[state] }} />
          {t(`linkHealth.states.${state}`)}
        </span>
      ))}
    </p>
  );
}

interface LimitsData { limits: Record<string, number>; ranges: Record<string, { default: number; min: number; max: number }> }
const LIMITS_KEY = ['topology-health-limits'];

export function HealthLimits({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const { data } = useQuery({
    queryKey: LIMITS_KEY, enabled: open,
    queryFn: async () => (await apiFetch<{ data: LimitsData }>('/topology/health/limits')).data,
  });
  const save = useMutation({
    mutationFn: (body: Record<string, number>) => apiFetch('/topology/health/limits', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { setDraft({}); void qc.invalidateQueries({ queryKey: LIMITS_KEY }); void qc.invalidateQueries({ queryKey: HEALTH_QUERY_KEY }); },
  });
  const changed = Object.entries(draft).filter(([key, value]) => value !== '' && data && Number(value) !== data.limits[key]);
  return (
    <section style={{ marginBottom: 14 }}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} style={{ cursor: 'pointer', fontSize: '0.82rem' }}>
        {open ? t('linkHealth.limitsHide') : t('linkHealth.limitsShow')}
      </button>
      {open && data && (
        <form
          aria-label={t('linkHealth.limitsTitle')}
          onSubmit={e => { e.preventDefault(); if (changed.length) save.mutate(Object.fromEntries(changed.map(([key, value]) => [key, Number(value)]))); }}
          style={{ marginTop: 8, padding: 12, border: '1px solid var(--border-color, #e2e8f0)', borderRadius: 8 }}
        >
          <p style={{ marginTop: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('linkHealth.limitsIntro')}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 8 }}>
            {Object.entries(data.ranges).map(([key, range]) => (
              <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: '0.85rem' }}>
                {t(`linkHealth.limits.${key}`)}
                <input
                  type="number" step="any" min={range.min} max={range.max} disabled={!canEdit}
                  value={draft[key] ?? String(data.limits[key])}
                  onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
                  style={styles.input}
                />
              </label>
            ))}
          </div>
          {canEdit
            ? <button type="submit" disabled={save.isPending || changed.length === 0} style={{ ...styles.input, cursor: 'pointer', fontWeight: 600, marginTop: 10 }}>{t('linkHealth.limitsSave')}</button>
            : <p style={{ marginBottom: 0, fontSize: '0.85rem' }}>{t('linkHealth.limitsReadOnly')}</p>}
          {save.isError && <span role="alert" style={{ color: '#991b1b', marginLeft: 10 }}>{(save.error as Error).message}</span>}
        </form>
      )}
    </section>
  );
}

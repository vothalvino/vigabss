// Zones of resellers and collectors: the organization's zones, and which
// zone each point is in. The bags list and its numbers filter by them.
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { styles } from '../crudStyles';
import {
  assignPointZone, cashBagKeys, createZone, fetchZonePoints, fetchZones, removeZone, renameZone,
} from './cashBagsApi';

export function ZonesTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const canEdit = can(user, 'resellers.update');
  const zones = useQuery({ queryKey: cashBagKeys.zones, queryFn: fetchZones });
  const points = useQuery({ queryKey: cashBagKeys.zonePoints, queryFn: fetchZonePoints });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      await qc.invalidateQueries({ queryKey: cashBagKeys.all });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('cashBags.zones.failed'));
    } finally {
      setBusy(false);
    }
  }
  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    void run(async () => { await createZone(name.trim()); setName(''); });
  }
  function rename(id: number, current: string) {
    const next = window.prompt(t('cashBags.zones.renamePrompt'), current);
    if (next && next.trim() && next.trim() !== current) void run(() => renameZone(id, next.trim()));
  }
  function remove(id: number, zoneName: string) {
    if (window.confirm(t('cashBags.zones.confirmRemove', { name: zoneName }))) void run(() => removeZone(id));
  }
  const list = zones.data ?? [];

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <p style={{ ...styles.msg, textAlign: 'left', padding: 0, fontStyle: 'normal' }}>{t('cashBags.zones.help')}</p>
      {error && <p role="alert" style={styles.msgError}>{error}</p>}

      <section aria-label={t('cashBags.zones.title')}>
        <h3 style={{ margin: '0 0 8px' }}>{t('cashBags.zones.title')}</h3>
        <div style={{ ...styles.tableCard, overflowX: 'auto' }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('cashBags.zones.id')}</th>
                <th style={styles.th}>{t('cashBags.zones.name')}</th>
                <th style={styles.thNum}>{t('cashBags.zones.points')}</th>
                {canEdit && <th style={styles.th}>{t('cashBags.col.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {zones.data && list.length === 0 && <tr><td colSpan={4} style={styles.emptyCell}>{t('cashBags.zones.none')}</td></tr>}
              {list.map(z => (
                <tr key={z.id} style={styles.tr}>
                  <td style={styles.td}>{z.id}</td>
                  <td style={{ ...styles.td, fontWeight: 600 }}>{z.name}</td>
                  <td style={styles.tdNum}>{z.points}</td>
                  {canEdit && (
                    <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                      <button type="button" style={{ ...styles.actionBtn, marginRight: 6 }} disabled={busy} onClick={() => rename(z.id, z.name)} aria-label={t('cashBags.zones.renameZone', { name: z.name })}>{t('cashBags.zones.rename')}</button>
                      <button type="button" style={styles.actionBtn} disabled={busy} onClick={() => remove(z.id, z.name)} aria-label={t('cashBags.zones.removeZone', { name: z.name })}>{t('cashBags.zones.remove')}</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canEdit && (
          <form onSubmit={add} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input style={styles.filterSelect} aria-label={t('cashBags.zones.newName')} placeholder={t('cashBags.zones.newName')} maxLength={100} value={name} onChange={e => setName(e.target.value)} />
            <button type="submit" style={styles.btnPrimary} disabled={busy || !name.trim()}>{t('cashBags.zones.add')}</button>
          </form>
        )}
      </section>

      <section aria-label={t('cashBags.zones.pointsTitle')}>
        <h3 style={{ margin: '0 0 8px' }}>{t('cashBags.zones.pointsTitle')}</h3>
        <div style={{ ...styles.tableCard, overflowX: 'auto' }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('cashBags.zones.point')}</th>
                <th style={styles.th}>{t('cashBags.zones.kind')}</th>
                <th style={styles.th}>{t('cashBags.zones.city')}</th>
                <th style={styles.th}>{t('cashBags.col.zone')}</th>
              </tr>
            </thead>
            <tbody>
              {points.data && points.data.length === 0 && <tr><td colSpan={4} style={styles.emptyCell}>{t('cashBags.zones.noPoints')}</td></tr>}
              {(points.data ?? []).map(p => (
                <tr key={p.id} style={styles.tr}>
                  <td style={{ ...styles.td, fontWeight: 600 }}>{p.name}</td>
                  <td style={styles.td}>{t(`cashBags.zones.kinds.${p.kind === 'collector' ? 'collector' : 'reseller'}`)}</td>
                  <td style={styles.td}>{p.city ?? '—'}</td>
                  <td style={styles.td}>
                    {canEdit ? (
                      <select
                        style={styles.filterSelect}
                        aria-label={t('cashBags.zones.zoneOf', { name: p.name })}
                        value={p.zone_id ?? ''}
                        disabled={busy}
                        onChange={e => void run(() => assignPointZone(p.id, Number(e.target.value) || null))}
                      >
                        <option value="">{t('cashBags.filters.noZone')}</option>
                        {list.map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
                      </select>
                    ) : (list.find(z => z.id === p.zone_id)?.name ?? '—')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

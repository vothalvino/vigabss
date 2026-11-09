// =============================================================================
// Cash bags (staff) — Transportistas (carriers.manage)
// =============================================================================
// A carrier is a staff login in the system "carrier" group: it signs in to
// the route app (/ruta) only, sees only the resellers assigned to it, picks
// up their sealed bags and drops off empty ones, and never sees an amount.
//   • the carriers with their resellers and the bags they hold (GET /carriers);
//   • "Crear transportista" (POST /carriers, which also needs users.create,
//     like a reseller login): the organization's password policy applies and
//     an email already in use is refused; the server's message is shown as is;
//   • "Asignar puntos" (GET/PUT /carriers/:userId/resellers): top-level
//     resellers of the organization only, listed by
//     GET /carriers/assignable-resellers (carriers.manage alone, every one).
// =============================================================================

import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@/api/useMutation';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { extractApiError } from '@/components/ClientFormModal';
import { LoadingState } from '@/components/FetchStates';
import { styles } from '../crudStyles';
import {
  cashBagKeys, createCarrier, fetchAssignableResellers, fetchCarrierResellers, fetchCarriers, saveCarrierResellers,
  type Carrier, type CarrierBody,
} from './cashBagsApi';

const EMPTY: CarrierBody = { first_name: '', last_name: '', email: '', password: '', phone: '' };

export function CarrierCreateForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<CarrierBody>(EMPTY);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const create = useMutation({
    mutationFn: (body: CarrierBody) => createCarrier(body),
    onSuccess: (data) => {
      setMsg({ ok: true, text: t('cashBags.carriers.created', { email: data.email }) });
      setForm(EMPTY);
      onCreated();
    },
    onError: (err: unknown) => setMsg({ ok: false, text: extractApiError(err, t('cashBags.carriers.createError')) }),
  });
  const set = (key: keyof CarrierBody) => (e: { target: { value: string } }) => setForm(p => ({ ...p, [key]: e.target.value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    const body: CarrierBody = { first_name: form.first_name.trim(), last_name: form.last_name.trim(), email: form.email.trim(), password: form.password };
    const phone = (form.phone ?? '').trim();
    if (phone) body.phone = phone;
    if (!body.first_name || !body.last_name || !body.email || !body.password) {
      setMsg({ ok: false, text: t('cashBags.carriers.required') });
      return;
    }
    setMsg(null);
    create.mutate(body);
  }

  const field = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 160, flex: '1 1 160px' } as const;
  return (
    <form onSubmit={submit} noValidate aria-labelledby="carrier-create-title" style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <h4 id="carrier-create-title" style={{ margin: '0 0 4px' }}>{t('cashBags.carriers.createTitle')}</h4>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 10px' }}>{t('cashBags.carriers.createHelp')}</p>
      {msg && <p role={msg.ok ? 'status' : 'alert'} style={{ ...(msg.ok ? styles.msg : styles.msgError), padding: '0 0 8px', fontStyle: 'normal' }}>{msg.text}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ ...styles.filterLabel, ...field }}>
          {t('resellerLogin.firstName')}
          <input style={styles.filterSelect} autoComplete="off" value={form.first_name} onChange={set('first_name')} />
        </label>
        <label style={{ ...styles.filterLabel, ...field }}>
          {t('resellerLogin.lastName')}
          <input style={styles.filterSelect} autoComplete="off" value={form.last_name} onChange={set('last_name')} />
        </label>
        <label style={{ ...styles.filterLabel, ...field }}>
          {t('resellerLogin.email')}
          <input style={styles.filterSelect} type="email" autoComplete="off" value={form.email} onChange={set('email')} />
        </label>
        <label style={{ ...styles.filterLabel, ...field }}>
          {t('cashBags.carriers.phone')}
          <input style={styles.filterSelect} type="tel" autoComplete="off" value={form.phone ?? ''} onChange={set('phone')} />
        </label>
        <label style={{ ...styles.filterLabel, ...field }}>
          {t('resellerLogin.password')}
          <input style={styles.filterSelect} type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
        </label>
        <button type="submit" style={styles.btnPrimary} disabled={create.isPending}>
          {create.isPending ? t('resellerLogin.creating') : t('cashBags.carriers.createSubmit')}
        </button>
      </div>
    </form>
  );
}

function AssignResellers({ carrier, onSaved, onClose }: { carrier: Carrier; onSaved: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const resellers = useQuery({ queryKey: cashBagKeys.assignableResellers, queryFn: fetchAssignableResellers });
  const assigned = useQuery({ queryKey: cashBagKeys.carrierResellers(carrier.user_id), queryFn: () => fetchCarrierResellers(carrier.user_id), gcTime: 0 });
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const [error, setError] = useState('');
  const chosen = picked ?? new Set(assigned.data ?? carrier.resellers.map(r => r.id));
  const save = useMutation({
    mutationFn: () => saveCarrierResellers(carrier.user_id, [...chosen].sort((a, b) => a - b)),
    onSuccess: () => { onSaved(); onClose(); },
    onError: (err: unknown) => setError(extractApiError(err, t('cashBags.carriers.assignError'))),
  });

  function toggle(id: number) {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  }

  return (
    <section aria-labelledby={`carrier-assign-${carrier.user_id}`} style={{ ...styles.tableCard, padding: '0.75rem 1rem', marginTop: 12 }}>
      <h4 id={`carrier-assign-${carrier.user_id}`} style={{ margin: '0 0 6px' }}>{t('cashBags.carriers.assignTitle', { name: carrier.name })}</h4>
      <p style={{ margin: '0 0 8px', color: 'var(--text-secondary)', fontSize: '0.82rem' }}>{t('cashBags.carriers.assignHelp')}</p>
      {(resellers.isLoading || assigned.isLoading) && <LoadingState />}
      {resellers.isError && <p role="alert" style={styles.errorText}>{t('cashBags.carriers.resellersError')}</p>}
      {resellers.data?.truncated && <p role="note" style={{ margin: '0 0 8px', fontSize: '0.82rem' }}>{t('cashBags.carriers.assignTruncated', { shown: resellers.data.resellers.length })}</p>}
      {resellers.data && !assigned.isLoading && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 4 }}>
          {resellers.data.resellers.map(r => (
            <label key={r.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={chosen.has(r.id)} onChange={() => toggle(r.id)} />
              {r.name}
            </label>
          ))}
        </div>
      )}
      {error && <p role="alert" style={styles.errorText}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" style={styles.btnPrimary} disabled={save.isPending || assigned.isLoading} onClick={() => { setError(''); save.mutate(); }}>
          {save.isPending ? t('cashBags.common.saving') : t('cashBags.carriers.assignSave', { count: chosen.size })}
        </button>
        <button type="button" style={styles.btnSecondary} onClick={onClose}>{t('cashBags.common.cancel')}</button>
      </div>
    </section>
  );
}

export function CarriersTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  // A carrier login is a new account: POST /carriers needs users.create or
  // point_logins.create too.
  const canCreate = can(user, 'users.create') || can(user, 'point_logins.create');
  const qc = useQueryClient();
  const carriers = useQuery({ queryKey: cashBagKeys.carriers, queryFn: fetchCarriers });
  const [editing, setEditing] = useState<number | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: cashBagKeys.carriers }); };
  const current = carriers.data?.find(c => c.user_id === editing) ?? null;

  return (
    <div>
      <p style={{ ...styles.msg, textAlign: 'left', padding: 0, fontStyle: 'normal' }}>{t('cashBags.carriers.help')}</p>
      {carriers.isLoading && <LoadingState />}
      {carriers.isError && <p style={styles.msgError}>{t('cashBags.carriers.loadError')}</p>}
      {carriers.data && (
        <div style={{ ...styles.tableCard, overflowX: 'auto', marginTop: 12 }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('cashBags.carriers.colName')}</th>
                <th style={styles.th}>{t('cashBags.carriers.colContact')}</th>
                <th style={styles.th}>{t('cashBags.carriers.colResellers')}</th>
                <th style={styles.thNum}>{t('cashBags.carriers.colStock')}</th>
                <th style={styles.thNum}>{t('cashBags.carriers.colTransit')}</th>
                <th style={styles.th}>{t('cashBags.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {carriers.data.length === 0 && <tr><td colSpan={6} style={styles.emptyCell}>{t('cashBags.carriers.empty')}</td></tr>}
              {carriers.data.map(c => (
                <tr key={c.user_id} style={styles.tr}>
                  <td style={styles.td}>{c.name}{!c.is_active && <> · {t('cashBags.carriers.inactive')}</>}</td>
                  <td style={styles.td}>{[c.email, c.phone].filter(Boolean).join(' · ') || '—'}</td>
                  <td style={styles.td}>{c.resellers.length ? c.resellers.map(r => r.name).join(', ') : t('cashBags.carriers.noResellers')}</td>
                  <td style={styles.tdNum}>{c.with_carrier}</td>
                  <td style={styles.tdNum}>{c.in_transit}</td>
                  <td style={styles.td}>
                    <button type="button" style={styles.actionBtn} onClick={() => setEditing(c.user_id)} aria-label={t('cashBags.carriers.assignFor', { name: c.name })}>
                      {t('cashBags.carriers.assign')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {current && <AssignResellers key={current.user_id} carrier={current} onSaved={refresh} onClose={() => setEditing(null)} />}
      {canCreate && <CarrierCreateForm onCreated={refresh} />}
    </div>
  );
}

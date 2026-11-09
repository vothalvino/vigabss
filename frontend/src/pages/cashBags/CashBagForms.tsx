// =============================================================================
// Cash bags (staff) — register bags and assign them to a point
// =============================================================================
// Register (POST /cash-bags, cash_bags.manage): one serial, or a range built
// as prefix + zero-padded number (at most 500 per call). Serials already
// registered are skipped and reported. New bags are in stock.
// Assign (cash_bags.manage): bags in stock go to one point (a top-level
// reseller or a collector), delivered by staff (POST /cash-bags/assign) or
// with a carrier that serves the point (POST /cash-bags/handover). They show
// on the point's page at once. The server takes all of the serials or none
// and names the ones that are not in stock.
// =============================================================================

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@/api/useMutation';
import { extractApiError } from '@/components/ClientFormModal';
import { styles } from '../crudStyles';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { ResellerListNotice, useResellerOptions } from '../resellers/resellerOptions';
import { RANGE_MAX, assignCashBags, cashBagKeys, fetchCarriers, handoverCashBags, rangeSerials, refusedSerials, registerCashBags, type RegisterResult } from './cashBagsApi';
import { mono, parseSerials } from './cashBagUi';

const card = { ...styles.tableCard, padding: '0.75rem 1rem', flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 6 } as const;
const field = { ...styles.input, width: '100%', boxSizing: 'border-box' } as const;

export function RegisterBagsForm({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'single' | 'range'>('single');
  const [serial, setSerial] = useState('');
  const [prefix, setPrefix] = useState('');
  const [from, setFrom] = useState('1');
  const [to, setTo] = useState('');
  const [pad, setPad] = useState('4');
  const [error, setError] = useState('');
  const [result, setResult] = useState<RegisterResult | null>(null);

  const fromN = Number(from);
  const toN = Number(to);
  const padN = Number(pad);
  const rangeOk = /^\d+$/.test(from) && /^\d+$/.test(to) && toN >= fromN && /^\d{1,2}$/.test(pad) && padN <= 12;
  const count = rangeOk ? toN - fromN + 1 : 0;
  const preview = rangeOk && count <= RANGE_MAX ? rangeSerials(prefix.trim(), fromN, toN, padN) : [];

  const save = useMutation({
    mutationFn: () => (mode === 'single'
      ? registerCashBags({ serial: serial.trim().toUpperCase() })
      : registerCashBags({ prefix: prefix.trim().toUpperCase(), from: fromN, to: toN, pad: padN })),
    onSuccess: (r: RegisterResult) => { setResult(r); setSerial(''); onSaved(); },
    onError: (err: unknown) => {
      // 409 BAG_SERIALS_EXIST: every serial was registered already.
      const existing = refusedSerials(err);
      setError(existing.length ? t('cashBags.register.allExist', { serials: existing.slice(0, 20).join(', ') }) : extractApiError(err, t('cashBags.register.error')));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setResult(null);
    if (mode === 'single') {
      const s = serial.trim();
      if (!s || s.length > 64) { setError(t('cashBags.register.serialInvalid')); return; }
    } else {
      if (!rangeOk || prefix.trim().length > 40) { setError(t('cashBags.register.rangeInvalid')); return; }
      if (count > RANGE_MAX) { setError(t('cashBags.register.rangeTooBig', { max: RANGE_MAX })); return; }
    }
    save.mutate();
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="cash-bags-register-title" style={card}>
      <h4 id="cash-bags-register-title" style={{ margin: 0 }}>{t('cashBags.register.title')}</h4>
      <fieldset style={{ border: 'none', margin: 0, padding: 0, display: 'flex', gap: 12 }}>
        <legend style={styles.label}>{t('cashBags.register.mode')}</legend>
        <label><input type="radio" name="cash-bags-mode" checked={mode === 'single'} onChange={() => setMode('single')} /> {t('cashBags.register.single')}</label>
        <label><input type="radio" name="cash-bags-mode" checked={mode === 'range'} onChange={() => setMode('range')} /> {t('cashBags.register.range')}</label>
      </fieldset>
      {mode === 'single' ? (
        <>
          <label style={styles.label} htmlFor="cash-bags-serial">{t('cashBags.register.serial')}</label>
          <input id="cash-bags-serial" style={field} maxLength={64} autoComplete="off" value={serial} onChange={e => setSerial(e.target.value)} />
        </>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
          <div><label style={styles.label} htmlFor="cash-bags-prefix">{t('cashBags.register.prefix')}</label>
            <input id="cash-bags-prefix" style={field} maxLength={40} autoComplete="off" value={prefix} onChange={e => setPrefix(e.target.value)} /></div>
          <div><label style={styles.label} htmlFor="cash-bags-from">{t('cashBags.register.from')}</label>
            <input id="cash-bags-from" style={field} inputMode="numeric" value={from} onChange={e => setFrom(e.target.value)} /></div>
          <div><label style={styles.label} htmlFor="cash-bags-to">{t('cashBags.register.to')}</label>
            <input id="cash-bags-to" style={field} inputMode="numeric" value={to} onChange={e => setTo(e.target.value)} /></div>
          <div><label style={styles.label} htmlFor="cash-bags-pad">{t('cashBags.register.pad')}</label>
            <input id="cash-bags-pad" style={field} inputMode="numeric" value={pad} onChange={e => setPad(e.target.value)} /></div>
        </div>
      )}
      {mode === 'range' && preview.length > 0 && (
        <p style={{ margin: 0, fontSize: '0.85rem' }}>
          {t('cashBags.register.preview', { count: preview.length })} <span style={mono}>{preview[0]}</span>
          {preview.length > 1 && <> … <span style={mono}>{preview[preview.length - 1]}</span></>}
        </p>
      )}
      {error && <p role="alert" style={styles.errorText}>{error}</p>}
      {result && (
        <p role="status" style={{ margin: 0, color: 'var(--success)' }}>
          {t('cashBags.register.done', { count: result.created.length })}
          {result.skipped.length > 0 && <> {t('cashBags.register.skipped', { count: result.skipped.length, serials: result.skipped.slice(0, 20).join(', ') })}</>}
        </p>
      )}
      <button type="submit" style={{ ...styles.btnPrimary, alignSelf: 'flex-start' }} disabled={save.isPending}>
        {save.isPending ? t('cashBags.common.saving') : t('cashBags.register.submit')}
      </button>
    </form>
  );
}

/**
 * Assign empty bags in stock to one point (a top-level reseller or a
 * collector): delivered by staff (POST /cash-bags/assign) or sent with a
 * carrier that serves the point (POST /cash-bags/handover). On the reseller
 * page the point is fixed (`pointId`); on the board it is picked first.
 */
export function AssignBagsForm({ pointId: fixedPoint, pointName: fixedName, onSaved }: {
  pointId?: number; pointName?: string; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  // Carriers need carriers.manage; without it bags can still be delivered directly.
  const canListCarriers = can(user, 'carriers.manage');
  const carriers = useQuery({ queryKey: cashBagKeys.carriers, queryFn: fetchCarriers, enabled: canListCarriers });
  const points = useResellerOptions({ enabled: fixedPoint === undefined });
  const [pointId, setPointId] = useState<number | null>(fixedPoint ?? null);
  const [mode, setMode] = useState<'direct' | 'carrier'>('direct');
  const [carrierId, setCarrierId] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const serials = parseSerials(text);
  // Bags belong to top-level points; a sub-reseller seals on its parent's.
  const pointOptions = (points.data?.rows ?? []).filter(r => r.parent_id === null);
  const pointName = fixedName ?? pointOptions.find(p => p.id === pointId)?.name ?? '';
  const serving = (carriers.data ?? []).filter(c => c.is_active && pointId !== null && c.resellers.some(r => r.id === pointId));
  const carrier = serving.find(c => c.user_id === carrierId) ?? null;

  const save = useMutation({
    mutationFn: () => (mode === 'carrier'
      ? handoverCashBags({ carrier_user_id: carrierId ?? 0, reseller_id: pointId ?? 0, serials })
      : assignCashBags({ reseller_id: pointId ?? 0, serials })),
    onSuccess: (list: string[]) => {
      setDone(mode === 'carrier'
        ? t('cashBags.assign.doneCarrier', { count: list.length, name: carrier?.name ?? '', point: pointName })
        : t('cashBags.assign.doneDirect', { count: list.length, point: pointName }));
      setText('');
      onSaved();
    },
    onError: (err: unknown) => {
      const bad = refusedSerials(err);
      setError(bad.length ? t('cashBags.assign.someFailed', { serials: bad.join(', ') }) : extractApiError(err, t('cashBags.assign.error')));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setDone('');
    if (!pointId) { setError(t('cashBags.assign.pickPoint')); return; }
    if (mode === 'carrier' && !carrier) { setError(t('cashBags.assign.pickCarrier')); return; }
    if (serials.length === 0) { setError(t('cashBags.assign.noSerials')); return; }
    if (serials.length > RANGE_MAX) { setError(t('cashBags.assign.tooMany', { max: RANGE_MAX })); return; }
    save.mutate();
  }

  const id = `cash-bags-assign-${fixedPoint ?? 'board'}`;
  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${id}-title`} style={card}>
      <h4 id={`${id}-title`} style={{ margin: 0 }}>{fixedPoint === undefined ? t('cashBags.assign.title') : t('cashBags.assign.titleFor', { point: pointName })}</h4>
      <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.82rem' }}>{t('cashBags.assign.help')}</p>
      {fixedPoint === undefined && (
        <>
          <label style={styles.label} htmlFor={`${id}-point`}>{t('cashBags.assign.point')}</label>
          <select id={`${id}-point`} style={field} value={pointId ?? ''} onChange={e => { setPointId(Number(e.target.value) || null); setCarrierId(null); }}>
            <option value="">{t('cashBags.assign.choosePoint')}</option>
            {pointOptions.map(p => (
              <option key={p.id} value={p.id}>{p.kind === 'collector' ? t('cashBags.assign.collectorOption', { name: p.name }) : p.name}</option>
            ))}
          </select>
          <ResellerListNotice list={points.data} />
        </>
      )}
      <fieldset style={{ border: 'none', padding: 0, margin: '4px 0 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <legend style={{ ...styles.label, padding: 0 }}>{t('cashBags.assign.how')}</legend>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="radio" name={`${id}-mode`} checked={mode === 'direct'} onChange={() => setMode('direct')} />
          {t('cashBags.assign.direct')}
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="radio" name={`${id}-mode`} checked={mode === 'carrier'} disabled={!canListCarriers} onChange={() => setMode('carrier')} />
          {t('cashBags.assign.withCarrier')}
        </label>
      </fieldset>
      {mode === 'carrier' && (
        <>
          <label style={styles.label} htmlFor={`${id}-carrier`}>{t('cashBags.assign.carrier')}</label>
          <select id={`${id}-carrier`} style={field} value={carrierId ?? ''} disabled={serving.length === 0} onChange={e => setCarrierId(Number(e.target.value) || null)}>
            <option value="">{t('cashBags.assign.chooseCarrier')}</option>
            {serving.map(c => <option key={c.user_id} value={c.user_id}>{c.name}</option>)}
          </select>
          {carriers.isError && <p role="alert" style={styles.errorText}>{t('cashBags.carriers.loadError')}</p>}
          <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
            {pointId !== null && carriers.data && serving.length === 0 ? t('cashBags.assign.noCarrier') : t('cashBags.assign.carrierHelp')}
          </p>
        </>
      )}
      <label style={styles.label} htmlFor={`${id}-serials`}>{t('cashBags.assign.serials')}</label>
      <textarea id={`${id}-serials`} rows={3} style={field} value={text} onChange={e => setText(e.target.value)} />
      <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{t('cashBags.assign.count', { count: serials.length })}</p>
      {error && <p role="alert" style={styles.errorText}>{error}</p>}
      {done && <p role="status" style={{ margin: 0, color: 'var(--success)' }}>{done}</p>}
      <button type="submit" style={{ ...styles.btnPrimary, alignSelf: 'flex-start' }} disabled={save.isPending}>
        {save.isPending ? t('cashBags.common.saving') : t('cashBags.assign.submit')}
      </button>
    </form>
  );
}

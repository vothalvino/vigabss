// =============================================================================
// Cash bags (staff) — register bags and hand them to a carrier
// =============================================================================
// Register (POST /cash-bags, cash_bags.manage): one serial, or a range built
// as prefix + zero-padded number (at most 500 per call). Serials already
// registered are skipped and reported. New bags are in stock.
// Hand over (POST /cash-bags/handover, cash_bags.manage): bags in stock go to
// a carrier, who drops them empty at its resellers. The server takes all of
// the serials or none and names the ones that are not in stock.
// =============================================================================

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@/api/useMutation';
import { extractApiError } from '@/components/ClientFormModal';
import { styles } from '../crudStyles';
import { RANGE_MAX, cashBagKeys, fetchCarriers, handoverCashBags, rangeSerials, refusedSerials, registerCashBags, type RegisterResult } from './cashBagsApi';
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

export function HandoverForm({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const carriers = useQuery({ queryKey: cashBagKeys.carriers, queryFn: fetchCarriers });
  const [carrierId, setCarrierId] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const serials = parseSerials(text);

  const save = useMutation({
    mutationFn: () => handoverCashBags({ carrier_user_id: carrierId ?? 0, serials }),
    onSuccess: (list: string[]) => {
      const name = carriers.data?.find(c => c.user_id === carrierId)?.name ?? '';
      setDone(t('cashBags.handover.done', { count: list.length, name }));
      setText('');
      onSaved();
    },
    onError: (err: unknown) => {
      const bad = refusedSerials(err);
      setError(bad.length ? t('cashBags.handover.someFailed', { serials: bad.join(', ') }) : extractApiError(err, t('cashBags.handover.error')));
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setDone('');
    if (!carrierId) { setError(t('cashBags.handover.pickCarrier')); return; }
    if (serials.length === 0) { setError(t('cashBags.handover.noSerials')); return; }
    if (serials.length > RANGE_MAX) { setError(t('cashBags.handover.tooMany', { max: RANGE_MAX })); return; }
    save.mutate();
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="cash-bags-handover-title" style={card}>
      <h4 id="cash-bags-handover-title" style={{ margin: 0 }}>{t('cashBags.handover.title')}</h4>
      <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.82rem' }}>{t('cashBags.handover.help')}</p>
      <label style={styles.label} htmlFor="cash-bags-handover-carrier">{t('cashBags.handover.carrier')}</label>
      <select id="cash-bags-handover-carrier" style={field} value={carrierId ?? ''} onChange={e => setCarrierId(Number(e.target.value) || null)}>
        <option value="">{t('cashBags.handover.chooseCarrier')}</option>
        {(carriers.data ?? []).filter(c => c.is_active).map(c => <option key={c.user_id} value={c.user_id}>{c.name}</option>)}
      </select>
      {carriers.isError && <p role="alert" style={styles.errorText}>{t('cashBags.carriers.loadError')}</p>}
      <label style={styles.label} htmlFor="cash-bags-handover-serials">{t('cashBags.handover.serials')}</label>
      <textarea id="cash-bags-handover-serials" rows={3} style={field} value={text} onChange={e => setText(e.target.value)} />
      <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{t('cashBags.handover.count', { count: serials.length })}</p>
      {error && <p role="alert" style={styles.errorText}>{error}</p>}
      {done && <p role="status" style={{ margin: 0, color: 'var(--success)' }}>{done}</p>}
      <button type="submit" style={{ ...styles.btnPrimary, alignSelf: 'flex-start' }} disabled={save.isPending}>
        {save.isPending ? t('cashBags.common.saving') : t('cashBags.handover.submit')}
      </button>
    </form>
  );
}

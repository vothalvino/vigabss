// Asked when someone signs out with their cashier still open: close it first,
// sign out anyway, or stay.
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  onGoToCashier: () => void;
  onSignOut: () => void;
  onCancel: () => void;
}

export function SignOutWithCashierDialog({ onGoToCashier, onSignOut, onCancel }: Props) {
  const { t } = useTranslation();
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-labelledby="signout-cashier-title">
      <div style={box}>
        <h3 id="signout-cashier-title" style={{ margin: '0 0 8px' }}>{t('cashierReminder.signOutTitle')}</h3>
        <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)' }}>{t('cashierReminder.signOutBody')}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="button" className="btn" onClick={onSignOut}>{t('cashierReminder.signOutAnyway')}</button>
          <button type="button" className="btn btn-primary" ref={first} onClick={onGoToCashier}>{t('cashierReminder.goToCashier')}</button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16,
};
const box: React.CSSProperties = {
  background: 'var(--bg-card, #fff)', color: 'var(--text-primary, #111827)', borderRadius: 10, padding: 20, maxWidth: 440, width: '100%',
  boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
};

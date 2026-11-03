// =============================================================================
// VigaBSS 5.0 — Portal Security: change the portal password (FE-26)
// =============================================================================
// PUT /portal/auth/password existed with no page calling it, so a subscriber
// could change their password only through "forgot password".
// =============================================================================

import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@/api/useMutation';
import { portalApiFetch } from '@/api/portalApiFetch';
import { portalPageStyles as styles } from './portalPageStyles';

const MIN_LENGTH = 8;

export function PortalSecurity() {
  const { t } = useTranslation();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const change = useMutation({
    mutationFn: () => portalApiFetch('/auth/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
    onSuccess: () => {
      setDone(true);
      setCurrentPassword(''); setNewPassword(''); setConfirm('');
    },
    onError: (err: Error) => setError(err.message),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null); setDone(false);
    if (newPassword.length < MIN_LENGTH) { setError(t('portalSecurity.tooShort', { min: MIN_LENGTH })); return; }
    if (newPassword !== confirm) { setError(t('portalSecurity.mismatch')); return; }
    change.mutate();
  }

  return (
    <div>
      <h1 style={styles.heading}>{t('portalSecurity.title')}</h1>
      <p style={styles.sub}>{t('portalSecurity.subtitle')}</p>
      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>{t('portalSecurity.changePassword')}</h2>
        <form onSubmit={submit} noValidate>
          <label style={styles.label} htmlFor="portal-current-password">{t('portalSecurity.current')}</label>
          <input id="portal-current-password" style={styles.input} type="password" autoComplete="current-password"
            value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required />
          <label style={styles.label} htmlFor="portal-new-password">{t('portalSecurity.new')}</label>
          <input id="portal-new-password" style={styles.input} type="password" autoComplete="new-password"
            value={newPassword} onChange={e => setNewPassword(e.target.value)} minLength={MIN_LENGTH} required
            aria-describedby="portal-new-password-hint" />
          <p id="portal-new-password-hint" style={{ ...styles.muted, marginTop: '-0.6rem', fontSize: '0.8rem' }}>
            {t('portalSecurity.hint', { min: MIN_LENGTH })}
          </p>
          <label style={styles.label} htmlFor="portal-confirm-password">{t('portalSecurity.confirm')}</label>
          <input id="portal-confirm-password" style={styles.input} type="password" autoComplete="new-password"
            value={confirm} onChange={e => setConfirm(e.target.value)} required />
          {error && <p role="alert" style={styles.error}>{error}</p>}
          {done && <p role="status" style={styles.success}>{t('portalSecurity.changed')}</p>}
          <button type="submit" style={styles.button} disabled={change.isPending || !currentPassword}>
            {change.isPending ? t('portalSecurity.saving') : t('portalSecurity.save')}
          </button>
        </form>
      </section>
    </div>
  );
}

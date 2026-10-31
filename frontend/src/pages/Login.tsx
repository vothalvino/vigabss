// =============================================================================
// VigaBSS 5.0 — Login Page
// =============================================================================

import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { BrandLockup } from '@/components/BrandLockup';

/** An SSO callback for a 2FA account lands on /login#mfa_token=… */
function readSsoChallenge(hash: string): string | null {
  if (!hash || hash.length < 2) return null;
  const token = new URLSearchParams(hash.slice(1)).get('mfa_token');
  return token && token.length > 0 ? token : null;
}

export function Login() {
  const { login, completeMfaLogin } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const from = (location.state as { from?: { pathname: string } } | null)?.from?.pathname ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Set once the password (or SSO) step has been accepted: the server returned
  // a short-lived challenge and no session exists until the code is verified.
  const [mfaToken, setMfaToken] = useState<string | null>(() => readSsoChallenge(location.hash));

  useEffect(() => {
    // Drop the challenge from the address bar/history once it is in memory.
    if (readSsoChallenge(location.hash)) {
      navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: location.state });
    }
  }, [location.hash, location.pathname, location.search, location.state, navigate]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mfaToken) {
        await completeMfaLogin(mfaToken, totpCode.trim());
        navigate(from, { replace: true });
        return;
      }
      const result = await login(email, password);
      if (result.status === 'mfa_required') {
        setMfaToken(result.mfaToken);
        setTotpCode('');
        return;
      }
      navigate(from, { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function backToPassword() {
    setMfaToken(null);
    setTotpCode('');
    setPassword('');
    setError(null);
  }

  return (
    <div style={styles.container}>
      <div style={styles.langBar}>
        <LanguageSwitcher variant="bar" />
      </div>
      <form style={styles.card} onSubmit={handleSubmit}>
        <h1 style={styles.title}><BrandLockup size="hero" showVersion /></h1>
        <p style={styles.subtitle}>{mfaToken ? t('login.totpPrompt') : t('login.subtitle')}</p>

        {(location.state as { notice?: string } | null)?.notice === 'passwordChanged' && !error && (
          <div role="status" style={{ background: '#d1fae5', color: '#065f46', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 14 }}>
            {t('login.passwordChanged')}
          </div>
        )}
        {error && <div style={styles.error} role="alert">{error}</div>}

        {mfaToken ? (
          <label style={styles.label}>
            {t('login.totpLabel')}
            <input
              type="text"
              inputMode="text"
              maxLength={10}
              value={totpCode}
              onChange={e => setTotpCode(e.target.value)}
              required
              autoFocus
              autoComplete="one-time-code"
              style={styles.input}
              placeholder={t('login.totpPlaceholder')}
            />
          </label>
        ) : (
          <>
            <label style={styles.label}>
              {t('login.emailLabel')}
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoComplete="email"
                style={styles.input}
              />
            </label>

            <label style={styles.label}>
              {t('login.passwordLabel')}
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                style={styles.input}
              />
            </label>
          </>
        )}

        <button type="submit" disabled={loading} style={styles.button}>
          {loading ? t('common.signingIn') : (mfaToken ? t('login.totpVerify') : t('common.signIn'))}
        </button>

        {mfaToken ? (
          <button type="button" onClick={backToPassword} style={styles.linkButton}>{t('login.totpBack')}</button>
        ) : (
          <Link to="/forgot-password" style={styles.link}>{t('login.forgotPasswordLink')}</Link>
        )}
      </form>
    </div>
  );
}

const styles = {
  container: {
    position: 'relative' as const,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    background: 'var(--bg-body)',
    fontFamily: 'var(--font-sans)',
  },
  langBar: {
    position: 'absolute' as const,
    top: 16,
    right: 16,
  },
  card: {
    background: 'var(--bg-card)',
    padding: '2rem',
    borderRadius: 8,
    boxShadow: '0 0 0 1px var(--border)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '1rem',
    width: '100%',
    maxWidth: 380,
  },
  title: { margin: 0, fontSize: '1.5rem', color: 'var(--accent)' },
  subtitle: { margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem' },
  error: {
    background: 'var(--danger-soft)',
    border: '1px solid var(--danger-border)',
    color: 'var(--danger)',
    padding: '0.6rem 0.8rem',
    borderRadius: 4,
    fontSize: '0.85rem',
  },
  label: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 4,
    fontSize: '0.9rem',
    color: 'var(--text-secondary)',
  },
  input: {
    padding: '0.5rem 0.75rem',
    border: '1px solid var(--input-border)',
    borderRadius: 4,
    fontSize: '1rem',
    color: 'var(--text-primary)',
    background: 'var(--input-bg)',
  },
  button: {
    padding: '0.6rem',
    background: 'var(--accent)',
    color: 'var(--accent-fg)',
    border: 'none',
    borderRadius: 4,
    fontSize: '1rem',
    cursor: 'pointer',
    marginTop: '0.5rem',
  },
  link: {
    color: 'var(--accent)',
    fontSize: '0.85rem',
    textAlign: 'center' as const,
    textDecoration: 'none',
  },
  linkButton: {
    color: 'var(--accent)',
    fontSize: '0.85rem',
    textAlign: 'center' as const,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
  },
};

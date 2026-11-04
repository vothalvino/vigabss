// =============================================================================
// VigaBSS 5.0 — 404 Not Found
// =============================================================================

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function NotFound() {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        fontFamily: 'var(--font-sans)',
        gap: 12,
        color: '#444',
      }}
    >
      <h1 style={{ fontSize: '3rem', margin: 0 }}>404</h1>
      <p style={{ margin: 0 }}>{t('ui.notFound.pageNotFound')}</p>
      <Link to="/" style={{ color: 'var(--accent)' }}>
        {t('ui.notFound.backToDashboard')}
      </Link>
    </div>
  );
}

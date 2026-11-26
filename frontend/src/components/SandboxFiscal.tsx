// =============================================================================
// Sandbox fiscal environment markers (BIL-35)
// =============================================================================
// A CFDI stamped by a sandbox PAC (or the simulator) looks like a real one.
// Only a test install (the install's live/test switch) stamps in the sandbox;
// these mark its CFDIs, and remind every billing page that nothing stamped
// there is fiscally valid.
// =============================================================================

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';

interface SandboxCandidate {
  pac_environment?: string | null;
  uuid?: string | null;
}

/** Stamped by a sandbox PAC, or by the simulator before the environment was recorded. */
export function isSandboxCfdi(doc: SandboxCandidate | null | undefined): boolean {
  return doc?.pac_environment === 'sandbox' || String(doc?.uuid ?? '').startsWith('SIMULADO-');
}

export function SandboxCfdiBadge({ doc }: { doc: SandboxCandidate | null | undefined }) {
  const { t } = useTranslation();
  if (!isSandboxCfdi(doc)) return null;
  return (
    <span
      title={t('sandboxFiscal.badgeTitle')}
      style={{
        marginLeft: 6, padding: '1px 6px', borderRadius: 4, fontSize: '0.7rem', fontWeight: 700,
        background: 'var(--warning-soft)', color: 'var(--warning)', border: '1px solid #f59e0b', whiteSpace: 'nowrap',
      }}
    >
      {t('sandboxFiscal.badge')}
    </span>
  );
}

/** Persistent reminder on billing and CFDI pages of a test install: its CFDIs are not fiscally valid. */
export function SandboxEnvironmentBanner() {
  const { user } = useAuth();
  const { t } = useTranslation();
  if (user?.install_mode !== 'test' || !can(user, 'cfdi_documents.view')) return null;
  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12,
        padding: '10px 16px', border: '1px solid #f59e0b', borderRadius: 6, background: 'var(--warning-soft)', color: 'var(--warning)',
      }}
    >
      <span aria-hidden="true">⚠️</span>
      <strong>{t('sandboxFiscal.bannerTitle')}</strong>
      <span>{t('sandboxFiscal.bannerDetail')}</span>
      <Link to="/pac-providers" style={{ color: 'var(--warning)', fontWeight: 700 }}>{t('sandboxFiscal.bannerAction')}</Link>
    </div>
  );
}

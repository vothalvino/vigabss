// =============================================================================
// Sandbox fiscal environment markers (BIL-35)
// =============================================================================
// A CFDI stamped by a sandbox PAC (or the simulator) looks like a real one,
// and a production install whose organization still points at the sandbox
// PAC issues CFDIs that are not fiscally valid. These mark both.
// =============================================================================

import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { api } from '@/api/client';

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
        background: '#fef3c7', color: '#92400e', border: '1px solid #f59e0b', whiteSpace: 'nowrap',
      }}
    >
      {t('sandboxFiscal.badge')}
    </span>
  );
}

interface FiscalEnvironment {
  pac_environment: 'sandbox' | 'production';
  production_install: boolean;
}

async function fetchEnvironment(): Promise<FiscalEnvironment> {
  const get = api.GET as unknown as (path: string) => Promise<{ data?: unknown; error?: unknown }>;
  const response = await get('/cfdi-documents/environment');
  if (response.error || !response.data) throw new Error('Failed to load the fiscal environment');
  return (response.data as { data: FiscalEnvironment }).data;
}

/** Persistent warning on billing and CFDI pages of a production install still on the sandbox PAC. */
export function SandboxEnvironmentBanner() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const allowed = can(user, 'cfdi_documents.view');
  const { data } = useQuery<FiscalEnvironment>({
    queryKey: ['cfdi-environment', user?.organization_id],
    queryFn: fetchEnvironment,
    enabled: allowed,
    staleTime: 60 * 1000,
    retry: false,
  });
  if (!allowed || !data || !data.production_install || data.pac_environment !== 'sandbox') return null;
  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12,
        padding: '10px 16px', border: '1px solid #f59e0b', borderRadius: 6, background: '#fffbeb', color: '#78350f',
      }}
    >
      <span aria-hidden="true">⚠️</span>
      <strong>{t('sandboxFiscal.bannerTitle')}</strong>
      <span>{t('sandboxFiscal.bannerDetail')}</span>
      <Link to="/pac-providers" style={{ color: '#92400e', fontWeight: 700 }}>{t('sandboxFiscal.bannerAction')}</Link>
    </div>
  );
}

// =============================================================================
// VigaBSS 5.0 — Security & Access Control Page (Section 17)
// =============================================================================
// Multi-tab page covering the security settings VigaBSS applies:
//   1. User Security — password policy, admin IP allowlist, IPs blocked at
//                      sign-in (install operator)
//   2. API Security  — API token rate limits
// Sections for data nothing applied (firewall, DDoS, blackhole routes, DNS
// blocklists, CPE scans, encryption key metadata, data masking, WebAuthn,
// fixed TLS text, and the secure deletion log, which the scheduled retention
// purge never writes) were removed from the page in 2026-11; their tables and
// API routes remain and can return when the feature is really built.
// =============================================================================

import { useState, useEffect, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/api/apiFetch';
import { LoginIpBlocksSection } from './security/LoginIpBlocksSection';
import { PasswordPolicySection } from './security/PasswordPolicySection';
import { ApiRateLimitsSection } from './security/ApiRateLimitsSection';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tab = 'userSecurity' | 'apiSecurity';

interface AdminIpEntry {
  id: number;
  cidr: string;
  description: string | null;
  is_active: number;
}

interface AdminIpStatus {
  enabled: boolean;
  source: 'environment' | 'database' | 'none';
  configurationValid: boolean;
  activeEntries: number;
  invalidEntries: number;
  currentIp: string | null;
  currentIpAllowed: boolean;
}

// ---------------------------------------------------------------------------
// Simple fetch helper
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

const TABS: Tab[] = ['userSecurity', 'apiSecurity'];

export function SecurityAccessControlPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>('userSecurity');

  return (
    <div style={{ padding: '20px' }}>
      <h1 style={{ marginBottom: 16 }}>{t('securityAccessControl.title')}</h1>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              fontWeight: activeTab === tab ? 'bold' : 'normal',
              padding: '6px 12px',
              border: activeTab === tab ? '2px solid #4a90e2' : '1px solid #ccc',
              borderRadius: 4,
              background: activeTab === tab ? '#eaf3ff' : '#fff',
              cursor: 'pointer',
            }}
          >
            {t(`securityAccessControl.tabs.${tab}`)}
          </button>
        ))}
      </div>
      {activeTab === 'userSecurity' && <UserSecurityTab />}
      {activeTab === 'apiSecurity' && <ApiSecurityTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: User Security
// ---------------------------------------------------------------------------

function UserSecurityTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [ipList, setIpList] = useState<AdminIpEntry[]>([]);
  const [ipStatus, setIpStatus] = useState<AdminIpStatus | null>(null);
  const [cidr, setCidr] = useState('');
  const [description, setDescription] = useState('');
  const [activateNow, setActivateNow] = useState(false);
  const [ipSaving, setIpSaving] = useState(false);
  const [ipError, setIpError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ data: AdminIpEntry[] }>('/security-admin/admin-ip-allowlist'),
      apiFetch<{ data: AdminIpStatus }>('/security-admin/admin-ip-allowlist/status'),
    ])
      .then(([ipRes, ipStatusRes]) => {
        setIpList(ipRes.data);
        setIpStatus(ipStatusRes.data);
        setLoading(false);
      })
      .catch(err => { setError(err.message); setLoading(false); });
  }, []);

  if (loading) return <p>{t('common.loading')}</p>;
  if (error) return <p style={{ color: 'red' }}>{t('common.error')}: {error}</p>;

  const environmentManaged = ipStatus?.source === 'environment';

  async function reloadIpAllowlist() {
    const [listResponse, statusResponse] = await Promise.all([
      apiFetch<{ data: AdminIpEntry[] }>('/security-admin/admin-ip-allowlist'),
      apiFetch<{ data: AdminIpStatus }>('/security-admin/admin-ip-allowlist/status'),
    ]);
    setIpList(listResponse.data);
    setIpStatus(statusResponse.data);
    await queryClient.invalidateQueries({ queryKey: ['admin-ip-allowlist-status'] });
  }

  async function addIpEntry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIpSaving(true);
    setIpError(null);
    try {
      await apiFetch('/security-admin/admin-ip-allowlist', {
        method: 'POST',
        body: JSON.stringify({ cidr, description: description || null, is_active: activateNow }),
      });
      setCidr('');
      setDescription('');
      setActivateNow(false);
      await reloadIpAllowlist();
    } catch (err) {
      setIpError(err instanceof Error ? err.message : String(err));
    } finally {
      setIpSaving(false);
    }
  }

  async function toggleIpEntry(entry: AdminIpEntry) {
    setIpSaving(true);
    setIpError(null);
    try {
      await apiFetch(`/security-admin/admin-ip-allowlist/${entry.id}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: !entry.is_active }),
      });
      await reloadIpAllowlist();
    } catch (err) {
      setIpError(err instanceof Error ? err.message : String(err));
    } finally {
      setIpSaving(false);
    }
  }

  async function deleteIpEntry(entry: AdminIpEntry) {
    if (!window.confirm(t('securityAccessControl.userSecurity.deleteConfirm', { cidr: entry.cidr }))) return;
    setIpSaving(true);
    setIpError(null);
    try {
      await apiFetch(`/security-admin/admin-ip-allowlist/${entry.id}`, { method: 'DELETE' });
      await reloadIpAllowlist();
    } catch (err) {
      setIpError(err instanceof Error ? err.message : String(err));
    } finally {
      setIpSaving(false);
    }
  }

  return (
    <div>
      <PasswordPolicySection />

      <h2 id="admin-ip-allowlist">{t('securityAccessControl.userSecurity.adminIpAllowlist')}</h2>
      <div
        role="status"
        style={{
          border: `1px solid ${ipStatus?.enabled ? '#15803d' : '#d97706'}`,
          borderLeftWidth: 4,
          borderRadius: 6,
          padding: '12px 14px',
          marginBottom: 16,
          background: ipStatus?.enabled ? '#f0fdf4' : '#fffbeb',
          color: '#1f2937',
        }}
      >
        <strong>
          {ipStatus?.enabled
            ? t('securityAccessControl.userSecurity.allowlistActive')
            : t('securityAccessControl.userSecurity.allowlistWarningTitle')}
        </strong>
        <div style={{ marginTop: 4 }}>
          {environmentManaged
            ? t('securityAccessControl.userSecurity.environmentManaged')
            : ipStatus?.enabled
              ? t('securityAccessControl.userSecurity.allowlistActiveDetail', { count: ipStatus.activeEntries })
              : t('securityAccessControl.userSecurity.allowlistWarningDetail')}
        </div>
        {ipStatus?.currentIp && (
          <div style={{ marginTop: 6 }}>
            {t('securityAccessControl.userSecurity.currentIp')}: <code>{ipStatus.currentIp}</code>
          </div>
        )}
        {ipStatus && !ipStatus.configurationValid && (
          <div style={{ marginTop: 6, color: '#b91c1c' }}>
            {t('securityAccessControl.userSecurity.invalidActiveEntries', { count: ipStatus.invalidEntries })}
          </div>
        )}
      </div>

      {!environmentManaged && (
        <form onSubmit={addIpEntry} style={{ display: 'grid', gap: 10, maxWidth: 620, marginBottom: 18 }}>
          <label>
            <span style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>{t('securityAccessControl.userSecurity.ipAddress')}</span>
            <input
              required
              value={cidr}
              onChange={event => setCidr(event.target.value)}
              placeholder={ipStatus?.currentIp || '203.0.113.5/32'}
              style={{ width: '100%', padding: '8px 10px' }}
            />
          </label>
          <label>
            <span style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>{t('common.description')}</span>
            <input
              value={description}
              onChange={event => setDescription(event.target.value)}
              placeholder={t('securityAccessControl.userSecurity.descriptionPlaceholder')}
              style={{ width: '100%', padding: '8px 10px' }}
            />
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input
              type="checkbox"
              checked={activateNow}
              onChange={event => setActivateNow(event.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>
              <strong>{t('securityAccessControl.userSecurity.activateNow')}</strong><br />
              <small>{t('securityAccessControl.userSecurity.activateSafety')}</small>
            </span>
          </label>
          <div>
            <button type="submit" disabled={ipSaving} style={{ padding: '8px 14px' }}>
              {ipSaving ? t('common.loading') : t('securityAccessControl.userSecurity.addEntry')}
            </button>
          </div>
        </form>
      )}

      {ipError && <p role="alert" style={{ color: '#b91c1c' }}>{ipError}</p>}
      {ipList.length === 0
        ? <p>{t('securityAccessControl.userSecurity.noIpEntries')}</p>
        : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ccc' }}>{t('securityAccessControl.userSecurity.ipAddress')}</th>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ccc' }}>{t('common.description')}</th>
                <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ccc' }}>{t('common.status')}</th>
                {!environmentManaged && <th style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ccc' }}>{t('common.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {ipList.map(e => (
                <tr key={e.id}>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #eee', fontFamily: 'monospace' }}>{e.cidr}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #eee' }}>{e.description ?? '—'}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid #eee' }}>{e.is_active ? t('common.active') : t('common.inactive')}</td>
                  {!environmentManaged && (
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid #eee', display: 'flex', gap: 6 }}>
                      <button type="button" disabled={ipSaving} onClick={() => toggleIpEntry(e)}>
                        {e.is_active
                          ? t('securityAccessControl.userSecurity.deactivate')
                          : t('securityAccessControl.userSecurity.activate')}
                      </button>
                      <button type="button" disabled={ipSaving} onClick={() => deleteIpEntry(e)}>
                        {t('common.delete')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )
      }

      <LoginIpBlocksSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: API Security
// ---------------------------------------------------------------------------

function ApiSecurityTab() {
  return <ApiRateLimitsSection />;
}

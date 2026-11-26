// The company's logo: what its customers see as the browser tab icon and at
// the top of the client portal and of the contract signing page.
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { authedFetch } from '@/api/client';
import { blobToDataUrl } from '@/utils/blobToDataUrl';

const MAX_BYTES = 512 * 1024;
const ACCEPT = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';

async function loadLogo(orgId: number): Promise<string | null> {
  const res = await authedFetch(`/api/v1/organizations/${orgId}/logo/image`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('logo load failed');
  return blobToDataUrl(await res.blob());
}

export function OrganizationLogoCard({ orgId, canEdit }: { orgId: number; canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const logo = useQuery({ queryKey: ['organization-logo', orgId], queryFn: () => loadLogo(orgId), retry: false });

  async function upload(file: File) {
    setMsg(null);
    if (file.size > MAX_BYTES) { setMsg({ ok: false, text: t('orgLogo.tooLarge') }); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await authedFetch(`/api/v1/organizations/${orgId}/logo`, { method: 'POST', body: fd });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message || t('orgLogo.uploadError'));
      }
      setMsg({ ok: true, text: t('orgLogo.saved') });
      await qc.invalidateQueries({ queryKey: ['organization-logo', orgId] });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : t('orgLogo.uploadError') });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  async function remove() {
    setMsg(null);
    setBusy(true);
    try {
      const res = await authedFetch(`/api/v1/organizations/${orgId}/logo`, { method: 'DELETE' });
      if (!res.ok) throw new Error('remove failed');
      setMsg({ ok: true, text: t('orgLogo.removed') });
      await qc.invalidateQueries({ queryKey: ['organization-logo', orgId] });
    } catch {
      setMsg({ ok: false, text: t('orgLogo.removeError') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={box} aria-labelledby="org-logo-title">
      <h3 id="org-logo-title" style={{ margin: '0 0 4px', fontSize: '1rem' }}>{t('orgLogo.title')}</h3>
      <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('orgLogo.hint')}</p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={preview}>
          {logo.data
            ? <img src={logo.data} alt={t('orgLogo.currentAlt')} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            : <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', textAlign: 'center' }}>{logo.isLoading ? '…' : t('orgLogo.none')}</span>}
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              aria-label={t('orgLogo.choose')}
              style={{ display: 'none' }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
            />
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => input.current?.click()}>
              {logo.data ? t('orgLogo.replace') : t('orgLogo.upload')}
            </button>
            {logo.data && (
              <button type="button" className="btn" disabled={busy} onClick={() => void remove()}>{t('orgLogo.remove')}</button>
            )}
          </div>
        )}
      </div>
      {msg && <p role={msg.ok ? 'status' : 'alert'} style={{ margin: '10px 0 0', fontSize: '0.85rem', color: msg.ok ? 'var(--success, #15803d)' : 'var(--danger, #b91c1c)' }}>{msg.text}</p>}
    </section>
  );
}

const box: React.CSSProperties = {
  border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginBottom: 20, background: 'var(--bg-card)',
};
const preview: React.CSSProperties = {
  width: 96, height: 96, borderRadius: 8, border: '1px dashed var(--border)', display: 'flex',
  alignItems: 'center', justifyContent: 'center', padding: 6, background: 'var(--bg-body)',
};

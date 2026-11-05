// =============================================================================
// Client detail: add-contact and portal-password modals
// =============================================================================
// Moved out of ClientDetail.tsx, past the 1,500-line page limit (src/test/pageSize.test.ts),
// when its UI text moved into the locale files (FE-07).
// =============================================================================

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { extractApiError, overlay, modalBox, errorBox, labelStyle, inputStyle, twoCol, submitBtn, cancelBtn } from '@/components/ClientFormModal';

// ---------------------------------------------------------------------------
// Add Contact modal
// ---------------------------------------------------------------------------

export function AddContactModal({
  clientId,
  onClose,
  onSaved,
}: {
  clientId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', role: '', email: '', phone: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    setError(null);
    const body: Record<string, string> = { name: form.name.trim() };
    if (form.role.trim()) body.role = form.role.trim();
    if (form.email.trim()) body.email = form.email.trim();
    if (form.phone.trim()) body.phone = form.phone.trim();
    const { error: apiError } = await api.POST('/clients/{id}/contacts', {
      params: { path: { id: Number(clientId) } },
      body: body,
    });
    setSaving(false);
    if (apiError) { setError(extractApiError(apiError, 'Failed to add contact.')); return; }
    onSaved();
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={t('ui.clientDetail.addContact2')}>
      <form style={modalBox} onSubmit={handleSubmit}>
        <h2 style={modalTitle}>{t('ui.clientDetail.addContact3')}</h2>
        {error && <div style={errorBox}>{error}</div>}
        <label style={labelStyle}>{t('ui.clientDetail.name')}</label>
        <input style={inputStyle} value={form.name} onChange={set('name')} autoFocus />
        <label style={labelStyle}>{t('ui.clientDetail.role')}</label>
        <input style={inputStyle} value={form.role} onChange={set('role')} />
        <div style={twoCol}>
          <div>
            <label style={labelStyle}>{t('ui.clientDetail.email')}</label>
            <input style={inputStyle} type="email" value={form.email} onChange={set('email')} />
          </div>
          <div>
            <label style={labelStyle}>{t('ui.clientDetail.phone')}</label>
            <input style={inputStyle} value={form.phone} onChange={set('phone')} />
          </div>
        </div>
        <div style={modalActions}>
          <button type="button" style={cancelBtn} onClick={onClose} disabled={saving}>{t('ui.clientDetail.cancel')}</button>
          <button type="submit" style={submitBtn} disabled={saving}>{saving ? 'Saving…' : 'Add Contact'}</button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Portal password modal
// ---------------------------------------------------------------------------

export function PortalPasswordModal({
  clientId,
  username,
  onClose,
  onSaved,
}: {
  clientId: string;
  username: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Set when the email is shared with other portal accounts (WHK-10).
  const [sharedWarning, setSharedWarning] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (sharedWarning) { onSaved(); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setSaving(true);
    setError(null);
    const { data, error: apiError } = await api.PUT('/clients/{id}/portal-password', {
      params: { path: { id: Number(clientId) } },
      body: { password },
    });
    setSaving(false);
    if (apiError) { setError(extractApiError(apiError, 'Failed to set portal password.')); return; }
    const warning = (data as { warning?: string } | undefined)?.warning;
    if (warning) { setSharedWarning(warning); return; }
    onSaved();
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={t('ui.clientDetail.setPortalPassword')}>
      <form style={modalBox} onSubmit={handleSubmit}>
        <h2 style={modalTitle}>{t('ui.clientDetail.setPortalPassword2')}</h2>
        {error && <div style={errorBox}>{error}</div>}
        {sharedWarning && (
          <div role="status" style={{ ...errorBox, background: '#fef3c7', color: '#92400e' }}>
            {t('ui.clientDetail.passwordSet')}{sharedWarning}
          </div>
        )}
        <label style={labelStyle}>{t('ui.clientDetail.portalUsername')}</label>
        {username ? (
          <>
            <input style={{ ...inputStyle, background: 'var(--bg-subtle)' }} type="text" value={username} readOnly />
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 0.5rem' }}>
              {t('ui.clientDetail.theClientSignsInTo')}
            </p>
          </>
        ) : (
          <div style={errorBox}>
            {t('ui.clientDetail.thisClientHasNoEmail')}
          </div>
        )}
        <label style={labelStyle}>{t('ui.clientDetail.newPassword')}</label>
        <input style={inputStyle} type="password" value={password} onChange={e => setPassword(e.target.value)} autoFocus />
        <label style={labelStyle}>{t('ui.clientDetail.confirmPassword')}</label>
        <input style={inputStyle} type="password" value={confirm} onChange={e => setConfirm(e.target.value)} />
        <div style={modalActions}>
          <button type="button" style={cancelBtn} onClick={onClose} disabled={saving}>{t('ui.clientDetail.cancel')}</button>
          <button type="submit" style={submitBtn} disabled={saving}>{saving ? 'Saving…' : sharedWarning ? 'Done' : 'Set Password'}</button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

export const modalTitle: React.CSSProperties = {
  margin: '0 0 1rem', fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-primary)',
};

export const modalActions: React.CSSProperties = {
  display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: '1.25rem',
};

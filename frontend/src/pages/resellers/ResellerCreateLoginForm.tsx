// =============================================================================
// Create a reseller login (POST /resellers/:id/users)
// =============================================================================
// Creates a staff user in the reseller_admin group and binds it to the
// reseller in one step, so the new account signs in straight to the reseller
// app. The server applies the organization's password policy and refuses an
// email already in use; its message is shown as is.
// =============================================================================

import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/api/apiFetch';
import { useMutation } from '@/api/useMutation';
import { extractApiError } from '@/components/ClientFormModal';
import { styles } from '../crudStyles';

export interface CreateLoginBody { first_name: string; last_name: string; email: string; password: string }

const EMPTY: CreateLoginBody = { first_name: '', last_name: '', email: '', password: '' };

export function ResellerCreateLoginForm({ resellerId, onCreated }: { resellerId: number; onCreated: () => void }) {
  const { t } = useTranslation();
  const [form, setForm] = useState<CreateLoginBody>(EMPTY);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const create = useMutation({
    mutationFn: async (body: CreateLoginBody) =>
      (await apiFetch<{ data: { user_id: number; email: string; reseller_id: number } }>(
        `/resellers/${resellerId}/users`, { method: 'POST', body: JSON.stringify(body) },
      )).data,
    onSuccess: (data) => {
      setMsg({ ok: true, text: t('resellerLogin.created', { email: data?.email ?? form.email }) });
      setForm(EMPTY);
      onCreated();
    },
    onError: (err: unknown) => setMsg({ ok: false, text: extractApiError(err, t('resellerLogin.error')) }),
  });

  const set = (key: keyof CreateLoginBody) => (e: { target: { value: string } }) => setForm(p => ({ ...p, [key]: e.target.value }));

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const body = { first_name: form.first_name.trim(), last_name: form.last_name.trim(), email: form.email.trim(), password: form.password };
    if (!body.first_name || !body.last_name || !body.email || !body.password) {
      setMsg({ ok: false, text: t('resellerLogin.required') });
      return;
    }
    setMsg(null);
    create.mutate(body);
  }

  const field = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180, flex: '1 1 180px' } as const;
  return (
    <form onSubmit={handleSubmit} noValidate aria-labelledby="reseller-login-title" style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <h4 id="reseller-login-title" style={{ margin: '0 0 4px' }}>{t('resellerLogin.title')}</h4>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0 0 10px' }}>{t('resellerLogin.help')}</p>
      {msg && <p role={msg.ok ? 'status' : 'alert'} style={{ ...(msg.ok ? styles.msg : styles.msgError), padding: '0 0 8px', fontStyle: 'normal' }}>{msg.text}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ ...styles.filterLabel, ...field }}>
          {t('resellerLogin.firstName')}
          <input style={styles.filterSelect} autoComplete="off" value={form.first_name} onChange={set('first_name')} />
        </label>
        <label style={{ ...styles.filterLabel, ...field }}>
          {t('resellerLogin.lastName')}
          <input style={styles.filterSelect} autoComplete="off" value={form.last_name} onChange={set('last_name')} />
        </label>
        <label style={{ ...styles.filterLabel, ...field }}>
          {t('resellerLogin.email')}
          <input style={styles.filterSelect} type="email" autoComplete="off" value={form.email} onChange={set('email')} />
        </label>
        <label style={{ ...styles.filterLabel, ...field }}>
          {t('resellerLogin.password')}
          <input style={styles.filterSelect} type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
        </label>
        <button type="submit" style={styles.btnPrimary} disabled={create.isPending}>
          {create.isPending ? t('resellerLogin.creating') : t('resellerLogin.submit')}
        </button>
      </div>
    </form>
  );
}

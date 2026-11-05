// =============================================================================
// VigaBSS 5.0 — Reseller staff access (reseller user bindings, TNB-13)
// =============================================================================
// A staff user bound to a reseller sees only that reseller's subtree: its
// clients, invoices and sub-resellers. The API could bind and unbind
// (PUT/DELETE /resellers/:id/users/:userId, migration 471) but no screen did,
// so confining a reseller's staff meant calling it by hand. Binding needs
// resellers.update and users.update and an organization-level admin; the
// server refuses binding your own account.
// =============================================================================

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { useMutation } from '@/api/useMutation';
import { parseApiError } from '@/api/errors';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { formatDate } from '@/lib/dates';
import { styles } from './crudStyles';
import { LoadingState } from '@/components/FetchStates';

type ResellerOption = { id: number; name: string };
type Binding = {
  id: number;
  user_id: number;
  reseller_id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  user_status: string | null;
  created_at: string;
};
type StaffUser = { id: number; first_name: string | null; last_name: string | null; email: string };

const fullName = (u: { first_name: string | null; last_name: string | null; email: string | null }) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || '—';

export function ResellerUserBindingsTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [resellerId, setResellerId] = useState<number | null>(null);
  const [userId, setUserId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = can(user, 'resellers.update') && can(user, 'users.update');

  const resellersQ = useQuery({
    queryKey: ['resellers-options'],
    queryFn: async () => {
      const res = await api.GET('/resellers', { params: { query: { limit: 100 } } });
      if (res.error) throw new Error('load failed');
      return (res.data as { data: ResellerOption[] }).data;
    },
  });
  const bindingsQ = useQuery({
    queryKey: ['reseller-user-bindings', resellerId],
    enabled: resellerId !== null,
    queryFn: async () => {
      const res = await api.GET('/resellers/{id}/users', { params: { path: { id: resellerId as number } } });
      if (res.error) throw new Error('load failed');
      return (res.data as { data: Binding[] }).data;
    },
  });
  const usersQ = useQuery({
    queryKey: ['staff-users-options'],
    enabled: canManage,
    queryFn: async () => {
      const res = await api.GET('/users', { params: { query: { limit: 200 } } });
      if (res.error) throw new Error('load failed');
      return (res.data as { data: StaffUser[] }).data;
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['reseller-user-bindings'] });
  const onError = (e: unknown) => setError(e instanceof Error ? e.message : t('resellerAccess.actionFailed'));

  const bind = useMutation({
    mutationFn: async () => {
      const res = await api.PUT('/resellers/{id}/users/{userId}', { params: { path: { id: resellerId as number, userId: userId as number } } });
      if (res.error) throw new Error(parseApiError(res.error, t('resellerAccess.actionFailed')));
    },
    onSuccess: () => { setError(null); setUserId(null); refresh(); },
    onError,
  });
  const unbind = useMutation({
    mutationFn: async (target: number) => {
      const res = await api.DELETE('/resellers/{id}/users/{userId}', { params: { path: { id: resellerId as number, userId: target } } });
      if (res.error) throw new Error(parseApiError(res.error, t('resellerAccess.actionFailed')));
    },
    onSuccess: () => { setError(null); refresh(); },
    onError,
  });

  function onBind() {
    if (!resellerId || !userId) return;
    if (!window.confirm(t('resellerAccess.confirmBind'))) return;
    bind.mutate();
  }

  function onUnbind(target: number) {
    if (!window.confirm(t('resellerAccess.confirmUnbind'))) return;
    unbind.mutate(target);
  }

  const bindings = bindingsQ.data ?? [];
  const bound = new Set(bindings.map(b => b.user_id));
  const candidates = (usersQ.data ?? []).filter(u => !bound.has(u.id) && u.id !== user?.id);

  return (
    <div>
      <h3>{t('resellerAccess.title')}</h3>
      <p style={{ ...styles.msg, textAlign: 'left', padding: 0 }}>{t('resellerAccess.description')}</p>
      <label style={styles.filterLabel}>
        {t('resellerAccess.reseller')}
        <select
          style={styles.filterSelect}
          value={resellerId ?? ''}
          onChange={e => { setResellerId(Number(e.target.value) || null); setError(null); }}
        >
          <option value="">{t('resellerAccess.selectReseller')}</option>
          {(resellersQ.data ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>

      {error && <p role="alert" style={styles.msgError}>{error}</p>}

      {resellerId !== null && (
        <>
          {bindingsQ.isLoading ? <LoadingState /> : bindingsQ.isError ? (
            <p style={styles.msgError}>{t('resellerAccess.loadError')}</p>
          ) : bindings.length === 0 ? (
            <p style={styles.msg}>{t('resellerAccess.none')}</p>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>{t('resellerAccess.col.user')}</th>
                  <th style={styles.th}>{t('resellerAccess.col.email')}</th>
                  <th style={styles.th}>{t('resellerAccess.col.status')}</th>
                  <th style={styles.th}>{t('resellerAccess.col.since')}</th>
                  {canManage && <th style={styles.th}>{t('resellerAccess.col.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {bindings.map(b => (
                  <tr key={b.id} style={styles.tr}>
                    <td style={styles.td}>{fullName(b)}</td>
                    <td style={styles.td}>{b.email ?? '—'}</td>
                    <td style={styles.td}>{b.user_status ?? '—'}</td>
                    <td style={styles.td}>{formatDate(b.created_at)}</td>
                    {canManage && (
                      <td style={styles.td}>
                        <button type="button" style={styles.actionBtn} disabled={unbind.isPending} onClick={() => onUnbind(b.user_id)}>
                          {t('resellerAccess.unbind')}
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {canManage && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 12, flexWrap: 'wrap' }}>
              <label style={styles.filterLabel}>
                {t('resellerAccess.addUser')}
                <select style={styles.filterSelect} value={userId ?? ''} onChange={e => setUserId(Number(e.target.value) || null)}>
                  <option value="">{t('resellerAccess.selectUser')}</option>
                  {candidates.map(u => <option key={u.id} value={u.id}>{fullName(u)} · {u.email}</option>)}
                </select>
              </label>
              <button type="button" style={styles.btnPrimary} disabled={!userId || bind.isPending} onClick={onBind}>
                {t('resellerAccess.bind')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// =============================================================================
// VigaBSS 5.0 — WhatsApp numbers bound to a client (SUP-04)
// =============================================================================
// Shown on the client's Communication tab. A bound number reads the account
// through the WhatsApp bot; staff can end a binding here (audited), e.g. when
// the subscriber reports a lost, stolen or recycled number.
// =============================================================================

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { extractApiError, errorBox, cancelBtn } from '@/components/ClientFormModal';

interface WhatsappLink {
  id: number;
  phone_e164: string;
  bound_via: string;
  bound_at: string;
  last_seen_at: string | null;
}

const fmt = (v: string | null) => (v ? new Date(v).toLocaleString() : '—');

export function ClientWhatsappLinks({ clientId }: { clientId: number }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const canRevoke = can(user, 'clients.update');
  const [error, setError] = useState('');

  const linksQ = useQuery({
    queryKey: ['client-whatsapp-links', clientId],
    queryFn: async () => {
      const { data, error: e } = await api.GET('/clients/{id}/whatsapp-links', { params: { path: { id: clientId } } });
      if (e) throw new Error(extractApiError(e, t('clientWhatsapp.loadFailed')));
      return ((data as { data?: WhatsappLink[] })?.data ?? []);
    },
  });

  const revoke = useMutation({
    mutationFn: async (linkId: number) => {
      const { error: e } = await api.DELETE('/clients/{id}/whatsapp-links/{linkId}', {
        params: { path: { id: clientId, linkId } },
      });
      if (e) throw new Error(extractApiError(e, t('clientWhatsapp.revokeFailed')));
    },
    onSuccess: () => { setError(''); qc.invalidateQueries({ queryKey: ['client-whatsapp-links', clientId] }); },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : t('clientWhatsapp.revokeFailed')),
  });

  const links = linksQ.data ?? [];
  return (
    <section style={{ padding: '1rem 0.5rem' }} aria-label={t('clientWhatsapp.title')}>
      <h4 style={{ margin: '0 0 0.25rem' }}>{t('clientWhatsapp.title')}</h4>
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
        {t('clientWhatsapp.description')}
      </p>
      {error && <div style={errorBox}>{error}</div>}
      {linksQ.isLoading && <p style={{ fontSize: '0.85rem' }}>{t('common.loading')}</p>}
      {linksQ.error && <div style={errorBox}>{t('clientWhatsapp.loadFailed')}</div>}
      {!linksQ.isLoading && !linksQ.error && links.length === 0 && (
        <p style={{ fontSize: '0.85rem' }}>{t('clientWhatsapp.none')}</p>
      )}
      {links.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>{t('clientWhatsapp.number')}</th>
              <th style={{ textAlign: 'left' }}>{t('clientWhatsapp.boundVia')}</th>
              <th style={{ textAlign: 'left' }}>{t('clientWhatsapp.boundAt')}</th>
              <th style={{ textAlign: 'left' }}>{t('clientWhatsapp.lastSeen')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {links.map(link => (
              <tr key={link.id}>
                <td>{link.phone_e164}</td>
                <td>{link.bound_via}</td>
                <td>{fmt(link.bound_at)}</td>
                <td>{fmt(link.last_seen_at)}</td>
                <td>
                  {canRevoke && (
                    <button
                      type="button"
                      style={cancelBtn}
                      disabled={revoke.isPending}
                      onClick={() => { if (window.confirm(t('clientWhatsapp.confirmRevoke'))) revoke.mutate(link.id); }}
                    >
                      {t('clientWhatsapp.revoke')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

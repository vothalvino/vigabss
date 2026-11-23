// =============================================================================
// VigaBSS 5.0 — Portal autopay status with its one action
// =============================================================================
// Whether autopay is on, and the button that fits: set it up when it is off,
// turn it off when it is on. Shown on the portal home and on the Account page,
// so both read the same status (one query key) and stay in step.
// =============================================================================

import { useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@/api/useMutation';
import { portalApiFetch } from '@/api/portalApiFetch';

interface AutopayStatus {
  enabled: boolean;
  profile: { card_brand: string | null; card_last_four: string | null } | null;
}

interface Props {
  cardStyle?: CSSProperties;
  titleStyle?: CSSProperties;
}

export function PortalAutopayCard({ cardStyle, titleStyle }: Props) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [confirmingOff, setConfirmingOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = useQuery({
    queryKey: ['portal-autopay-status'],
    queryFn: () => portalApiFetch<{ data: AutopayStatus }>('/autopay/status'),
  });
  const enroll = useMutation({
    mutationFn: () => portalApiFetch<{ data: { setup_url: string } }>('/autopay/enroll', {
      method: 'POST',
      body: JSON.stringify({ return_url: window.location.href }),
    }),
    onSuccess: (res) => { window.location.href = res.data.setup_url; },
    onError: (e: Error) => setError(e.message),
  });
  const disable = useMutation({
    mutationFn: () => portalApiFetch('/autopay', { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmingOff(false);
      qc.invalidateQueries({ queryKey: ['portal-autopay-status'] });
    },
    onError: (e: Error) => { setConfirmingOff(false); setError(e.message); },
  });

  const autopay = status.data?.data;
  const card = autopay?.profile?.card_last_four
    ? `${autopay.profile.card_brand ? `${autopay.profile.card_brand} ` : ''}${autopay.profile.card_last_four}`
    : null;

  return (
    <section style={cardStyle} data-testid="portal-autopay">
      <h2 style={titleStyle}>{t('portalAccount.autopay')}</h2>
      {status.isLoading && <p style={s.text}>{t('portalCommon.loading')}</p>}
      {status.isError && <p style={s.error} role="alert">{t('portalAccount.autopayUnavailable')}</p>}
      {autopay && (
        <>
          <p style={s.statusLine}>
            <span style={{ ...s.badge, ...(autopay.enabled ? s.badgeOn : s.badgeOff) }}>
              {autopay.enabled ? t('portalAccount.autopayStatusOn') : t('portalAccount.autopayStatusOff')}
            </span>
          </p>
          <p style={s.text}>
            {autopay.enabled
              ? (card ? t('portalAccount.autopayOnCard', { card }) : t('portalAccount.autopayOn'))
              : t('portalAccount.autopayPitch')}
          </p>
          {error && <p style={s.error} role="alert">{error}</p>}
          {!autopay.enabled && (
            <button style={s.primary} onClick={() => { setError(null); enroll.mutate(); }} disabled={enroll.isPending}>
              {enroll.isPending ? t('portalAccount.redirecting') : t('portalAccount.autopayEnable')}
            </button>
          )}
          {autopay.enabled && !confirmingOff && (
            <button style={s.secondary} onClick={() => { setError(null); setConfirmingOff(true); }}>
              {t('portalAccount.autopayOff')}
            </button>
          )}
          {autopay.enabled && confirmingOff && (
            <div>
              <p style={s.text}>{t('portalAccount.autopayOffConfirm')}</p>
              <div style={s.row}>
                <button style={s.danger} onClick={() => disable.mutate()} disabled={disable.isPending}>
                  {t('portalAccount.autopayOffYes')}
                </button>
                <button style={s.secondary} onClick={() => setConfirmingOff(false)} disabled={disable.isPending}>
                  {t('portalAccount.autopayOffNo')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const button: CSSProperties = {
  padding: '0.5rem 1rem', borderRadius: '6px', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer',
};
const s: Record<string, CSSProperties> = {
  text: { color: 'var(--text-secondary)', fontSize: '0.875rem', margin: '0 0 0.75rem' },
  statusLine: { margin: '0 0 0.5rem' },
  badge: { display: 'inline-block', padding: '0.15rem 0.6rem', borderRadius: '999px', fontSize: '0.75rem', fontWeight: 700 },
  badgeOn: { background: 'var(--success-soft)', color: 'var(--success)' },
  badgeOff: { background: 'var(--bg-secondary)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' },
  error: { color: 'var(--danger)', fontSize: '0.875rem', margin: '0 0 0.75rem' },
  row: { display: 'flex', gap: '0.5rem', flexWrap: 'wrap' },
  primary: { ...button, background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none' },
  secondary: { ...button, background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)' },
  danger: { ...button, background: 'var(--danger)', color: '#fff', border: 'none' },
};

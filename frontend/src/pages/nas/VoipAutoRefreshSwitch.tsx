// =============================================================================
// VigaBSS 5.0 — weekly VoIP range refresh: the install-wide switch
// =============================================================================
// Routers with real-time (VoIP) priority recognise calling apps by address.
// Providers change those addresses, so VigaBSS can refresh each router's list
// every week. This is the switch for that. It used to be an environment
// variable on the server; nothing is configured outside the app now.
//
// It runs for every organization on the install, so only the install operator
// can change it. Everyone else who can see NAS devices sees its state.
// =============================================================================

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@/api/useMutation';
import { apiFetch } from '@/api/apiFetch';

interface AutoRefresh {
  available: boolean;
  enabled: boolean;
  last_run_at: string | null;
  last_status: string | null;
  can_change: boolean;
}

export function VoipAutoRefreshSwitch() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['nas-voip-auto-refresh'],
    queryFn: () => apiFetch<{ data: AutoRefresh }>('/nas/voip/auto-refresh'),
  });
  const change = useMutation({
    mutationFn: (enabled: boolean) => apiFetch<{ data: AutoRefresh }>('/nas/voip/auto-refresh', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    }),
    onSuccess: (res) => qc.setQueryData(['nas-voip-auto-refresh'], res),
  });

  const data = status.data?.data;
  if (!data || !data.available) return null;

  return (
    <div style={s.box}>
      <label style={s.label}>
        <input
          type="checkbox"
          checked={data.enabled}
          disabled={!data.can_change || change.isPending}
          onChange={(e) => change.mutate(e.target.checked)}
        />
        <span>{t('nasVoip.autoRefresh')}</span>
      </label>
      <p style={s.hint}>
        {t('nasVoip.autoRefreshHint')}
        {!data.can_change && ` ${t('nasVoip.operatorOnly')}`}
        {data.last_run_at && ` ${t('nasVoip.lastRun', { when: new Date(data.last_run_at).toLocaleString() })}`}
      </p>
      {change.isError && <p style={s.error} role="alert">{(change.error as Error).message}</p>}
    </div>
  );
}

const s = {
  box: { border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.6rem 0.9rem', margin: '0 0 1rem', background: 'var(--bg-secondary)' },
  label: { display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem', fontWeight: 600, color: 'var(--text-primary)' },
  hint: { margin: '0.3rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' },
  error: { margin: '0.3rem 0 0', fontSize: '0.8rem', color: 'var(--danger)' },
} as const;

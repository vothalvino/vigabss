// =============================================================================
// VigaBSS 5.0 — API token rate limits (Security & Access Control → API)
// =============================================================================
// A limit row for an API token (api_key_rate_limits) is enforced on every
// request made with that token (middleware/rateLimit.apiTokenConfiguredLimiter):
// a burst per second and ceilings per minute, hour and day. An empty field
// takes the default (20 / 60 / 1000 / 10000). An inactive row leaves only the
// install's general limits. PUT /security-admin/api-key-rate-limits/:tokenId
// creates or replaces the row; there is no delete, a row is turned off instead.
// =============================================================================

import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { apiFetch } from '@/api/apiFetch';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';

interface RateLimitRow {
  id: number;
  api_token_id: number;
  requests_per_minute: number | null;
  requests_per_hour: number | null;
  requests_per_day: number | null;
  burst_size: number | null;
  is_active: number | boolean;
}

interface ApiToken {
  id: number;
  name: string | null;
  revoked_at?: string | null;
}

type Field = 'burst_size' | 'requests_per_minute' | 'requests_per_hour' | 'requests_per_day';
const FIELDS: { key: Field; fallback: number; max: number }[] = [
  { key: 'burst_size', fallback: 20, max: 65535 },
  { key: 'requests_per_minute', fallback: 60, max: 4294967295 },
  { key: 'requests_per_hour', fallback: 1000, max: 4294967295 },
  { key: 'requests_per_day', fallback: 10000, max: 4294967295 },
];

interface Draft {
  tokenId: string;
  values: Record<Field, string>;
  active: boolean;
}

const EMPTY: Draft = { tokenId: '', values: { burst_size: '', requests_per_minute: '', requests_per_hour: '', requests_per_day: '' }, active: true };

const cell = { padding: '6px 8px', borderBottom: '1px solid #eee' } as const;
const head = { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #ccc' } as const;

export function ApiRateLimitsSection() {
  const { t } = useTranslation();
  const k = (key: string, opts?: Record<string, unknown>) => t(`securityAccessControl.apiRateLimits.${key}`, opts);
  const { user } = useAuth();
  const canEdit = can(user, 'api_key_rate_limits.update');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const limitsQ = useQuery({
    queryKey: ['api-key-rate-limits'],
    queryFn: () => apiFetch<{ data: RateLimitRow[] }>('/security-admin/api-key-rate-limits').then(r => r.data),
  });
  // Token names for the picker and the table; without api_tokens.view the
  // table falls back to the token number.
  const tokensQ = useQuery({
    queryKey: ['api-tokens', 'for-rate-limits'],
    queryFn: () => apiFetch<{ data: ApiToken[] }>('/api-tokens?limit=200').then(r => r.data),
    retry: false,
  });

  const save = useMutation({
    mutationFn: (d: Draft) => {
      const body: Record<string, number | boolean | null> = { is_active: d.active };
      for (const f of FIELDS) {
        const raw = d.values[f.key].trim();
        body[f.key] = raw === '' ? null : Number(raw);
      }
      return apiFetch(`/security-admin/api-key-rate-limits/${d.tokenId}`, { method: 'PUT', body: JSON.stringify(body) });
    },
    onSuccess: async () => {
      setDraft(null);
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['api-key-rate-limits'] });
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  });

  const tokens = (tokensQ.data ?? []).filter(tok => !tok.revoked_at);
  const tokenName = (id: number) => {
    const tok = (tokensQ.data ?? []).find(x => Number(x.id) === Number(id));
    return tok?.name ? `${tok.name} (#${id})` : `#${id}`;
  };
  const rows = limitsQ.data ?? [];

  function edit(row: RateLimitRow) {
    setError(null);
    setDraft({
      tokenId: String(row.api_token_id),
      values: {
        burst_size: row.burst_size == null ? '' : String(row.burst_size),
        requests_per_minute: row.requests_per_minute == null ? '' : String(row.requests_per_minute),
        requests_per_hour: row.requests_per_hour == null ? '' : String(row.requests_per_hour),
        requests_per_day: row.requests_per_day == null ? '' : String(row.requests_per_day),
      },
      active: Boolean(Number(row.is_active)),
    });
  }

  const invalidFields = draft
    ? FIELDS.filter(f => {
      const raw = draft.values[f.key].trim();
      if (raw === '') return false;
      if (!/^\d+$/.test(raw)) return true;
      const n = Number(raw);
      return n < 1 || n > f.max;
    }).map(f => f.key)
    : [];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !draft.tokenId || invalidFields.length > 0) return;
    save.mutate(draft);
  }

  const shown = (v: number | null, fallback: number) => (v == null ? k('defaultValue', { value: fallback }) : String(v));

  return (
    <section aria-labelledby="api-rate-limits">
      <h2 id="api-rate-limits">{t('securityAccessControl.apiSecurity.rateLimits')}</h2>
      <p role="note">{k('explain')}</p>

      {limitsQ.isLoading ? <p>{t('common.loading')}</p>
        : limitsQ.error ? <p role="alert" style={{ color: '#b91c1c' }}>{t('common.error')}: {(limitsQ.error as Error).message}</p>
          : rows.length === 0 ? <p>{t('securityAccessControl.apiSecurity.noRateLimits')}</p>
            : (
              <div style={{ overflowX: 'auto', marginBottom: 16 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={head}>{k('token')}</th>
                      <th style={head}>{k('burst_size')}</th>
                      <th style={head}>{t('securityAccessControl.apiSecurity.perMinute')}</th>
                      <th style={head}>{t('securityAccessControl.apiSecurity.perHour')}</th>
                      <th style={head}>{t('securityAccessControl.apiSecurity.perDay')}</th>
                      <th style={head}>{t('common.status')}</th>
                      {canEdit && <th style={head}>{t('common.actions')}</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.id}>
                        <td style={cell}>{tokenName(r.api_token_id)}</td>
                        <td style={cell}>{shown(r.burst_size, 20)}</td>
                        <td style={cell}>{shown(r.requests_per_minute, 60)}</td>
                        <td style={cell}>{shown(r.requests_per_hour, 1000)}</td>
                        <td style={cell}>{shown(r.requests_per_day, 10000)}</td>
                        <td style={cell}>{Number(r.is_active) ? t('common.active') : t('common.inactive')}</td>
                        {canEdit && (
                          <td style={cell}><button type="button" onClick={() => edit(r)}>{t('common.edit')}</button></td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

      {canEdit && !draft && (
        <button type="button" onClick={() => { setError(null); setDraft({ ...EMPTY, values: { ...EMPTY.values } }); }} style={{ padding: '8px 14px' }}>
          {k('add')}
        </button>
      )}

      {canEdit && draft && (
        <form onSubmit={submit} style={{ display: 'grid', gap: 10, maxWidth: 620, border: '1px solid #ddd', borderRadius: 6, padding: 14 }}>
          <label>
            <span style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>{k('token')}</span>
            {tokens.length > 0 || rows.some(r => String(r.api_token_id) === draft.tokenId) ? (
              <select
                required
                value={draft.tokenId}
                onChange={e => setDraft({ ...draft, tokenId: e.target.value })}
                style={{ padding: '8px 10px', minWidth: 260 }}
              >
                <option value="">{k('pickToken')}</option>
                {tokens.map(tok => <option key={tok.id} value={String(tok.id)}>{tokenName(tok.id)}</option>)}
                {draft.tokenId && !tokens.some(tok => String(tok.id) === draft.tokenId) && (
                  <option value={draft.tokenId}>{tokenName(Number(draft.tokenId))}</option>
                )}
              </select>
            ) : (
              <span>{tokensQ.isLoading ? t('common.loading') : k('noTokens')}</span>
            )}
          </label>
          {FIELDS.map(f => {
            const bad = invalidFields.includes(f.key);
            const id = `api-rate-limit-${f.key}`;
            return (
              <div key={f.key}>
                <label htmlFor={id} style={{ display: 'block', fontWeight: 600, marginBottom: 4 }}>{k(f.key)}</label>
                <input
                  id={id}
                  aria-describedby={`${id}-help`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={f.max}
                  step={1}
                  value={draft.values[f.key]}
                  placeholder={String(f.fallback)}
                  aria-invalid={bad}
                  onChange={e => setDraft({ ...draft, values: { ...draft.values, [f.key]: e.target.value } })}
                  style={{ width: 160, padding: '6px 8px', borderColor: bad ? '#b91c1c' : undefined }}
                />
                <small id={`${id}-help`} style={{ display: 'block', color: bad ? '#b91c1c' : '#555' }}>{k('fieldHelp', { value: f.fallback })}</small>
              </div>
            );
          })}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} />
            {k('active')}
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" disabled={save.isPending || !draft.tokenId || invalidFields.length > 0} style={{ padding: '8px 14px' }}>
              {save.isPending ? t('common.loading') : k('save')}
            </button>
            <button type="button" onClick={() => setDraft(null)}>{t('common.cancel')}</button>
          </div>
          {error && <p role="alert" style={{ color: '#b91c1c' }}>{error}</p>}
        </form>
      )}
    </section>
  );
}

// =============================================================================
// VigaBSS 5.0 — Password policy (Security & Access Control → User security)
// =============================================================================
// The organization's staff password policy (passwordPolicyService, SEC-17):
// composition rules on every password set, password history, rotation, and
// the sign-in lockout. GET /security-admin/password-policy returns the policy
// in force (configured: false = the built-in defaults); PUT saves it. Until
// 2026-11 this page only displayed five of its fields.
// =============================================================================

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMutation } from '@/api/useMutation';
import { apiFetch } from '@/api/apiFetch';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';

export interface PasswordPolicy {
  min_length: number | null;
  require_uppercase: number | boolean;
  require_lowercase: number | boolean;
  require_digits: number | boolean;
  require_special_chars: number | boolean;
  max_repeated_chars: number | null;
  rotation_days: number | null;
  history_count?: number | null;
  lockout_attempts: number | null;
  lockout_duration_minutes: number | null;
  /** false: no row is stored and the built-in defaults are in force. */
  configured?: boolean;
}

interface Draft {
  min_length: string;
  require_uppercase: boolean;
  require_lowercase: boolean;
  require_digits: boolean;
  require_special_chars: boolean;
  max_repeated_chars: string;
  rotation_days: string;
  history_count: string;
  lockout_attempts: string;
  lockout_duration_minutes: string;
}

// Field limits, as the API validates them (middleware/schemas/security.js).
const NUMBERS: { key: keyof Draft; min: number; max: number; offWhenZero?: boolean }[] = [
  { key: 'min_length', min: 8, max: 128 },
  { key: 'max_repeated_chars', min: 0, max: 128, offWhenZero: true },
  { key: 'history_count', min: 0, max: 24 },
  { key: 'rotation_days', min: 0, max: 3650, offWhenZero: true },
  { key: 'lockout_attempts', min: 1, max: 100 },
  { key: 'lockout_duration_minutes', min: 1, max: 1440 },
];
const BOOLEANS: (keyof Draft)[] = ['require_uppercase', 'require_lowercase', 'require_digits', 'require_special_chars'];

const numText = (v: number | null | undefined) => (v === null || v === undefined ? '0' : String(v));

function toDraft(p: PasswordPolicy): Draft {
  return {
    min_length: numText(p.min_length ?? 8),
    require_uppercase: Boolean(Number(p.require_uppercase)),
    require_lowercase: Boolean(Number(p.require_lowercase)),
    require_digits: Boolean(Number(p.require_digits)),
    require_special_chars: Boolean(Number(p.require_special_chars)),
    max_repeated_chars: numText(p.max_repeated_chars),
    rotation_days: numText(p.rotation_days),
    history_count: numText(p.history_count),
    lockout_attempts: numText(p.lockout_attempts ?? 5),
    lockout_duration_minutes: numText(p.lockout_duration_minutes ?? 15),
  };
}

const QUERY_KEY = ['password-policy'];

export function PasswordPolicySection() {
  const { t } = useTranslation();
  const k = (key: string, opts?: Record<string, unknown>) => t(`securityAccessControl.passwordPolicyForm.${key}`, opts);
  const { user } = useAuth();
  const canEdit = can(user, 'password_policy.update');
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const policyQ = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch<{ data: PasswordPolicy }>('/security-admin/password-policy').then(r => r.data),
    retry: false,
  });

  useEffect(() => {
    if (policyQ.data) setDraft(toDraft(policyQ.data));
  }, [policyQ.data]);

  const save = useMutation({
    mutationFn: (body: Record<string, number | boolean>) => apiFetch<{ data: PasswordPolicy }>('/security-admin/password-policy', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
    onSuccess: async (res) => {
      setSaved(true);
      setError(null);
      queryClient.setQueryData(QUERY_KEY, res.data);
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (err: unknown) => { setSaved(false); setError(err instanceof Error ? err.message : String(err)); },
  });

  if (policyQ.isLoading) return <p>{t('common.loading')}</p>;
  if (policyQ.error || !draft) return <p>{t('securityAccessControl.userSecurity.noPolicyConfigured')}</p>;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft(prev => (prev ? { ...prev, [key]: value } : prev));
    setSaved(false);
  };

  // Every field must be a whole number in range before anything is sent.
  const invalid = NUMBERS.filter(({ key, min, max }) => {
    const raw = String(draft[key]).trim();
    if (!/^\d+$/.test(raw)) return true;
    const n = Number(raw);
    return n < min || n > max;
  }).map(f => f.key);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || invalid.length > 0) return;
    const body: Record<string, number | boolean> = {};
    for (const { key } of NUMBERS) body[key] = Number(String(draft[key]).trim());
    for (const key of BOOLEANS) body[key] = Boolean(draft[key]);
    save.mutate(body);
  }

  const row = { display: 'grid', gridTemplateColumns: 'minmax(180px, 280px) 1fr', gap: 12, alignItems: 'center' } as const;

  const numberField = (key: keyof Draft) => {
    const spec = NUMBERS.find(f => f.key === key)!;
    const bad = invalid.includes(key);
    const id = `password-policy-${key}`;
    return (
      <div key={key} style={row}>
        <label htmlFor={id} style={{ fontWeight: 600 }}>{t(`securityAccessControl.passwordPolicyLabels.${key}`)}</label>
        <span>
          <input
            id={id}
            aria-describedby={`${id}-help`}
            type="number"
            inputMode="numeric"
            min={spec.min}
            max={spec.max}
            step={1}
            value={String(draft[key])}
            disabled={!canEdit}
            aria-invalid={bad}
            onChange={e => set(key, e.target.value)}
            style={{ width: 110, padding: '6px 8px', borderColor: bad ? '#b91c1c' : undefined }}
          />
          <small id={`${id}-help`} style={{ display: 'block', color: bad ? '#b91c1c' : '#555' }}>
            {t(`securityAccessControl.passwordPolicyHelp.${key}`, { min: spec.min, max: spec.max })}
          </small>
        </span>
      </div>
    );
  };

  return (
    <section aria-labelledby="password-policy" style={{ marginBottom: 28 }}>
      <h2 id="password-policy">{t('securityAccessControl.userSecurity.passwordPolicy')}</h2>
      <p role="note">
        {policyQ.data?.configured === false
          ? t('securityAccessControl.userSecurity.policyDefaults')
          : t('securityAccessControl.userSecurity.policyEnforced')}
      </p>
      <form onSubmit={submit} style={{ display: 'grid', gap: 12, maxWidth: 720 }}>
        <fieldset style={{ border: '1px solid #ddd', borderRadius: 6, padding: '10px 14px', display: 'grid', gap: 10 }}>
          <legend style={{ fontWeight: 700 }}>{k('composition')}</legend>
          {numberField('min_length')}
          {BOOLEANS.map(key => (
            <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={Boolean(draft[key])} disabled={!canEdit} onChange={e => set(key, e.target.checked)} />
              {t(`securityAccessControl.passwordPolicyLabels.${key}`)}
            </label>
          ))}
          {numberField('max_repeated_chars')}
        </fieldset>
        <fieldset style={{ border: '1px solid #ddd', borderRadius: 6, padding: '10px 14px', display: 'grid', gap: 10 }}>
          <legend style={{ fontWeight: 700 }}>{k('reuse')}</legend>
          {numberField('history_count')}
          {numberField('rotation_days')}
        </fieldset>
        <fieldset style={{ border: '1px solid #ddd', borderRadius: 6, padding: '10px 14px', display: 'grid', gap: 10 }}>
          <legend style={{ fontWeight: 700 }}>{k('lockout')}</legend>
          {numberField('lockout_attempts')}
          {numberField('lockout_duration_minutes')}
        </fieldset>
        {canEdit ? (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="submit" disabled={save.isPending || invalid.length > 0} style={{ padding: '8px 14px' }}>
              {save.isPending ? t('common.loading') : k('save')}
            </button>
            {saved && <span role="status" style={{ color: '#15803d' }}>{k('saved')}</span>}
            <small style={{ color: '#555' }}>{k('appliesNext')}</small>
          </div>
        ) : (
          <p role="note">{k('readOnly')}</p>
        )}
        {error && <p role="alert" style={{ color: '#b91c1c' }}>{error}</p>}
      </form>
    </section>
  );
}

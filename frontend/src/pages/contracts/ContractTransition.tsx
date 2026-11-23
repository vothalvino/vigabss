// =============================================================================
// VigaBSS 5.0 — technology transition from the contract page
// =============================================================================
// Moving a subscriber between WISP and FTTH is done with a new contract that
// the customer signs. This shows how a contract relates to others (what it
// replaces, what is replacing it) and starts a transition: it creates the
// replacement contract, which then goes through the normal activation steps,
// signature included. The current contract keeps working until the new one
// is activated, and ends at that moment.
// =============================================================================

import { useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@/api/useMutation';
import { apiFetch } from '@/api/apiFetch';

interface Related { id: number; status: string }
interface Relations { replaces: Related | null; replaced_by: Related | null }
interface PlanOption { id: number; name: string; price: string; access_technology?: string | null; status?: string }

interface Props {
  contractId: string;
  clientId: string;
  status: string;
  technology: string | null | undefined;
  connectionType: string | null;
  canEdit: boolean;
}

const TODAY = () => new Date().toISOString().slice(0, 10);

export function ContractTransition({ contractId, clientId, status, technology, connectionType, canEdit }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [planId, setPlanId] = useState('');
  const [startDate, setStartDate] = useState(TODAY);

  const current = technology === 'ftth' ? 'ftth' : 'wisp';
  const target = current === 'ftth' ? 'wisp' : 'ftth';

  const relations = useQuery({
    queryKey: ['contract-transition', contractId],
    queryFn: () => apiFetch<{ data: Relations }>(`/contracts/${contractId}/transition`),
  });
  const plans = useQuery({
    queryKey: ['plans-for-transition', target],
    queryFn: () => apiFetch<{ data: PlanOption[] }>('/plans?limit=200&status=active'),
    enabled: open,
  });
  const offered = (plans.data?.data ?? []).filter(p => p.access_technology === target || p.access_technology === 'both');

  const start = useMutation({
    mutationFn: () => apiFetch<{ data: { id: number } }>('/contracts', {
      method: 'POST',
      body: JSON.stringify({
        client_id: Number(clientId),
        plan_id: Number(planId),
        start_date: startDate,
        connection_type: connectionType || 'pppoe',
        access_technology: target,
        replaces_contract_id: Number(contractId),
      }),
    }),
    onSuccess: (res) => navigate(`/contracts/${res.data.id}`),
  });

  const rel = relations.data?.data;
  const inService = status === 'active' || status === 'suspended';
  const pendingReplacement = rel?.replaced_by?.status === 'pending';
  const canStart = canEdit && inService && !rel?.replaced_by;

  function submit(e: FormEvent) { e.preventDefault(); if (planId && startDate) start.mutate(); }

  if (!rel?.replaces && !rel?.replaced_by && !canStart) return null;

  return (
    <div style={s.box}>
      {rel?.replaces && (
        <p style={s.line}>
          {t('contractTransition.replaces')}{' '}
          <Link to={`/contracts/${rel.replaces.id}`} style={s.link}>#{rel.replaces.id}</Link>
          {' '}({rel.replaces.status}). {status === 'pending' ? t('contractTransition.replacesPending') : ''}
        </p>
      )}
      {rel?.replaced_by && (
        <p style={s.line}>
          {pendingReplacement ? t('contractTransition.beingReplaced') : t('contractTransition.replacedBy')}{' '}
          <Link to={`/contracts/${rel.replaced_by.id}`} style={s.link}>#{rel.replaced_by.id}</Link>
          {pendingReplacement ? `. ${t('contractTransition.beingReplacedHint')}` : '.'}
        </p>
      )}
      {canStart && !open && (
        <button type="button" style={s.button} onClick={() => setOpen(true)}>
          {t('contractTransition.start', { technology: t(`accessTechnology.name.${target}`) })}
        </button>
      )}
      {canStart && open && (
        <form onSubmit={submit} style={s.form}>
          <p style={s.line}><strong>{t('contractTransition.title', { technology: t(`accessTechnology.name.${target}`) })}</strong></p>
          <p style={s.hint}>{t('contractTransition.explain')}</p>
          <label style={s.label}>{t('contractTransition.plan')}
            <select style={s.input} value={planId} onChange={e => setPlanId(e.target.value)} required aria-label={t('contractTransition.plan')}>
              <option value="">{plans.isLoading ? t('contractTransition.loadingPlans') : t('accessTechnology.choose')}</option>
              {offered.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {plans.data && offered.length === 0 && (
            <p style={s.error}>{t('contractTransition.noPlans', { technology: t(`accessTechnology.name.${target}`) })}</p>
          )}
          <label style={s.label}>{t('contractTransition.startDate')}
            <input style={s.input} type="date" value={startDate} onChange={e => setStartDate(e.target.value)} required />
          </label>
          {start.isError && <p style={s.error} role="alert">{(start.error as Error).message}</p>}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="submit" style={s.primary} disabled={!planId || start.isPending}>
              {start.isPending ? t('contractTransition.creating') : t('contractTransition.create')}
            </button>
            <button type="button" style={s.button} onClick={() => setOpen(false)} disabled={start.isPending}>{t('contractTransition.cancel')}</button>
          </div>
        </form>
      )}
    </div>
  );
}

const btn: CSSProperties = { padding: '0.45rem 0.9rem', borderRadius: 6, fontSize: '0.85rem', fontWeight: 600, cursor: 'pointer' };
const s: Record<string, CSSProperties> = {
  box: { border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.75rem 1rem', margin: '0 0 1rem', background: 'var(--bg-secondary)' },
  line: { margin: '0 0 0.5rem', fontSize: '0.88rem', color: 'var(--text-primary)' },
  hint: { margin: '0 0 0.75rem', fontSize: '0.82rem', color: 'var(--text-secondary)' },
  link: { color: 'var(--accent)', fontWeight: 600 },
  form: { display: 'flex', flexDirection: 'column', gap: '0.6rem', maxWidth: 420 },
  label: { display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.82rem', color: 'var(--text-secondary)' },
  input: { padding: '0.45rem 0.6rem', border: '1px solid var(--input-border)', borderRadius: 6, background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '0.9rem' },
  button: { ...btn, background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)' },
  primary: { ...btn, background: 'var(--accent)', color: 'var(--accent-fg)', border: 'none' },
  error: { margin: 0, fontSize: '0.85rem', color: 'var(--danger)' },
};

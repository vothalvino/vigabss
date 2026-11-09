// =============================================================================
// Reseller allowed plans (GET/PUT /resellers/:id/allowed-plans)
// =============================================================================
// The plans a top-level reseller may offer in the reseller app. Its
// sub-resellers offer the same set. With none selected the reseller app
// offers every active plan of the organization.
// =============================================================================

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiFetch } from '@/api/apiFetch';
import { useMutation } from '@/api/useMutation';
import { extractApiError } from '@/components/ClientFormModal';
import { LoadingState } from '@/components/FetchStates';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { formatMoney } from '@/lib/money';
import { styles } from '../crudStyles';
import { ResellerListNotice, resellersOnly, useResellerOptions } from './resellerOptions';

interface PlanRow { id: number; name: string; price: string | number; currency?: string | null; status?: string }
interface AllowedRow { plan_id: number; name: string; price: string | number }

// GET /plans returns at most 100 rows a page; read every page.
const PLAN_PAGE = 100;
async function fetchAllPlans(): Promise<PlanRow[]> {
  const all: PlanRow[] = [];
  for (let page = 1; ; page += 1) {
    const res = await apiFetch<{ data: PlanRow[]; meta?: { total?: number } }>(
      `/plans?page=${page}&limit=${PLAN_PAGE}&order_by=name&order=ASC`,
    );
    const rows = res.data ?? [];
    all.push(...rows);
    const total = Number(res.meta?.total);
    if (rows.length < PLAN_PAGE || (Number.isFinite(total) && all.length >= total)) return all;
  }
}

export function ResellerAllowedPlansTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const canSave = can(user, 'resellers.update');
  const [resellerId, setResellerId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const resellersQ = useResellerOptions({ topLevel: true });
  const plansQ = useQuery({
    queryKey: ['reseller-allowed-plans-catalogue'],
    queryFn: fetchAllPlans,
  });
  const allowedQ = useQuery({
    queryKey: ['reseller-allowed-plans', resellerId],
    enabled: resellerId !== null,
    queryFn: async () => (await apiFetch<{ data: AllowedRow[] }>(`/resellers/${resellerId}/allowed-plans`)).data ?? [],
  });

  // Start from the saved set whenever another reseller's set arrives.
  useEffect(() => {
    if (allowedQ.data) setSelected(new Set(allowedQ.data.map(a => a.plan_id)));
  }, [allowedQ.data]);

  const save = useMutation({
    mutationFn: async (planIds: number[]) => {
      await apiFetch(`/resellers/${resellerId}/allowed-plans`, { method: 'PUT', body: JSON.stringify({ plan_ids: planIds }) });
    },
    onSuccess: () => {
      setMsg({ ok: true, text: t('resellerPlans.saved') });
      void qc.invalidateQueries({ queryKey: ['reseller-allowed-plans'] });
    },
    onError: (err: unknown) => setMsg({ ok: false, text: extractApiError(err, t('resellerPlans.saveError')) }),
  });

  function toggle(id: number) {
    setMsg(null);
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // Active plans, plus any inactive one still in the saved set so it can be removed.
  const plans = (plansQ.data ?? []).filter(p => !p.status || p.status === 'active' || selected.has(p.id));

  return (
    <div>
      <h3>{t('resellerPlans.title')}</h3>
      <p style={{ ...styles.msg, textAlign: 'left', padding: 0 }}>{t('resellerPlans.help')}</p>
      <label style={styles.filterLabel}>
        {t('resellerPlans.reseller')}
        <select
          style={styles.filterSelect}
          value={resellerId ?? ''}
          onChange={e => { setResellerId(Number(e.target.value) || null); setMsg(null); }}
        >
          <option value="">{t('resellerPlans.selectReseller')}</option>
          {resellersOnly(resellersQ.data?.rows ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <ResellerListNotice list={resellersQ.data} />

      {msg && <p role={msg.ok ? 'status' : 'alert'} style={{ ...(msg.ok ? styles.msg : styles.msgError), padding: '0.75rem 0', fontStyle: 'normal' }}>{msg.text}</p>}

      {resellerId !== null && (
        allowedQ.isLoading || plansQ.isLoading ? <LoadingState /> : allowedQ.isError || plansQ.isError ? (
          <p style={styles.msgError}>{t('resellerPlans.loadError')}</p>
        ) : (
          <fieldset style={{ border: 'none', padding: 0, margin: '12px 0 0' }}>
            <legend style={{ fontWeight: 600, marginBottom: 8 }}>{t('resellerPlans.legend')}</legend>
            {plans.length === 0 && <p style={styles.msg}>{t('resellerPlans.noPlans')}</p>}
            {plans.map(p => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <input type="checkbox" checked={selected.has(p.id)} disabled={!canSave} onChange={() => toggle(p.id)} />
                <span>{p.name}</span>
                <span style={{ color: 'var(--text-secondary)' }}>{formatMoney(p.price, p.currency)}</span>
              </label>
            ))}
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
              {selected.size === 0 ? t('resellerPlans.noneSelected') : t('resellerPlans.countSelected', { count: selected.size })}
            </p>
            {canSave && (
              <button type="button" style={styles.btnPrimary} disabled={save.isPending} onClick={() => save.mutate([...selected].sort((a, b) => a - b))}>
                {save.isPending ? t('resellerPlans.saving') : t('resellerPlans.save')}
              </button>
            )}
          </fieldset>
        )
      )}
    </div>
  );
}

// =============================================================================
// VigaBSS 5.0 — Portal Account Settings (§11.3)
// =============================================================================
// Self-service actions: plan upgrade, Wi-Fi password, PPPoE password,
// static IP request, cancellation, visit schedule.
// =============================================================================

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { portalAuthedFetch } from '@/auth/PortalAuthContext';

const API_BASE = '/api/v1/portal';

interface ServiceRequest {
  id: number;
  request_type: string;
  status: string;
  payload: Record<string, unknown> | null;
  notes: string | null;
  proration_net: string | null;
  created_at: string;
}

interface PlanOption {
  id: number;
  name: string;
  price: string;
  currency: string;
  billing_cycle: string;
  download_speed_mbps: number;
  upload_speed_mbps: number;
}

interface WaLink {
  id: number;
  phone: string;
  boundVia: string;
  boundAt: string;
  lastSeenAt: string | null;
}

interface WaCode {
  code: string;
  deepLink: string | null;
  businessNumber: string | null;
  expiresInMinutes: number;
}

async function portalFetch<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await portalAuthedFetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(body?.error?.message || 'Request failed');
  }
  return res.json() as Promise<T>;
}

type RequestType = 'plan_upgrade' | 'wifi_password_change' | 'pppoe_password_change'
  | 'static_ip_request' | 'cancellation' | 'visit_schedule';

const REQUEST_TYPES: RequestType[] = [
  'plan_upgrade', 'wifi_password_change', 'pppoe_password_change',
  'static_ip_request', 'cancellation', 'visit_schedule',
];
const TIME_SLOTS = ['morning', 'afternoon', 'evening'];

export function PortalAccount() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<'requests' | 'new' | 'whatsapp'>('requests');
  const [reqType, setReqType] = useState<RequestType>('plan_upgrade');
  const [payload, setPayload] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [errMsg, setErrMsg] = useState('');
  const [waCode, setWaCode] = useState<WaCode | null>(null);

  const { data: reqData, isLoading } = useQuery({
    queryKey: ['portal-service-requests'],
    queryFn: () => portalFetch<{ data: ServiceRequest[] }>('/service-requests?limit=50'),
  });

  // The plans the subscriber may move to, picked from a list instead of a
  // typed plan id (BIL-23).
  const { data: planOptions } = useQuery({
    queryKey: ['portal-plan-options'],
    queryFn: () => portalFetch<{ data: PlanOption[] }>('/service-requests/plan-options'),
    enabled: reqType === 'plan_upgrade',
  });

  const createMutation = useMutation({
    mutationFn: (body: { request_type: string; payload: Record<string, unknown> }) =>
      portalFetch<{ data: ServiceRequest }>('/service-requests', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      setMsg(t('portalAccount.submitted'));
      setErrMsg('');
      setPayload({});
      setActiveTab('requests');
      qc.invalidateQueries({ queryKey: ['portal-service-requests'] });
    },
    onError: (e: Error) => { setErrMsg(e.message); setMsg(''); },
  });

  const cancelMutation = useMutation({
    mutationFn: (id: number) =>
      portalFetch(`/service-requests/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-service-requests'] }),
    onError: (e: Error) => {
      setErrMsg(e.message || t('portalAccount.cancelFailed'));
      setMsg('');
    },
  });

  const { data: waStatus } = useQuery({
    queryKey: ['portal-whatsapp-status'],
    queryFn: () => portalFetch<{ data: { linked: boolean; links: WaLink[] } }>('/whatsapp/status'),
  });

  const linkCodeMutation = useMutation({
    mutationFn: () => portalFetch<{ data: WaCode }>('/whatsapp/link-code', { method: 'POST' }),
    onSuccess: (res) => { setWaCode(res.data); setErrMsg(''); },
    onError: (e: Error) => { setErrMsg(e.message); },
  });

  const unlinkWaMutation = useMutation({
    mutationFn: (id: number) => portalFetch(`/whatsapp/link/${id}`, { method: 'DELETE' }),
    onSuccess: () => { setWaCode(null); qc.invalidateQueries({ queryKey: ['portal-whatsapp-status'] }); },
    onError: (e: Error) => { setErrMsg(e.message); },
  });

  const waLinks = waStatus?.data.links ?? [];

  const { data: autopay } = useQuery({
    queryKey: ['portal-autopay-status'],
    queryFn: () => portalFetch<{ data: { enabled: boolean; profile: { card_brand: string | null; card_last_four: string | null } | null } }>('/autopay/status'),
  });
  const autopayEnrollMutation = useMutation({
    mutationFn: () => portalFetch<{ data: { setup_url: string } }>('/autopay/enroll', {
      method: 'POST',
      body: JSON.stringify({ return_url: window.location.href }),
    }),
    onSuccess: (res) => { window.location.href = res.data.setup_url; },
    onError: (e: Error) => { setErrMsg(e.message); },
  });
  const autopayDisableMutation = useMutation({
    mutationFn: () => portalFetch('/autopay', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['portal-autopay-status'] }),
    onError: (e: Error) => { setErrMsg(e.message); },
  });

  function handleSubmit() {
    setMsg(''); setErrMsg('');

    // Client-side required-field validation per request type
    if (reqType === 'plan_upgrade' && !payload.new_plan_id?.trim()) {
      setErrMsg(t('portalAccount.errPlanId'));
      return;
    }
    if ((reqType === 'wifi_password_change' || reqType === 'pppoe_password_change') && !payload.new_password?.trim()) {
      setErrMsg(t('portalAccount.errPassword'));
      return;
    }
    if (reqType === 'cancellation' && !payload.reason?.trim()) {
      setErrMsg(t('portalAccount.errReason'));
      return;
    }
    if (reqType === 'visit_schedule') {
      if (!payload.preferred_date?.trim()) {
        setErrMsg(t('portalAccount.errDate'));
        return;
      }
      if (!payload.preferred_slot?.trim()) {
        setErrMsg(t('portalAccount.errSlot'));
        return;
      }
    }

    createMutation.mutate({ request_type: reqType, payload: { ...payload } });
  }

  const requests = reqData?.data ?? [];

  return (
    <div>
      <h1 style={styles.heading}>{t('portalAccount.title')}</h1>

      <section style={{ ...styles.card, marginBottom: '1rem' }}>
        <h2 style={styles.sectionTitle}>{t('portalAccount.autopay')}</h2>
        {autopay?.data.enabled ? (
          <div>
            <p style={styles.muted}>
              ✅ {autopay.data.profile?.card_last_four
                ? t('portalAccount.autopayOnCard', { card: `${autopay.data.profile.card_brand ? `${autopay.data.profile.card_brand} ` : ''}${autopay.data.profile.card_last_four}` })
                : t('portalAccount.autopayOn')}
            </p>
            <button style={styles.cancelBtn} onClick={() => autopayDisableMutation.mutate()}>{t('portalAccount.autopayOff')}</button>
          </div>
        ) : (
          <div>
            <p style={styles.muted}>{t('portalAccount.autopayPitch')}</p>
            <button style={styles.submitBtn} onClick={() => autopayEnrollMutation.mutate()} disabled={autopayEnrollMutation.isPending}>
              {autopayEnrollMutation.isPending ? t('portalAccount.redirecting') : t('portalAccount.autopayEnable')}
            </button>
          </div>
        )}
      </section>

      <div style={styles.tabs}>
        <button
          style={{ ...styles.tab, ...(activeTab === 'requests' ? styles.tabActive : {}) }}
          onClick={() => setActiveTab('requests')}
        >
          {t('portalAccount.tabRequests')}
        </button>
        <button
          style={{ ...styles.tab, ...(activeTab === 'new' ? styles.tabActive : {}) }}
          onClick={() => setActiveTab('new')}
        >
          {t('portalAccount.tabNew')}
        </button>
        <button
          style={{ ...styles.tab, ...(activeTab === 'whatsapp' ? styles.tabActive : {}) }}
          onClick={() => setActiveTab('whatsapp')}
        >
          WhatsApp
        </button>
      </div>

      {activeTab === 'requests' && (
        <section style={styles.card}>
          <h2 style={styles.sectionTitle}>{t('portalAccount.myRequests')}</h2>
          {isLoading && <p style={styles.muted}>{t('portalCommon.loading')}</p>}
          {!isLoading && requests.length === 0 && (
            <p style={styles.muted}>{t('portalAccount.noRequests')}</p>
          )}
          {requests.length > 0 && (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>{t('portalAccount.type')}</th>
                  <th style={styles.th}>{t('portalAccount.status')}</th>
                  <th style={styles.th}>{t('portalAccount.submittedAt')}</th>
                  <th style={styles.th}></th>
                </tr>
              </thead>
              <tbody>
                {requests.map(r => (
                  <tr key={r.id}>
                    <td style={styles.td}>{t(`portalAccount.requestTypes.${r.request_type}`, { defaultValue: r.request_type })}</td>
                    <td style={styles.td}>
                      <span style={{ ...styles.badge, ...badgeColor(r.status) }}>{t(`portalServiceRequests.status.${r.status}`, { defaultValue: r.status })}</span>
                    </td>
                    <td style={styles.td}>{r.created_at.slice(0, 10)}</td>
                    <td style={styles.td}>
                      {r.status === 'pending' && (
                        <button
                          style={styles.cancelBtn}
                          onClick={() => cancelMutation.mutate(r.id)}
                        >
                          {t('portalAccount.cancel')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {activeTab === 'new' && (
        <section style={styles.card}>
          <h2 style={styles.sectionTitle}>{t('portalAccount.submitTitle')}</h2>

          <div style={styles.formGroup}>
            <label style={styles.label}>{t('portalAccount.requestType')}</label>
            <select
              value={reqType}
              onChange={e => { setReqType(e.target.value as RequestType); setPayload({}); }}
              style={styles.select}
            >
              {REQUEST_TYPES.map(k => (
                <option key={k} value={k}>{t(`portalAccount.requestTypes.${k}`)}</option>
              ))}
            </select>
          </div>

          {/* Dynamic payload fields per request type */}
          {reqType === 'plan_upgrade' && (
            <div style={styles.formGroup}>
              <label style={styles.label} htmlFor="portal-new-plan">{t('portalAccount.newPlanId')}</label>
              <select
                id="portal-new-plan"
                value={payload.new_plan_id ?? ''}
                onChange={e => setPayload(p => ({ ...p, new_plan_id: e.target.value }))}
                style={styles.input}
              >
                <option value="">{t('portalAccount.newPlanIdPlaceholder')}</option>
                {(planOptions?.data ?? []).map(plan => (
                  <option key={plan.id} value={String(plan.id)}>
                    {`${plan.name} — ${plan.download_speed_mbps}/${plan.upload_speed_mbps} Mbps — ${plan.price} ${plan.currency}`}
                  </option>
                ))}
              </select>
            </div>
          )}

          {(reqType === 'wifi_password_change' || reqType === 'pppoe_password_change') && (
            <div style={styles.formGroup}>
              <label style={styles.label}>{t('portalAccount.newPassword')}</label>
              <input
                type="password"
                value={payload.new_password ?? ''}
                onChange={e => setPayload(p => ({ ...p, new_password: e.target.value }))}
                style={styles.input}
                placeholder={t('portalAccount.newPasswordPlaceholder')}
                minLength={8}
              />
            </div>
          )}

          {reqType === 'static_ip_request' && (
            <div style={styles.formGroup}>
              <label style={styles.label}>{t('portalAccount.notesReason')}</label>
              <textarea
                value={payload.notes ?? ''}
                onChange={e => setPayload(p => ({ ...p, notes: e.target.value }))}
                style={styles.textarea}
                placeholder={t('portalAccount.staticIpPlaceholder')}
              />
            </div>
          )}

          {reqType === 'cancellation' && (
            <div style={styles.formGroup}>
              <label style={styles.label}>{t('portalAccount.cancellationReason')}</label>
              <textarea
                value={payload.reason ?? ''}
                onChange={e => setPayload(p => ({ ...p, reason: e.target.value }))}
                style={styles.textarea}
                placeholder={t('portalAccount.cancellationPlaceholder')}
              />
            </div>
          )}

          {reqType === 'visit_schedule' && (
            <>
              <div style={styles.formGroup}>
                <label style={styles.label}>{t('portalAccount.preferredDate')}</label>
                <input
                  type="date"
                  value={payload.preferred_date ?? ''}
                  onChange={e => setPayload(p => ({ ...p, preferred_date: e.target.value }))}
                  style={styles.input}
                />
              </div>
              <div style={styles.formGroup}>
                <label style={styles.label}>{t('portalAccount.preferredSlot')}</label>
                <select
                  value={payload.preferred_slot ?? ''}
                  onChange={e => setPayload(p => ({ ...p, preferred_slot: e.target.value }))}
                  style={styles.select}
                >
                  <option value="">{t('portalAccount.selectSlot')}</option>
                  {TIME_SLOTS.map(slot => <option key={slot} value={slot}>{t(`portalAccount.slots.${slot}`)}</option>)}
                </select>
              </div>
              <div style={styles.formGroup}>
                <label style={styles.label}>{t('portalAccount.notes')}</label>
                <textarea
                  value={payload.notes ?? ''}
                  onChange={e => setPayload(p => ({ ...p, notes: e.target.value }))}
                  style={styles.textarea}
                  placeholder={t('portalAccount.visitPlaceholder')}
                />
              </div>
            </>
          )}

          {msg && <p style={styles.success}>{msg}</p>}
          {errMsg && <p style={styles.error}>{errMsg}</p>}

          <button
            style={styles.submitBtn}
            onClick={handleSubmit}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? t('portalAccount.submitting') : t('portalAccount.submit')}
          </button>
        </section>
      )}

      {activeTab === 'whatsapp' && (
        <section style={styles.card}>
          <h2 style={styles.sectionTitle}>{t('portalAccount.waTitle')}</h2>
          <p style={styles.muted}>
            {t('portalAccount.waIntro')}
          </p>

          {waLinks.length > 0 ? (
            <table style={{ ...styles.table, marginTop: '0.75rem' }}>
              <thead>
                <tr>
                  <th style={styles.th}>{t('portalAccount.waNumber')}</th>
                  <th style={styles.th}>{t('portalAccount.waConnected')}</th>
                  <th style={styles.th}></th>
                </tr>
              </thead>
              <tbody>
                {waLinks.map(l => (
                  <tr key={l.id}>
                    <td style={styles.td}>{l.phone}</td>
                    <td style={styles.td}>{l.boundAt.slice(0, 10)}</td>
                    <td style={styles.td}>
                      <button style={styles.cancelBtn} onClick={() => unlinkWaMutation.mutate(l.id)}>
                        {t('portalAccount.waUnlink')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ ...styles.muted, marginTop: '0.75rem' }}>{t('portalAccount.waNone')}</p>
          )}

          <div style={{ marginTop: '1.25rem' }}>
            <button
              style={styles.submitBtn}
              onClick={() => linkCodeMutation.mutate()}
              disabled={linkCodeMutation.isPending}
            >
              {linkCodeMutation.isPending ? t('portalAccount.waGenerating') : t('portalAccount.waGetCode')}
            </button>
          </div>

          {waCode && (
            <div style={styles.waCodeBox}>
              <p style={styles.muted}>
                {t('portalAccount.waCodeHint', { count: waCode.expiresInMinutes })}
              </p>
              <p style={styles.waCode}>{waCode.code}</p>
              {waCode.deepLink && (
                <a href={waCode.deepLink} target="_blank" rel="noopener noreferrer" style={styles.waLink}>
                  {t('portalAccount.waOpen')}
                </a>
              )}
            </div>
          )}

          {errMsg && <p style={styles.error}>{errMsg}</p>}
        </section>
      )}
    </div>
  );
}

function badgeColor(status: string): React.CSSProperties {
  switch (status) {
    case 'pending': return { background: '#fef3c7', color: '#92400e' };
    case 'approved': return { background: '#d1fae5', color: '#065f46' };
    case 'rejected': return { background: '#fee2e2', color: '#991b1b' };
    case 'completed': return { background: '#dbeafe', color: '#1e40af' };
    case 'cancelled': return { background: '#f3f4f6', color: '#6b7280' };
    default: return { background: '#f3f4f6', color: '#374151' };
  }
}

const styles: Record<string, React.CSSProperties> = {
  heading: { margin: '0 0 1rem', fontSize: '1.4rem', color: 'var(--text-primary)' },
  tabs: { display: 'flex', gap: '0.5rem', marginBottom: '1rem' },
  tab: {
    padding: '0.4rem 0.9rem',
    border: '1px solid var(--border-strong)',
    borderRadius: 4,
    background: 'var(--bg-card)',
    cursor: 'pointer',
    fontSize: '0.875rem',
    color: 'var(--text-secondary)',
  },
  tabActive: { background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)' },
  card: { background: 'var(--bg-card)', borderRadius: 8, padding: '1.25rem', boxShadow: '0 0 0 1px var(--border)' },
  sectionTitle: { margin: '0 0 1rem', fontSize: '1rem', color: 'var(--text-secondary)' },
  muted: { color: 'var(--text-muted)', fontSize: '0.9rem' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem' },
  th: { textAlign: 'left' as const, padding: '0.5rem', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '2px solid var(--border-subtle)' },
  td: { padding: '0.5rem', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' },
  badge: { display: 'inline-block', padding: '0.15rem 0.4rem', borderRadius: 10, fontSize: '0.78rem', fontWeight: 600 },
  cancelBtn: { padding: '0.2rem 0.5rem', fontSize: '0.78rem', border: '1px solid #dc2626', color: '#dc2626', borderRadius: 4, cursor: 'pointer', background: 'transparent' },
  formGroup: { marginBottom: '0.875rem' },
  label: { display: 'block', marginBottom: '0.3rem', fontSize: '0.85rem', color: 'var(--text-muted)' },
  input: { width: '100%', boxSizing: 'border-box' as const, padding: '0.45rem 0.6rem', border: '1px solid var(--input-border)', borderRadius: 4, fontSize: '0.9rem', background: 'var(--bg-input)', color: 'var(--text-primary)' },
  select: { width: '100%', boxSizing: 'border-box' as const, padding: '0.45rem 0.6rem', border: '1px solid var(--input-border)', borderRadius: 4, fontSize: '0.9rem', background: 'var(--bg-input)', color: 'var(--text-primary)' },
  textarea: { width: '100%', boxSizing: 'border-box' as const, padding: '0.45rem 0.6rem', border: '1px solid var(--input-border)', borderRadius: 4, fontSize: '0.9rem', minHeight: 80, background: 'var(--bg-input)', color: 'var(--text-primary)' },
  submitBtn: { padding: '0.5rem 1.25rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: '0.9rem', fontWeight: 600 },
  success: { color: '#16a34a', fontSize: '0.875rem', marginBottom: '0.5rem' },
  error: { color: '#dc2626', fontSize: '0.875rem', marginBottom: '0.5rem' },
  waCodeBox: { marginTop: '1rem', padding: '1rem', border: '1px dashed var(--border-strong)', borderRadius: 8, textAlign: 'center' as const },
  waCode: { fontSize: '1.8rem', fontWeight: 700, letterSpacing: 6, color: 'var(--text-primary)', margin: '0.5rem 0' },
  waLink: { display: 'inline-block', padding: '0.5rem 1.25rem', background: '#25D366', color: '#fff', borderRadius: 4, textDecoration: 'none', fontSize: '0.9rem', fontWeight: 600 },
};

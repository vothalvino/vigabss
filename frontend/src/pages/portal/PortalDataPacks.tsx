// =============================================================================
// VigaBSS 5.0 — Portal Data packs and allowance (FE-26)
// =============================================================================
// The data-pack list, purchase and my-purchases routes and the allowance
// route existed with no page calling them. A purchase issues an invoice for
// the pack, so it asks for confirmation first.
// =============================================================================

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@/api/useMutation';
import { portalApiFetch } from '@/api/portalApiFetch';
import { portalPageStyles as styles } from './portalPageStyles';

interface Allowance { base_cap_gb: number; pack_gb: number; rollover_gb: number; total_gb: number }
interface DataPack { id: number; name: string; description: string | null; data_gb: string; price: string; currency: string; validity_days: number }
interface Purchase { id: number; pack_name: string; gb_applied: string; status: string; purchased_at: string; expires_at: string | null }

const gb = (value: number | string) => `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 })} GB`;

export function PortalDataPacks() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<DataPack | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const allowance = useQuery({
    queryKey: ['portal-allowance'],
    queryFn: () => portalApiFetch<{ data: Allowance | null }>('/usage/allowance'),
  });
  const packs = useQuery({
    queryKey: ['portal-data-packs'],
    queryFn: () => portalApiFetch<{ data: DataPack[] }>('/data-packs'),
  });
  const purchases = useQuery({
    queryKey: ['portal-data-pack-purchases'],
    queryFn: () => portalApiFetch<{ data: Purchase[] }>('/data-packs/my-purchases'),
  });

  const buy = useMutation({
    mutationFn: (pack: DataPack) => portalApiFetch(`/data-packs/${pack.id}/purchase`, { method: 'POST' }),
    onSuccess: (_data, pack) => {
      setConfirming(null);
      setMessage({ ok: true, text: t('portalDataPacks.bought', { name: pack.name }) });
      qc.invalidateQueries({ queryKey: ['portal-allowance'] });
      qc.invalidateQueries({ queryKey: ['portal-data-pack-purchases'] });
      qc.invalidateQueries({ queryKey: ['portal-invoices'] });
    },
    onError: (err: Error) => { setConfirming(null); setMessage({ ok: false, text: err.message }); },
  });

  const a = allowance.data?.data;
  const packList = packs.data?.data ?? [];
  const purchaseList = purchases.data?.data ?? [];

  return (
    <div>
      <h1 style={styles.heading}>{t('portalDataPacks.title')}</h1>
      <p style={styles.sub}>{t('portalDataPacks.subtitle')}</p>

      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>{t('portalDataPacks.allowance')}</h2>
        {allowance.isLoading && <p style={styles.muted}>{t('portalCommon.loading')}</p>}
        {!allowance.isLoading && !a && <p style={styles.muted}>{t('portalDataPacks.noContract')}</p>}
        {a && (
          <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem', margin: 0 }}>
            {([['plan', a.base_cap_gb], ['packs', a.pack_gb], ['rollover', a.rollover_gb], ['total', a.total_gb]] as const).map(([key, value]) => (
              <div key={key}>
                <dt style={styles.muted}>{t(`portalDataPacks.allowanceParts.${key}`)}</dt>
                <dd style={{ margin: 0, fontWeight: key === 'total' ? 700 : 500 }}>{key === 'plan' && !value ? t('portalDataPacks.unlimited') : gb(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>{t('portalDataPacks.available')}</h2>
        {message && <p role={message.ok ? 'status' : 'alert'} style={message.ok ? styles.success : styles.error}>{message.text}</p>}
        {packs.isLoading && <p style={styles.muted}>{t('portalCommon.loading')}</p>}
        {!packs.isLoading && packList.length === 0 && <p style={styles.muted}>{t('portalDataPacks.noPacks')}</p>}
        {packList.length > 0 && (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('portalDataPacks.pack')}</th>
                <th style={styles.th}>{t('portalDataPacks.data')}</th>
                <th style={styles.th}>{t('portalDataPacks.validity')}</th>
                <th style={styles.th}>{t('portalDataPacks.price')}</th>
                <th style={styles.th} />
              </tr>
            </thead>
            <tbody>
              {packList.map(p => (
                <tr key={p.id}>
                  <td style={styles.td}>
                    <div style={{ fontWeight: 600 }}>{p.name}</div>
                    {p.description && <div style={{ ...styles.muted, fontSize: '0.8rem' }}>{p.description}</div>}
                  </td>
                  <td style={styles.td}>{gb(p.data_gb)}</td>
                  <td style={styles.td}>{t('portalDataPacks.days', { count: p.validity_days })}</td>
                  <td style={styles.td}>{Number(p.price).toFixed(2)} {p.currency}</td>
                  <td style={styles.td}>
                    {confirming?.id === p.id ? (
                      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span>{t('portalDataPacks.confirm', { price: `${Number(p.price).toFixed(2)} ${p.currency}` })}</span>
                        <button type="button" style={styles.button} disabled={buy.isPending} onClick={() => buy.mutate(p)}>
                          {buy.isPending ? t('portalDataPacks.buying') : t('portalDataPacks.confirmBuy')}
                        </button>
                        <button type="button" style={styles.pageBtn} onClick={() => setConfirming(null)}>{t('portalDataPacks.cancel')}</button>
                      </span>
                    ) : (
                      <button type="button" style={styles.button} onClick={() => { setMessage(null); setConfirming(p); }}>
                        {t('portalDataPacks.buy')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={styles.card}>
        <h2 style={styles.sectionTitle}>{t('portalDataPacks.purchases')}</h2>
        {!purchases.isLoading && purchaseList.length === 0 && <p style={styles.muted}>{t('portalDataPacks.noPurchases')}</p>}
        {purchaseList.length > 0 && (
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('portalDataPacks.pack')}</th>
                <th style={styles.th}>{t('portalDataPacks.data')}</th>
                <th style={styles.th}>{t('portalDataPacks.purchased')}</th>
                <th style={styles.th}>{t('portalDataPacks.expires')}</th>
                <th style={styles.th}>{t('portalDataPacks.status')}</th>
              </tr>
            </thead>
            <tbody>
              {purchaseList.map(p => (
                <tr key={p.id}>
                  <td style={styles.td}>{p.pack_name}</td>
                  <td style={styles.td}>{gb(p.gb_applied)}</td>
                  <td style={styles.td}>{String(p.purchased_at).slice(0, 10)}</td>
                  <td style={styles.td}>{p.expires_at ? String(p.expires_at).slice(0, 10) : '—'}</td>
                  <td style={styles.td}>{t(`portalDataPacks.statuses.${p.status}`, { defaultValue: p.status })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

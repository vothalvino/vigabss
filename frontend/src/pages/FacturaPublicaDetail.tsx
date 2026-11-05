// =============================================================================
// VigaBSS 5.0 — Factura global: one record's invoices and stamp
// =============================================================================
// A factura global (venta al público en general) reports, as one CFDI to
// PUBLICO EN GENERAL, the paid invoices of a period that have no CFDI of their
// own. Here staff build a draft's invoice set (add every eligible invoice of
// the period at once, add or remove one) and stamp it. The server re-checks
// every rule under the record's lock when it stamps.
// =============================================================================

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { useMutation } from '@/api/useMutation';
import { parseApiError } from '@/api/errors';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { formatMoney } from '@/lib/money';
import { formatDate } from '@/lib/dates';
import { styles } from './crudStyles';
import { LoadingState } from '@/components/FetchStates';

export type FacturaPublica = {
  id: number;
  periodicidad: string;
  meses: string;
  anio: number;
  subtotal: string | number | null;
  total_impuestos: string | number | null;
  total: string | number | null;
  status: string;
  cfdi_document_id: number | null;
};

type LinkedItem = {
  id: number;
  invoice_id: number;
  invoice_number: string | null;
  total: string | null;
  currency: string | null;
  invoice_status: string | null;
  paid_at: string | null;
};

type EligibleInvoice = {
  id: number;
  invoice_number: string | null;
  total: string;
  currency: string;
  paid_at: string;
};

type Paged<T> = {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
};

type EligiblePage = Paged<EligibleInvoice> & {
  meta: Paged<EligibleInvoice>['meta'] & { byCurrency: { currency: string; count: number; total: string }[] };
};

type StampResult = { stamped: boolean; cfdi_document_id: number; uuid?: string | null };

const PAGE_SIZE = 50;

async function fetchItems(id: number, page: number): Promise<Paged<LinkedItem>> {
  const res = await api.GET('/facturas-publicas/{id}/items', { params: { path: { id }, query: { page, limit: PAGE_SIZE } } });
  if (res.error) throw new Error('load failed');
  return res.data as Paged<LinkedItem>;
}

async function fetchEligible(id: number, page: number): Promise<EligiblePage> {
  const res = await api.GET('/facturas-publicas/{id}/eligible-invoices', { params: { path: { id }, query: { page, limit: PAGE_SIZE } } });
  if (res.error) throw new Error('load failed');
  return res.data as EligiblePage;
}

function Pager({ page, totalPages, onPage }: { page: number; totalPages: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  if (totalPages <= 1) return null;
  return (
    <div style={styles.pagination}>
      <button type="button" style={styles.pageBtn} onClick={() => onPage(page - 1)} disabled={page <= 1}>{t('facturaGlobal.prev')}</button>
      <span style={styles.pageInfo}>{t('facturaGlobal.pageOf', { page, total: totalPages })}</span>
      <button type="button" style={styles.pageBtn} onClick={() => onPage(page + 1)} disabled={page >= totalPages}>{t('facturaGlobal.next')}</button>
    </div>
  );
}

export function FacturaPublicaDetail({ factura, onClose }: { factura: FacturaPublica; onClose: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [itemsPage, setItemsPage] = useState(1);
  const [eligiblePage, setEligiblePage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isDraft = factura.status === 'draft' && !factura.cfdi_document_id;
  const canEdit = isDraft && can(user, 'facturas_publicas.update');
  const canStamp = isDraft && can(user, 'cfdi_documents.create');

  const itemsQ = useQuery({ queryKey: ['factura-publica-items', factura.id, itemsPage], queryFn: () => fetchItems(factura.id, itemsPage) });
  const eligibleQ = useQuery({
    queryKey: ['factura-publica-eligible', factura.id, eligiblePage],
    queryFn: () => fetchEligible(factura.id, eligiblePage),
    enabled: isDraft,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['factura-publica-items', factura.id] });
    qc.invalidateQueries({ queryKey: ['factura-publica-eligible', factura.id] });
    qc.invalidateQueries({ queryKey: ['facturas-publicas'] });
  };
  const onError = (e: unknown) => { setNotice(null); setError(e instanceof Error ? e.message : t('facturaGlobal.actionFailed')); };
  const fail = (body: unknown) => new Error(parseApiError(body, t('facturaGlobal.actionFailed')));

  const addAll = useMutation({
    mutationFn: async (currency: string) => {
      const res = await api.POST('/facturas-publicas/{id}/items/add-eligible', { params: { path: { id: factura.id } }, body: { currency } });
      if (res.error) throw fail(res.error);
      return (res.data as { data: { added: number } }).data.added;
    },
    onSuccess: (added) => { setError(null); setNotice(t('facturaGlobal.added', { count: added })); setItemsPage(1); setEligiblePage(1); refresh(); },
    onError,
  });

  const addOne = useMutation({
    mutationFn: async (invoiceId: number) => {
      const res = await api.POST('/facturas-publicas/{id}/items', { params: { path: { id: factura.id } }, body: { invoice_id: invoiceId } });
      if (res.error) throw fail(res.error);
    },
    onSuccess: () => { setError(null); setNotice(null); refresh(); },
    onError,
  });

  const remove = useMutation({
    mutationFn: async (itemId: number) => {
      const res = await api.DELETE('/facturas-publicas/{id}/items/{itemId}', { params: { path: { id: factura.id, itemId } } });
      if (res.error) throw fail(res.error);
    },
    onSuccess: () => { setError(null); setNotice(null); refresh(); },
    onError,
  });

  const stamp = useMutation({
    mutationFn: async () => {
      const res = await api.POST('/facturas-publicas/{id}/stamp', { params: { path: { id: factura.id } } });
      if (res.error) throw fail(res.error);
      return (res.data as { data: StampResult }).data;
    },
    onSuccess: (result) => {
      setError(null);
      setNotice(result.stamped
        ? t('facturaGlobal.stamped', { uuid: result.uuid ?? '' })
        : t('facturaGlobal.stampPending', { id: result.cfdi_document_id }));
      refresh();
    },
    onError,
  });

  function onStamp() {
    if (!window.confirm(t('facturaGlobal.confirmStamp'))) return;
    stamp.mutate();
  }

  const items = itemsQ.data?.data ?? [];
  const linkedCount = itemsQ.data?.meta.total ?? 0;
  const eligible = eligibleQ.data?.data ?? [];
  const byCurrency = eligibleQ.data?.meta.byCurrency ?? [];
  const busy = addAll.isPending || addOne.isPending || remove.isPending || stamp.isPending;

  return (
    <section aria-labelledby={`factura-${factura.id}-title`} style={{ ...styles.tableCard, marginTop: 16, padding: 16 }}>
      <div style={{ ...styles.header, marginBottom: 8 }}>
        <h2 id={`factura-${factura.id}-title`} style={{ margin: 0, fontSize: '1.1rem' }}>
          {t('facturaGlobal.detailTitle', { id: factura.id, period: `${factura.meses}/${factura.anio}` })}
        </h2>
        <div style={{ display: 'flex', gap: 8 }}>
          {canStamp && (
            <button type="button" style={styles.btnPrimary} disabled={busy || linkedCount === 0} onClick={onStamp}>
              {stamp.isPending ? t('facturaGlobal.stamping') : t('facturaGlobal.stamp')}
            </button>
          )}
          <button type="button" style={styles.btnSecondary} onClick={onClose}>{t('facturaGlobal.close')}</button>
        </div>
      </div>
      {!isDraft && <p style={styles.msg}>{t('facturaGlobal.frozen')}</p>}
      {error && <p role="alert" style={styles.msgError}>{error}</p>}
      {notice && <p role="status" style={styles.msg}>{notice}</p>}

      <h3 style={{ fontSize: '1rem', margin: '12px 0 4px' }}>{t('facturaGlobal.linkedTitle', { count: linkedCount })}</h3>
      {itemsQ.isLoading ? <LoadingState /> : itemsQ.isError ? (
        <p style={styles.msgError}>{t('facturaGlobal.loadError')}</p>
      ) : items.length === 0 ? (
        <p style={styles.msg}>{t('facturaGlobal.noLinked')}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>{t('facturaGlobal.col.invoice')}</th>
                <th style={styles.th}>{t('facturaGlobal.col.paidAt')}</th>
                <th style={styles.thNum}>{t('facturaGlobal.col.total')}</th>
                {canEdit && <th style={styles.th}>{t('facturaGlobal.col.actions')}</th>}
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <tr key={it.id} style={styles.tr}>
                  <td style={styles.td}>{it.invoice_number ?? `#${it.invoice_id}`}</td>
                  <td style={styles.td}>{formatDate(it.paid_at)}</td>
                  <td style={styles.tdNum}>{formatMoney(it.total, it.currency)}</td>
                  {canEdit && (
                    <td style={styles.td}>
                      <button type="button" style={styles.actionBtn} disabled={busy} onClick={() => remove.mutate(it.id)}>
                        {t('facturaGlobal.remove')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={itemsPage} totalPages={itemsQ.data?.meta.totalPages ?? 1} onPage={setItemsPage} />

      {isDraft && (
        <>
          <h3 style={{ fontSize: '1rem', margin: '16px 0 4px' }}>{t('facturaGlobal.eligibleTitle')}</h3>
          <p style={{ ...styles.msg, textAlign: 'left', padding: 0 }}>{t('facturaGlobal.eligibleHelp')}</p>
          {canEdit && byCurrency.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
              {byCurrency.map(c => (
                <button key={c.currency} type="button" style={styles.btnPrimary} disabled={busy} onClick={() => addAll.mutate(c.currency)}>
                  {t('facturaGlobal.addAll', { count: c.count, total: formatMoney(c.total, c.currency) })}
                </button>
              ))}
            </div>
          )}
          {eligibleQ.isLoading ? <LoadingState /> : eligibleQ.isError ? (
            <p style={styles.msgError}>{t('facturaGlobal.loadError')}</p>
          ) : eligible.length === 0 ? (
            <p style={styles.msg}>{t('facturaGlobal.noEligible')}</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>{t('facturaGlobal.col.invoice')}</th>
                    <th style={styles.th}>{t('facturaGlobal.col.paidAt')}</th>
                    <th style={styles.thNum}>{t('facturaGlobal.col.total')}</th>
                    {canEdit && <th style={styles.th}>{t('facturaGlobal.col.actions')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {eligible.map(inv => (
                    <tr key={inv.id} style={styles.tr}>
                      <td style={styles.td}>{inv.invoice_number ?? `#${inv.id}`}</td>
                      <td style={styles.td}>{formatDate(inv.paid_at)}</td>
                      <td style={styles.tdNum}>{formatMoney(inv.total, inv.currency)}</td>
                      {canEdit && (
                        <td style={styles.td}>
                          <button type="button" style={styles.actionBtn} disabled={busy} onClick={() => addOne.mutate(inv.id)}>
                            {t('facturaGlobal.add')}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={eligiblePage} totalPages={eligibleQ.data?.meta.totalPages ?? 1} onPage={setEligiblePage} />
        </>
      )}
    </section>
  );
}

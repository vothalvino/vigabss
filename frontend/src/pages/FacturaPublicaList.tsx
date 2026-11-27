// =============================================================================
// VigaBSS 5.0 — Facturas globales (factura pública)
// =============================================================================
// Page at /facturas-publicas. A factura global reports, as one CFDI 4.0 to
// PUBLICO EN GENERAL with InformacionGlobal, the paid invoices of a period
// that have no CFDI of their own. Staff create one for a period here, build
// its invoice set and stamp it (FacturaPublicaDetail).
// =============================================================================

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { formatMoney } from '@/lib/money';
import { styles } from './crudStyles';
import { StatusBadge, type StatusColors } from '@/components/ui/StatusBadge';
import { GlobalInvoiceBuilder } from './facturaGlobal/GlobalInvoiceBuilder';
import { FacturaPublicaDetail, type FacturaPublica } from './FacturaPublicaDetail';

type FacturaPublicaPage = {
  data: FacturaPublica[];
  meta: { total: number; page: number; limit: number; totalPages?: number };
};

const DEFAULT_PAGE_SIZE = 50;

const STATUS_COLORS: StatusColors = {
  draft: { bg: 'var(--bg-subtle)', color: 'var(--text-secondary)' },
  stamped: { bg: 'var(--success-soft)', color: 'var(--success)' },
  cancelled: { bg: 'var(--danger-soft)', color: 'var(--danger)' },
};

async function fetchFacturas(page: number): Promise<FacturaPublicaPage> {
  const res = await api.GET('/facturas-publicas', { params: { query: { page, limit: DEFAULT_PAGE_SIZE } } });
  if (res.error) throw new Error('Failed to load facturas públicas');
  return res.data as FacturaPublicaPage;
}

export function FacturaPublicaList() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const facturasQ = useQuery({
    queryKey: ['facturas-publicas', page],
    queryFn: () => fetchFacturas(page),
  });

  const facturas = facturasQ.data?.data ?? [];
  const meta = facturasQ.data?.meta;
  const totalPages = meta?.totalPages ?? (meta ? Math.max(1, Math.ceil(meta.total / meta.limit)) : 1);
  const open = facturas.find(f => f.id === openId) ?? null;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t('facturaGlobal.title')}</h1>
        {meta && <span style={styles.countBadge}>{t('facturaGlobal.total', { count: meta.total })}</span>}
        {can(user, 'facturas_publicas.create') && (
          <button type="button" style={styles.btnPrimary} onClick={() => setCreating(true)}>{t('facturaGlobal.new')}</button>
        )}
      </div>
      <p style={{ margin: '0 0 12px', color: 'var(--text-muted)', fontSize: '0.875rem' }}>{t('facturaGlobal.description')}</p>

      <div style={styles.tableCard}>
        {facturasQ.isLoading ? (
          <p style={styles.msg}>{t('facturaGlobal.loading')}</p>
        ) : facturasQ.error ? (
          <p style={styles.msgError}>{t('facturaGlobal.loadError')}</p>
        ) : facturas.length === 0 ? (
          <p style={styles.msg}>{t('facturaGlobal.empty')}</p>
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>{t('facturaGlobal.col.id')}</th>
                    <th style={styles.th}>{t('facturaGlobal.anio')}</th>
                    <th style={styles.th}>{t('facturaGlobal.meses')}</th>
                    <th style={styles.th}>{t('facturaGlobal.periodicidad')}</th>
                    <th style={styles.th}>{t('facturaGlobal.builder.forma')}</th>
                    <th style={styles.th}>{t('facturaGlobal.builder.days')}</th>
                    <th style={styles.thNum}>{t('facturaGlobal.col.subtotal')}</th>
                    <th style={styles.thNum}>{t('facturaGlobal.col.taxes')}</th>
                    <th style={styles.thNum}>{t('facturaGlobal.col.total')}</th>
                    <th style={styles.th}>{t('facturaGlobal.col.status')}</th>
                    <th style={styles.th}>{t('facturaGlobal.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {facturas.map(f => (
                    <tr key={f.id} style={styles.tr}>
                      <td style={styles.td}>#{f.id}</td>
                      <td style={{ ...styles.td, fontWeight: 500 }}>{f.anio}</td>
                      <td style={styles.td}>{f.meses ? t(`facturaGlobal.mesesNames.${f.meses}`, { defaultValue: f.meses }) : '—'}</td>
                      <td style={styles.td}>{t(`facturaGlobal.periodicidades.${f.periodicidad}`, { defaultValue: f.periodicidad })}</td>
                      <td style={styles.td}>{f.forma_pago ? t(`facturaGlobal.builder.formas.${f.forma_pago}`, { defaultValue: f.forma_pago }) : (f.date_from ? t('facturaGlobal.builder.mixed') : '—')}</td>
                      <td style={styles.td}>{f.date_from ? `${String(f.date_from).slice(0, 10)} – ${String(f.date_to ?? '').slice(0, 10)}` : '—'}</td>
                      <td style={styles.tdNum}>{formatMoney(f.subtotal)}</td>
                      <td style={styles.tdNum}>{formatMoney(f.total_impuestos)}</td>
                      <td style={{ ...styles.tdNum, fontWeight: 500 }}>{formatMoney(f.total)}</td>
                      <td style={styles.td}><StatusBadge status={f.status} colors={STATUS_COLORS} /></td>
                      <td style={styles.td}>
                        <button type="button" style={styles.actionBtn} onClick={() => setOpenId(f.id)} aria-pressed={openId === f.id}>
                          {t('facturaGlobal.open')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div style={styles.pagination}>
                <button type="button" style={styles.pageBtn} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
                  {t('facturaGlobal.prev')}
                </button>
                <span style={styles.pageInfo}>{t('facturaGlobal.pageOf', { page, total: totalPages })}</span>
                <button
                  type="button"
                  style={styles.pageBtn}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                >
                  {t('facturaGlobal.next')}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {open && <FacturaPublicaDetail key={open.id} factura={open} onClose={() => setOpenId(null)} />}

      {creating && (
        <GlobalInvoiceBuilder
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(ids) => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['facturas-publicas'] });
            setPage(1);
            setOpenId(ids[0] ?? null);
          }}
        />
      )}
    </div>
  );
}

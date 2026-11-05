// =============================================================================
// VigaBSS 5.0 — Facturas globales (factura pública)
// =============================================================================
// Page at /facturas-publicas. A factura global reports, as one CFDI 4.0 to
// PUBLICO EN GENERAL with InformacionGlobal, the paid invoices of a period
// that have no CFDI of their own. Staff create one for a period here, build
// its invoice set and stamp it (FacturaPublicaDetail).
// =============================================================================

import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/api/client';
import { useMutation } from '@/api/useMutation';
import { parseApiError } from '@/api/errors';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';
import { formatMoney } from '@/lib/money';
import { styles } from './crudStyles';
import { StatusBadge, type StatusColors } from '@/components/ui/StatusBadge';
import { Modal } from '@/components/ui/Modal';
import { FacturaPublicaDetail, type FacturaPublica } from './FacturaPublicaDetail';

type FacturaPublicaPage = {
  data: FacturaPublica[];
  meta: { total: number; page: number; limit: number; totalPages?: number };
};

const DEFAULT_PAGE_SIZE = 50;

// SAT c_Periodicidad.
const PERIODICIDADES = ['01', '02', '03', '04', '05'] as const;
// SAT c_Meses: 01-12 one month (every periodicidad but bimestral), 13-18 a
// bimester (bimestral only).
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
const BIMESTERS = ['13', '14', '15', '16', '17', '18'];

const STATUS_COLORS: StatusColors = {
  draft: { bg: '#f3f4f6', color: '#374151' },
  stamped: { bg: '#d1fae5', color: '#065f46' },
  cancelled: { bg: '#fee2e2', color: '#991b1b' },
};

async function fetchFacturas(page: number): Promise<FacturaPublicaPage> {
  const res = await api.GET('/facturas-publicas', { params: { query: { page, limit: DEFAULT_PAGE_SIZE } } });
  if (res.error) throw new Error('Failed to load facturas públicas');
  return res.data as FacturaPublicaPage;
}

function CreateFacturaModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (f: FacturaPublica) => void;
}) {
  const { t } = useTranslation();
  const now = new Date();
  const [periodicidad, setPeriodicidad] = useState('04');
  const [meses, setMeses] = useState(String(now.getMonth() + 1).padStart(2, '0'));
  const [anio, setAnio] = useState(now.getFullYear());
  const [error, setError] = useState<string | null>(null);
  const options = periodicidad === '05' ? BIMESTERS : MONTHS;

  const create = useMutation({
    mutationFn: async () => {
      const res = await api.POST('/facturas-publicas', { body: { periodicidad, meses, anio } });
      if (res.error) throw new Error(parseApiError(res.error, t('facturaGlobal.actionFailed')));
      return (res.data as { data: FacturaPublica }).data;
    },
    onSuccess: (f) => { setError(null); onCreated(f); },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : t('facturaGlobal.actionFailed')),
  });

  function onPeriodicidad(value: string) {
    setPeriodicidad(value);
    // Keep Meses valid for the new periodicidad.
    if (value === '05' && !BIMESTERS.includes(meses)) setMeses('13');
    if (value !== '05' && !MONTHS.includes(meses)) setMeses('01');
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  return (
    <Modal open={open} title={t('facturaGlobal.newTitle')} onClose={onClose}>
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
        <label style={styles.label}>
          {t('facturaGlobal.periodicidad')}
          <select style={styles.filterSelect} value={periodicidad} onChange={e => onPeriodicidad(e.target.value)}>
            {PERIODICIDADES.map(p => <option key={p} value={p}>{t(`facturaGlobal.periodicidades.${p}`)}</option>)}
          </select>
        </label>
        <label style={styles.label}>
          {t('facturaGlobal.meses')}
          <select style={styles.filterSelect} value={meses} onChange={e => setMeses(e.target.value)}>
            {options.map(m => <option key={m} value={m}>{t(`facturaGlobal.mesesNames.${m}`)}</option>)}
          </select>
        </label>
        <label style={styles.label}>
          {t('facturaGlobal.anio')}
          <input
            style={styles.input}
            type="number"
            min={2022}
            max={2099}
            value={anio}
            onChange={e => setAnio(Number(e.target.value))}
          />
        </label>
        {error && <p role="alert" style={styles.msgError}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={styles.btnSecondary} onClick={onClose}>{t('facturaGlobal.cancel')}</button>
          <button type="submit" style={styles.btnPrimary} disabled={create.isPending}>{t('facturaGlobal.create')}</button>
        </div>
      </form>
    </Modal>
  );
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
        <CreateFacturaModal
          open={creating}
          onClose={() => setCreating(false)}
          onCreated={(f) => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['facturas-publicas'] });
            setPage(1);
            setOpenId(f.id);
          }}
        />
      )}
    </div>
  );
}

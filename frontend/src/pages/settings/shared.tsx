// =============================================================================
// VigaBSS 5.0 — Settings page: shared styles and small components
// =============================================================================
// Used by Settings.tsx and the tabs split out of it.
// =============================================================================

import type React from 'react';
import { useTranslation } from 'react-i18next';

interface ModalProps { title: string; onClose: () => void; children: React.ReactNode; }
export function Modal({ title, onClose, children }: ModalProps) {
  return (
    <div style={sty.overlay}>
      <div style={sty.modal}>
        <div style={sty.modalHeader}>
          <span style={{ fontWeight: 600 }}>{title}</span>
          <button style={sty.closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={sty.modalBody}>{children}</div>
      </div>
    </div>
  );
}

interface ConfirmProps { message: string; onConfirm: () => void; onCancel: () => void; loading: boolean; }
export function ConfirmDialog({ message, onConfirm, onCancel, loading }: ConfirmProps) {
  const { t } = useTranslation();
  return (
    <div style={sty.overlay}>
      <div style={{ ...sty.modal, maxWidth: 400 }}>
        <div style={sty.modalBody}>
          <p style={{ marginTop: 0 }}>{message}</p>
          <div style={sty.modalFooter}>
            <button style={sty.btnGhost} onClick={onCancel} disabled={loading}>{t('ui.settings.cancel')}</button>
            <button style={sty.btnDanger} onClick={onConfirm} disabled={loading}>
              {loading ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function channelBadge(label: string) {
  const colours: Record<string, string> = {
    email: '#3b82f6', sms: '#8b5cf6', whatsapp: '#22c55e', push: '#f59e0b',
    stripe: '#635bff', conekta: '#e74c3c', openpay: '#2ecc71', paypal: '#003087',
    mercadopago: '#009ee3', manual: '#888', other: '#888',
  };
  return { ...sty.badge, background: colours[label] ?? '#888' };
}

export function statusBadge(st: string) {
  return {
    padding: '2px 8px', borderRadius: 10, fontSize: '0.75rem', fontWeight: 600,
    background: st === 'active' ? '#16a34a' : '#888', color: 'var(--bg-card)',
  };
}

export const sty = {
  page: { padding: '1.5rem 2rem', fontFamily: 'var(--font-sans)', maxWidth: 1000 },
  pageTitle: { margin: '0 0 1rem', fontSize: '1.4rem' },
  tabs: { display: 'flex', gap: 4, borderBottom: '2px solid var(--border)', marginBottom: '1.25rem' },
  tabBtn: {
    background: 'none', border: 'none', borderBottom: '2px solid transparent',
    padding: '0.5rem 1rem', cursor: 'pointer', fontSize: '0.9rem', color: 'var(--text-muted)',
    marginBottom: -2, transition: 'color .15s',
  } as React.CSSProperties,
  tabBtnActive: { color: 'var(--accent)', borderBottomColor: 'var(--accent)', fontWeight: 600 } as React.CSSProperties,
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '1.5rem' },
  sectionTitle: { margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600 },
  tabBar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' },
  muted: { color: 'var(--text-faint)', fontStyle: 'italic' as const, fontSize: '0.875rem' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem' },
  th: { textAlign: 'left' as const, padding: '0.5rem 0.75rem', borderBottom: '2px solid var(--border)', fontWeight: 600, color: 'var(--text-secondary)' },
  td: { padding: '0.6rem 0.75rem', borderBottom: '1px solid var(--border-subtle)', verticalAlign: 'middle' as const },
  code: { background: 'var(--bg-subtle)', padding: '2px 6px', borderRadius: 4, fontFamily: 'monospace', fontSize: '0.82rem' },
  valueCap: { display: 'block', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  badge: { padding: '2px 8px', borderRadius: 10, fontSize: '0.75rem', fontWeight: 600, color: '#fff' },
  rowActions: { display: 'flex', gap: 6 },
  errorText: { color: 'var(--danger)', fontSize: '0.85rem', margin: '0.5rem 0 0' },
  hint: { fontWeight: 400, color: 'var(--text-faint)', fontSize: '0.8rem' },
  // modal
  overlay: { position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 80, zIndex: 1000 },
  modal: { background: 'var(--bg-card)', borderRadius: 8, width: '100%', maxWidth: 560, boxShadow: '0 8px 32px rgba(0,0,0,.2)', maxHeight: '80vh', overflow: 'auto' as const },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)' },
  modalBody: { padding: '1.25rem' },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: '1rem' },
  closeBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.1rem', color: 'var(--text-faint)' },
  form: { display: 'flex', flexDirection: 'column' as const, gap: 12 },
  label: { display: 'flex', flexDirection: 'column' as const, gap: 4, fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' },
  input: { padding: '0.45rem 0.65rem', border: '1px solid var(--input-border)', borderRadius: 6, fontSize: '0.875rem', width: '100%', boxSizing: 'border-box' as const },
  select: { padding: '0.45rem 0.65rem', border: '1px solid var(--input-border)', borderRadius: 6, fontSize: '0.875rem', background: 'var(--input-bg)', width: '100%', boxSizing: 'border-box' as const },
  row2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  verList: { display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1.25rem', margin: 0, fontSize: '0.9rem' },
  verKey: { color: 'var(--text-secondary)', fontWeight: 500 },
  verVal: { margin: 0 },
  verNote: { marginTop: '1.25rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.6 },
  verRule: { border: 0, borderTop: '1px solid var(--border)', margin: '1.75rem 0 1.25rem' },
  verPre: { background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: 6, padding: '0.75rem', fontSize: '0.78rem', overflowX: 'auto' as const, whiteSpace: 'pre' as const, margin: '0.75rem 0' },
  btnDisabled: { opacity: 0.55, cursor: 'not-allowed' as const },
  checkRow: { display: 'flex', gap: 24, fontSize: '0.875rem' },
  // buttons
  btnPrimary: { padding: '0.4rem 1rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.875rem', fontWeight: 500 },
  btnGhost: { padding: '0.4rem 1rem', background: 'var(--bg-body)', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', borderRadius: 6, cursor: 'pointer', fontSize: '0.875rem' },
  btnDanger: { padding: '0.4rem 1rem', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.875rem' },
};

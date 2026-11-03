// Shared look of the portal self-service pages (FE-26).
export const portalPageStyles = {
  heading: { margin: '0 0 0.25rem', fontSize: '1.4rem', color: 'var(--text-primary)' },
  sub: { margin: '0 0 1.25rem', color: 'var(--text-muted)', fontSize: '0.9rem' },
  card: { background: 'var(--bg-card)', borderRadius: 8, boxShadow: '0 0 0 1px var(--border)', padding: '1.25rem', marginBottom: '1.25rem', overflow: 'auto' },
  sectionTitle: { margin: '0 0 0.75rem', fontSize: '1.05rem', color: 'var(--text-primary)' },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '0.875rem' },
  th: { textAlign: 'left' as const, padding: '0.6rem 0.75rem', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '2px solid var(--border-subtle)' },
  td: { padding: '0.6rem 0.75rem', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' },
  muted: { color: 'var(--text-muted)' },
  error: { color: '#b91c1c' },
  success: { color: '#065f46' },
  label: { display: 'block', fontWeight: 600, fontSize: '0.875rem', marginBottom: '0.3rem', color: 'var(--text-secondary)' },
  input: { width: '100%', maxWidth: 360, padding: '0.5rem 0.6rem', border: '1px solid var(--input-border)', borderRadius: 4, fontSize: '0.9rem', marginBottom: '0.9rem' },
  button: { padding: '0.5rem 1.2rem', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600 },
  pagination: { display: 'flex', alignItems: 'center', gap: '1rem', marginTop: '1rem', justifyContent: 'center' },
  pageBtn: { padding: '0.4rem 0.8rem', border: '1px solid var(--border-strong)', borderRadius: 4, cursor: 'pointer', background: 'var(--bg-card)', fontSize: '0.875rem' },
};

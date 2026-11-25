// =============================================================================
// VigaBSS 5.0 — a section's setup page
// =============================================================================
// Where a section keeps what is configured once and rarely revisited, so the
// sidebar holds only everyday work. One card per setup tab set of the nav
// registry, each saying in a line what it is for; a person sees the cards and
// pages their permissions open. Every page here is also found by search.
// =============================================================================
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/auth/AuthContext';
import { visibleSetupCards, type SectionId } from '@/nav/routes';

export function SetupPage({ section }: { section: Extract<SectionId, 'admin' | 'billing' | 'network'> }) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const cards = user ? visibleSetupCards(user, section) : [];

  return (
    <div style={styles.page}>
      <h1 style={styles.title}>{t(`nav.setup.${section}.title`)}</h1>
      <p style={styles.hint}>{t(`nav.setup.${section}.hint`)}</p>
      {cards.length === 0 ? (
        <p style={styles.hint}>{t('nav.hubs.empty')}</p>
      ) : (
        <div style={styles.grid}>
          {cards.map(({ set, items }) => (
            <section key={set.id} style={styles.card} aria-labelledby={`setup-card-${set.id}`}>
              <h2 id={`setup-card-${set.id}`} style={styles.cardTitle}>{t(set.labelKey)}</h2>
              {set.hintKey && <p style={styles.cardHint}>{t(set.hintKey)}</p>}
              <ul style={styles.list}>
                {items.map(item => (
                  <li key={item.path}><Link to={item.path} style={styles.link}>{t(item.labelKey)}</Link></li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { padding: '1.5rem' },
  title: { fontSize: '1.4rem', margin: 0, color: 'var(--text-primary)' },
  hint: { color: 'var(--text-secondary)', fontSize: '0.9rem', margin: '4px 0 20px', maxWidth: 640 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 },
  card: { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' },
  cardTitle: { margin: 0, fontSize: '1rem', color: 'var(--text-primary)' },
  cardHint: { margin: '4px 0 10px', fontSize: '0.84rem', color: 'var(--text-secondary)' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 },
  link: { display: 'block', padding: '6px 0', fontSize: '0.9rem', color: 'var(--accent)', textDecoration: 'none' },
};

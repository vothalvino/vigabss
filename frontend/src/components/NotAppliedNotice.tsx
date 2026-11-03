// =============================================================================
// VigaBSS 5.0 — "recorded, not applied" notice (TNA-40)
// =============================================================================
// Some settings pages store records that nothing acts on yet (backup
// schedules, masking rules, billing adjustments). The page says so, so an
// operator does not rely on a setting that has no effect.
// =============================================================================

import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui';

export function NotAppliedNotice({ detail }: { detail: string }) {
  const { t } = useTranslation();
  return (
    <div
      role="note"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12,
        padding: '10px 16px', border: '1px solid var(--border, #e5e7eb)', borderRadius: 6, fontSize: '0.875rem',
      }}
    >
      <Badge tone="warning">{t('notApplied.badge')}</Badge>
      <span>{detail}</span>
    </div>
  );
}

// =============================================================================
// VigaBSS 5.0 — NOC AI Insights page
// =============================================================================
// AI-generated analysis for the network team (capacity, interference,
// alignment drift, alert explanations, shift summaries). It was a tab of the
// customer-support AI page; it is network tooling, so it sits with the NOC
// pages. The content is NocInsightsTab, unchanged.
// =============================================================================

import { useTranslation } from 'react-i18next';
import { NocInsightsTab } from './AiSupportPage';

export function NocInsightsPage() {
  const { t } = useTranslation();
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginTop: 0 }}>{t('nav.nocInsights')}</h2>
      <NocInsightsTab />
    </div>
  );
}

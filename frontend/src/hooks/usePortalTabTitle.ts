// The customer portal's browser tab names the company the customer deals
// with, never the software. Before sign-in the company is not known, so the
// tab reads a plain "Customer portal". The previous title comes back when the
// portal screen goes away.
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

export function usePortalTabTitle(companyName?: string | null): void {
  const { t } = useTranslation();
  const title = companyName?.trim() || t('portalLayout.tabTitle');
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);
}

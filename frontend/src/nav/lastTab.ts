// Which page of a tab set was open last, per browser, so its sidebar row
// leads back there. Storage may be unavailable (private window, blocked site
// data): then the row simply leads to the set's first page.
const key = (tabset: string) => `vigabss.nav.lastTab.${tabset}`;

export function lastTab(tabset: string): string | null {
  try { return window.localStorage.getItem(key(tabset)); } catch { return null; }
}

export function rememberTab(tabset: string, path: string): void {
  try { window.localStorage.setItem(key(tabset), path); } catch { /* not kept */ }
}

// =============================================================================
// Money amounts from the API (FE-23)
// =============================================================================
// DECIMAL columns arrive as strings ('1160.00'). Pages each declared their own
// fmtAmount/fmtMoney; the es-MX currency ones are this. A missing or
// non-numeric amount is '—' (a copy that parsed blindly printed "$NaN").
// =============================================================================

/** Format an amount in its currency (MXN when the row carries none). */
export function formatMoney(amount: string | number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const num = typeof amount === 'number' ? amount : parseFloat(amount);
  if (Number.isNaN(num)) return '—';
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: currency || 'MXN' }).format(num);
}

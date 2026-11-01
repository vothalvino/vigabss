// =============================================================================
// Calendar dates from the API (FE-10)
// =============================================================================
// MySQL DATE columns (due_date, issue_date, payment_date, start_date, …)
// arrive as UTC-midnight ISO strings ('2026-11-01T00:00:00.000Z'), or as epoch
// milliseconds through GraphQL. `new Date(s).toLocaleDateString()` renders
// them in the browser's zone, so in Mexico (UTC-6) a due date of 1 November
// showed as 31 October, while the edit form (which slices the ISO string)
// showed the 1st. A date-only value, or one exactly at UTC midnight, is a
// calendar date and is formatted in UTC; anything else is a moment and is
// formatted locally.
// =============================================================================

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const UTC_MIDNIGHT = /^\d{4}-\d{2}-\d{2}T00:00:00(?:\.0+)?(?:Z|[+-]00:?00)$/;
const DAY_MS = 86_400_000;

const DEFAULT_OPTIONS: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };

function parse(value: string | number | Date): { date: Date; calendar: boolean } | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : { date: value, calendar: value.getTime() % DAY_MS === 0 };
  }
  if (typeof value === 'number' || /^\d{10,}$/.test(String(value).trim())) {
    const n = Number(value);
    const ms = n < 1e12 ? n * 1000 : n;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : { date, calendar: ms % DAY_MS === 0 };
  }
  const s = String(value).trim();
  if (DATE_ONLY.test(s)) return { date: new Date(`${s}T00:00:00Z`), calendar: true };
  const date = new Date(s);
  if (Number.isNaN(date.getTime())) return null;
  return { date, calendar: UTC_MIDNIGHT.test(s) };
}

/** Format an API date for display; calendar dates never shift a day. */
export function formatDate(
  value: string | number | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = DEFAULT_OPTIONS,
  locale = 'es-MX',
): string {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = parse(value);
  if (!parsed) return '—';
  return parsed.date.toLocaleDateString(locale, parsed.calendar ? { ...options, timeZone: 'UTC' } : options);
}

/** The YYYY-MM-DD of an API calendar date (for inputs and chart labels). */
export function calendarDay(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const parsed = parse(value);
  if (!parsed) return '';
  const d = parsed.date;
  if (parsed.calendar) return d.toISOString().slice(0, 10);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

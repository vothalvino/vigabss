// FE-10: DATE columns arrive as UTC-midnight ISO strings (or GraphQL epoch
// millis). Formatted in the browser's zone, a due date of 1 November showed
// as 31 October in Mexico, and the portal usage chart labelled bars with
// '01T00:00:00.000Z'. Vitest runs in UTC, which hid it; this file runs in
// Mexico City time.
import { describe, expect, it } from 'vitest';
import { formatDate, calendarDay } from '../dates';
import { fmtDate } from '@/pages/crudStyles';

process.env.TZ = 'America/Mexico_City';

describe('formatDate in America/Mexico_City', () => {
  it('the zone is really Mexico City here', () => {
    expect(new Date('2026-11-01T00:00:00.000Z').getDate()).toBe(31); // the bug's mechanism
  });

  it.each([
    ['2026-11-01T00:00:00.000Z', 'REST DATE column'],
    ['2026-11-01', 'date-only string'],
    [String(Date.UTC(2026, 10, 1)), 'GraphQL epoch millis'],
    [Date.UTC(2026, 10, 1), 'epoch number'],
  ] as Array<[string | number, string]>)('%s (%s) is 1 November', (value) => {
    expect(formatDate(value)).toBe(new Date(Date.UTC(2026, 10, 1)).toLocaleDateString('es-MX', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }));
    expect(formatDate(value)).toMatch(/^1 nov/);
  });

  it('a real moment is still shown in local time', () => {
    // 03:00 UTC on 1 November is the evening of 31 October in Mexico City.
    expect(formatDate('2026-11-01T03:00:00.000Z')).toMatch(/^31 oct/);
  });

  it('empty and unparseable values render a dash', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate('')).toBe('—');
    expect(formatDate('not a date')).toBe('—');
  });

  it('calendarDay gives the date part for labels and inputs', () => {
    expect(calendarDay('2026-11-01T00:00:00.000Z')).toBe('2026-11-01');
    expect(calendarDay('2026-11-01')).toBe('2026-11-01');
    expect(calendarDay('2026-11-01T03:00:00.000Z')).toBe('2026-10-31');
  });
});

describe('page formatters', () => {
  it('the shared fmtDate shows a due date on its own day', () => {
    expect(fmtDate('2026-11-01T00:00:00.000Z')).toMatch(/^1 nov/);
  });
});

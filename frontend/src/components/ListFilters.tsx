// A list's filters: a date range (both days included) and, where the list has
// one, the client. The same bar on every list that offers them; a page adds
// its own controls as children. The API reads the range as ?date_from= and
// ?date_to= on the list's own date (issue date, payment date, …).
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ClientPicker } from '@/components/ClientPicker';

export interface ListFilterValue {
  from: string;
  to: string;
  clientId: number | null;
  clientName: string;
}

export const EMPTY_LIST_FILTERS: ListFilterValue = { from: '', to: '', clientId: null, clientName: '' };

/** The query parameters a filter value stands for; unset filters are left out. */
export function listFilterQuery(value: ListFilterValue): Record<string, string | number> {
  const query: Record<string, string | number> = {};
  if (value.from) query.date_from = value.from;
  if (value.to) query.date_to = value.to;
  if (value.clientId) query.client_id = value.clientId;
  return query;
}

/** A stable key for a filter value, for query keys. */
export function listFilterKey(value: ListFilterValue): string {
  return `${value.from}|${value.to}|${value.clientId ?? ''}`;
}

const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 };
const label: React.CSSProperties = { fontSize: '0.75rem', color: 'var(--text-muted)' };
const input: React.CSSProperties = {
  padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border-strong)',
  background: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: '0.85rem',
};

export function ListFilters({ value, onChange, dateLabel, showClient = true, children }: {
  value: ListFilterValue;
  onChange: (next: ListFilterValue) => void;
  /** What the dates mean on this list, e.g. "Issue date". */
  dateLabel: string;
  showClient?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const active = Boolean(value.from || value.to || value.clientId);
  return (
    <div
      role="group"
      aria-label={t('listFilters.title')}
      style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '1rem' }}
    >
      <div style={field}>
        <label htmlFor={`${id}-from`} style={label}>{t('listFilters.from', { what: dateLabel })}</label>
        <input
          id={`${id}-from`} type="date" style={input} value={value.from} max={value.to || undefined}
          onChange={e => onChange({ ...value, from: e.target.value })}
        />
      </div>
      <div style={field}>
        <label htmlFor={`${id}-to`} style={label}>{t('listFilters.to')}</label>
        <input
          id={`${id}-to`} type="date" style={input} value={value.to} min={value.from || undefined}
          onChange={e => onChange({ ...value, to: e.target.value })}
        />
      </div>
      {showClient && (
        <div style={{ minWidth: 240, flex: '0 1 300px' }}>
          <ClientPicker
            value={value.clientId ?? ''}
            initialName={value.clientName}
            required={false}
            label={t('listFilters.client')}
            onChange={(clientId, clientName) => onChange({ ...value, clientId: clientId || null, clientName })}
          />
        </div>
      )}
      {children}
      {active && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_LIST_FILTERS)}
          style={{ ...input, cursor: 'pointer', background: 'var(--bg-subtle)' }}
        >
          {t('listFilters.clear')}
        </button>
      )}
    </div>
  );
}

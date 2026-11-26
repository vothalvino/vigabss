// =============================================================================
// VigaBSS 5.0 — Model picker for a provider with a live model list (OpenRouter)
// =============================================================================
// The list comes from GET /ai/providers/models (OpenRouter's own catalog,
// cached for an hour, refreshable). The picker shows it as a list that can be
// searched, limited to free models and sorted by price, so a cheaper or better
// model is a click away. The id can still be typed by hand: OpenRouter adds
// models faster than any list is refreshed.
//
// `audioOnly` is the voice-note picker: OpenRouter's dedicated speech-to-text
// models (Whisper and the like, priced per minute of audio) and the chat
// models that accept audio in a message. The text picker leaves the
// speech-to-text models out, since they cannot answer a chat.
// =============================================================================

import { useMemo, useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';

/** One row of GET /ai/providers/models. Prices are USD **per token**. */
export interface OpenRouterModel {
  id: string;
  name: string | null;
  context_length: number | null;
  prompt_price: number | null;
  completion_price: number | null;
  free: boolean;
  /** Accepts audio in a chat message (can transcribe a voice note). */
  audio_input?: boolean;
  /** A dedicated speech-to-text model (Whisper and the like); not a chat model. */
  transcription?: boolean;
  /** USD per minute of audio, when the model is priced by audio time. */
  audio_minute_price?: number | null;
}

export interface ModelCatalogState {
  models: OpenRouterModel[];
  loading: boolean;
  loaded: boolean;
  stale: boolean;
  error: string;
  /** When the server last fetched the list from OpenRouter (ms since epoch). */
  cachedAt?: number | null;
}

export const EMPTY_MODEL_CATALOG: ModelCatalogState = {
  models: [], loading: false, loaded: false, stale: false, error: '', cachedAt: null,
};

// The list holds several hundred models; this many rows are drawn at once.
export const MAX_ROWS = 60;

/** USD per token → the per-million-token figure providers actually quote. */
export function pricePerMillion(perToken: number | null | undefined): string | null {
  // null means "unknown", which is NOT the same as free — show nothing.
  if (perToken == null || !Number.isFinite(perToken)) return null;
  const perM = perToken * 1e6;
  const digits = perM >= 1 ? 2 : perM >= 0.01 ? 3 : 4;
  return `$${perM.toFixed(digits)}`;
}

export function formatContext(len: number | null | undefined): string | null {
  if (!len || !Number.isFinite(len)) return null;
  return len >= 1000 ? `${Math.round(len / 1000)}K` : String(len);
}

// Input plus output price: what "cheapest first" sorts by. Unknown prices last.
function cost(m: OpenRouterModel): number {
  if (m.prompt_price == null || m.completion_price == null) return Number.POSITIVE_INFINITY;
  return m.prompt_price + m.completion_price;
}

// Speech-to-text models are priced by the minute of audio and chat models by
// the token, which cannot be compared: cheapest-first lists the per-minute
// ones first, by that price, then the rest by token price.
function compareByPrice(a: OpenRouterModel, b: OpenRouterModel): number {
  const am = a.audio_minute_price ?? null;
  const bm = b.audio_minute_price ?? null;
  if (am !== null && bm !== null) return am - bm || a.id.localeCompare(b.id);
  if (am !== null) return -1;
  if (bm !== null) return 1;
  return cost(a) - cost(b) || a.id.localeCompare(b.id);
}

interface ModelPickerProps {
  /** id of the text input, so the label and tests can find it. */
  id: string;
  label: string;
  value: string;
  onChange: (model: string) => void;
  catalog: ModelCatalogState;
  onRefresh: () => void;
  audioOnly?: boolean;
  placeholder?: string;
  /** Extra line under the field (for example what an empty value means). */
  hint?: string;
}

export function ModelPicker({
  id, label, value, onChange, catalog, onRefresh, audioOnly = false, placeholder, hint,
}: ModelPickerProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [sort, setSort] = useState<'name' | 'price'>('name');

  const pool = useMemo(
    // Voice notes: the dedicated speech-to-text models and the chat models
    // that accept audio. Text: everything that is a chat model.
    () => (audioOnly
      ? catalog.models.filter(m => m.transcription || m.audio_input)
      : catalog.models.filter(m => !m.transcription)),
    [catalog.models, audioOnly],
  );
  const matches = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const found = pool.filter((m) => {
      if (freeOnly && !m.free) return false;
      const text = `${m.id} ${m.name ?? ''}`.toLowerCase();
      return words.every(w => text.includes(w));
    });
    return sort === 'price' ? [...found].sort(compareByPrice) : found;
  }, [pool, search, freeOnly, sort]);

  function summary(m: OpenRouterModel): string {
    const parts: string[] = [];
    if (m.transcription) {
      parts.push(t('aiAssistantSettings.providers.openrouter.speechToText'));
      if (m.audio_minute_price != null) {
        const digits = m.audio_minute_price >= 0.01 ? 3 : 4;
        parts.push(t('aiAssistantSettings.providers.openrouter.perMinute', { price: `$${m.audio_minute_price.toFixed(digits)}` }));
      }
      return parts.join(' · ');
    }
    const ctx = formatContext(m.context_length);
    if (ctx) parts.push(t('aiAssistantSettings.providers.openrouter.context', { tokens: ctx }));
    if (m.free) {
      parts.push(t('aiAssistantSettings.providers.openrouter.free'));
    } else {
      const inPrice = pricePerMillion(m.prompt_price);
      const outPrice = pricePerMillion(m.completion_price);
      if (inPrice) parts.push(t('aiAssistantSettings.providers.openrouter.priceIn', { price: inPrice }));
      if (outPrice) parts.push(t('aiAssistantSettings.providers.openrouter.priceOut', { price: outPrice }));
    }
    return parts.join(' · ');
  }

  // The voice-note picker sits under the text-model picker of the same
  // provider and shares its list: the refresh button and the list's own
  // status (loading, failed, out of date) are shown once, by the one above.
  const primary = !audioOnly;
  // No usable list → the field is a plain text input.
  const canPick = pool.length > 0;
  const selected = canPick ? pool.find(m => m.id === value) : undefined;
  const statusId = `${id}-status`;

  return (
    <div style={sty.field}>
      <div style={sty.header}>
        <label htmlFor={id}>{label}</label>
        {primary && (
        <span style={sty.headerRight}>
          {catalog.cachedAt && (
            <span style={sty.hint}>
              {t('aiAssistantSettings.providers.openrouter.updated', { time: new Date(catalog.cachedAt).toLocaleTimeString() })}
            </span>
          )}
          <button type="button" style={sty.btnTiny} onClick={onRefresh} disabled={catalog.loading}>
            {catalog.loading
              ? t('aiAssistantSettings.providers.openrouter.refreshing')
              : t('aiAssistantSettings.providers.openrouter.refresh')}
          </button>
        </span>
        )}
      </div>

      <input
        id={id}
        style={sty.input}
        value={value}
        autoComplete="off"
        placeholder={placeholder}
        // The status lines below are the only place the picker explains
        // itself, so they are the field's accessible description.
        aria-describedby={statusId}
        onChange={e => onChange(e.target.value)}
      />

      {canPick && (
        <div style={sty.panel}>
          <div style={sty.filters}>
            <input
              style={{ ...sty.input, flex: 1, minWidth: 140 }}
              type="search"
              value={search}
              aria-label={t('aiAssistantSettings.providers.openrouter.search')}
              placeholder={t('aiAssistantSettings.providers.openrouter.search')}
              onChange={e => setSearch(e.target.value)}
            />
            <label style={sty.check}>
              <input type="checkbox" checked={freeOnly} onChange={e => setFreeOnly(e.target.checked)} />
              {t('aiAssistantSettings.providers.openrouter.freeOnly')}
            </label>
            <select
              style={sty.select}
              value={sort}
              aria-label={t('aiAssistantSettings.providers.openrouter.sort')}
              onChange={e => setSort(e.target.value === 'price' ? 'price' : 'name')}
            >
              <option value="name">{t('aiAssistantSettings.providers.openrouter.sortName')}</option>
              <option value="price">{t('aiAssistantSettings.providers.openrouter.sortPrice')}</option>
            </select>
          </div>
          <ul style={sty.list} role="listbox" aria-label={t('aiAssistantSettings.providers.openrouter.listLabel', { label })}>
            {matches.slice(0, MAX_ROWS).map((m) => {
              const active = m.id === value;
              return (
                <li key={m.id} role="option" aria-selected={active}>
                  <button
                    type="button"
                    style={{ ...sty.row, ...(active ? sty.rowActive : null) }}
                    onClick={() => onChange(m.id)}
                  >
                    <span style={sty.rowName}>{m.name ?? m.id}</span>
                    <span style={sty.rowMeta}>{m.id}{summary(m) ? ` · ${summary(m)}` : ''}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <span style={sty.hint}>
            {matches.length > MAX_ROWS
              ? t('aiAssistantSettings.providers.openrouter.showing', { shown: MAX_ROWS, total: matches.length })
              : t('aiAssistantSettings.providers.openrouter.matching', { count: matches.length, total: pool.length })}
          </span>
        </div>
      )}

      <span id={statusId} role="status" aria-live="polite">
        {hint && <span style={sty.hint}>{hint}</span>}
        {primary && catalog.loading && (
          <span style={sty.hint}>{t('aiAssistantSettings.providers.openrouter.loading')}</span>
        )}
        {primary && !!catalog.error && (
          <span style={sty.errorText}>
            {t('aiAssistantSettings.providers.openrouter.error', { error: catalog.error })}
          </span>
        )}
        {primary && catalog.loaded && !catalog.loading && !canPick && (
          <span style={sty.hint}>{t('aiAssistantSettings.providers.openrouter.fallback')}</span>
        )}
        {primary && canPick && catalog.stale && (
          <span style={sty.hint}>{t('aiAssistantSettings.providers.openrouter.stale')}</span>
        )}
        {selected && (
          <span style={sty.hint}>
            {selected.name ?? selected.id}{summary(selected) ? ` · ${summary(selected)}` : ''}
          </span>
        )}
        {canPick && !selected && value.trim() !== '' && (
          <span style={sty.hint}>{t('aiAssistantSettings.providers.openrouter.unknownModel')}</span>
        )}
      </span>
    </div>
  );
}

const sty: Record<string, React.CSSProperties> = {
  field: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.875rem', fontWeight: 500, color: 'var(--text-secondary)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 8 },
  input: { padding: '0.45rem 0.65rem', border: '1px solid var(--input-border)', borderRadius: 6, fontSize: '0.875rem', width: '100%', boxSizing: 'border-box', background: 'var(--input-bg)', color: 'var(--text-primary)' },
  select: { padding: '0.4rem 0.5rem', border: '1px solid var(--input-border)', borderRadius: 6, fontSize: '0.8rem', background: 'var(--input-bg)', color: 'var(--text-primary)' },
  panel: { display: 'flex', flexDirection: 'column', gap: 6, border: '1px solid var(--border)', borderRadius: 6, padding: 8, background: 'var(--bg-subtle)' },
  filters: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  check: { display: 'flex', alignItems: 'center', gap: 4, fontWeight: 400, fontSize: '0.8rem', whiteSpace: 'nowrap' },
  list: { listStyle: 'none', margin: 0, padding: 0, maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 },
  row: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, width: '100%', textAlign: 'left', padding: '5px 8px', border: '1px solid transparent', borderRadius: 4, background: 'var(--bg-card)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: '0.82rem' },
  rowActive: { borderColor: 'var(--accent)', background: 'var(--accent-soft)' },
  rowName: { fontWeight: 600 },
  rowMeta: { fontWeight: 400, fontSize: '0.74rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' },
  hint: { fontWeight: 400, color: 'var(--text-faint)', fontSize: '0.8rem', display: 'block' },
  errorText: { color: 'var(--danger)', fontSize: '0.85rem', display: 'block' },
  btnTiny: { padding: '0 6px', background: 'var(--bg-body)', color: 'var(--text-secondary)', border: '1px solid var(--border-strong)', borderRadius: 4, cursor: 'pointer', fontSize: '0.75rem', lineHeight: '1.6' },
};

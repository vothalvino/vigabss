// =============================================================================
// FE-07 — every t() key exists, and no page adds untranslated text
// =============================================================================
// The catalogue checks compared en/es/pt-BR with each other and reported 100%
// while 251 t() calls named keys en.json lacked (i18next shows the raw key in
// every locale) and the portal hard-coded English. These gates read the
// source: an unknown literal key fails, and a file may not add JSX text or
// visible attribute strings beyond scripts/i18n-literal-baseline.json.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { findMissingKeys, literalRegressions } from '../../scripts/i18n-usage.mjs';

describe('i18n — source usage', () => {
  it('every literal t() key exists in en.json or passes a default', () => {
    expect(findMissingKeys()).toEqual([]);
  });

  it('no file adds untranslated UI text beyond the baseline', async () => {
    // Translating a page lowers its count: update the baseline with
    // `npm run i18n:baseline` so the ratchet keeps the gain.
    expect(await literalRegressions()).toEqual([]);
  }, 60_000);
});

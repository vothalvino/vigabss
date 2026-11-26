// =============================================================================
// VigaBSS 5.0 — Vitest global test setup
// =============================================================================
import '@testing-library/jest-dom';
import { configure } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';
import i18n from '@/i18n';

// waitFor / findBy give up after one second by default. A page that loads part
// of itself lazily (the Markdown view, for one) can take longer than that when
// the machine is busy running other suites, which failed tests that were
// otherwise correct. A passing test still returns as soon as its condition
// holds; only a genuinely failing one waits the full five seconds.
configure({ asyncUtilTimeout: 5000 });

// Catalogues load on demand (FE-21); tests render with English loaded.
await i18n.changeLanguage('en');

expect.extend(toHaveNoViolations);

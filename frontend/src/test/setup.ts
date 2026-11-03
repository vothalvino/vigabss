// =============================================================================
// VigaBSS 5.0 — Vitest global test setup
// =============================================================================
import '@testing-library/jest-dom';
import { toHaveNoViolations } from 'jest-axe';
import i18n from '@/i18n';

// Catalogues load on demand (FE-21); tests render with English loaded.
await i18n.changeLanguage('en');

expect.extend(toHaveNoViolations);

// =============================================================================
// VigaBSS 5.0 — i18n (internationalisation) configuration
// =============================================================================
// Supported locales: en (default), es (Spanish MX), pt-BR (Portuguese BR).
// Language detection order: cookie → localStorage → browser language header.
// A language without a catalogue falls back to 'en'.
//
// Each catalogue is its own chunk, loaded when its language is first used
// (FE-21): all three (about 830 KB) used to ship in the main bundle. A
// supported language loads only itself; the catalogues are kept complete by
// `pnpm run i18n:check`, so it needs no English fallback. Components suspend
// until the active catalogue has arrived (react-i18next's default), inside
// the app's Suspense boundaries.
// =============================================================================

import i18n, { type BackendModule } from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

export const SUPPORTED_LANGUAGES = ['en', 'es', 'pt-BR'] as const;

type Catalogue = { default: Record<string, unknown> };
const loaders: Record<string, () => Promise<Catalogue>> = {
  en: () => import('./locales/en.json'),
  es: () => import('./locales/es.json'),
  'pt-BR': () => import('./locales/pt-BR.json'),
};

const lazyCatalogues: BackendModule = {
  type: 'backend',
  init: () => {},
  read(language, _namespace, callback) {
    (loaders[language] ?? loaders.en)().then(
      (module) => callback(null, module.default),
      (err: Error) => callback(err, false),
    );
  },
};

const isSupported = (code: string) => (SUPPORTED_LANGUAGES as readonly string[]).includes(code)
  || (SUPPORTED_LANGUAGES as readonly string[]).includes(code.split('-')[0]);

i18n
  .use(lazyCatalogues)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // English only for a language without its own catalogue.
    fallbackLng: (code: string) => (code && isSupported(code) ? [] : ['en']),
    supportedLngs: [...SUPPORTED_LANGUAGES],
    load: 'currentOnly',
    interpolation: {
      // React already escapes values
      escapeValue: false,
    },
    detection: {
      order: ['cookie', 'localStorage', 'navigator'],
      caches: ['cookie', 'localStorage'],
      cookieMinutes: 525600, // 1 year
    },
  });

export default i18n;

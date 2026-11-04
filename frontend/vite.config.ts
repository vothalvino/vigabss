import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'url';
import { readFileSync } from 'node:fs';
import { type UserConfig } from 'vitest/config';

const packageMetadata = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.VITE_API_URL || 'http://localhost:3000';

  return {
    plugins: [react()],
    define: {
      __VIGABSS_VERSION__: JSON.stringify(packageMetadata.version),
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // Dev proxy — forwards /api and /healthz to the Express backend
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/healthz': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/health': {
          target: apiTarget,
          changeOrigin: true,
        },
        '/ws': {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      // Built for debugging but never published: no sourceMappingURL, and
      // scripts/postbuild.mjs moves the maps out of dist/ (FE-21).
      sourcemap: 'hidden',
      // Read by scripts/postbuild.mjs for the initial-bundle budget.
      manifest: true,
      // The production CSP deliberately keeps font-src at 'self'.  Vite's
      // default 4 KiB threshold turns small @fontsource subsets into data:
      // URLs, which the browser then (correctly) blocks.  Emit every asset as
      // a same-origin file instead.
      assetsInlineLimit: 0,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      // A Mexican zone, where a UTC-midnight DATE read as local time is the
      // previous day (FE-24); CI runners are UTC, which hid that bug class.
      env: { TZ: 'America/Mexico_City' },
      coverage: {
        provider: 'v8',
        include: ['src/pages/**/*.tsx', 'src/auth/**/*.tsx'],
        // Enforced in CI from FE-24. The 60 written here before never ran
        // (the coverage command crashed in test-exclude, and CI ran plain
        // `test`); measured coverage was 57.4%, so the floor starts there.
        thresholds: { lines: 57 },
      },
    } as UserConfig['test'],
  };
});

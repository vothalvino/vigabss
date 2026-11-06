import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Self-hosted fonts (design system: Inter for UI, JetBrains Mono for data)
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './index.css';
import './i18n';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { reloadOnce } from './utils/staleChunkReload';

// Vite fires this when a lazy page's chunk or CSS from an earlier deploy fails
// to load; reload into the new build rather than failing the navigation.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadOnce()) event.preventDefault();
});

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

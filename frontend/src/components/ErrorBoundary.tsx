// =============================================================================
// ErrorBoundary — a render error shows a message instead of a blank app
// =============================================================================
// There was no error boundary anywhere, so one page throwing while rendering
// (FE2-01: a list route without `meta`, a `{ data }` envelope read as the
// payload) made React unmount the whole root: sidebar, top bar and all.
// Layout wraps each page in one keyed by the path, so navigating away clears
// the error; main.tsx wraps the app as a last resort.
// =============================================================================

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

function Fallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" style={{ padding: '2rem', maxWidth: 560 }}>
      <h2 style={{ margin: '0 0 0.5rem', fontSize: '1.1rem' }}>{t('errorBoundary.title')}</h2>
      <p style={{ margin: '0 0 1rem', color: 'var(--text-muted, #6b7280)' }}>{t('errorBoundary.body')}</p>
      <button type="button" onClick={onRetry}>{t('errorBoundary.retry')}</button>
    </div>
  );
}

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Render error caught by ErrorBoundary', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) return <Fallback onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}

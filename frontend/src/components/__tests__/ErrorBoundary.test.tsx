// FE2-12 — a page that throws while rendering shows a fallback inside the
// shell instead of unmounting the app; the subscriber portal does the same.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary';

function Boom({ explode }: { explode: boolean }) {
  if (explode) throw new Error('render failure');
  return <p>page content</p>;
}

describe('ErrorBoundary', () => {
  it('catches a render error and keeps siblings mounted', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <div>
        <nav>shell</nav>
        <ErrorBoundary><Boom explode /></ErrorBoundary>
      </div>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('shell')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(2); // retry and reload
    spy.mockRestore();
  });

  it('retry re-renders the children', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let explode = true;
    function Toggle() { return <Boom explode={explode} />; }
    render(<ErrorBoundary><Toggle /></ErrorBoundary>);
    explode = false;
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.getByText('page content')).toBeTruthy();
    spy.mockRestore();
  });

  it.each(['Layout.tsx', 'PortalLayout.tsx'])('%s wraps its routed outlet in a boundary keyed by path', (file) => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    expect(src).toMatch(/<ErrorBoundary key=\{location\.pathname\}>\s*<Outlet \/>\s*<\/ErrorBoundary>/);
  });
});

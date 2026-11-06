import { describe, expect, it, vi } from 'vitest';
import { isStaleChunkError, reloadOnce } from '../staleChunkReload';

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe('staleChunkReload', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://x/assets/PaymentList-abc.js',
    'error loading dynamically imported module',
    'Importing a module script failed.',
    'Unable to preload CSS for /assets/PaymentList-abc.css',
  ])('recognizes a stale chunk: %s', (msg) => {
    expect(isStaleChunkError(new Error(msg))).toBe(true);
  });

  it('ignores ordinary render errors', () => {
    expect(isStaleChunkError(new Error("Cannot read properties of undefined (reading 'map')"))).toBe(false);
  });

  it('reloads once, then not again within a minute', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    let t = 1_000_000;
    const now = () => t;
    expect(reloadOnce({ storage, reload, now })).toBe(true);
    t += 30_000;
    expect(reloadOnce({ storage, reload, now })).toBe(false);
    t += 31_000;
    expect(reloadOnce({ storage, reload, now })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload without storage for the guard', () => {
    const reload = vi.fn();
    const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => undefined };
    expect(reloadOnce({ storage, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

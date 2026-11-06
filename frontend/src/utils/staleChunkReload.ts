// =============================================================================
// Reload once when a page's code belongs to an earlier deploy
// =============================================================================
// Routes are lazy chunks with content-hashed names. A tab opened before a
// deploy still asks for the old names, the server answers 404, and the page
// failed to load until someone reloaded by hand. One full reload fetches the
// new index.html and its chunks. The timestamp guard stops a reload loop when
// the reload does not help (a real outage, not a stale tab).
// =============================================================================

const KEY = 'vigabss.staleChunkReloadAt';
const WINDOW_MS = 60_000;

// Chrome, Firefox and Safari word the failed dynamic import differently;
// Vite's preload helper adds the CSS case.
const STALE_CHUNK = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

export function isStaleChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return STALE_CHUNK.test(message);
}

interface ReloadDeps {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  reload?: () => void;
  now?: () => number;
}

/** Reloads the page unless it already did so in the last minute. Returns whether it reloaded. */
export function reloadOnce({
  storage = window.sessionStorage,
  reload = () => window.location.reload(),
  now = Date.now,
}: ReloadDeps = {}): boolean {
  try {
    const last = Number(storage.getItem(KEY) || 0);
    if (last && now() - last < WINDOW_MS) return false;
    storage.setItem(KEY, String(now()));
  } catch {
    // No sessionStorage (private mode, blocked): without the guard a reload
    // could loop, so leave the error on screen with its Reload button.
    return false;
  }
  reload();
  return true;
}

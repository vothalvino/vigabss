// =============================================================================
// VigaBSS 5.0 — WebSocket size and pre-auth connection limits (SEC-16)
// =============================================================================
// Both WebSocket servers (the browser hub and the FireRelay agent tunnel) were
// created without maxPayload, so ws's 100 MiB default applied, and an
// unauthenticated socket's first message was buffered, stringified and
// JSON-parsed in full before any auth decision. Nothing capped how many
// sockets could sit unauthenticated either.
//
// maxPayload bounds every frame (ws closes the socket with 1009 above it). A
// message that arrives before authentication must also fit PRE_AUTH_MAX_BYTES
// — an auth message is a few hundred bytes. PendingSockets caps how many
// unauthenticated sockets one IP, and the whole server, may hold at once.
// =============================================================================

const PRE_AUTH_MAX_BYTES = 4 * 1024;
const PENDING_PER_IP = 20;
const PENDING_TOTAL = 1000;

function byteLength(raw) {
  if (Buffer.isBuffer(raw)) return raw.length;
  if (Array.isArray(raw)) return raw.reduce((n, b) => n + b.length, 0);
  if (raw instanceof ArrayBuffer) return raw.byteLength;
  return Buffer.byteLength(String(raw));
}

/** True (and the socket closed) when a pre-auth message is too large. */
function rejectOversizedPreAuth(ws, raw) {
  if (byteLength(raw) <= PRE_AUTH_MAX_BYTES) return false;
  ws.close(1009, 'Message too large');
  return true;
}

class PendingSockets {
  constructor({ perIp = PENDING_PER_IP, total = PENDING_TOTAL } = {}) {
    this.perIp = perIp;
    this.total = total;
    this._byIp = new Map();
    this._count = 0;
  }

  /**
   * Admit an unauthenticated socket. Returns a release() to call once it
   * authenticates or closes (idempotent), or null when a cap is reached.
   */
  admit(ip) {
    const key = ip || 'unknown';
    const n = this._byIp.get(key) || 0;
    if (n >= this.perIp || this._count >= this.total) return null;
    this._byIp.set(key, n + 1);
    this._count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this._byIp.get(key) || 1) - 1;
      if (left <= 0) this._byIp.delete(key); else this._byIp.set(key, left);
      this._count -= 1;
    };
  }
}

module.exports = { PRE_AUTH_MAX_BYTES, PENDING_PER_IP, PENDING_TOTAL, rejectOversizedPreAuth, PendingSockets };

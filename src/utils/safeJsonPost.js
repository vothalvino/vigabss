// =============================================================================
// VigaBSS 5.0 — DNS-pinned outbound JSON POST for tenant-configured endpoints
// =============================================================================
// AI providers of kind `custom` and `ollama` take a tenant-chosen endpoint_url,
// and the adapters fetch()ed it: any host, any address, redirects followed, and
// the upstream body copied into the error a tenant admin sees — a readable
// SSRF through POST /ai/providers/:id/verify (ASY-11). Unlike safeHttpsPost
// (webhooks), an LLM call needs the response body, so this reads it, bounded.
//
//   - By default the URL must be https and resolve only to public addresses;
//     the connection is pinned to those addresses and the connected peer is
//     checked again.
//   - An install operator can permit specific hosts, e.g. a LAN Ollama, with
//     AI_PROVIDER_ALLOWED_HOSTS ("host" or "host:port", comma-separated).
//     Those may use http and private addresses; they are still pinned.
//   - Redirects are never followed: a 3xx is returned as the status.
//   - The response is capped; callers must not echo it to the client.
// =============================================================================

const http = require('http');
const https = require('https');
const { AppError } = require('./errors');
const {
  resolveSafeOutboundUrl,
  resolveTrustedOutboundHost,
  isBlockedIp,
} = require('./safeOutboundUrl');

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Hosts the install operator allows outside the public-HTTPS rule. */
function allowedHosts() {
  return String(process.env.AI_PROVIDER_ALLOWED_HOSTS || '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
}

function isOperatorAllowed(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return allowedHosts().some(entry => entry === host || entry === `${host}:${port}`);
}

function parseUrl(raw, field) {
  try {
    return new URL(String(raw).trim());
  } catch (_err) {
    throw new AppError(`${field} is not a valid URL.`, 422, 'UNSAFE_URL');
  }
}

/**
 * Resolve and pin a tenant-supplied endpoint. Throws a 422 AppError when it is
 * not allowed.
 * @returns {Promise<{ url: URL, lookup: Function, trusted: boolean }>}
 */
async function resolveEndpoint(raw, field = 'endpoint_url', options = {}) {
  const url = parseUrl(raw, field);
  if (isOperatorAllowed(url)) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new AppError(`${field} must use http or https.`, 422, 'UNSAFE_URL');
    }
    if (url.username || url.password) {
      throw new AppError(`${field} must not include credentials.`, 422, 'UNSAFE_URL');
    }
    const resolved = await resolveTrustedOutboundHost(url.hostname.replace(/^\[|\]$/g, ''), field, options);
    return { url, lookup: resolved.lookup, trusted: true };
  }
  const resolved = await resolveSafeOutboundUrl(url.toString(), field, options);
  return { url: resolved.url, lookup: resolved.lookup, trusted: false };
}

/** Write-time check for an endpoint_url; resolves without returning anything. */
async function assertAllowedEndpoint(raw, field = 'endpoint_url') {
  await resolveEndpoint(raw, field, { timeoutMs: 5000 });
}

function timeoutError() {
  return Object.assign(new Error('Outbound request timed out'), { code: 'ETIMEDOUT' });
}

/**
 * POST a JSON body and return { status, ok, text }.
 * @param {string} rawUrl
 * @param {object} payload
 * @param {object} [headers]
 * @param {{ timeoutMs?: number, signal?: AbortSignal, field?: string, maxBytes?: number }} [options]
 */
async function safeJsonPost(rawUrl, payload, headers = {}, options = {}) {
  const field = options.field || 'endpoint_url';
  const timeoutMs = Math.max(1, Math.min(120000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const maxBytes = options.maxBytes || MAX_RESPONSE_BYTES;
  const start = Date.now();
  const { url, lookup, trusted } = await resolveEndpoint(rawUrl, field, { timeoutMs, timeoutCode: 'ETIMEDOUT' });
  const remainingMs = timeoutMs - (Date.now() - start);
  if (remainingMs <= 0) throw timeoutError();
  const body = JSON.stringify(payload);
  const transport = url.protocol === 'http:' ? http : https;
  if (options.signal?.aborted) throw Object.assign(new Error('Outbound request aborted'), { name: 'AbortError' });

  return new Promise((resolve, reject) => {
    let settled = false;
    const pending = { req: null };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const fail = (err) => {
      finish(reject, err);
      if (pending.req) pending.req.destroy();
    };
    const onAbort = () => fail(Object.assign(new Error('Outbound request aborted'), { name: 'AbortError' }));
    const timer = setTimeout(() => fail(timeoutError()), remainingMs);
    if (typeof timer.unref === 'function') timer.unref();
    if (options.signal) options.signal.addEventListener('abort', onAbort);

    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers, 'Content-Length': Buffer.byteLength(body) },
      lookup,
      agent: false,
    }, (res) => {
      const peer = res.socket?.remoteAddress;
      if (!trusted && (!peer || isBlockedIp(peer))) {
        fail(new AppError(`${field} connected to a non-public address.`, 422, 'UNSAFE_URL'));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          fail(Object.assign(new Error(`Response exceeded ${maxBytes} bytes`), { code: 'RESPONSE_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const status = Number(res.statusCode);
        finish(resolve, { status, ok: status >= 200 && status < 300, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', fail);
    });
    pending.req = req;
    req.on('error', fail);
    req.end(body);
  });
}

module.exports = { safeJsonPost, assertAllowedEndpoint, MAX_RESPONSE_BYTES };

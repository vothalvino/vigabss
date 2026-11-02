// =============================================================================
// VigaBSS 5.0 — Cloud Storage Service (S3-compatible)
// =============================================================================
// Uploads files to any S3-compatible object store using AWS Signature
// Version 4 and Node.js built-in modules only: AWS S3, Google Cloud Storage
// (XML interoperability API + HMAC keys), Backblaze B2, Cloudflare R2, or a
// self-hosted MinIO server.
//
// The remote target is resolved by the caller (see
// backupSettingsService.getEffectiveRemoteConfig(): UI-saved settings first,
// BACKUP_S3_* env vars as fallback) and passed in as a config object. When no
// config is passed, the env vars are read directly — the pre-migration-404
// behavior, kept for compatibility:
//   BACKUP_S3_BUCKET      — Target bucket name
//   BACKUP_S3_REGION      — AWS region (e.g. us-east-1) or B2 region (e.g. us-west-002)
//   BACKUP_S3_ACCESS_KEY  — Access key ID (AWS) / Application Key ID (B2) / HMAC key (GCS)
//   BACKUP_S3_SECRET_KEY  — Secret access key / Application Key / HMAC secret
//   BACKUP_S3_ENDPOINT    — Optional: override endpoint for B2/R2/GCS/MinIO
//                           (e.g. https://s3.us-west-002.backblazeb2.com)
//   BACKUP_S3_PREFIX      — Optional: key prefix / folder (default: "db-backups/")
// =============================================================================

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const logger = require('../utils/logger').child({ service: 'cloudStorage' });

// ---------------------------------------------------------------------------
// AWS Signature Version 4 helpers
// ---------------------------------------------------------------------------

function hmac(key, data, encoding) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest(encoding);
}

function hash(data, encoding) {
  return crypto.createHash('sha256').update(data).digest(encoding);
}

/**
 * Derive the SigV4 signing key.
 */
function getSigningKey(secretKey, dateStamp, region, service) {
  const kDate = hmac('AWS4' + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  return kSigning;
}

/**
 * Build the SigV4 Authorization header for an S3 request.
 *
 * @param {object} opts
 * @param {string} opts.method       — HTTP method (PUT / DELETE / HEAD)
 * @param {string} opts.path         — URL path (e.g. "/bucket/backups/file.sql.gz")
 * @param {string} [opts.query]      — Canonical query string (sorted, encoded)
 * @param {string} opts.region       — AWS region
 * @param {string} opts.accessKey    — Access key ID
 * @param {string} opts.secretKey    — Secret access key
 * @param {string} opts.payloadHash  — SHA-256 hex of the request body
 * @param {string} opts.dateISO      — ISO-8601 date/time (yyyymmddTHHMMSSZ)
 * @param {string} opts.dateStamp    — Date stamp (yyyymmdd)
 * @param {object} opts.headers      — Headers to sign, EXACT values as sent
 *                                     (lowercase names; must include host)
 * @returns {string} the Authorization header value
 */
function buildAuthorizationHeader(opts) {
  const { method, path: urlPath, query = '', region, accessKey, secretKey, payloadHash, dateISO, dateStamp, headers } = opts;

  const service = 's3';
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const canonicalHeaders = names.map(n => `${n}:${String(headers[n]).trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method,
    urlPath,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    dateISO,
    credentialScope,
    hash(canonicalRequest, 'hex'),
  ].join('\n');

  const signingKey = getSigningKey(secretKey, dateStamp, region, service);
  const signature = hmac(signingKey, stringToSign, 'hex');

  return [
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');
}

// ---------------------------------------------------------------------------
// Config + endpoint resolution
// ---------------------------------------------------------------------------

/**
 * Returns true when all required cloud storage env vars are present.
 */
function isConfigured() {
  return Boolean(
    process.env.BACKUP_S3_BUCKET &&
    process.env.BACKUP_S3_REGION &&
    process.env.BACKUP_S3_ACCESS_KEY &&
    process.env.BACKUP_S3_SECRET_KEY,
  );
}

/**
 * Read the BACKUP_S3_* env vars into a config object, or null when unset.
 */
function resolveEnvConfig() {
  if (!isConfigured()) return null;
  return {
    bucket: process.env.BACKUP_S3_BUCKET,
    region: process.env.BACKUP_S3_REGION,
    accessKey: process.env.BACKUP_S3_ACCESS_KEY,
    secretKey: process.env.BACKUP_S3_SECRET_KEY,
    endpoint: process.env.BACKUP_S3_ENDPOINT || null,
    prefix: process.env.BACKUP_S3_PREFIX !== undefined ? process.env.BACKUP_S3_PREFIX : 'db-backups/',
    source: 'env',
  };
}

/**
 * Resolve host + base URL + base path for a config. Path-style addressing
 * throughout — required by MinIO without wildcard DNS, accepted by every
 * other provider. `basePath` carries any path component of a custom endpoint
 * (e.g. a reverse-proxied MinIO at https://host/minio) so the SIGNED path and
 * the SENT path always agree.
 */
function resolveTarget(config) {
  if (config.endpoint) {
    const u = new URL(config.endpoint);
    const basePath = u.pathname.replace(/\/+$/, '');
    return { host: u.host, origin: u.origin, endpointBase: `${u.origin}${basePath}`, basePath };
  }
  const host = `s3.${config.region}.amazonaws.com`;
  const origin = `https://${host}`;
  return { host, origin, endpointBase: origin, basePath: '' };
}

/**
 * AWS UriEncode of one path segment: like encodeURIComponent, but also
 * percent-encodes ! ' ( ) * — S3 canonicalizes those, and a mismatch means
 * SignatureDoesNotMatch for perfectly legal object keys.
 */
function uriEncodeSegment(segment) {
  return encodeURIComponent(segment)
    .replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function objectPath(config, objectKey) {
  // Encode per segment, keeping literal slashes so S3 treats the key as a
  // path (prefix/filename) rather than a single URL-encoded segment.
  const encodedKey = String(objectKey).split('/').map(uriEncodeSegment).join('/');
  return `/${config.bucket}/${encodedKey}`;
}

/**
 * The object-key prefix for a config: '' stays '' (bucket root); anything
 * else is guaranteed to end in exactly one '/'. A prefix saved without the
 * trailing slash must become a folder, not a filename prefix glued onto the
 * backup name.
 */
function normalizedPrefix(config) {
  const prefix = config.prefix ?? 'db-backups/';
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

// ---------------------------------------------------------------------------
// Signed requests
// ---------------------------------------------------------------------------

// ASY-30: a stalled endpoint used to leave the request pending forever. The
// backup run never finished, its in-process guard stayed set, and every later
// backup failed with 'already in progress' until a restart. Every request now
// fails after REQUEST_IDLE_MS without socket activity or REQUEST_DEADLINE_MS
// in total.
function timeoutMs(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
const REQUEST_IDLE_MS = () => timeoutMs('BACKUP_S3_IDLE_TIMEOUT_MS', 60 * 1000);
const REQUEST_DEADLINE_MS = () => timeoutMs('BACKUP_S3_REQUEST_TIMEOUT_MS', 15 * 60 * 1000);

/** Canonical SigV4 query string: keys sorted, keys and values URI-encoded. */
function canonicalQuery(query) {
  return Object.keys(query).sort()
    .map(key => `${uriEncodeSegment(key)}=${uriEncodeSegment(String(query[key] ?? ''))}`)
    .join('&');
}

/**
 * Perform a signed S3 request with an optional buffer body.
 * Resolves {statusCode, headers, body}; rejects on transport errors and on
 * the idle or total timeout.
 */
function signedRequest(config, method, objectKey, body, contentType, query = {}) {
  const { host, origin, basePath } = resolveTarget(config);
  // The signed path includes any endpoint base path, and the request URL is
  // origin + this exact path — signed and sent always match.
  const urlPath = `${basePath}${objectPath(config, objectKey)}`;
  const queryString = canonicalQuery(query);
  const payloadHash = hash(body || '', 'hex');

  const now = new Date();
  const dateISO = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const dateStamp = dateISO.slice(0, 8);

  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': dateISO,
  };
  if (body) {
    headers['content-length'] = body.length;
    headers['content-type'] = contentType || 'application/octet-stream';
  }

  const authorization = buildAuthorizationHeader({
    method,
    path: urlPath,
    query: queryString,
    region: config.region,
    accessKey: config.accessKey,
    secretKey: config.secretKey,
    payloadHash,
    dateISO,
    dateStamp,
    headers,
  });

  const parsedUrl = new URL(`${origin}${urlPath}`);
  const requestOptions = {
    method,
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + (queryString ? `?${queryString}` : ''),
    headers: { ...headers, Authorization: authorization },
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const req = transport.request(requestOptions, (res) => {
      let responseBody = '';
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => settle(resolve, { statusCode: res.statusCode, headers: res.headers || {}, body: responseBody }));
      res.on('error', err => settle(reject, err));
    });
    const abort = (message) => {
      const err = Object.assign(new Error(message), { code: 'ETIMEDOUT' });
      settle(reject, err);
      req.destroy(err);
    };
    const idleMs = REQUEST_IDLE_MS();
    const deadlineMs = REQUEST_DEADLINE_MS();
    req.setTimeout(idleMs, () => abort(`Cloud request stalled: no response activity for ${Math.round(idleMs / 1000)}s`));
    deadline = setTimeout(() => abort(`Cloud request timed out after ${Math.round(deadlineMs / 1000)}s`), deadlineMs);
    deadline.unref?.();
    req.on('error', err => settle(reject, err));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Build the client-facing error for a failed S3 request. The raw response
 * body is NEVER included — these messages end up in last_test_error /
 * backup_runs.error_message, i.e. in HTTP responses and the UI, and the
 * endpoint is admin-supplied (reflecting an arbitrary host's response body
 * would turn the accepted blind-SSRF into a readable one). Only the S3
 * error <Code> token (a bare word like AccessDenied / NoSuchBucket) is
 * surfaced; the full body goes to the server log.
 */
function remoteError(kind, res) {
  logger.warn({ kind, statusCode: res.statusCode, body: String(res.body).slice(0, 500) }, 'S3 request failed');
  const code = /<Code>([A-Za-z0-9]{1,64})<\/Code>/.exec(String(res.body));
  return new Error(`Cloud ${kind} failed: HTTP ${res.statusCode}${code ? ` (${code[1]})` : ''}`);
}

/**
 * Upload a buffer to the bucket. Throws on any non-2xx response.
 * @returns {Promise<string>} — the object URL.
 */
async function uploadObject(config, objectKey, body, contentType) {
  const { endpointBase } = resolveTarget(config);
  const res = await signedRequest(config, 'PUT', objectKey, body, contentType);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw remoteError('upload', res);
  }
  return `${endpointBase}/${config.bucket}/${objectKey}`;
}

/**
 * Delete an object. 404 is treated as success (already gone).
 */
async function deleteObject(config, objectKey) {
  const res = await signedRequest(config, 'DELETE', objectKey, null, null);
  if (res.statusCode !== 404 && (res.statusCode < 200 || res.statusCode >= 300)) {
    throw remoteError('delete', res);
  }
}

// S3 parts are 5 MiB to 5 GiB, at most 10,000 per upload: 16 MiB parts cover
// dumps up to about 160 GB while holding one part in memory at a time.
const PART_SIZE = 16 * 1024 * 1024;

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Upload a file larger than one part with S3 multipart upload, reading one
 * part at a time instead of loading the whole dump into the API process
 * (a single PUT is also capped at 5 GiB). A failed upload is aborted so the
 * bucket keeps no orphaned parts.
 */
async function uploadFileMultipart(config, objectKey, localPath, size, partSize) {
  const created = await signedRequest(config, 'POST', objectKey, null, null, { uploads: '' });
  if (created.statusCode < 200 || created.statusCode >= 300) throw remoteError('upload', created);
  const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(String(created.body))?.[1];
  if (!uploadId) throw new Error('Cloud upload failed: the endpoint returned no UploadId');

  const handle = await fs.promises.open(localPath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(partSize, size));
    const parts = [];
    for (let offset = 0, partNumber = 1; offset < size; offset += partSize, partNumber += 1) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(partSize, size - offset), offset);
      const res = await signedRequest(config, 'PUT', objectKey, buffer.subarray(0, bytesRead),
        'application/octet-stream', { partNumber, uploadId });
      if (res.statusCode < 200 || res.statusCode >= 300) throw remoteError('upload', res);
      if (!res.headers.etag) throw new Error(`Cloud upload failed: part ${partNumber} returned no ETag`);
      parts.push(`<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXml(res.headers.etag)}</ETag></Part>`);
    }
    const manifest = Buffer.from(`<CompleteMultipartUpload>${parts.join('')}</CompleteMultipartUpload>`, 'utf8');
    const completed = await signedRequest(config, 'POST', objectKey, manifest, 'application/xml', { uploadId });
    // S3 can answer 200 and still report the failure in an <Error> body.
    if (completed.statusCode < 200 || completed.statusCode >= 300 || /<Error>/.test(String(completed.body))) {
      throw remoteError('upload', completed);
    }
  } catch (err) {
    try {
      await signedRequest(config, 'DELETE', objectKey, null, null, { uploadId });
    } catch (abortErr) {
      logger.warn({ err: abortErr, objectKey }, 'Could not abort the failed multipart upload; a bucket lifecycle rule removes leftover parts');
    }
    throw err;
  } finally {
    await handle.close();
  }
}

/**
 * Upload a local backup file to the configured bucket.
 *
 * @param {string} localPath  — Absolute path to the file to upload.
 * @param {string} [filename] — Destination filename inside the bucket prefix.
 *                             Defaults to the basename of localPath.
 * @param {object} [config]   — Remote config (from
 *                             backupSettingsService.getEffectiveRemoteConfig()).
 *                             Defaults to the BACKUP_S3_* env vars.
 * @param {object} [options]
 * @param {number} [options.partSize] — Multipart part size (tests use a small one).
 * @returns {Promise<string>} — The URL of the uploaded object.
 */
async function uploadBackup(localPath, filename, config, { partSize = PART_SIZE } = {}) {
  const effective = config || resolveEnvConfig();
  if (!effective) {
    throw new Error(
      'Cloud storage is not configured. Save remote backup settings in the UI or set ' +
      'BACKUP_S3_BUCKET, BACKUP_S3_REGION, BACKUP_S3_ACCESS_KEY, and BACKUP_S3_SECRET_KEY.',
    );
  }

  const destFilename = filename || path.basename(localPath);
  const objectKey = `${normalizedPrefix(effective)}${destFilename}`;
  const { size } = await fs.promises.stat(localPath);

  logger.info(
    { bucket: effective.bucket, objectKey, source: effective.source, sizeKB: (size / 1024).toFixed(1) },
    'Uploading backup to cloud',
  );
  let url;
  if (size > partSize) {
    await uploadFileMultipart(effective, objectKey, localPath, size, partSize);
    url = `${resolveTarget(effective).endpointBase}/${effective.bucket}/${objectKey}`;
  } else {
    url = await uploadObject(effective, objectKey, await fs.promises.readFile(localPath), 'application/gzip');
  }
  logger.info({ bucket: effective.bucket, objectKey }, 'Backup uploaded to cloud');
  return url;
}

module.exports = {
  uploadBackup, uploadObject, deleteObject, isConfigured, resolveEnvConfig, normalizedPrefix, PART_SIZE,
};

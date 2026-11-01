// =============================================================================
// Map tile origins allowed by the CSP img-src (FE-11)
// =============================================================================
// Leaflet loads map tiles as cross-origin <img> elements from the configured
// tile server (settings.map_tile_url, OpenStreetMap by default), and the CSP
// allowed images only from 'self' and data:, so every map was grey in
// production (the Vite dev server sends no CSP). The tile server's origin is
// read from settings at startup and every minute, and again when saved.
// =============================================================================

const db = require('../config/database');
const logger = require('./logger');

const DEFAULT_ORIGINS = ['https://*.tile.openstreetmap.org'];
const REFRESH_MS = 60_000;
let origins = DEFAULT_ORIGINS;
let timer = null;

/**
 * The CSP source for a Leaflet URL template such as
 * https://{s}.tile.example.com/{z}/{x}/{y}.png → https://*.tile.example.com.
 * Returns null for anything that is not a plain http(s) URL.
 */
function tileOrigin(template) {
  const raw = String(template || '').trim();
  const m = raw.match(/^(https?):\/\/([^/?#]+)/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  let host = m[2].toLowerCase();
  if (host.includes('@')) return null;
  // A subdomain placeholder becomes a wildcard label; other placeholders in
  // the host cannot be expressed as a CSP source.
  host = host.replace(/^\{[a-z]+\}\./, '*.');
  if (/[{}\s'";,]/.test(host)) return null;
  return `${scheme}://${host}`;
}

/** Image origins for the CSP (synchronous: the CSP runs on every response). */
function mapTileOrigins() {
  return origins;
}

/** Re-read settings.map_tile_url. Called at startup, every minute and on save. */
async function loadMapTileOrigins() {
  try {
    const [rows] = await db.query("SELECT setting_value FROM settings WHERE setting_key = 'map_tile_url' LIMIT 1");
    const configured = tileOrigin(rows?.[0]?.setting_value);
    origins = configured && !DEFAULT_ORIGINS.includes(configured) ? [...DEFAULT_ORIGINS, configured] : DEFAULT_ORIGINS;
  } catch (err) {
    logger.warn({ err: err.message }, 'mapTileOrigins: could not read map_tile_url; keeping the current tile origins');
  }
  return origins;
}

/** Keep the origins current on every replica (another may have saved it). */
function startMapTileOriginRefresh() {
  if (timer) return;
  loadMapTileOrigins();
  timer = setInterval(loadMapTileOrigins, REFRESH_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

function stopMapTileOriginRefresh() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  mapTileOrigins, loadMapTileOrigins, startMapTileOriginRefresh, stopMapTileOriginRefresh, tileOrigin, DEFAULT_ORIGINS,
};

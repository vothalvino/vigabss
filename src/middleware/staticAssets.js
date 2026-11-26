'use strict';

// =============================================================================
// The built SPA (FE-21)
// =============================================================================
// /assets/* files carry a content hash in their name, so they are cached for a
// year as immutable; index.html is revalidated on every load so a deploy is
// picked up at once. frontend/scripts/postbuild.mjs writes a .gz beside each
// text asset, served here to browsers that accept gzip: Express does not
// compress, and neither do the host-nginx and Kubernetes topologies.
//
// A missing /assets file is a 404, never the SPA's index.html. A tab still
// running the previous deploy asks for its old chunk names; answering those
// with HTML (200, and with the year-long immutable header already set) made
// the page's module import fail, and let a browser cache HTML under a script
// URL for a year. The frontend reloads once on that 404 to pick up the new
// build.
// =============================================================================

const fs = require('fs');
const path = require('path');
const express = require('express');

const YEAR = 'public, max-age=31536000, immutable';
const NO_STORE = 'no-store';

/**
 * @param {string} distDir - frontend/dist
 * @returns {{ assets: import('express').RequestHandler, spa: import('express').RequestHandler, portalPage: import('express').RequestHandler }}
 *   `assets` is mounted at /assets (before `spa`).
 */
function staticAssets(distDir) {
  const assetsDir = path.join(distDir, 'assets');

  const precompressed = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!/\bgzip\b/.test(req.get('accept-encoding') || '')) return next();
    let file;
    try {
      file = path.join(assetsDir, decodeURIComponent(req.path));
    } catch {
      return next();
    }
    // Only files inside assets/, never a traversal out of it.
    if (!file.startsWith(assetsDir + path.sep)) return next();
    const gz = `${file}.gz`;
    if (!fs.existsSync(gz)) return next();
    res.setHeader('Cache-Control', YEAR);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.type(path.extname(file));
    return res.sendFile(gz);
  };

  const spa = express.static(distDir, {
    setHeaders: (res, file) => {
      if (path.basename(file) === 'index.html') res.setHeader('Cache-Control', 'no-cache');
    },
  });

  const plain = express.static(assetsDir, {
    index: false,
    setHeaders: (res) => res.setHeader('Cache-Control', YEAR),
  });

  const missing = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.setHeader('Cache-Control', NO_STORE);
    return res.status(404).type('text/plain').send('Not found');
  };

  // The first paint of the pages a company's customers open (the client
  // portal and the contract signing link): the same page with a neutral head.
  // The app replaces the title and icon with the company's once it has
  // loaded; until then a customer's browser tab must not show the software's
  // name, version or logo.
  const portalPage = (req, res, next) => {
    fs.readFile(path.join(distDir, 'index.html'), 'utf8', (err, html) => {
      if (err) return next();
      // The signing page has already been marked no-store; keep that.
      if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
      return res.type('html').send(neutralHead(html));
    });
  };

  return { assets: [precompressed, plain, missing], spa, portalPage };
}

/** The page's title and description with nothing that names the software. */
function neutralHead(html) {
  return html
    .replace(/<title>[^<]*<\/title>/i, '<title>Portal</title>')
    .replace(/<meta\s+name="description"[^>]*>/i, '<meta name="description" content="Portal" />')
    // A plain icon until the page swaps in the company's logo, and no web-app
    // manifest: that file names the software as the installable app.
    .replace(/<link\s+rel="icon"[^>]*>/i, '<link rel="icon" href="/icons/portal.svg" type="image/svg+xml" />')
    .replace(/[ \t]*<link\s+rel="manifest"[^>]*>\r?\n?/i, '');
}

module.exports = { staticAssets, neutralHead };

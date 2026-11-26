'use strict';

// =============================================================================
// A company's logo
// =============================================================================
// One image per organization, shown to that company's customers: the browser
// tab icon and the header of the client portal, and the contract signing page.
// It lives on disk under storage/organizations/logos with a row in `files`
// (entity_type 'organization', category 'logo'); uploading a new one retires
// the old one.
//
// Only PNG, JPEG and WebP are accepted, and the type is read from the file's
// first bytes, never from its name or the uploader's Content-Type. SVG is left
// out on purpose: an SVG served from this origin can carry script.
// =============================================================================

const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../config/database');
const { attachmentStorage, resolveStoredPath, STORAGE_ROOT } = require('../middleware/upload');

const LOGO_SUBDIR = path.join('organizations', 'logos');
const MAX_LOGO_BYTES = 512 * 1024;
const LOGO_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function rejection(message) {
  const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE');
  err.message = message;
  return err;
}

/** multer middleware for the logo upload. Field name: "file". */
const uploadLogo = multer({
  storage: attachmentStorage(LOGO_SUBDIR),
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!LOGO_EXTENSIONS.has(ext)) return cb(rejection('The logo must be a PNG, JPG or WebP image.'));
    return cb(null, true);
  },
  limits: { fileSize: MAX_LOGO_BYTES, files: 1 },
}).single('file');

/** The image type the first bytes say it is, or null when it is none of ours. */
function sniffImageType(head) {
  if (!Buffer.isBuffer(head) || head.length < 12) return null;
  if (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    const read = fs.readSync(fd, head, 0, 12, 0);
    return head.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// Logos are install-wide company records: they are kept in the primary
// database whatever tenant the request is running as.
function primary(fn) {
  return typeof db.withPrimaryContext === 'function' ? db.withPrimaryContext(fn) : fn();
}

function unlinkQuietly(file) {
  try { if (file) fs.unlinkSync(file); } catch { /* already gone */ }
}

/** The organization's current logo row, or null. */
async function current(orgId) {
  const [rows] = await primary(() => db.query(
    `SELECT id, file_name, file_path, file_size, mime_type, created_at
       FROM files
      WHERE entity_type = 'organization' AND entity_id = ? AND category = 'logo' AND deleted_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [orgId],
  ));
  return rows[0] || null;
}

/** What the screens are told about a logo: never its place on disk. */
function describe(row) {
  if (!row) return null;
  return { file_name: row.file_name, file_size: Number(row.file_size), mime_type: row.mime_type, uploaded_at: row.created_at };
}

/**
 * Make an uploaded file the organization's logo. The file is deleted again
 * when it is not an image we accept.
 */
function replace(orgId, file, userId) {
  return primary(() => replaceInPrimary(orgId, file, userId));
}

async function replaceInPrimary(orgId, file, userId) {
  const mime = sniffImageType(readHead(file.path));
  if (!mime) {
    unlinkQuietly(file.path);
    const err = new Error('The file is not a PNG, JPG or WebP image.');
    err.code = 'NOT_AN_IMAGE';
    throw err;
  }
  const [old] = await db.query(
    `SELECT id, file_path FROM files
      WHERE entity_type = 'organization' AND entity_id = ? AND category = 'logo' AND deleted_at IS NULL`,
    [orgId],
  );
  let insertId;
  try {
    const [result] = await db.query(
      `INSERT INTO files (entity_type, entity_id, category, file_name, file_path, file_size, mime_type, uploaded_by)
       VALUES ('organization', ?, 'logo', ?, ?, ?, ?, ?)`,
      [orgId, String(file.originalname || 'logo').slice(0, 255), path.relative(STORAGE_ROOT, file.path), file.size, mime, userId || null],
    );
    insertId = result.insertId;
  } catch (err) {
    unlinkQuietly(file.path);
    throw err;
  }
  await retire(orgId, old.filter((row) => Number(row.id) !== Number(insertId)));
  return current(orgId);
}

async function retire(orgId, rows) {
  for (const row of rows) {
    await db.query(
      "UPDATE files SET deleted_at = NOW() WHERE id = ? AND entity_type = 'organization' AND entity_id = ? AND category = 'logo'",
      [row.id, orgId],
    );
    unlinkQuietly(resolveStoredPath(row.file_path));
  }
}

/** Remove the organization's logo. Returns whether there was one. */
function remove(orgId) {
  return primary(() => removeInPrimary(orgId));
}

async function removeInPrimary(orgId) {
  const [rows] = await db.query(
    `SELECT id, file_path FROM files
      WHERE entity_type = 'organization' AND entity_id = ? AND category = 'logo' AND deleted_at IS NULL`,
    [orgId],
  );
  await retire(orgId, rows);
  return rows.length > 0;
}

/**
 * Answer a request with the organization's logo, or 404.
 * `cacheControl` is the caller's: a signed-in reader gets a private copy, the
 * sign-in page a short public one.
 */
async function send(res, orgId, cacheControl) {
  const row = orgId ? await current(orgId) : null;
  const file = row && resolveStoredPath(row.file_path);
  if (!file || !fs.existsSync(file)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No logo' } });
  }
  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', cacheControl);
  return res.sendFile(file);
}

module.exports = { uploadLogo, sniffImageType, current, describe, replace, remove, send, MAX_LOGO_BYTES };

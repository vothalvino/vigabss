// =============================================================================
// VigaBSS 5.0 — Import Routes (Bulk CSV)
// =============================================================================

const { Router } = require('express');
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { uploadLimiter } = require('../middleware/rateLimit');
const { validate } = require('../middleware/validate');
const importSchemas = require('../middleware/schemas/import');
const importJobService = require('../services/importJobService');
const rbac = require('../middleware/rbac');
const { ForbiddenError, ValidationError } = require('../utils/errors');

const router = Router();
router.use(authenticate);
router.use(orgScope);

// Memory storage for import files — files are parsed in-memory, not persisted.
const IMPORT_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_IMPORT_MIMES = new Set([
  'text/csv',
  'text/plain',
  'application/octet-stream',
]);

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMPORT_MAX_SIZE },
  fileFilter(_req, file, cb) {
    const ext = require('path').extname(file.originalname).toLowerCase();
    if (ext !== '.csv' || !ALLOWED_IMPORT_MIMES.has(file.mimetype)) {
      return cb(new Error('Only .csv files are accepted'));
    }
    cb(null, true);
  },
}).single('file');

/**
 * Wrap multer upload for import routes, converting MulterError to 422.
 */
function uploadImportFile(req, res, next) {
  importUpload(req, res, (err) => {
    if (err) {
      return res.status(422).json({ error: { code: 'UPLOAD_ERROR', message: err.message } });
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Every import runs as a background job (migration 522): the request stores
// the CSV, queues it and answers 202 with the job. GET /import/jobs/:id
// reports its progress and result.
// ---------------------------------------------------------------------------

function queueImport(entity, source) {
  return async (req, res, next) => {
    try {
      const csv = source === 'file' ? req.file?.buffer?.toString('utf8') : req.body.csv;
      if (!csv) throw new ValidationError(source === 'file' ? 'file is required' : 'csv field is required');
      const job = await importJobService.createImportJob({
        organizationId: req.orgId, entity, csv, userId: req.user?.id ?? null,
      });
      res.status(202).json({ data: job });
    } catch (err) {
      next(err);
    }
  };
}

// The caller's recent imports of the entities they may import.
router.get('/jobs', async (req, res, next) => {
  try {
    const allowed = [];
    for (const entity of importJobService.ENTITIES) {
      if (await rbac.userHasPermission(req, importJobService.ENTITY_PERMISSION[entity])) allowed.push(entity);
    }
    res.json({ data: await importJobService.listImportJobs(req.orgId, allowed, req.query) });
  } catch (err) {
    next(err);
  }
});

router.get('/jobs/:id', async (req, res, next) => {
  try {
    const job = await importJobService.getImportJob(req.params.id, req.orgId);
    if (!await rbac.userHasPermission(req, importJobService.ENTITY_PERMISSION[job.entity])) {
      throw new ForbiddenError(`Insufficient permissions. Required: ${importJobService.ENTITY_PERMISSION[job.entity]}`);
    }
    res.json({ data: job });
  } catch (err) {
    next(err);
  }
});

// CSV string in a JSON body.
for (const entity of importJobService.ENTITIES) {
  router.post(`/${entity}`, requirePermission(importJobService.ENTITY_PERMISSION[entity]), validate(importSchemas.importCsv, { strip: false }), queueImport(entity, 'body'));
}

// File upload (multipart/form-data, field "file", .csv only). uploadLimiter
// is mounted first (before requirePermission), matching bulk.js's
// bulkEmailLimiter convention: reject cheaply before the file parse and
// before any permission-check DB work.
for (const entity of importJobService.ENTITIES) {
  router.post(`/${entity}/upload`, uploadLimiter, requirePermission(importJobService.ENTITY_PERMISSION[entity]), uploadImportFile, queueImport(entity, 'file'));
}

module.exports = router;

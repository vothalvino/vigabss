// =============================================================================
// VigaBSS 5.0 — Bandwidth Test Routes (§10.4)
// =============================================================================
// Covers: bandwidth test server registry and subscriber speed test jobs.
// =============================================================================

const { sealSecret } = require('../utils/sealSecrets');
const { redactSecretsInResponses } = require('../utils/secretRedaction');
const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { createBandwidthTestServer, updateBandwidthTestServer } = require('../middleware/schemas/bandwidthTestServers');
const { createSpeedTestJob } = require('../middleware/schemas/subscriberSpeedTestJobs');
const db = require('../config/database');
const { NotFoundError, ValidationError } = require('../utils/errors');

const router = Router();

// ---------------------------------------------------------------------------
// Organization guards
// ---------------------------------------------------------------------------
// A path :id outside req.orgId is 404; a body reference (contract_id,
// test_server_id, site_id) outside req.orgId is a 422 ValidationError
// (ARCHITECTURE.md tenant routing; mirrors assertQuoteFks/assertTicketFks).
// organization_id is nullable on every table here, so comparisons are
// null-safe. Global (organization_id IS NULL) test servers stay readable and
// usable as a job target, but only an org's own servers are writable.

function foreignRef(field, label) {
  return new ValidationError(`${field} does not belong to this organization`, [
    { field, message: `Invalid or cross-organization ${label}` },
  ]);
}

async function assertServerFks(body, orgId) {
  if (body.site_id !== undefined && body.site_id !== null) {
    const [[site]] = await db.query(
      'SELECT id FROM sites WHERE id = ? AND organization_id <=> ? AND deleted_at IS NULL',
      [body.site_id, orgId],
    );
    if (!site) throw foreignRef('site_id', 'site');
  }
}

async function assertSpeedTestJobFks(body, orgId) {
  const [[contract]] = await db.query(
    'SELECT id FROM contracts WHERE id = ? AND organization_id <=> ? AND deleted_at IS NULL',
    [body.contract_id, orgId],
  );
  if (!contract) throw foreignRef('contract_id', 'contract');
  if (body.test_server_id !== undefined && body.test_server_id !== null) {
    const [[server]] = await db.query(
      `SELECT id FROM bandwidth_test_servers
       WHERE id = ? AND (organization_id <=> ? OR organization_id IS NULL) AND deleted_at IS NULL`,
      [body.test_server_id, orgId],
    );
    if (!server) throw foreignRef('test_server_id', 'bandwidth test server');
  }
}

// An org's own (writable) server, deleted or not; 404 otherwise.
async function requireOwnedServer(id, orgId) {
  const [[row]] = await db.query(
    'SELECT * FROM bandwidth_test_servers WHERE id = ? AND organization_id <=> ?',
    [id, orgId],
  );
  if (!row) throw new NotFoundError('Bandwidth test server');
  return row;
}

router.use(['/bandwidth-test-servers', '/subscriber-speed-test-jobs'], authenticate, orgScope);

// The iperf auth token is write-only (NET-10): bandwidth_test_servers.view
// returned it, including the tokens of install-wide servers, to every tenant.
// It is encrypted at rest; a blank value on update keeps the stored one.
router.use('/bandwidth-test-servers', redactSecretsInResponses(['auth_token']));
function sealAuthToken(req, _res, next) {
  try {
    const value = req.body ? req.body.auth_token : undefined;
    if (value === '' || value === null) delete req.body.auth_token;
    else if (typeof value === 'string') req.body.auth_token = sealSecret(value);
    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// Bandwidth Test Servers
// ---------------------------------------------------------------------------

// GET /bandwidth-test-servers
router.get('/bandwidth-test-servers', requirePermission('bandwidth_test_servers.view'), async (req, res, next) => {
  try {
    const [rows] = await db.query(
      `SELECT * FROM bandwidth_test_servers
       WHERE (organization_id = ? OR organization_id IS NULL)
         AND deleted_at IS NULL
       ORDER BY name ASC`,
      [req.orgId],
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /bandwidth-test-servers/:id
router.get('/bandwidth-test-servers/:id', requirePermission('bandwidth_test_servers.view'), async (req, res, next) => {
  try {
    const [[row]] = await db.query(
      `SELECT * FROM bandwidth_test_servers
       WHERE id = ? AND (organization_id = ? OR organization_id IS NULL) AND deleted_at IS NULL`,
      [req.params.id, req.orgId],
    );
    if (!row) throw new NotFoundError('Bandwidth test server');
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

// POST /bandwidth-test-servers
router.post('/bandwidth-test-servers', requirePermission('bandwidth_test_servers.create'), validate(createBandwidthTestServer), sealAuthToken, async (req, res, next) => {
  try {
    const { name, description, host, port = 5201, protocol = 'iperf3', region, site_id, is_active = true, auth_token, max_bandwidth_mbps } = req.body;
    await assertServerFks(req.body, req.orgId);
    const [result] = await db.query(
      `INSERT INTO bandwidth_test_servers
         (organization_id, name, description, host, port, protocol, region, site_id, is_active, auth_token, max_bandwidth_mbps)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.orgId, name, description || null, host, port, protocol, region || null, site_id || null,
        is_active ? 1 : 0, auth_token || null, max_bandwidth_mbps || null],
    );
    const [[row]] = await db.query('SELECT * FROM bandwidth_test_servers WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: row });
  } catch (err) {
    next(err);
  }
});

// PUT /bandwidth-test-servers/:id
router.put('/bandwidth-test-servers/:id', requirePermission('bandwidth_test_servers.update'), validate(updateBandwidthTestServer), sealAuthToken, async (req, res, next) => {
  try {
    const allowed = ['name','description','host','port','protocol','region','site_id','is_active','auth_token','max_bandwidth_mbps'];
    const fields = [];
    const params = [];
    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k)) { fields.push(`${k} = ?`); params.push(v); }
    }
    if (!fields.length) return res.status(400).json({ error: 'No updatable fields provided' });
    const existing = await requireOwnedServer(req.params.id, req.orgId);
    if (existing.deleted_at) throw new NotFoundError('Bandwidth test server');
    await assertServerFks(req.body, req.orgId);
    params.push(req.params.id, req.orgId);
    await db.query(
      `UPDATE bandwidth_test_servers SET ${fields.join(', ')}
       WHERE id = ? AND organization_id <=> ? AND deleted_at IS NULL`,
      params,
    );
    const row = await requireOwnedServer(req.params.id, req.orgId);
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

// DELETE /bandwidth-test-servers/:id
router.delete('/bandwidth-test-servers/:id', requirePermission('bandwidth_test_servers.delete'), async (req, res, next) => {
  try {
    const [result] = await db.query(
      'UPDATE bandwidth_test_servers SET deleted_at = NOW() WHERE id = ? AND organization_id <=> ? AND deleted_at IS NULL',
      [req.params.id, req.orgId],
    );
    if (!result || !result.affectedRows) throw new NotFoundError('Bandwidth test server');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// POST /bandwidth-test-servers/:id/restore
router.post('/bandwidth-test-servers/:id/restore', requirePermission('bandwidth_test_servers.update'), async (req, res, next) => {
  try {
    await requireOwnedServer(req.params.id, req.orgId);
    await db.query(
      'UPDATE bandwidth_test_servers SET deleted_at = NULL WHERE id = ? AND organization_id <=> ?',
      [req.params.id, req.orgId],
    );
    const row = await requireOwnedServer(req.params.id, req.orgId);
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Subscriber Speed Test Jobs
// ---------------------------------------------------------------------------

// GET /subscriber-speed-test-jobs
router.get('/subscriber-speed-test-jobs', requirePermission('subscriber_speed_tests.view'), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;
    let where = 'j.organization_id = ?';
    const params = [req.orgId];
    if (req.query.contract_id) { where += ' AND j.contract_id = ?'; params.push(req.query.contract_id); }
    if (req.query.status) { where += ' AND j.status = ?'; params.push(req.query.status); }

    const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM subscriber_speed_test_jobs j WHERE ${where}`, params);
    const [rows] = await db.query(
      `SELECT j.*, s.name AS server_name
       FROM subscriber_speed_test_jobs j
       LEFT JOIN bandwidth_test_servers s ON j.test_server_id = s.id
       WHERE ${where}
       ORDER BY j.scheduled_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    res.json({ data: rows, meta: { total, page, limit } });
  } catch (err) {
    next(err);
  }
});

// GET /subscriber-speed-test-jobs/:id
router.get('/subscriber-speed-test-jobs/:id', requirePermission('subscriber_speed_tests.view'), async (req, res, next) => {
  try {
    const [[row]] = await db.query(
      `SELECT j.*, s.name AS server_name
       FROM subscriber_speed_test_jobs j
       LEFT JOIN bandwidth_test_servers s ON j.test_server_id = s.id
       WHERE j.id = ? AND j.organization_id = ?`,
      [req.params.id, req.orgId],
    );
    if (!row) throw new NotFoundError('Speed test job');
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

// POST /subscriber-speed-test-jobs
router.post('/subscriber-speed-test-jobs', requirePermission('subscriber_speed_tests.create'), validate(createSpeedTestJob), async (req, res, next) => {
  try {
    const { contract_id, test_server_id, scheduled_at, notes } = req.body;
    await assertSpeedTestJobFks(req.body, req.orgId);
    const [result] = await db.query(
      `INSERT INTO subscriber_speed_test_jobs
         (organization_id, contract_id, test_server_id, requested_by, scheduled_at, notes)
       VALUES (?, ?, ?, 'admin', ?, ?)`,
      [req.orgId, contract_id, test_server_id || null, scheduled_at || new Date(), notes || null],
    );
    const [[row]] = await db.query('SELECT * FROM subscriber_speed_test_jobs WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: row });
  } catch (err) {
    next(err);
  }
});

// POST /subscriber-speed-test-jobs/:id/cancel
router.post('/subscriber-speed-test-jobs/:id/cancel', requirePermission('subscriber_speed_tests.update'), async (req, res, next) => {
  try {
    await db.query(
      `UPDATE subscriber_speed_test_jobs SET status = 'cancelled'
       WHERE id = ? AND organization_id <=> ? AND status IN ('queued','running')`,
      [req.params.id, req.orgId],
    );
    const [[row]] = await db.query(
      'SELECT * FROM subscriber_speed_test_jobs WHERE id = ? AND organization_id <=> ?',
      [req.params.id, req.orgId],
    );
    if (!row) throw new NotFoundError('Speed test job');
    res.json({ data: row });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

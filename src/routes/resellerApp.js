// =============================================================================
// VigaBSS 5.0 — Reseller app (Punto de Venta), phases 1 and 2
// =============================================================================
// A reseller is a commission agent: it signs up neighbours as leads, which the
// ISP converts, signs and installs, and it collects cash from the ISP's
// subscribers within a credit limit (phase 2, routes/resellerAppCollect.js).
// A staff user bound to a reseller (reseller_user_bindings) uses these routes
// from the /punto web app.
//
//  GET  /reseller-app/me                    the bound reseller, its counts and its cash position
//  GET  /reseller-app/clients               clients of the reseller subtree
//  GET  /reseller-app/clients/:id           one of those clients
//  GET  /reseller-app/plans                 plans the reseller may offer
//  GET  /reseller-app/leads                 leads the subtree captured
//  POST /reseller-app/leads                 sign up a customer as a lead
//  GET  /reseller-app/leads/:id/feasibility coverage summary for such a lead
//  ...and the phase-2 collection, receipt, cash-box and ledger routes of
//  routes/resellerAppCollect.js and the phase-3 cash-bag routes of
//  routes/resellerAppBags.js and the phase-5 statements of
//  routes/resellerAppStatements.js and the phase-5b support routes of
//  routes/resellerAppSupport.js, mounted below with the same guards.
//
// A collector (resellers.kind = 'collector', migration 011) uses the same app
// for its cash only: Cobrar by client number, Mi caja, Mis bolsas and its
// statements. Whatever permissions its group is given, every client, plan,
// lead and ticket route answers 403 to it (collectorFence below).
//
// Every route needs a binding: org-level staff get 403 (they use the staff
// pages). The subtree is the bound reseller and its sub-resellers
// (middleware/resellerScope.js). Every query binds organization_id and skips
// soft-deleted rows; a client or lead outside the subtree is 404.
// =============================================================================

const { Router } = require('express');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { resellerScope } = require('../middleware/resellerScope');
const { tagGuard } = require('../middleware/routeGuard');
const { resellerSignupLimiter } = require('../middleware/rateLimit');
const { createLead } = require('../middleware/schemas/leads');
const { ForbiddenError, NotFoundError, ValidationError } = require('../utils/errors');
const { inPlaceholders } = require('../utils/sqlBuild');
const { paidOrCreditedSql } = require('../utils/invoiceBalance');
const { businessToday } = require('../utils/businessDate');
const { PAYABLE_STATUSES } = require('../services/paymentAllocationService');
const leadFeasibilityService = require('../services/leadFeasibilityService');
const auditLog = require('../services/auditLog');
const resellerLedgerService = require('../services/resellerLedgerService');
const resellerCollectionService = require('../services/resellerCollectionService');
const resellerCommissionService = require('../services/resellerCommissionService');
const collectorService = require('../services/collectorService');
const Organization = require('../models/Organization');
const db = require('../config/database');

const router = Router();
router.use(authenticate);
router.use(orgScope);
router.use(resellerScope);

// Org-level staff (and validated global-access principals) have no reseller
// to act as; the reseller app is for bound reseller accounts only.
const requireBoundReseller = tagGuard((req, _res, next) => {
  if (!req.resellerScope || req.resellerScope.all) {
    return next(new ForbiddenError('Only reseller accounts can use the reseller app'));
  }
  next();
}, { reseller: 'bound' });
router.use(requireBoundReseller);

// The bound point's kind, for the collector fence and the collector's lookup.
async function loadPointKind(req, _res, next) {
  try {
    req.pointKind = await collectorService.kindOf(req.orgId, req.resellerScope.rootId);
    next();
  } catch (err) { next(err); }
}
router.use(loadPointKind);

// A collector only takes payments: no client, plan, lead or ticket route, and
// not the own-client Cobrar shortcut, whatever its group holds.
const COLLECTOR_REFUSED = /^\/(?:clients|plans|leads|tickets|collect\/client)(?:\/|$)/;
const collectorFence = tagGuard((req, _res, next) => {
  if (req.pointKind === 'collector' && COLLECTOR_REFUSED.test(req.path)) {
    return next(new ForbiddenError('A collector account only takes payments'));
  }
  next();
}, { reseller: 'collector-fence' });
router.use(collectorFence);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLIENT_STATUSES = ['active', 'inactive', 'suspended'];
const LEAD_CLOSED_STATUSES = ['won', 'lost'];

function subtree(req) {
  return req.resellerScope.resellerIds;
}

function pagination(query, defaultLimit = 25) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(Math.max(1, parseInt(query.limit, 10) || defaultLimit), 100);
  return { page, limit, offset: (page - 1) * limit };
}

function positiveId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const PAYABLE_IN = PAYABLE_STATUSES.map(() => '?').join(', ');

// What is still owed on one invoice aliased `i` (never below zero).
const OPEN_BALANCE_SQL = `GREATEST(i.total - ${paidOrCreditedSql('i')}, 0)`;

// An unpaid invoice of client `c` past its due date. Binds PAYABLE_STATUSES
// and then the business date.
const OVERDUE_INVOICE_SQL = `SELECT 1 FROM invoices i
                       WHERE i.client_id = c.id AND i.organization_id = c.organization_id
                         AND i.deleted_at IS NULL AND i.status IN (${PAYABLE_IN})
                         AND i.due_date < ? AND ${OPEN_BALANCE_SQL} > 0.005`;
const OVERDUE_FLAGS = ['1', 'true', '0', 'false'];

/**
 * The client, if it belongs to the caller's reseller subtree in the active
 * organization; 404 otherwise (a foreign or out-of-subtree id looks missing).
 */
async function assertClientInResellerScope(req, clientId) {
  const id = positiveId(clientId);
  const ids = subtree(req);
  if (!id || !ids.length) throw new NotFoundError('Client');
  const [[client]] = await db.query(
    `SELECT c.id, c.name, c.phone, c.email, c.address, c.city, c.status, c.reseller_id
       FROM clients c
      WHERE c.id = ? AND c.organization_id = ? AND c.deleted_at IS NULL
        AND c.reseller_id IN (${inPlaceholders(ids)})
      LIMIT 1`,
    [id, req.orgId, ...ids],
  );
  if (!client) throw new NotFoundError('Client');
  return client;
}

/**
 * Plans the bound reseller may offer: the reseller_allowed_plans rows of its
 * top-level reseller, or every active plan of the organization when there
 * are none. Only active, live plans are ever offered.
 */
async function allowedPlans(orgId, boundResellerId) {
  // Allowed plans are set on the top-level reseller and apply to its sub-resellers.
  const resellerId = await resellerLedgerService.topLevelResellerId(orgId, boundResellerId);
  const [[{ total }]] = await db.query(
    'SELECT COUNT(*) AS total FROM reseller_allowed_plans WHERE organization_id = ? AND reseller_id = ?',
    [orgId, resellerId],
  );
  let rows;
  if (Number(total) > 0) {
    [rows] = await db.query(
      `SELECT p.id, p.name, p.price, p.download_speed_mbps, p.upload_speed_mbps
         FROM reseller_allowed_plans rap
         JOIN plans p ON p.id = rap.plan_id AND p.organization_id = rap.organization_id
                     AND p.deleted_at IS NULL AND p.status = 'active'
        WHERE rap.organization_id = ? AND rap.reseller_id = ?
        ORDER BY p.price ASC, p.name ASC`,
      [orgId, resellerId],
    );
  } else {
    [rows] = await db.query(
      `SELECT p.id, p.name, p.price, p.download_speed_mbps, p.upload_speed_mbps
         FROM plans p
        WHERE p.organization_id = ? AND p.deleted_at IS NULL AND p.status = 'active'
        ORDER BY p.price ASC, p.name ASC`,
      [orgId],
    );
  }
  return rows.map((p) => ({
    id: Number(p.id),
    name: p.name,
    price: money(p.price),
    download_speed: Number(p.download_speed_mbps),
    upload_speed: Number(p.upload_speed_mbps),
  }));
}

function leadRow(row) {
  return {
    id: Number(row.id),
    name: row.name,
    phone: row.phone,
    status: row.status,
    desired_plan_id: row.desired_plan_id === null || row.desired_plan_id === undefined ? null : Number(row.desired_plan_id),
    desired_plan_name: row.desired_plan_name ?? null,
    created_at: row.created_at,
    converted_client_id: row.converted_client_id === null || row.converted_client_id === undefined
      ? null
      : Number(row.converted_client_id),
  };
}

// The lead fields a reseller may fill in, validated exactly like the staff
// lead form (middleware/schemas/leads.js). Phone is required here: the ISP
// calls the prospect to schedule the installation.
const LEAD_FIELDS = [
  'name', 'phone', 'email', 'address', 'city', 'latitude', 'longitude', 'desired_plan_id',
  'rfc', 'razon_social', 'regimen_fiscal', 'codigo_postal_fiscal', 'notes',
];
const signupLeadSchema = Object.fromEntries(LEAD_FIELDS.map((field) => [field, { ...createLead[field] }]));
signupLeadSchema.phone = { ...signupLeadSchema.phone, required: true, min: 1 };

// ---------------------------------------------------------------------------
// Feasibility summary
// ---------------------------------------------------------------------------
// The staff desk check (services/leadFeasibilityService.js) names the ISP's
// network: AP and ODF ids, names and coordinates, radio parameters, port
// counts and, on a zone lookup error, the database error text. A reseller is
// a third party and chooses the coordinates it asks about, so it gets only
// the outcome: whether the point is inside a zone that is in service, and
// coarse wireless and FTTH flags. A zone that is planned, under construction
// or retired does not count, and an AP or ODF frame farther than
// FEASIBILITY_NEARBY_KM is not "nearby" (the service has no distance limit).

const COVERED_ZONE_STATUSES = ['active', 'degraded'];
const FEASIBILITY_NEARBY_KM = 3;

function distanceBand(km) {
  if (km === null || !Number.isFinite(km)) return null;
  if (km <= 1) return 'under_1km';
  if (km <= FEASIBILITY_NEARBY_KM) return 'under_3km';
  return 'farther';
}

function nearestKm(rows) {
  const distances = (Array.isArray(rows) ? rows : [])
    .map((row) => Number(row && row.distance_km))
    .filter((km) => Number.isFinite(km));
  return distances.length ? Math.min(...distances) : null;
}

const optionalNumber = (value) => (value === null || value === undefined || value === '' ? null : Number(value));

function resellerFeasibilitySummary(result) {
  if (!result || !result.has_coordinates) {
    return {
      has_coordinates: false,
      covered: false,
      coverage_zones: [],
      zone_lookup_failed: false,
      wireless: { nearby: false, distance_band: null },
      ftth: { nearby: false, distance_band: null, has_free_ports: null },
    };
  }
  const zoneRows = Array.isArray(result.coverage_zones) ? result.coverage_zones : [];
  const zones = zoneRows
    .filter((z) => z && !z.error && COVERED_ZONE_STATUSES.includes(z.status))
    .map((z) => ({
      name: z.name,
      zone_type: z.zone_type ?? null,
      status: z.status,
      max_download_mbps: optionalNumber(z.max_download_mbps),
      max_upload_mbps: optionalNumber(z.max_upload_mbps),
    }));

  const wirelessBand = distanceBand(nearestKm(result.wireless));
  const ftthRows = Array.isArray(result.ftth) ? result.ftth : [];
  const ftthBand = distanceBand(nearestKm(ftthRows));
  // Free ports are known only for frames whose ports were registered.
  const nearFrames = ftthRows.filter((f) => Number(f && f.distance_km) <= FEASIBILITY_NEARBY_KM);
  const tracked = nearFrames.filter((f) => Number(f.ports_tracked) > 0);
  const hasFreePorts = tracked.length ? tracked.some((f) => Number(f.free_ports) > 0) : null;
  const near = (band) => band === 'under_1km' || band === 'under_3km';

  return {
    has_coordinates: true,
    covered: zones.length > 0,
    coverage_zones: zones,
    zone_lookup_failed: zoneRows.some((z) => z && z.error),
    wireless: { nearby: near(wirelessBand), distance_band: wirelessBand },
    ftth: { nearby: near(ftthBand), distance_band: ftthBand, has_free_ports: near(ftthBand) ? hasFreePorts : null },
  };
}

/**
 * /me of a collector (migration 011): its cash only, never a count of
 * clients, overdue clients or prospects.
 */
async function collectorMe(req, point) {
  const currency = await Organization.getCurrency(req.orgId);
  const id = Number(point.id);
  const [summary, collectedToday, bags, settings, feesMonth] = await Promise.all([
    resellerLedgerService.summaryFor(req.orgId, id),
    resellerCollectionService.collectedToday(req.orgId, id),
    resellerLedgerService.bagCounts(req.orgId, id),
    collectorService.pointRow(db.query.bind(db), req.orgId, id),
    collectorService.feesThisMonth(req.orgId, id),
  ]);
  return {
    reseller: {
      id,
      name: point.name,
      level: Number(point.level),
      status: point.status,
      kind: 'collector',
      parent_id: null,
      collection_fee_type: settings?.collection_fee_type ?? 'none',
      collection_fee_value: Number(settings?.collection_fee_value) || 0,
    },
    currency,
    counts: null,
    money: {
      currency,
      balance: summary.balance,
      in_bags: summary.in_bags,
      cash_on_hand: summary.cash_on_hand,
      credit_limit: summary.credit_limit,
      available_to_collect: summary.available_to_collect,
      limit_reached: summary.limit_reached,
      collected_today: collectedToday,
      empty_bags: bags.empty,
      bags_on_the_way: bags.on_the_way,
      bags_ready_for_pickup: bags.ready_for_pickup,
      bags_in_transit: bags.in_transit,
      fees_month: feesMonth,
    },
  };
}

// =============================================================================
// GET /reseller-app/me
// =============================================================================
router.get('/me', requirePermission('reseller_app.use', 'reseller_app.cash'), async (req, res, next) => {
  try {
    const ids = subtree(req);
    const idsIn = inPlaceholders(ids);
    const [[reseller]] = await db.query(
      `SELECT id, name, level, status, commission_rate, parent_id
         FROM resellers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
      [req.resellerScope.rootId, req.orgId],
    );
    if (!reseller) throw new NotFoundError('Reseller');
    if (req.pointKind === 'collector') return res.json({ data: await collectorMe(req, reseller) });

    const [[clientCounts]] = await db.query(
      `SELECT COALESCE(SUM(c.status = 'active'), 0) AS active_clients,
              COALESCE(SUM(c.status = 'suspended'), 0) AS suspended_clients
         FROM clients c
        WHERE c.organization_id = ? AND c.reseller_id IN (${idsIn}) AND c.deleted_at IS NULL`,
      [req.orgId, ...ids],
    );
    const [[leadCounts]] = await db.query(
      `SELECT COUNT(*) AS open_leads
         FROM leads l
        WHERE l.organization_id = ? AND l.reseller_id IN (${idsIn}) AND l.deleted_at IS NULL
          AND l.converted_client_id IS NULL AND l.status NOT IN (${inPlaceholders(LEAD_CLOSED_STATUSES)})`,
      [req.orgId, ...ids, ...LEAD_CLOSED_STATUSES],
    );
    const [[overdue]] = await db.query(
      `SELECT COUNT(DISTINCT c.id) AS overdue_clients
         FROM clients c
         JOIN invoices i ON i.client_id = c.id AND i.organization_id = c.organization_id
        WHERE c.organization_id = ? AND c.reseller_id IN (${idsIn}) AND c.deleted_at IS NULL
          AND i.deleted_at IS NULL AND i.status IN (${PAYABLE_IN}) AND i.due_date < ?
          AND ${OPEN_BALANCE_SQL} > 0.005`,
      [req.orgId, ...ids, ...PAYABLE_STATUSES, businessToday()],
    );

    // The cash position of the collecting (top-level) reseller.
    const currency = await Organization.getCurrency(req.orgId);
    const collectorId = await resellerLedgerService.collectingResellerId(req);
    const [summary, collectedToday, bags, commissionMonth, topRows] = await Promise.all([
      resellerLedgerService.summaryFor(req.orgId, collectorId),
      resellerCollectionService.collectedToday(req.orgId, collectorId),
      resellerLedgerService.bagCounts(req.orgId, collectorId),
      // Commissions are earned and booked on the top-level reseller (phase 4).
      resellerCommissionService.commissionThisMonth(req.orgId, collectorId),
      Number(collectorId) === Number(reseller.id)
        ? Promise.resolve(null)
        : db.query('SELECT commission_rate FROM resellers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [collectorId, req.orgId]),
    ]);
    const topRate = topRows ? topRows[0]?.[0]?.commission_rate : reseller.commission_rate;

    res.json({
      data: {
        reseller: {
          id: Number(reseller.id),
          name: reseller.name,
          level: Number(reseller.level),
          status: reseller.status,
          commission_rate: Number(reseller.commission_rate),
          parent_id: reseller.parent_id === null ? null : Number(reseller.parent_id),
          kind: 'reseller',
        },
        currency,
        counts: {
          active_clients: Number(clientCounts?.active_clients) || 0,
          suspended_clients: Number(clientCounts?.suspended_clients) || 0,
          open_leads: Number(leadCounts?.open_leads) || 0,
          overdue_clients: Number(overdue?.overdue_clients) || 0,
        },
        money: {
          currency,
          balance: summary.balance,
          in_bags: summary.in_bags,
          cash_on_hand: summary.cash_on_hand,
          credit_limit: summary.credit_limit,
          available_to_collect: summary.available_to_collect,
          limit_reached: summary.limit_reached,
          collected_today: collectedToday,
          // Cash bags (phase 3): empty ones it may fill (including those a
          // carrier is bringing it, migration 010), sealed ones waiting for
          // the carrier, and those on their way to the ISP.
          empty_bags: bags.empty,
          bags_on_the_way: bags.on_the_way,
          bags_ready_for_pickup: bags.ready_for_pickup,
          bags_in_transit: bags.in_transit,
          // Commission (phase 4): the rate of the top-level reseller, which
          // applies to every client of its subtree, and what it earned this
          // month and still keeps (reversed commissions excluded).
          commission_rate: Number(topRate) || 0,
          commission_month: commissionMonth,
        },
      },
    });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /reseller-app/clients
// =============================================================================
router.get('/clients', requirePermission('reseller_app.use'), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query);
    const ids = subtree(req);
    const status = typeof req.query.status === 'string' && req.query.status !== '' ? req.query.status : null;
    if (status && !CLIENT_STATUSES.includes(status)) {
      throw new ValidationError(`status must be one of: ${CLIENT_STATUSES.join(', ')}`);
    }
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const overdueRaw = typeof req.query.overdue === 'string' ? req.query.overdue : '';
    if (overdueRaw && !OVERDUE_FLAGS.includes(overdueRaw)) {
      throw new ValidationError(`overdue must be one of: ${OVERDUE_FLAGS.join(', ')}`);
    }
    const overdueOnly = overdueRaw === '1' || overdueRaw === 'true';
    const today = businessToday();

    const conditions = [`c.organization_id = ? AND c.reseller_id IN (${inPlaceholders(ids)})`];
    const params = [req.orgId, ...ids];
    if (status) { conditions.push('c.status = ?'); params.push(status); }
    if (search) {
      conditions.push('(c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (overdueOnly) {
      // The same test as the overdue column and the /me overdue_clients count.
      conditions.push(`EXISTS (${OVERDUE_INVOICE_SQL})`);
      params.push(...PAYABLE_STATUSES, today);
    }
    const where = conditions.join(' AND ');

    const [rows] = await db.query(
      `SELECT c.id, c.name, c.phone, c.email, c.status, c.reseller_id,
              COALESCE((SELECT SUM(${OPEN_BALANCE_SQL}) FROM invoices i
                         WHERE i.client_id = c.id AND i.organization_id = c.organization_id
                           AND i.deleted_at IS NULL AND i.status IN (${PAYABLE_IN})), 0) AS balance_due,
              EXISTS (${OVERDUE_INVOICE_SQL}) AS overdue
         FROM clients c
        WHERE c.deleted_at IS NULL AND ${where}
        ORDER BY c.name ASC, c.id ASC
        LIMIT ${limit} OFFSET ${offset}`,
      [...PAYABLE_STATUSES, ...PAYABLE_STATUSES, today, ...params],
    );
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM clients c WHERE c.deleted_at IS NULL AND ${where}`, params,
    );

    res.json({
      data: rows.map((c) => ({
        id: Number(c.id),
        name: c.name,
        phone: c.phone,
        email: c.email,
        status: c.status,
        reseller_id: Number(c.reseller_id),
        balance_due: money(c.balance_due),
        overdue: Number(c.overdue) === 1,
      })),
      meta: { total: Number(total), page, limit },
    });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /reseller-app/clients/:id
// =============================================================================
router.get('/clients/:id', requirePermission('reseller_app.use'), async (req, res, next) => {
  try {
    const client = await assertClientInResellerScope(req, req.params.id);

    const [contracts] = await db.query(
      `SELECT ct.id, ct.status, p.name AS plan_name,
              COALESCE(ct.price_override, p.price) AS monthly_price
         FROM contracts ct
         /* includes deleted rows: a contract keeps showing the plan it was sold on */
         LEFT JOIN plans p ON p.id = ct.plan_id AND p.organization_id <=> ct.organization_id
        WHERE ct.client_id = ? AND ct.organization_id = ? AND ct.deleted_at IS NULL
        ORDER BY ct.id DESC`,
      [client.id, req.orgId],
    );
    const [invoices] = await db.query(
      `SELECT i.id, i.invoice_number, i.status, i.total, i.due_date, i.issue_date,
              CASE WHEN i.status IN (${PAYABLE_IN}) THEN ${OPEN_BALANCE_SQL} ELSE 0 END AS balance
         FROM invoices i
        WHERE i.client_id = ? AND i.organization_id = ? AND i.deleted_at IS NULL AND i.status <> 'draft'
        ORDER BY i.issue_date DESC, i.id DESC
        LIMIT 20`,
      [...PAYABLE_STATUSES, client.id, req.orgId],
    );
    const [[due]] = await db.query(
      `SELECT COALESCE(SUM(${OPEN_BALANCE_SQL}), 0) AS balance_due
         FROM invoices i
        WHERE i.client_id = ? AND i.organization_id = ? AND i.deleted_at IS NULL
          AND i.status IN (${PAYABLE_IN})`,
      [client.id, req.orgId, ...PAYABLE_STATUSES],
    );

    res.json({
      data: {
        id: Number(client.id),
        name: client.name,
        phone: client.phone,
        email: client.email,
        address: client.address,
        city: client.city,
        status: client.status,
        reseller_id: Number(client.reseller_id),
        balance_due: money(due?.balance_due),
        contracts: contracts.map((ct) => ({
          id: Number(ct.id),
          status: ct.status,
          plan_name: ct.plan_name ?? null,
          monthly_price: ct.monthly_price === null || ct.monthly_price === undefined ? null : money(ct.monthly_price),
        })),
        invoices: invoices.map((i) => ({
          id: Number(i.id),
          invoice_number: i.invoice_number,
          status: i.status,
          total: money(i.total),
          balance: money(i.balance),
          due_date: i.due_date,
          issue_date: i.issue_date,
        })),
      },
    });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /reseller-app/plans
// =============================================================================
router.get('/plans', requirePermission('reseller_app.use'), async (req, res, next) => {
  try {
    res.json({ data: await allowedPlans(req.orgId, req.resellerScope.rootId) });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /reseller-app/leads
// =============================================================================
router.get('/leads', requirePermission('reseller_app.use'), async (req, res, next) => {
  try {
    const { page, limit, offset } = pagination(req.query);
    const ids = subtree(req);
    const where = `l.organization_id = ? AND l.reseller_id IN (${inPlaceholders(ids)})`;
    const params = [req.orgId, ...ids];
    const [rows] = await db.query(
      `SELECT l.id, l.name, l.phone, l.status, l.desired_plan_id, p.name AS desired_plan_name,
              l.created_at, l.converted_client_id
         FROM leads l
         /* includes deleted rows: a lead keeps showing the plan it asked for */
         LEFT JOIN plans p ON p.id = l.desired_plan_id AND p.organization_id <=> l.organization_id
        WHERE l.deleted_at IS NULL AND ${where}
        ORDER BY l.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM leads l WHERE l.deleted_at IS NULL AND ${where}`, params,
    );
    res.json({ data: rows.map(leadRow), meta: { total: Number(total), page, limit } });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /reseller-app/leads
// =============================================================================
router.post('/leads', requirePermission('reseller_app.signup'), resellerSignupLimiter, validate(signupLeadSchema), async (req, res, next) => {
  try {
    const rootId = req.resellerScope.rootId;
    const [[reseller]] = await db.query(
      'SELECT id, status FROM resellers WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
      [rootId, req.orgId],
    );
    if (!reseller) throw new NotFoundError('Reseller');
    if (reseller.status !== 'active') {
      throw new ForbiddenError('Your reseller account is not active; contact the ISP');
    }

    // Empty optional fields are stored as NULL.
    const body = {};
    for (const field of LEAD_FIELDS) {
      const value = req.body[field];
      body[field] = value === undefined || value === '' ? null : value;
    }
    if ((body.latitude === null) !== (body.longitude === null)) {
      throw new ValidationError('latitude and longitude must be sent together');
    }
    if (body.rfc !== null) body.rfc = String(body.rfc).trim().toUpperCase();

    let planName = null;
    if (body.desired_plan_id !== null) {
      const plan = (await allowedPlans(req.orgId, rootId)).find((p) => p.id === Number(body.desired_plan_id));
      if (!plan) throw new ValidationError('desired_plan_id: this plan is not offered by your reseller');
      planName = plan.name;
    }

    // A lead the reseller captured, for the ISP to contact, convert and
    // install. Who captured it is in the audit log; the reseller in reseller_id.
    const [result] = await db.query(
      `INSERT INTO leads
         (organization_id, reseller_id, name, phone, email, address, city, latitude, longitude,
          desired_plan_id, rfc, razon_social, regimen_fiscal, codigo_postal_fiscal, notes, source, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'referral', 'new')`,
      [req.orgId, rootId, body.name, body.phone, body.email, body.address, body.city,
        body.latitude, body.longitude, body.desired_plan_id, body.rfc, body.razon_social,
        body.regimen_fiscal, body.codigo_postal_fiscal, body.notes],
    );
    const leadId = result.insertId;
    await auditLog.log({
      userId: req.user.id,
      organizationId: req.orgId,
      action: 'create',
      tableName: 'leads',
      recordId: leadId,
      newValues: { reseller_id: rootId, name: body.name, phone: body.phone, desired_plan_id: body.desired_plan_id },
    });

    const [[row]] = await db.query(
      `SELECT id, name, phone, email, address, city, latitude, longitude, status, desired_plan_id,
              reseller_id, created_at, converted_client_id
         FROM leads WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
      [leadId, req.orgId],
    );
    const lead = row || { id: leadId, ...body, status: 'new', reseller_id: rootId, converted_client_id: null };
    res.status(201).json({
      data: {
        ...leadRow({ ...lead, desired_plan_name: planName }),
        email: lead.email ?? null,
        address: lead.address ?? null,
        city: lead.city ?? null,
        latitude: lead.latitude === null || lead.latitude === undefined ? null : Number(lead.latitude),
        longitude: lead.longitude === null || lead.longitude === undefined ? null : Number(lead.longitude),
        reseller_id: Number(lead.reseller_id),
      },
    });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /reseller-app/leads/:id/feasibility
// =============================================================================
router.get('/leads/:id/feasibility', requirePermission('reseller_app.use'), async (req, res, next) => {
  try {
    const id = positiveId(req.params.id);
    const ids = subtree(req);
    if (!id || !ids.length) throw new NotFoundError('Lead');
    const [[lead]] = await db.query(
      `SELECT id FROM leads
        WHERE id = ? AND organization_id = ? AND deleted_at IS NULL
          AND reseller_id IN (${inPlaceholders(ids)})
        LIMIT 1`,
      [id, req.orgId, ...ids],
    );
    if (!lead) throw new NotFoundError('Lead');
    const result = await leadFeasibilityService.assess(id, req.orgId);
    res.json({ data: resellerFeasibilitySummary(result) });
  } catch (err) { next(err); }
});

// Phase 2: cash collection, receipts, the cash box and the ledger.
router.use(require('./resellerAppCollect'));
// Phase 3: the reseller's cash bags.
router.use(require('./resellerAppBags'));
// Phase 5: the reseller's statements (estados de cuenta).
router.use(require('./resellerAppStatements'));
// Phase 5b: "Reportar falla" and the signing link of a lead's installation.
router.use(require('./resellerAppSupport'));

module.exports = router;
module.exports.assertClientInResellerScope = assertClientInResellerScope;
module.exports.allowedPlans = allowedPlans;
module.exports.resellerFeasibilitySummary = resellerFeasibilitySummary;
module.exports.FEASIBILITY_NEARBY_KM = FEASIBILITY_NEARBY_KM;

// =============================================================================
// VigaBSS 5.0 — Carrier accounts, staff side (reseller app phase 3)
// =============================================================================
// A carrier is a staff user in the seeded 'carrier' group: it uses only the
// carrier app (/carrier-app, the SPA's /ruta) and sees only the top-level
// resellers assigned to it here.
//
//  GET /carriers                       carriers with their resellers and bags in hand
//  POST /carriers                      create a carrier login (also users.create or point_logins.create)
//  GET /carriers/assignable-resellers  top-level resellers a carrier may be given
//  GET /carriers/:userId/resellers     resellers assigned to a carrier
//  PUT /carriers/:userId/resellers     replace that set
//
// Org-level staff with carriers.manage only (refused to reseller-bound users
// and carriers).
// =============================================================================

const { Router } = require('express');
const bcrypt = require('bcryptjs');
const { authenticate } = require('../middleware/auth');
const { orgScope } = require('../middleware/orgScope');
const { requirePermission } = require('../middleware/rbac');
const { validate } = require('../middleware/validate');
const { resellerScope } = require('../middleware/resellerScope');
const { createUser: createUserSchema } = require('../middleware/schemas/users');
const { SALT_ROUNDS: PASSWORD_SALT_ROUNDS } = require('../middleware/hashPassword');
const { assertPasswordAllowed } = require('../services/passwordPolicyService');
const { isCarrierRequest, carrierGroupId } = require('../services/carrierAccount');
const carrierService = require('../services/carrierService');
const auditLog = require('../services/auditLog');
const User = require('../models/User');
const { runInPrimaryContext } = require('../utils/primaryContext');
const { ConflictError, ForbiddenError, NotFoundError, ValidationError } = require('../utils/errors');

const router = Router();
router.use(authenticate);
router.use(orgScope);
router.use(resellerScope);

async function requireOrgStaff(req, _res, next) {
  try {
    if (!req.resellerScope || !req.resellerScope.all) {
      return next(new ForbiddenError('Only the ISP can manage carriers'));
    }
    if (await isCarrierRequest(req)) return next(new ForbiddenError('Carrier accounts can only use the carrier app'));
    next();
  } catch (err) { next(err); }
}
router.use(requireOrgStaff);

// Same validation and password policy as a reseller login (POST
// /resellers/:id/users) and POST /users.
const createCarrierSchema = Object.fromEntries(
  ['first_name', 'last_name', 'email', 'password', 'phone'].map((field) => [field, { ...createUserSchema[field] }]),
);

const assignmentsSchema = {
  reseller_ids: { type: 'array', required: true },
};

async function carrierOr404(req) {
  const carrier = await carrierService.findCarrier(req.orgId, req.params.userId);
  if (!carrier) throw new NotFoundError('Carrier');
  return carrier;
}

// =============================================================================
// GET /carriers
// =============================================================================
router.get('/', requirePermission('carriers.manage'), async (req, res, next) => {
  try {
    const users = await carrierService.listCarrierUsers(req.orgId);
    const ids = users.map((u) => Number(u.id));
    const [assignments, inHand] = await Promise.all([
      carrierService.assignmentsFor(req.orgId, ids),
      carrierService.bagsInHandFor(req.orgId, ids),
    ]);
    res.json({
      data: users.map((u) => ({
        user_id: Number(u.id),
        first_name: u.first_name,
        last_name: u.last_name,
        email: u.email,
        phone: u.phone ?? null,
        status: u.status,
        resellers: assignments.get(Number(u.id)) || [],
        bags_in_hand: inHand.get(Number(u.id)) || { with_carrier: 0, in_transit: 0 },
      })),
    });
  } catch (err) { next(err); }
});

// =============================================================================
// POST /carriers
// =============================================================================
// A staff user in the carrier group, homed in this organization. It is never
// bound to a reseller (PUT /resellers/:id/users/:userId refuses a carrier).
// Creating a login needs users.create or point_logins.create as well, like a
// reseller login (POST /resellers/:id/users): carriers.manage alone only
// assigns resellers.
router.post('/', requirePermission('carriers.manage'), requirePermission('users.create', 'point_logins.create'), validate(createCarrierSchema, { strip: true }), async (req, res, next) => {
  try {
    const email = String(req.body.email).trim();
    const existing = await runInPrimaryContext(() => User.findByEmail(email));
    if (existing) throw new ConflictError('A user with this email already exists');
    await assertPasswordAllowed(req.body.password, req.orgId);
    const passwordHash = await bcrypt.hash(req.body.password, PASSWORD_SALT_ROUNDS);
    const groupId = await carrierGroupId();
    if (!groupId) throw new ValidationError('The carrier user group is missing');
    const phone = typeof req.body.phone === 'string' && req.body.phone.trim() ? req.body.phone.trim() : null;

    const user = await User.create({
      organization_id: req.orgId,
      first_name: req.body.first_name,
      last_name: req.body.last_name,
      email,
      phone,
      password_hash: passwordHash,
      group_id: groupId,
      status: 'active',
    });
    await auditLog.log({
      userId: req.user.id,
      organizationId: req.orgId,
      action: 'create',
      tableName: 'users',
      recordId: user.id,
      newValues: { email, group_id: groupId, carrier: true },
    });
    res.status(201).json({
      data: {
        user_id: Number(user.id),
        first_name: req.body.first_name,
        last_name: req.body.last_name,
        email,
        phone,
      },
    });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /carriers/assignable-resellers
// =============================================================================
// The assignment picker's list: every live top-level reseller (up to
// carrierService.MAX_ASSIGNABLE) with carriers.manage alone, so assigning
// needs neither resellers.view nor paging through GET /resellers.
router.get('/assignable-resellers', requirePermission('carriers.manage'), async (req, res, next) => {
  try {
    const { rows, total } = await carrierService.assignableResellers(req.orgId);
    res.json({ data: rows, meta: { total, truncated: total > rows.length } });
  } catch (err) { next(err); }
});

// =============================================================================
// GET /carriers/:userId/resellers
// =============================================================================
router.get('/:userId/resellers', requirePermission('carriers.manage'), async (req, res, next) => {
  try {
    const carrier = await carrierOr404(req);
    res.json({ data: await carrierService.assignmentRows(req.orgId, Number(carrier.id)) });
  } catch (err) { next(err); }
});

// =============================================================================
// PUT /carriers/:userId/resellers
// =============================================================================
router.put('/:userId/resellers', requirePermission('carriers.manage'), validate(assignmentsSchema), async (req, res, next) => {
  try {
    const carrier = await carrierOr404(req);
    const raw = req.body.reseller_ids;
    if (!raw.every((id) => Number.isInteger(id) && id > 0)) {
      throw new ValidationError('reseller_ids must be an array of reseller ids');
    }
    if (raw.length > 500) throw new ValidationError('reseller_ids: at most 500 resellers');
    const { before, after } = await carrierService.setAssignments(req.orgId, Number(carrier.id), raw, req.user.id);
    await auditLog.log({
      userId: req.user.id,
      organizationId: req.orgId,
      action: 'update',
      tableName: 'carrier_reseller_assignments',
      recordId: Number(carrier.id),
      oldValues: { reseller_ids: before },
      newValues: { reseller_ids: after },
    });
    res.json({ data: await carrierService.assignmentRows(req.orgId, Number(carrier.id)) });
  } catch (err) { next(err); }
});

module.exports = router;

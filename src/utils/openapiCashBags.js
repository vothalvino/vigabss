// =============================================================================
// OpenAPI paths and schemas of the reseller app, phase 3 (migration 005):
// cash bags, carriers and the carrier app. Merged into the spec by
// src/utils/openapi.js; routes in src/routes/cashBags.js, carriers.js,
// carrierApp.js, resellerAppBags.js and resellers.js (GET /resellers/:id/bags).
// =============================================================================

const BAG_STATUSES = ['in_stock', 'with_carrier', 'at_reseller', 'ready_for_pickup', 'in_transit', 'received', 'void', 'lost'];

const nullableString = (format) => (format ? { type: ['string', 'null'], format } : { type: ['string', 'null'] });
const nullableInteger = () => ({ type: ['integer', 'null'] });
const nullableNumber = () => ({ type: ['number', 'null'] });
const dateTime = () => ({ type: 'string', format: 'date-time' });

function obj(properties, required = Object.keys(properties)) {
  return { type: 'object', required, properties };
}
function data(schema) {
  return obj({ data: schema });
}
function list(item) {
  return obj({
    data: { type: 'array', items: item },
    meta: obj({ total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' } }),
  });
}
function ok(description, schema) {
  return { description, content: { 'application/json': { schema } } };
}
function err(description) {
  return {
    description,
    content: { 'application/json': { schema: obj({
      error: obj({
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
        requestId: { type: 'string' },
      }, ['code', 'message']),
    }) } },
  };
}
function body(schema, description) {
  return { description, required: true, content: { 'application/json': { schema } } };
}
const idParam = (name = 'id') => ({ name, in: 'path', required: true, schema: { type: 'integer' } });
const pageParam = () => ({ name: 'page', in: 'query', required: false, schema: { type: 'integer' } });
const limitParam = () => ({ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } });
const security = [{ bearerAuth: [] }];

const statusEnum = () => ({ type: 'string', enum: BAG_STATUSES });
const serial = () => ({ type: 'string', minLength: 1, maxLength: 64, description: 'Trimmed and uppercased by the server' });

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

function staffBagSchema() {
  return obj({
    id: { type: 'integer' },
    serial: { type: 'string' },
    status: statusEnum(),
    reseller_id: nullableInteger(),
    reseller_name: nullableString(),
    carrier_user_id: nullableInteger(),
    carrier_name: nullableString(),
    declared_amount: { ...nullableNumber(), description: 'Declared by the reseller when sealing' },
    counted_amount: { ...nullableNumber(), description: 'Counted by the ISP on receipt' },
    variance: { ...nullableNumber(), description: 'counted - declared, for a received bag' },
    currency: { type: 'string' },
    sealed_at: nullableString('date-time'),
    picked_up_at: nullableString('date-time'),
    received_at: nullableString('date-time'),
    notes: nullableString(),
    created_at: nullableString('date-time'),
    updated_at: nullableString('date-time'),
  });
}

function bagEventSchema() {
  return obj({
    id: { type: 'integer' },
    from_status: { type: ['string', 'null'], enum: [...BAG_STATUSES, null] },
    to_status: statusEnum(),
    actor_user_id: nullableInteger(),
    actor_name: nullableString(),
    amount: { ...nullableNumber(), description: 'Declared on seal, counted on receive' },
    reseller_id: nullableInteger(),
    reseller_name: nullableString(),
    carrier_user_id: nullableInteger(),
    carrier_name: nullableString(),
    latitude: nullableNumber(),
    longitude: nullableNumber(),
    note: nullableString(),
    created_at: dateTime(),
  });
}

function staffBagWithEventsSchema() {
  const base = staffBagSchema();
  return {
    ...base,
    required: [...base.required, 'events'],
    properties: { ...base.properties, events: { type: 'array', items: bagEventSchema() } },
  };
}

function statusCountsSchema() {
  return obj(Object.fromEntries(BAG_STATUSES.map((s) => [s, { type: 'integer' }])));
}

function varianceTotalsProperties() {
  return {
    received_bags: { type: 'integer' },
    bags_with_difference: { type: 'integer' },
    declared_total: { type: 'number' },
    counted_total: { type: 'number' },
    variance: { type: 'number', description: 'SUM(counted - declared) of received bags; negative = short' },
  };
}

function moneySummarySchema(staff) {
  const properties = {
    balance: { type: 'number', description: 'What the reseller owes the ISP (sum of its ledger); a sealed bag left it at sealing' },
    in_bags: { type: 'number', description: 'Declared cash in its sealed bags not yet received (ready_for_pickup, in_transit), already off the balance; for information' },
    cash_on_hand: { type: 'number', description: 'The cash it still holds: equal to balance' },
    credit_limit: { type: 'number', description: 'Effective limit' },
    available_to_collect: { type: 'number', description: 'max(0, credit_limit - cash_on_hand): the room left before the limit' },
    limit_reached: { type: 'boolean', description: 'cash_on_hand >= credit_limit: collections are refused until a bag is sealed or the cash handed in' },
  };
  if (staff) properties.credit_limit_override = { type: ['number', 'null'], description: "The reseller's own limit; null = the organization default" };
  return obj(properties);
}

function resellerAppBagSchema() {
  return obj({
    id: { type: 'integer' },
    serial: { type: 'string' },
    status: { type: 'string', enum: ['at_reseller', 'with_carrier', 'ready_for_pickup', 'in_transit'], description: 'with_carrier: a carrier is bringing it; it may already be sealed' },
    declared_amount: nullableNumber(),
    sealed_at: nullableString('date-time'),
    picked_up_at: nullableString('date-time'),
  });
}

function resellerAppBagMoneySchema() {
  return obj({
    currency: { type: 'string' },
    balance: { type: 'number' },
    in_bags: { type: 'number' },
    cash_on_hand: { type: 'number' },
    credit_limit: { type: 'number' },
    available_to_collect: { type: 'number' },
    limit_reached: { type: 'boolean' },
    empty_bags: { type: 'integer', description: 'Empty bags it may fill: at_reseller plus those a carrier is bringing it (with_carrier)' },
    bags_on_the_way: { type: 'integer', description: 'Empty bags a carrier is bringing it (with_carrier)' },
    bags_ready_for_pickup: { type: 'integer' },
    bags_in_transit: { type: 'integer' },
  });
}

function ledgerEntrySchema() {
  return obj({
    id: { type: 'integer' },
    entry_type: { type: 'string', enum: ['collection', 'collection_void', 'deposit', 'adjustment', 'bag_sealed'] },
    amount: { type: 'number', description: 'Signed: + increases what the reseller owes' },
    currency: { type: 'string' },
    note: nullableString(),
    created_at: dateTime(),
    payment_id: nullableInteger(),
    cash_session_id: nullableInteger(),
    created_by: nullableInteger(),
    cash_bag_id: nullableInteger(),
    cash_bag_serial: nullableString(),
  });
}

function carrierBagSchema() {
  return obj({
    id: { type: 'integer' },
    serial: { type: 'string' },
    status: { type: 'string', enum: ['with_carrier', 'in_transit'] },
    reseller_id: { ...nullableInteger(), description: 'with_carrier: the point it is for (null = any assigned point); in_transit: where it was picked up' },
    reseller_name: nullableString(),
    picked_up_at: { ...nullableString('date-time'), description: 'in_transit only' },
  });
}

function carrierRowSchema() {
  return obj({
    user_id: { type: 'integer' },
    first_name: { type: 'string' },
    last_name: { type: 'string' },
    email: { type: 'string' },
    phone: nullableString(),
    status: { type: 'string', enum: ['active', 'inactive'] },
    resellers: { type: 'array', items: obj({ id: { type: 'integer' }, name: { type: 'string' } }) },
    bags_in_hand: obj({ with_carrier: { type: 'integer' }, in_transit: { type: 'integer' } }),
  });
}

function carrierAssignmentSchema() {
  return obj({ id: { type: 'integer' }, name: { type: 'string' }, city: nullableString(), phone: nullableString() });
}

const ORG_ONLY = 'Reseller-bound users and carriers are refused';
const NOT_CARRIER = 'Only carrier accounts can use the carrier app';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function cashBagPaths() {
  const coordinates = {
    latitude: { type: 'number', minimum: -90, maximum: 90 },
    longitude: { type: 'number', minimum: -180, maximum: 180 },
  };
  return {
    // ---- Reseller app, phase 3: cash bags ----
    '/reseller-app/bags': {
      get: { tags: ['Reseller App'], summary: "The collecting reseller's live cash bags (empty at_reseller, empty with_carrier on their way to it, ready_for_pickup, in_transit; received, void and lost ones do not appear) and its money position. Needs reseller_app.bags", operationId: 'listResellerAppBags', security, responses: { 200: ok('Bags', obj({ data: { type: 'array', items: resellerAppBagSchema() }, summary: resellerAppBagMoneySchema() })), 403: err('Not a reseller account, or no reseller_app.bags') } },
    },
    '/reseller-app/bags/seal': {
      post: { tags: ['Reseller App'], summary: 'Fill an empty bag of the reseller (at_reseller, or with_carrier when staff assigned it and the carrier has not confirmed the delivery) with the cash it holds: declared_amount must be more than 0 and at most cash_on_hand, with 2 decimals. The bag becomes ready_for_pickup and, in the same transaction, a bag_sealed ledger entry of -declared_amount takes the cash off the balance (and cash_on_hand), which frees the limit at once; in_bags shows it until the bag is received. Locks the reseller row, then the bag. Needs reseller_app.bags', operationId: 'sealResellerAppBag', security, requestBody: body(obj({ serial: serial(), declared_amount: { type: 'number', minimum: 0.01 } }), 'The bag and the cash in it'), responses: { 200: ok('Sealed', data(obj({ bag: resellerAppBagSchema(), summary: resellerAppBagMoneySchema() }))), 403: err('Not a reseller account, or no reseller_app.bags'), 404: err('No empty bag of this reseller with that serial'), 409: err('BAG_AMOUNT_EXCEEDS_CASH: more than the cash on hand (details.cash_on_hand)'), 422: err('Validation failed') } },
    },

    // ---- Carrier app (/ruta) ----
    '/carrier-app/me': {
      get: { tags: ['Carrier App'], summary: 'The carrier, the bags it holds (stock = with_carrier, in_transit) and how many resellers it is assigned', operationId: 'getCarrierAppMe', security, responses: { 200: ok('Carrier', data(obj({ carrier: obj({ user_id: { type: 'integer' }, first_name: { type: 'string' }, last_name: { type: 'string' }, name: nullableString() }), counts: obj({ stock: { type: 'integer' }, in_transit: { type: 'integer' }, assigned_resellers: { type: 'integer' } }) }))), 403: err(NOT_CARRIER) } },
    },
    '/carrier-app/resellers': {
      get: { tags: ['Carrier App'], summary: 'The resellers assigned to the carrier, with where to find them and their bag counts. No money, clients or ledger', operationId: 'listCarrierAppResellers', security, responses: { 200: ok('Resellers', data({ type: 'array', items: obj({ id: { type: 'integer' }, name: { type: 'string' }, address: nullableString(), city: nullableString(), phone: nullableString(), latitude: nullableNumber(), longitude: nullableNumber(), counts: obj({ ready_for_pickup: { type: 'integer' }, empty_bags: { type: 'integer', description: 'Empty bags it has (at_reseller)' }, to_deliver: { type: 'integer', description: 'Empty bags assigned to it that a carrier holds (with_carrier)' } }) }) })), 403: err(NOT_CARRIER) } },
    },
    '/carrier-app/bags': {
      get: { tags: ['Carrier App'], summary: "The carrier's own bags: its stock of empty bags (with_carrier) and those it carries (in_transit). Never an amount", operationId: 'listCarrierAppBags', security, responses: { 200: ok('Bags', data({ type: 'array', items: carrierBagSchema() })), 403: err(NOT_CARRIER) } },
    },
    '/carrier-app/pickup': {
      post: { tags: ['Carrier App'], summary: 'Pick up a sealed bag at an assigned reseller by its typed or scanned serial: it must be a ready_for_pickup bag of that reseller, and becomes in_transit with the carrier. Needs carrier_app.pickup. The answer carries no amount', operationId: 'carrierAppPickup', security, requestBody: body(obj({ reseller_id: { type: 'integer', minimum: 1 }, serial: serial(), ...coordinates }, ['reseller_id', 'serial']), 'The reseller and the serial'), responses: { 200: ok('Picked up', data(obj({ id: { type: 'integer' }, serial: { type: 'string' }, status: { type: 'string', enum: ['in_transit'] }, reseller_id: { type: 'integer' }, reseller_name: { type: 'string' }, picked_up_at: nullableString('date-time') }))), 403: err(NOT_CARRIER), 404: err('No bag ready for pickup with that serial at that reseller (an unknown serial, another reseller, an unassigned reseller and a bag that is not ready all answer the same)'), 422: err('Validation failed') } },
    },
    '/carrier-app/dropoff': {
      post: { tags: ['Carrier App'], summary: "Confirm the delivery of empty bags of the carrier's own stock (with_carrier) to their point: 1 to 50 serials, all or nothing. A bag staff assigned to another point is refused; one with no point (taken back from a point) takes this one. Needs carrier_app.pickup", operationId: 'carrierAppDropoff', security, requestBody: body(obj({ reseller_id: { type: 'integer', minimum: 1 }, serials: { type: 'array', minItems: 1, maxItems: 50, items: serial() }, ...coordinates }, ['reseller_id', 'serials']), 'The reseller and the serials'), responses: { 200: ok('Dropped off', data(obj({ reseller_id: { type: 'integer' }, reseller_name: { type: 'string' }, bags: { type: 'array', items: obj({ serial: { type: 'string' }, status: { type: 'string', enum: ['at_reseller'] } }) } }))), 403: err(NOT_CARRIER), 404: err('Reseller not assigned to the carrier'), 422: err('BAGS_NOT_IN_YOUR_STOCK (details.failed lists the serials that are not empty bags in your stock), BAGS_FOR_ANOTHER_POINT (details.failed), or validation failed') } },
    },

    // ---- Staff: cash bags ----
    '/cash-bags': {
      get: { tags: ['Cash Bags'], summary: 'A page of the organization\'s cash bags, most recently changed first. Needs cash_bags.view (org-level staff only)', operationId: 'listCashBags', security, parameters: [{ name: 'status', in: 'query', required: false, description: 'One status or a comma-separated list', schema: { type: 'string' } }, { name: 'reseller_id', in: 'query', required: false, schema: { type: 'integer' } }, { name: 'carrier_user_id', in: 'query', required: false, schema: { type: 'integer' } }, { name: 'serial', in: 'query', required: false, description: 'Part of the serial', schema: { type: 'string' } }, { name: 'has_variance', in: 'query', required: false, description: 'Only received bags whose count differs from the declared amount', schema: { type: 'string', enum: ['1', 'true'] } }, pageParam(), limitParam()], responses: { 200: ok('Bags', list(staffBagSchema())), 403: err(ORG_ONLY), 422: err('Invalid filter') } },
      post: { tags: ['Cash Bags'], summary: 'Register one serial, or a range prefix + from..to (at most 500, each number padded to pad digits, default the digits of to). Existing serials are skipped and reported. Needs cash_bags.manage', operationId: 'registerCashBags', security, requestBody: body({ type: 'object', properties: { serial: serial(), prefix: { type: 'string', maxLength: 40 }, from: { type: 'integer', minimum: 0 }, to: { type: 'integer', minimum: 0 }, pad: { type: 'integer', minimum: 0, maximum: 12 }, notes: { type: 'string', maxLength: 500 } } }, 'A serial, or a range'), responses: { 201: ok('Registered', data(obj({ created: { type: 'array', items: obj({ id: { type: 'integer' }, serial: { type: 'string' } }) }, skipped: { type: 'array', items: { type: 'string' } } }))), 403: err(ORG_ONLY), 409: err('BAG_SERIALS_EXIST: every serial is already registered (details.skipped)'), 422: err('Validation failed') } },
    },
    '/cash-bags/summary': {
      get: { tags: ['Cash Bags'], summary: 'Bag counts per status, the cash in sealed bags, and the differences of received bags per reseller. Needs cash_bags.view', operationId: 'getCashBagSummary', security, responses: { 200: ok('Summary', data(obj({ counts: statusCountsSchema(), in_bags: { type: 'number' }, resellers: { type: 'array', items: obj({ reseller_id: nullableInteger(), reseller_name: nullableString(), ...varianceTotalsProperties() }) } }))), 403: err(ORG_ONLY) } },
    },
    '/cash-bags/handover': {
      post: { tags: ['Cash Bags'], summary: 'Hand bags in stock to a carrier for one point (in_stock -> with_carrier, reseller_id set), by serials or bag ids, all or nothing. The point (a top-level reseller or collector) must be assigned to the carrier; from now on the bags appear on its page and it may seal them. Needs cash_bags.manage', operationId: 'handOverCashBags', security, requestBody: body({ type: 'object', required: ['carrier_user_id', 'reseller_id'], properties: { carrier_user_id: { type: 'integer', minimum: 1 }, reseller_id: { type: 'integer', minimum: 1, description: 'The point the bags are for' }, serials: { type: 'array', minItems: 1, maxItems: 500, items: serial() }, bag_ids: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'integer', minimum: 1 } } } }, 'The carrier, the point and the bags (serials or bag_ids)'), responses: { 200: ok('Handed over', data(obj({ carrier_user_id: { type: 'integer' }, carrier_name: nullableString(), reseller_id: { type: 'integer' }, reseller_name: { type: 'string' }, bags: { type: 'array', items: obj({ id: { type: 'integer' }, serial: { type: 'string' }, status: { type: 'string', enum: ['with_carrier'] } }) } }))), 403: err(ORG_ONLY), 422: err('BAGS_NOT_IN_STOCK (details.failed), not a carrier, POINT_NOT_ASSIGNED_TO_CARRIER, or validation failed') } },
    },
    '/cash-bags/{id}': {
      get: { tags: ['Cash Bags'], summary: 'One bag with its history (every transition, who and when). Needs cash_bags.view', operationId: 'getCashBag', security, parameters: [idParam()], responses: { 200: ok('Bag', data(staffBagWithEventsSchema())), 403: err(ORG_ONLY), 404: err('Bag not found') } },
    },
    '/cash-bags/{id}/receive': {
      post: { tags: ['Cash Bags'], summary: 'Count a bag and receive it (from in_transit, or from ready_for_pickup when the reseller brought it in person). The declared amount left the reseller ledger when the bag was sealed (bag_sealed), so only a difference is posted: an adjustment of declared - counted (a short bag raises the debt, an over bag lowers it); ledger_entries is empty when the count matches. A bag sealed before migration 006 without a bag_sealed entry also gets the deposit of -declared. Locks the reseller row, then the bag. Needs cash_bags.receive', operationId: 'receiveCashBag', security, parameters: [idParam()], requestBody: body(obj({ counted_amount: { type: 'number', minimum: 0 }, note: { type: 'string', maxLength: 400 } }, ['counted_amount']), 'The count'), responses: { 200: ok('Received', data(obj({ bag: staffBagSchema(), ledger_entries: { type: 'array', items: ledgerEntrySchema() }, summary: moneySummarySchema(true) }))), 403: err(ORG_ONLY), 404: err('Bag not found'), 409: err('BAG_INVALID_TRANSITION: the bag is not ready_for_pickup or in_transit; BAG_CHANGED: retry'), 422: err('Validation failed') } },
    },
    '/cash-bags/{id}/void': {
      post: { tags: ['Cash Bags'], summary: 'Take a bag with no declared money out of use (from in_stock, with_carrier or at_reseller). Needs cash_bags.manage', operationId: 'voidCashBag', security, parameters: [idParam()], requestBody: body(obj({ reason: { type: 'string', minLength: 3, maxLength: 500 } }), 'Why'), responses: { 200: ok('Voided', data(staffBagSchema())), 403: err(ORG_ONLY), 404: err('Bag not found'), 409: err('BAG_INVALID_TRANSITION'), 422: err('Validation failed') } },
    },
    '/cash-bags/{id}/lost': {
      post: { tags: ['Cash Bags'], summary: 'Mark a bag with money in it lost (from ready_for_pickup or in_transit). Nothing is posted: its declared amount left the reseller ledger when it was sealed, so the reseller does not owe it and the ISP absorbs the loss (an administrator who holds the reseller liable records an adjustment). The bag leaves in_bags. Needs cash_bags.manage', operationId: 'markCashBagLost', security, parameters: [idParam()], requestBody: body(obj({ reason: { type: 'string', minLength: 3, maxLength: 500 } }), 'Why'), responses: { 200: ok('Lost', data(staffBagSchema())), 403: err(ORG_ONLY), 404: err('Bag not found'), 409: err('BAG_INVALID_TRANSITION'), 422: err('Validation failed') } },
    },
    '/cash-bags/{id}/return': {
      post: { tags: ['Cash Bags'], summary: 'A carrier hands stock back (with_carrier -> in_stock, its point cleared), or takes an empty bag back from a reseller (at_reseller -> with_carrier, to carrier_user_id or the carrier that dropped it off). Needs cash_bags.manage', operationId: 'returnCashBag', security, parameters: [idParam()], requestBody: body({ type: 'object', properties: { reason: { type: 'string', maxLength: 500 }, carrier_user_id: { type: 'integer', minimum: 1 } } }, 'Optional reason and carrier'), responses: { 200: ok('Returned', data(staffBagSchema())), 403: err(ORG_ONLY), 404: err('Bag not found'), 409: err('BAG_INVALID_TRANSITION'), 422: err('Validation failed') } },
    },
    '/resellers/{id}/bags': {
      get: { tags: ['Resellers'], summary: "A page of the reseller's cash bags with their history, and its totals: counts per status, cash in bags, and the differences of received bags. Needs cash_bags.view (org-level staff only)", operationId: 'listResellerCashBags', security, parameters: [idParam(), pageParam(), limitParam()], responses: { 200: ok('Bags', obj({ data: { type: 'array', items: staffBagWithEventsSchema() }, summary: obj({ counts: statusCountsSchema(), in_bags: { type: 'number' }, ...varianceTotalsProperties() }), meta: obj({ total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' } }) })), 403: err(ORG_ONLY), 404: err('Reseller not found') } },
    },

    // ---- Staff: carriers ----
    '/carriers': {
      get: { tags: ['Carriers'], summary: 'Carrier accounts of the organization, with their assigned resellers and the bags they hold. Needs carriers.manage', operationId: 'listCarriers', security, responses: { 200: ok('Carriers', data({ type: 'array', items: carrierRowSchema() })), 403: err(ORG_ONLY) } },
      post: { tags: ['Carriers'], summary: 'Create a carrier login: a staff user in the carrier group, homed in this organization, with the same validation and password policy as POST /users. Needs carriers.manage and users.create or point_logins.create', operationId: 'createCarrier', security, requestBody: body(obj({ first_name: { type: 'string', minLength: 1, maxLength: 100 }, last_name: { type: 'string', minLength: 1, maxLength: 100 }, email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8, maxLength: 128 }, phone: { type: 'string', maxLength: 30 } }, ['first_name', 'last_name', 'email', 'password']), 'The new login'), responses: { 201: ok('Created', data(obj({ user_id: { type: 'integer' }, first_name: { type: 'string' }, last_name: { type: 'string' }, email: { type: 'string' }, phone: nullableString() }))), 403: err(`${ORG_ONLY}; also refused without carriers.manage, or without both users.create and point_logins.create`), 409: err('A user with this email already exists'), 422: err('Validation failed or the password policy refused the password') } },
    },
    '/carriers/assignable-resellers': {
      get: { tags: ['Carriers'], summary: 'The live top-level resellers of the organization a carrier may be assigned, by name (the assignment picker; at most 2000, meta.truncated when there are more). Needs carriers.manage only', operationId: 'listAssignableCarrierResellers', security, responses: { 200: ok('Resellers', obj({ data: { type: 'array', items: obj({ id: { type: 'integer' }, name: { type: 'string' }, city: nullableString() }) }, meta: obj({ total: { type: 'integer' }, truncated: { type: 'boolean' } }) })), 403: err(ORG_ONLY) } },
    },
    '/carriers/{userId}/resellers': {
      get: { tags: ['Carriers'], summary: 'Top-level resellers assigned to the carrier. Needs carriers.manage', operationId: 'listCarrierResellers', security, parameters: [idParam('userId')], responses: { 200: ok('Resellers', data({ type: 'array', items: carrierAssignmentSchema() })), 403: err(ORG_ONLY), 404: err('Carrier not found') } },
      put: { tags: ['Carriers'], summary: 'Replace the resellers the carrier may see and visit (top-level resellers of the organization; an empty list removes all). Needs carriers.manage', operationId: 'setCarrierResellers', security, parameters: [idParam('userId')], requestBody: body(obj({ reseller_ids: { type: 'array', maxItems: 500, items: { type: 'integer', minimum: 1 } } }), 'Reseller ids'), responses: { 200: ok('Resellers', data({ type: 'array', items: carrierAssignmentSchema() })), 403: err(ORG_ONLY), 404: err('Carrier not found'), 422: err('Not a top-level reseller of this organization') } },
    },
  };
}

module.exports = { cashBagPaths, moneySummarySchema, BAG_STATUSES };

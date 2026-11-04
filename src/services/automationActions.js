// =============================================================================
// VigaBSS — Automation rule actions and event triggers (ASY-36)
// =============================================================================
// An automation rule is "when <trigger_event> happens and its conditions hold,
// do <action_type>". Rules only ran through the manual /execute route, and no
// action did anything (ASY-16 made them say so). Now:
//
//   - create_ticket opens a ticket (source 'automation') for the event's client;
//   - suspend_contract suspends the event's contract through suspensionService;
//   - send_notification queues an email or SMS to the event's client through
//     the message outbox, under the client's communication preferences;
//   - any other action_type is refused when a rule is saved, and a stored rule
//     with one records 'skipped: not implemented'.
//
// Every business event on eventBus runs the organization's enabled rules for
// that event. An event raised by a rule's own action (the ticket.created of a
// create_ticket rule) does not run rules again, so rules cannot loop.
//
// The event's client, contract and invoice come from its payload (the rows
// businessEvents attaches, or plain *_id fields for a manual run) and are
// checked against the organization before anything is done to them.
// =============================================================================

const { AsyncLocalStorage } = require('async_hooks');
const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'automationActions' });

const TICKET_PRIORITIES = ['low', 'medium', 'high', 'critical'];
const TICKET_CATEGORIES = ['technical', 'billing', 'installation', 'general'];
const NOTIFICATION_CHANNELS = ['email', 'sms'];
const MESSAGE_CLASSES = ['transactional', 'marketing'];

/** Set while a rule's action runs; events raised meanwhile run no rules. */
const ruleScope = new AsyncLocalStorage();

const done = message => ({ status: 'done', message });
const skipped = message => ({ status: 'skipped', message });

function pick(...values) {
  return values.find(v => v !== undefined && v !== null && v !== '');
}

/** The client, contract and invoice an event is about. */
function eventSubjects(payload = {}) {
  const p = payload || {};
  return {
    clientId: pick(p.client_id, p.client?.id, p.contract?.client_id, p.invoice?.client_id,
      p.ticket?.client_id, p.payment?.client_id),
    contractId: pick(p.contract_id, p.contract?.id, p.invoice?.contract_id, p.ticket?.contract_id),
    invoiceId: pick(p.invoice_id, p.invoice?.id),
  };
}

async function ownedClient(clientId, organizationId) {
  if (!clientId) return null;
  const [[row]] = await db.query(
    'SELECT id, name, email, phone FROM clients WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [clientId, organizationId],
  );
  return row || null;
}

async function ownedContract(contractId, organizationId) {
  if (!contractId) return null;
  const [[row]] = await db.query(
    'SELECT id, client_id, status FROM contracts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [contractId, organizationId],
  );
  return row || null;
}

/** The event's client, or the client of its contract. */
async function eventClient(payload, organizationId) {
  const { clientId, contractId } = eventSubjects(payload);
  if (clientId) return ownedClient(clientId, organizationId);
  const contract = await ownedContract(contractId, organizationId);
  return contract ? ownedClient(contract.client_id, organizationId) : null;
}

/** Fill {{a.b}} placeholders from the event payload; unknown ones become ''. */
function fill(template, payload) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path) => {
    const value = path.split('.').reduce((obj, key) => (obj && obj[key] !== undefined ? obj[key] : undefined), payload);
    return value === undefined || value === null || typeof value === 'object' ? '' : String(value);
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function createTicket(config, payload, organizationId, rule) {
  const client = await eventClient(payload, organizationId);
  if (!client) return skipped('The event names no client of this organization; no ticket was opened');
  const { contractId } = eventSubjects(payload);
  const contract = await ownedContract(contractId, organizationId);
  const subject = fill(config.subject, payload).trim().slice(0, 255)
    || `${rule.name || 'Automation rule'}: ${payload.event || rule.trigger_event}`;
  const description = [
    fill(config.description, payload).trim(),
    `Opened by automation rule #${rule.id} (${rule.name || 'unnamed'}) on ${payload.event || rule.trigger_event}.`,
  ].filter(Boolean).join('\n\n');
  const priority = TICKET_PRIORITIES.includes(config.priority) ? config.priority : 'medium';
  const category = TICKET_CATEGORIES.includes(config.category) ? config.category : 'general';

  const [created] = await db.query(
    `INSERT INTO tickets
       (organization_id, client_id, contract_id, subject, description, priority, category, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 'automation')`,
    [organizationId, client.id, contract?.id ?? null, subject, description, priority, category],
  );
  await require('./businessEvents').emitTicketCreated(organizationId, {
    id: created.insertId, organization_id: organizationId, client_id: client.id,
    contract_id: contract?.id ?? null, subject, category, priority, status: 'open', source: 'automation',
  });
  return done(`Ticket #${created.insertId} opened for client #${client.id}`);
}

async function suspendContract(config, payload, organizationId) {
  const { contractId, invoiceId } = eventSubjects(payload);
  const contract = await ownedContract(contractId, organizationId);
  if (!contract) return skipped('The event names no contract of this organization; nothing was suspended');
  if (contract.status !== 'active') return skipped(`Contract #${contract.id} is ${contract.status}; nothing was suspended`);
  const [[invoice]] = invoiceId
    ? await db.query('SELECT id FROM invoices WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [invoiceId, organizationId])
    : [[null]];
  // No suspension rule id: that argument makes suspendContract require an
  // overdue balance, which is the billing rules' condition, not this one's.
  const outcome = await require('./suspensionService').suspendContract(contract.id, null, null, invoice?.id ?? null);
  if (outcome && outcome.skipped) return skipped(`Contract #${contract.id} was not suspended: ${outcome.reason || 'skipped'}`);
  return done(`Contract #${contract.id} suspended`);
}

async function sendNotification(config, payload, organizationId, rule) {
  const client = await eventClient(payload, organizationId);
  if (!client) return skipped('The event names no client of this organization; nothing was sent');
  const channel = config.channel || 'email';
  const recipient = channel === 'email' ? client.email : client.phone;
  if (!recipient) return skipped(`Client #${client.id} has no ${channel === 'email' ? 'email address' : 'phone number'}`);
  const body = fill(config.message, payload).trim();
  const subject = fill(config.subject, payload).trim() || rule.name || 'Notification';

  const queued = await require('./messageOutbox').enqueue({
    channel,
    organizationId,
    clientId: client.id,
    messageClass: MESSAGE_CLASSES.includes(config.message_class) ? config.message_class : 'transactional',
    recipient,
    ...(channel === 'email'
      ? { subject, bodyText: body, bodyHtml: `<p>${require('./notificationService').escapeHtmlForTemplate(body)}</p>` }
      : { bodyText: body }),
    sourceType: 'automation_rule',
    sourceId: rule.id ?? null,
  });
  if (!queued.queued) return skipped(`Not sent: ${queued.code || 'blocked by the client\'s communication preferences'}`);
  return done(`${channel === 'email' ? 'Email' : 'SMS'} queued for client #${client.id} (outbox #${queued.id})`);
}

const ACTIONS = {
  create_ticket: createTicket,
  suspend_contract: suspendContract,
  send_notification: sendNotification,
};
const ACTION_TYPES = Object.freeze(Object.keys(ACTIONS));

/**
 * The problem with a rule's action, or null. Saved rules must name an action
 * that exists and carry the settings it needs.
 */
function actionConfigProblem(actionType, config = {}) {
  if (!ACTIONS[actionType]) return `action_type must be one of: ${ACTION_TYPES.join(', ')}`;
  const c = config || {};
  if (actionType === 'create_ticket') {
    if (c.priority !== undefined && !TICKET_PRIORITIES.includes(c.priority)) return `action_config.priority must be one of: ${TICKET_PRIORITIES.join(', ')}`;
    if (c.category !== undefined && !TICKET_CATEGORIES.includes(c.category)) return `action_config.category must be one of: ${TICKET_CATEGORIES.join(', ')}`;
  }
  if (actionType === 'send_notification') {
    if (c.channel !== undefined && !NOTIFICATION_CHANNELS.includes(c.channel)) return `action_config.channel must be one of: ${NOTIFICATION_CHANNELS.join(', ')}`;
    if (c.message_class !== undefined && !MESSAGE_CLASSES.includes(c.message_class)) return `action_config.message_class must be one of: ${MESSAGE_CLASSES.join(', ')}`;
    if (typeof c.message !== 'string' || !c.message.trim()) return 'send_notification needs action_config.message';
  }
  return null;
}

/**
 * Run one rule's action.
 * @returns {Promise<{ status: 'done'|'skipped'|'not_implemented', message: string }>}
 */
async function runAction(rule, payload, organizationId) {
  const action = ACTIONS[rule.action_type];
  if (!action) {
    logger.info({ organizationId, actionType: rule.action_type }, 'Automation action is not implemented; nothing was done');
    return { status: 'not_implemented', message: `Action '${rule.action_type}' is not implemented yet; nothing was done` };
  }
  const config = rule.action_config && typeof rule.action_config === 'object' ? rule.action_config : {};
  return ruleScope.run({ ruleId: rule.id }, () => action(config, payload || {}, organizationId, rule));
}

// ---------------------------------------------------------------------------
// Event triggers
// ---------------------------------------------------------------------------

const TRIGGER_CACHE_MS = 60 * 1000;
const triggerCache = new Map(); // organizationId -> { at, events: Set }

/** Forget the cached trigger events (a rule was saved or deleted). */
function invalidateTriggerCache(organizationId) {
  if (organizationId === undefined) triggerCache.clear();
  else triggerCache.delete(Number(organizationId));
}

async function hasRulesFor(organizationId, event) {
  const key = Number(organizationId);
  const cached = triggerCache.get(key);
  if (cached && Date.now() - cached.at < TRIGGER_CACHE_MS) return cached.events.has(event);
  const [rows] = await db.query(
    `SELECT DISTINCT trigger_event FROM automation_rules
      WHERE organization_id = ? AND is_enabled = 1 AND deleted_at IS NULL`,
    [key],
  );
  const events = new Set(rows.map(r => r.trigger_event));
  triggerCache.set(key, { at: Date.now(), events });
  return events.has(event);
}

async function onBusinessEvent(data = {}) {
  const { event } = data;
  const organizationId = data.organizationId ?? data.organization_id;
  if (!event || organizationId === undefined || organizationId === null) return;
  if (ruleScope.getStore()) {
    logger.debug({ event, ruleId: ruleScope.getStore().ruleId }, 'Event raised by a rule action; rules not run again');
    return;
  }
  if (!await hasRulesFor(organizationId, event)) return;
  const { organizationId: _o, organization_id: _oi, ...payload } = data;
  await require('./automationService').evaluateAutomationRules(Number(organizationId), event, payload);
}

let registered = false;
/** Run automation rules on every business event (once per process). */
function registerAutomationTriggers() {
  if (registered) return;
  registered = true;
  require('./eventBus').on('*', onBusinessEvent);
}

module.exports = {
  ACTION_TYPES,
  actionConfigProblem,
  eventSubjects,
  fill,
  runAction,
  onBusinessEvent,
  registerAutomationTriggers,
  invalidateTriggerCache,
  _resetForTests() { registered = false; triggerCache.clear(); },
};

// =============================================================================
// VigaBSS 5.0 — Business events emitted after the fact (ASY-08)
// =============================================================================
// notificationHooks.js listens for invoice.created, payment.received,
// contract.suspended / .restored, suspension.warning, ticket.created and
// maintenance.scheduled — the documented outbound webhook events — but
// nothing emitted them, so integrations, SSE and portal push never saw an
// invoice, a payment or a suspension.
//
// Each helper loads the rows the hook reads and emits once the write that
// created them has committed. Emitting is best-effort: an error is logged and
// never fails the caller, whose work is already done.
//
// Client-facing email and SMS for these events still come from the code that
// already sent them (runAutoInvoice, runAutoSuspend, runSuspensionWarnings),
// so no event carries `client` unless noted: the hooks then dispatch the
// webhook and SSE notification without messaging the subscriber again.
// =============================================================================

const db = require('../config/database');
const eventBus = require('./eventBus');
const logger = require('../utils/logger').child({ service: 'businessEvents' });

async function first(sql, params) {
  const [rows] = await db.query(sql, params);
  return rows[0] || null;
}

function hasListeners(name) {
  if (typeof eventBus.listenerCount !== 'function') return true;
  return eventBus.listenerCount(name) + eventBus.listenerCount('*') > 0;
}

async function emitSafely(name, build) {
  try {
    // Nothing listens (a process that registered no hooks): skip the lookups.
    if (!hasListeners(name)) return;
    const payload = await build();
    if (payload) eventBus.emit(name, payload);
  } catch (err) {
    logger.warn({ err, event: name }, 'Business event not emitted');
  }
}

const rowOrId = async (value, sql) => (value && typeof value === 'object' ? value : first(sql, [value]));

/** A new invoice (any path) after its transaction committed. */
function emitInvoiceCreated(organizationId, invoiceOrId) {
  return emitSafely('invoice.created', async () => {
    const invoice = await rowOrId(invoiceOrId, 'SELECT * FROM invoices WHERE id = ? AND deleted_at IS NULL');
    if (!invoice) return null;
    const [items] = await db.query('SELECT description, amount FROM invoice_items WHERE invoice_id = ?', [invoice.id]);
    return { organizationId, invoice, items };
  });
}

/** A recorded payment (manual, gateway, group) after it committed. */
function emitPaymentReceived(organizationId, paymentOrId) {
  return emitSafely('payment.received', async () => {
    const payment = await rowOrId(paymentOrId, 'SELECT * FROM payments WHERE id = ? AND deleted_at IS NULL');
    return payment ? { organizationId, payment } : null;
  });
}

/**
 * A contract that was just suspended (hard, soft or walled garden). The
 * organization is the contract's own.
 */
function emitContractSuspended(contractId, { invoiceId = null, mode = 'suspend' } = {}) {
  return emitSafely('contract.suspended', async () => {
    const contract = await first('SELECT * FROM contracts WHERE id = ?', [contractId]);
    if (!contract) return null;
    const invoice = invoiceId ? await first('SELECT * FROM invoices WHERE id = ?', [invoiceId]) : null;
    return { organizationId: contract.organization_id ?? null, contract, invoice, mode };
  });
}

/** A contract that was just reconnected. */
function emitContractRestored(contractId) {
  return emitSafely('contract.restored', async () => {
    const contract = await first('SELECT * FROM contracts WHERE id = ?', [contractId]);
    return contract ? { organizationId: contract.organization_id ?? null, contract } : null;
  });
}

/**
 * A suspension warning whose email the caller already sent: the hook adds the
 * SMS (emailSent stops it emailing again).
 */
function emitSuspensionWarning(organizationId, { contract, client, invoice, daysOverdue }) {
  return emitSafely('suspension.warning', async () => ({
    organizationId, contract, client, invoice, daysOverdue, emailSent: true,
  }));
}

/** A new ticket, from any channel. */
function emitTicketCreated(organizationId, ticketOrId) {
  return emitSafely('ticket.created', async () => {
    const ticket = await rowOrId(ticketOrId, 'SELECT * FROM tickets WHERE id = ?');
    return ticket ? { organizationId: organizationId ?? ticket.organization_id, ticket } : null;
  });
}

/**
 * A new maintenance window, in the shape the hook reads. Subscribers are not
 * messaged: a window may cover one device, and the hook's client notice goes
 * to every active client (notifyClients stays false).
 */
function emitMaintenanceScheduled(organizationId, windowOrId) {
  return emitSafely('maintenance.scheduled', async () => {
    const window = await rowOrId(windowOrId, 'SELECT * FROM maintenance_windows WHERE id = ?');
    if (!window) return null;
    const start = window.starts_at ? new Date(window.starts_at) : null;
    const end = window.ends_at ? new Date(window.ends_at) : null;
    return {
      organizationId,
      notifyClients: false,
      maintenance: {
        id: window.id,
        title: window.name,
        description: window.description,
        scheduled_at: window.starts_at,
        estimated_duration_minutes: start && end ? Math.round((end - start) / 60000) : null,
        device_id: window.device_id ?? null,
        site_id: window.site_id ?? null,
      },
    };
  });
}

module.exports = {
  emitInvoiceCreated,
  emitPaymentReceived,
  emitContractSuspended,
  emitContractRestored,
  emitSuspensionWarning,
  emitTicketCreated,
  emitMaintenanceScheduled,
};

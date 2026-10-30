// =============================================================================
// VigaBSS 5.0 — Billing Controller
// =============================================================================
// Domain-specific endpoints for the billing workflow:
//   generate billing period → create invoice → allocate payment → ledger.
// =============================================================================

const db = require('../config/database');
const billingService = require('../services/billingService');

/**
 * POST /api/billing/generate-period
 * Generate the next billing period for a contract.
 */
async function generatePeriod(req, res, next) {
  try {
    const { contract_id } = req.body;

    const [contracts] = await db.query(
      'SELECT * FROM contracts WHERE id = ? AND organization_id = ?',
      [contract_id, req.orgId],
    );
    if (!contracts[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contract not found' } });
    }

    const period = await billingService.generateBillingPeriod(contracts[0]);
    res.status(201).json({ data: period });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/billing/generate-invoice
 * Generate a billing period then immediately produce an invoice.
 */
async function generateInvoice(req, res, next) {
  try {
    const { contract_id } = req.body;

    const [contracts] = await db.query(
      'SELECT * FROM contracts WHERE id = ? AND organization_id = ?',
      [contract_id, req.orgId],
    );
    if (!contracts[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Contract not found' } });
    }
    const contract = contracts[0];

    const [plans] = await db.query('SELECT * FROM plans WHERE id = ?', [contract.plan_id]);
    if (!plans[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plan not found' } });
    }

    const period = await billingService.generateBillingPeriod(contract);
    const invoice = await billingService.generateInvoice(period, contract, plans[0], req.orgId);
    res.status(201).json({ data: invoice });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/billing/bulk-generate
 * Generate invoices for all active contracts in the organization.
 */
async function bulkGenerate(req, res, next) {
  try {
    const [contracts] = await db.query(
      `SELECT c.*, p.name AS plan_name, p.price AS plan_price, p.currency AS plan_currency
       FROM contracts c
       JOIN plans p ON p.id = c.plan_id
       WHERE c.status = 'active' AND c.organization_id = ?`,
      [req.orgId],
    );

    let generated = 0;
    const errors = [];

    for (const contract of contracts) {
      try {
        const period = await billingService.generateBillingPeriod(contract);
        if (period.status === 'pending') {
          const plan = { name: contract.plan_name, price: contract.plan_price, currency: contract.plan_currency };
          await billingService.generateInvoice(period, contract, plan, req.orgId);
          generated++;
        }
      } catch (err) {
        errors.push({ contract_id: contract.id, error: err.message });
      }
    }

    res.json({ data: { generated, total_contracts: contracts.length, errors } });
  } catch (err) {
    next(err);
  }
}

module.exports = { generatePeriod, generateInvoice, bulkGenerate };

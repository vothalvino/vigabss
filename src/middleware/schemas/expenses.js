// =============================================================================
// VigaBSS 5.0 — Expense Validation Schemas
// =============================================================================

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const createExpense = {
  category: { type: 'string', required: true, max: 100 },
  description: { type: 'string', max: 5000 },
  amount: { type: 'number', required: true, min: 0 },
  currency: { type: 'string', max: 3 },
  receipt_url: { type: 'string', max: 500 },
  // expenses.expense_date is NOT NULL: a create without it failed in MySQL.
  expense_date: { type: 'string', required: true, pattern: DATE },
  notes: { type: 'string', max: 5000 },
};

const updateExpense = {
  category: { type: 'string', max: 100 },
  description: { type: 'string', max: 5000 },
  amount: { type: 'number', min: 0 },
  currency: { type: 'string', max: 3 },
  receipt_url: { type: 'string', max: 500 },
  expense_date: { type: 'string', pattern: DATE },
  notes: { type: 'string', max: 5000 },
};

module.exports = { createExpense, updateExpense };

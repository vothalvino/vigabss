// =============================================================================
// AI spend control (ASY-34)
// =============================================================================
// Every AI provider call costs money and nothing capped it: each portal chat
// message and ticket could call the provider several times (classification
// plus up to three generation attempts). llmProviderService records the cost
// of each call in ai_usage_events and refuses a call once the organization's
// month-to-date spend reaches ai_policies.monthly_budget_usd (NULL = no limit).
// =============================================================================

const db = require('../config/database');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger').child({ service: 'aiBudget' });

// First instant of the current calendar month in UTC (sessions run in UTC).
function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** { budget_usd: number|null, spent_usd: number, remaining_usd: number|null } */
async function status(orgId) {
  const [[policy]] = await db.query(
    'SELECT monthly_budget_usd FROM ai_policies WHERE organization_id = ? LIMIT 1',
    [orgId],
  );
  const [[usage]] = await db.query(
    'SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM ai_usage_events WHERE organization_id = ? AND created_at >= ?',
    [orgId, monthStart()],
  );
  const budget = policy && policy.monthly_budget_usd !== null && policy.monthly_budget_usd !== undefined
    ? Number(policy.monthly_budget_usd)
    : null;
  const spent = Number(usage?.spent) || 0;
  return {
    budget_usd: budget,
    spent_usd: Number(spent.toFixed(6)),
    remaining_usd: budget === null ? null : Number(Math.max(0, budget - spent).toFixed(6)),
  };
}

async function overBudget(orgId) {
  const s = await status(orgId);
  return s.budget_usd !== null && s.spent_usd >= s.budget_usd;
}

async function assertWithinBudget(orgId) {
  if (await overBudget(orgId)) {
    throw new AppError('The organization has reached its monthly AI budget', 429, 'AI_BUDGET_EXCEEDED');
  }
}

/** Best effort: a failed ledger write never fails the AI call it records. */
async function recordUsage(orgId, { providerId = null, operation = 'chat', usage = null, costUsd = null } = {}) {
  try {
    await db.query(
      `INSERT INTO ai_usage_events
         (organization_id, ai_provider_id, operation, prompt_tokens, completion_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orgId, providerId, operation, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null,
        Number.isFinite(costUsd) ? costUsd : null],
    );
  } catch (err) {
    logger.warn({ err: err.message, orgId }, 'Could not record AI usage');
  }
}

module.exports = { status, overBudget, assertWithinBudget, recordUsage, monthStart };

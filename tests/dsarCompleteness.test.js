// =============================================================================
// ASY-31 — the DSAR export covers communications, chat, consent, profiling and
// gateway payment data
// =============================================================================
// GET /dsar/clients/:id exported contacts, contracts, money, tickets, network
// sessions and AI drafts, but not the ticket comments, chat transcripts,
// SMS/email/WhatsApp messages, consents, communication preferences, churn
// scores or payment-gateway records VigaBSS also holds about the subject.
// =============================================================================

const fs = require('fs');
const path = require('path');

jest.mock('../src/config/database', () => ({ query: jest.fn(), withPrimaryContext: fn => fn() }));

const { clientCollectionDescriptors } = require('../src/routes/dsar');

const schema = fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
function columnsOf(table) {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`No table ${table} in schema.sql`);
  const body = schema.slice(start, schema.indexOf('\n)', start));
  return new Set([...body.matchAll(/^\s+([a-z_][a-z0-9_]*)\s+[A-Z]/gm)].map(m => m[1]));
}

const descriptors = clientCollectionDescriptors(42, 7);
const byKey = Object.fromEntries(descriptors.map(d => [d.key, d]));

const ADDED = [
  'ticketComments', 'supportConversations', 'supportMessages', 'portalChatSessions', 'whatsappInboundMessages',
  'smsLogs', 'emailLogs', 'outboxMessages', 'campaignMessages', 'contactSuppressions', 'consents',
  'communicationPreferences', 'churnScores', 'paymentTransactions', 'recurringPaymentProfiles',
];

test.each(ADDED)('%s is exported', (key) => {
  expect(byKey[key]).toBeDefined();
});

test.each(descriptors.map(d => [d.key, d]))('%s selects only columns its tables have', (_key, d) => {
  // alias -> table, from the FROM clause.
  const aliases = Object.fromEntries([...d.from.matchAll(/(?:FROM\s+|JOIN\s+|^\s*)([a-z_]+)\s+([a-z_]+)(?=\s|$)/g)]
    .filter(m => !['ON', 'JOIN'].includes(m[2].toUpperCase()))
    .map(m => [m[2], m[1]]));
  const missing = [];
  for (const [, alias, column] of d.select.matchAll(/\b([a-z_]+)\.([a-z_]+)\b/g)) {
    const table = aliases[alias];
    if (!table) continue;
    if (!columnsOf(table).has(column)) missing.push(`${table}.${column}`);
  }
  expect(missing).toEqual([]);
});

test.each(ADDED)('%s is limited to the subject and the organization', (key) => {
  const d = byKey[key];
  expect(d.where).toMatch(/client_id = \?/);
  expect(d.where).toMatch(/organization_id = \?/);
  expect(d.params).toEqual([42, 7]);
});

describe('secrets and internal traces stay out', () => {
  test('a reset link or code in the outbox has no body in the export', () => {
    expect(byKey.outboxMessages.select).toMatch(/CASE WHEN outbox\.is_sensitive = 1 THEN NULL ELSE outbox\.body_text END AS body_text/);
    expect(byKey.outboxMessages.select).not.toMatch(/body_html|payload/);
  });

  test('saved payment profiles show masked gateway tokens only', () => {
    const { select } = byKey.recurringPaymentProfiles;
    expect(select).toMatch(/RIGHT\(payment_profile\.token_reference, 4\)\) AS token_reference_masked/);
    expect(select.replace(/RIGHT\(payment_profile\.(token_reference|stripe_customer_id), 4\)/g, '')).not.toMatch(/payment_profile\.(token_reference|stripe_customer_id)\b(?!\s+IS NULL)/);
  });

  test('gateway transactions leave out the raw provider bodies', () => {
    expect(byKey.paymentTransactions.select).not.toMatch(/raw_request|raw_response|webhook_payload|idempotency_key/);
  });

  test('chat session tokens and the assistant retrieval trace are left out', () => {
    expect(byKey.portalChatSessions.select).not.toMatch(/session_token/);
    expect(byKey.supportMessages.select).not.toMatch(/data_sources/);
  });

  test('internal ticket notes are exported and flagged', () => {
    expect(byKey.ticketComments.select).toMatch(/ticket_comment\.is_internal/);
  });
});

test('AI, chat and profiling tables have a configurable retention period', () => {
  const { loadPolicies } = require('../src/services/retentionService');
  const policies = loadPolicies();
  for (const table of ['ai_reply_logs', 'ai_diagnostic_runs', 'portal_chat_sessions', 'support_conversations', 'churn_scores']) {
    expect(policies[table]).toBeGreaterThan(0);
  }
  process.env.RETENTION_CHURN_SCORES_DAYS = '90';
  try {
    expect(loadPolicies().churn_scores).toBe(90);
  } finally {
    delete process.env.RETENTION_CHURN_SCORES_DAYS;
  }
});

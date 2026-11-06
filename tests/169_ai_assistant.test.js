// =============================================================================
// VigaBSS 5.0 — AI assistant schema (introduced by development migration 169)
// =============================================================================
// Asserts the tables, columns, defaults and foreign keys an install gets for
// the AI assistant, read from the baseline without a database connection.
// =============================================================================

const { baselineTable, baselineColumns } = require('./helpers/baseline');

describe('AI assistant — tables', () => {
  it.each([
    'ai_providers', 'ai_policies', 'ai_phrase_library', 'ai_forbidden_terms',
    'ai_reply_logs', 'contract_topology_paths',
  ])('creates %s', table => expect(() => baselineTable(table)).not.toThrow());
});

describe.each([
  ['ai_providers', [
    'id', 'organization_id', 'name', 'kind', 'model', 'endpoint_url',
    'api_key_encrypted', 'extra_config', 'temperature', 'max_tokens',
    'timeout_ms', 'enabled', 'priority',
    'created_at', 'updated_at', 'deleted_at',
  ]],
  ['ai_policies', [
    'id', 'organization_id', 'enabled', 'enabled_channels', 'mode',
    'auto_send_confidence', 'default_locale', 'tone', 'redact_pii_before_llm',
    'active_provider_id', 'created_at', 'updated_at',
  ]],
  ['ai_phrase_library', [
    'id', 'organization_id', 'locale', 'category', 'text', 'is_required',
    'created_at', 'updated_at', 'deleted_at',
  ]],
  ['ai_forbidden_terms', [
    'id', 'organization_id', 'locale', 'term', 'replacement',
    'created_at', 'updated_at', 'deleted_at',
  ]],
  ['ai_reply_logs', [
    'id', 'organization_id', 'ticket_id', 'provider_id',
    'classification', 'confidence', 'context_snapshot', 'prompt_hash',
    'draft_text', 'final_text', 'action', 'reviewer_user_id',
    'prompt_tokens', 'completion_tokens', 'cost_usd', 'duration_ms',
    'error', 'created_at',
  ]],
  ['contract_topology_paths', ['id', 'contract_id', 'path', 'computed_at']],
])('%s columns', (table, expected) => {
  const cols = baselineColumns(table);
  it.each(expected)('has column %s', col => expect(cols.has(col)).toBe(true));
});

describe('AI assistant — default values', () => {
  const policies = baselineColumns('ai_policies');
  const providers = baselineColumns('ai_providers');

  it.each([
    ['ai_policies.enabled defaults to 0 (off)', policies, 'enabled', /^tinyint\(1\) NOT NULL DEFAULT '0'/],
    ['ai_policies.mode defaults to draft_only', policies, 'mode', /NOT NULL DEFAULT 'draft_only'/],
    ['ai_policies.auto_send_confidence defaults to 0.85', policies, 'auto_send_confidence', /^decimal\(3,2\) NOT NULL DEFAULT '0\.85'/],
    ['ai_policies.tone defaults to formal', policies, 'tone', /NOT NULL DEFAULT 'formal'/],
    ['ai_policies.redact_pii_before_llm defaults to 1', policies, 'redact_pii_before_llm', /^tinyint\(1\) NOT NULL DEFAULT '1'/],
    ['ai_providers.temperature defaults to 0.20', providers, 'temperature', /^decimal\(3,2\) NOT NULL DEFAULT '0\.20'/],
    ['ai_providers.max_tokens defaults to 800', providers, 'max_tokens', /^int unsigned NOT NULL DEFAULT '800'/],
    ['ai_providers.timeout_ms defaults to 20000', providers, 'timeout_ms', /^int unsigned NOT NULL DEFAULT '20000'/],
    ['ai_providers.enabled defaults to 1', providers, 'enabled', /^tinyint\(1\) NOT NULL DEFAULT '1'/],
  ])('%s', (_label, cols, column, pattern) => expect(cols.get(column)).toMatch(pattern));
});

describe('AI assistant — columns added to existing tables', () => {
  it('network_links.medium', () => {
    expect(baselineColumns('network_links').get('medium')).toMatch(/^enum\('fiber','wireless','copper'\)/);
  });

  it('network_links.role', () => {
    expect(baselineColumns('network_links').get('role')).toMatch(/^enum\('access','distribution','backhaul','core'\)/);
  });

  it('devices.role', () => {
    expect(baselineColumns('devices').get('role')).toMatch(/^enum\('access','distribution','backhaul','core'\)/);
  });

  it('organization_quotas.max_ai_tokens_month', () => {
    expect(baselineColumns('organization_quotas').has('max_ai_tokens_month')).toBe(true);
  });
});

describe('AI assistant — foreign key constraints', () => {
  const fk = (table, name, parent) => new RegExp(`CONSTRAINT \`${name}\` FOREIGN KEY \\([^)]*\\) REFERENCES \`${parent}\``);

  it('ai_policies references organizations', () => {
    expect(baselineTable('ai_policies')).toMatch(fk('ai_policies', 'fk_ai_policies_org', 'organizations'));
  });

  it('ai_policies.active_provider_id references ai_providers', () => {
    expect(baselineTable('ai_policies')).toMatch(fk('ai_policies', 'fk_ai_policies_provider', 'ai_providers'));
  });

  it('ai_providers references organizations', () => {
    expect(baselineTable('ai_providers')).toMatch(fk('ai_providers', 'fk_ai_providers_org', 'organizations'));
  });

  it('ai_reply_logs references tickets', () => {
    expect(baselineTable('ai_reply_logs')).toMatch(fk('ai_reply_logs', 'fk_ai_reply_logs_ticket', 'tickets'));
  });

  it('contract_topology_paths references contracts', () => {
    expect(baselineTable('contract_topology_paths')).toMatch(fk('contract_topology_paths', 'fk_contract_topology_paths_contract', 'contracts'));
  });
});

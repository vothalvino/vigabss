// =============================================================================
// VigaBSS 5.0 — Security Validation Schemas (§17)
// =============================================================================

const createFirewallRule = {
  action: { required: true, enum: ['allow', 'deny', 'log'] },
  protocol: { required: true, enum: ['tcp', 'udp', 'icmp', 'any'] },
  priority: { type: 'integer' },
  // firewall_rules.name is NOT NULL; a rule without one failed with a 500.
  name: { type: 'string', required: true, min: 1, max: 150 },
  description: { type: 'string', max: 65535 },
  src_ip: { type: 'string', max: 50 },
  src_port: { type: 'string', max: 50 },
  dst_ip: { type: 'string', max: 50 },
  dst_port: { type: 'string', max: 50 },
  direction: { enum: ['inbound', 'outbound', 'both'] },
};

// Field names and enum values mirror ddos_protection_rules in database/schema.sql
// exactly. They previously did not: the route wrote threshold_pps/threshold_bps/
// is_active (no such columns) and this schema accepted action values
// ('drop'/'ratelimit'/'redirect') that are not in the column's ENUM, so a request
// that passed validation was still rejected by MySQL.
const createDdosRule = {
  rule_type: { required: true, enum: ['flowspec', 'rtbh', 'scrubbing', 'rate_limit'] },
  target_prefix: { required: true },
  action: {
    required: true,
    enum: ['blackhole', 'rate_limit', 'redirect_scrubbing', 'flowspec_drop', 'monitor_only'],
  },
  name: { required: true },
  pps_threshold: { type: 'number' },
  bandwidth_threshold_mbps: { type: 'number' },
  status: { enum: ['inactive', 'active', 'auto_triggered', 'expired'] },
  notes: {},
};

const createBlackholeRoute = {
  prefix: { required: true },
  reason: { required: true },
  notes: {},
};

const createDnsBlocklist = {
  domain: { required: true },
  category: { required: true, enum: ['malware', 'phishing', 'ads', 'spam', 'adult', 'gambling', 'botnet', 'other'] },
  entry_type: { enum: ['manual', 'auto_import', 'threat_feed'] },
  threat_feed_source: {},
  is_active: { type: 'boolean' },
};

const createWebAuthn = {
  credential_id: { required: true },
  public_key: { required: true },
  friendly_name: {},
  aaguid: {},
  transports: {},
};

const updatePasswordPolicy = {
  min_length: { type: 'integer', min: 8, max: 128 },
  require_uppercase: { type: 'boolean' },
  require_lowercase: { type: 'boolean' },
  require_digits: { type: 'boolean' },
  require_special_chars: { type: 'boolean' },
  // 0 turns the limit off (stored as NULL).
  max_repeated_chars: { type: 'integer', min: 0, max: 128 },
  rotation_days: { type: 'integer', min: 0, max: 3650 },
  history_count: { type: 'integer', min: 0, max: 24 },
  // A zero lockout would lock on the first miss or never expire.
  lockout_attempts: { type: 'integer', min: 1, max: 100 },
  lockout_duration_minutes: { type: 'integer', min: 1, max: 1440 },
};

const createAdminIpAllowlist = {
  cidr: { required: true },
  description: {},
  is_active: { type: 'boolean' },
};

const triggerCpeScan = {
  scan_type: { required: true, enum: ['default_credentials', 'open_ports', 'firmware_cve', 'configuration_audit', 'full'] },
  device_id: { type: 'number' },
  cpe_device_id: { type: 'number' },
};

module.exports = {
  createFirewallRule,
  createDdosRule,
  createBlackholeRoute,
  createDnsBlocklist,
  createWebAuthn,
  updatePasswordPolicy,
  createAdminIpAllowlist,
  triggerCpeScan,
};

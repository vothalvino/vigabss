// =============================================================================
// OPS-23 — the env templates and the code agree
// =============================================================================
// .env.example and .env.prod.example listed settings nothing read (Stripe and
// Conekta API keys, PAC_*, RADIUS_SECRET/HOST/COA_PORT, SNMP_COMMUNITY,
// SNMP_POLL_INTERVAL: those live in the UI) and left out dozens the code
// does read (WHATSAPP_*, TENANT_DB_*, FIRERELAY_TUNNEL_*, ROUTEROS_API_*,
// SCRIPT_EXECUTION_ENABLED, ...). Both directions are checked here.
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function walk(dir, ext) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory()
    ? walk(path.join(dir, e.name), ext)
    : ext.some(x => e.name.endsWith(x)) ? [path.join(dir, e.name)] : []));
}

const READ = /(?:process\.env\.|process\.env\[['"]|\b(?:parseIntEnv|parseBoolEnv|positiveEnv|envInt|envBool|env)\(\s*['"])([A-Z][A-Z0-9_]+)/g;

// Read by the code but not operator settings.
const INTERNAL = [
  /^LOADTEST_/, /^SOAK_/, // load and soak test scripts
  /^E2E_/, // the e2e persona seed (src/scripts/seed-e2e.js); set by CI and docker-compose.e2e.yml
  /_GIT_SHA$/, /_UPDATE_REPO$/, // stamped by the image build and update tooling
  /^WG_LEGACY_SERVER_ENABLED$/, /^WG_HELPER_SOCKET$/, /^WG_PRIVILEGED_HELPER$/, // set by docker-compose.prod.yml / the helper
  /^(VIGABSS_|FIREISP_)?ADMIN_PASSWORD$/, // npm run admin, documented in the README
  /^FIREISP_/, // legacy aliases of documented VIGABSS_* names
  /^(NODE_ENV|HOME|PATH|HOSTNAME|npm_)/, /^JEST_/, /^CI$/,
];
// Built from a name pattern rather than read literally.
const DYNAMIC = [/^RETENTION_[A-Z0-9_]+_DAYS$/, /^OUTBOX_RATE_[A-Z]+_PER_MINUTE$/];
// Template entries for opt-in hardware tests, read only by tests/.
const TEST_ONLY = [/^MIKROTIK_HAP_/];

function templateKeys(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  return new Set([...text.matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map(m => m[1]));
}

const example = templateKeys('.env.example');
const prodExample = templateKeys('.env.prod.example');

const srcFiles = walk(path.join(ROOT, 'src'), ['.js']).filter(f => !f.endsWith(path.join('utils', 'logger.js')));
const reads = new Set();
for (const file of srcFiles) {
  for (const m of fs.readFileSync(file, 'utf8').matchAll(READ)) reads.add(m[1]);
}

// Everything that can consume a template key: the code and the deploy files.
const consumers = [
  ...srcFiles,
  ...walk(path.join(ROOT, 'scripts'), ['.js', '.sh', '.mjs']),
  ...walk(path.join(ROOT, 'charts'), ['.yaml', '.yml', '.tpl']),
  ...walk(path.join(ROOT, 'k8s'), ['.yaml', '.yml']).filter(f => !f.endsWith('sealed-secret.yaml')),
  ...walk(path.join(ROOT, 'nginx'), ['.conf', '.sh', '.template']),
  ...fs.readdirSync(ROOT).filter(f => /^docker-compose.*\.ya?ml$|^Dockerfile|^install\.sh$|^update\.sh$/.test(f)).map(f => path.join(ROOT, f)),
].map(f => fs.readFileSync(f, 'utf8')).join('\n');

const matches = (name, patterns) => patterns.some(re => re.test(name));

test('every setting the code reads is documented in .env.example', () => {
  const missing = [...reads].filter(k => !example.has(k) && !matches(k, INTERNAL)).sort();
  expect(missing).toEqual([]);
});

test.each([['.env.example', example], ['.env.prod.example', prodExample]])('every key in %s is read by something', (_file, keys) => {
  const dead = [...keys].filter(k => !matches(k, DYNAMIC) && !matches(k, TEST_ONLY)
    && !new RegExp(`\\b${k}\\b`).test(consumers)).sort();
  expect(dead).toEqual([]);
});

test('the settings that moved to the UI stay out of the templates', () => {
  for (const key of ['STRIPE_SECRET_KEY', 'CONEKTA_API_KEY', 'PAC_PROVIDER', 'PAC_USER', 'PAC_PASSWORD', 'PAC_URL',
    'RADIUS_SECRET', 'RADIUS_HOST', 'RADIUS_COA_PORT', 'SNMP_COMMUNITY', 'SNMP_POLL_INTERVAL']) {
    expect(example.has(key)).toBe(false);
    expect(prodExample.has(key)).toBe(false);
  }
});

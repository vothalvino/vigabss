// =============================================================================
// SUP-12 — the WhatsApp bot works for isolated-database organizations
// =============================================================================
// Inbound messages carry no tenant context. The bound bot read the client's
// balance, plan and tickets from the primary database, where an isolated
// organization's data does not live; and code running inside a tenant context
// (the clients routes revoking links) wrote whatsapp_links in the tenant DB.

const contexts = [];
jest.mock('../src/config/database', () => {
  const { AsyncLocalStorage } = require('async_hooks');
  const store = new AsyncLocalStorage();
  return {
    _store: store,
    query: jest.fn(async (sql) => {
      contexts.push({ sql, org: store.getStore()?.orgId ?? null });
      if (/FROM whatsapp_links/.test(sql)) return [[{ id: 3, client_id: 7, organization_id: 9, bound_at: new Date(), last_seen_at: new Date() }]];
      if (/FROM clients WHERE id = \? LIMIT 1/.test(sql)) return [[{ status: 'active', deleted_at: null, name: 'Ana' }]];
      if (/COUNT\(\*\)/.test(sql)) return [[{ n: 0 }]];
      return [[]];
    }),
    withTenantContext: (orgId, fn) => store.run({ orgId }, fn),
    withPrimaryContext: fn => store.run({ orgId: null }, fn),
  };
});

const cap = require('../src/services/whatsappCapabilityService');
const bot = require('../src/services/whatsappBotService');
const wa = require('../src/services/whatsappService');

beforeEach(() => { contexts.length = 0; jest.restoreAllMocks(); });

test("a bound client's request runs in the client's organization database", async () => {
  let balanceOrg;
  jest.spyOn(cap, 'balanceText').mockImplementation(async () => {
    balanceOrg = require('../src/config/database')._store.getStore()?.orgId ?? null;
    return 'Saldo';
  });
  await bot.handleInbound({ phone: '+525512345678', body: '1' });

  expect(balanceOrg).toBe(9);
  // The WhatsApp tables were still read on the primary.
  const linkRead = contexts.find(c => /FROM whatsapp_links/.test(c.sql));
  expect(linkRead.org).toBeNull();
  for (const c of contexts.filter(x => /whatsapp_/.test(x.sql))) expect(c.org).toBeNull();
});

test('revoking links from inside a tenant context writes the primary whatsapp_links', async () => {
  const db = require('../src/config/database');
  await db.withTenantContext(9, () => wa.revokeClientLinks({ clientId: 7, organizationId: 9, reason: 'email_changed' }));
  const update = contexts.find(c => /UPDATE whatsapp_links SET status = 'revoked'/.test(c.sql));
  expect(update.org).toBeNull();
});

// The summary used to open with "view audit logs" and hand back client,
// contract, invoice, ticket and device totals together. Each block now follows
// the permission that guards its data, and the cached copy is kept per set of
// blocks so a fuller answer is never replayed to someone who holds less.

const { httpCache } = require('../src/middleware/httpCache');
const cacheService = require('../src/services/cacheService');
const dashboardController = require('../src/controllers/dashboardController');
const dashboardRoutes = require('../src/routes/dashboard');
const { GUARD } = require('../src/middleware/routeGuard');

function summaryLayer() {
  return dashboardRoutes.stack.find((layer) => layer.route && layer.route.path === '/summary');
}

describe('dashboard summary permissions', () => {
  test('every block names the view permission of its own data', () => {
    expect(dashboardController.SUMMARY_BLOCKS).toEqual({
      clients: 'clients.view',
      contracts: 'contracts.view',
      revenue_30d: 'invoices.view',
      tickets: 'tickets.view',
      devices: 'devices.view',
    });
  });

  test('the route opens with any block permission and never with audit_logs.view', () => {
    const guards = summaryLayer().route.stack.map((l) => l.handle[GUARD]).filter(Boolean);
    const permissions = guards.flatMap((g) => g.permissions || []);
    expect(permissions.sort()).toEqual(Object.values(dashboardController.SUMMARY_BLOCKS).sort());
  });

  test('the cached copy is separate for each set of blocks', async () => {
    const store = new Map();
    jest.spyOn(cacheService, 'get').mockImplementation(async (k) => (store.has(k) ? store.get(k) : null));
    jest.spyOn(cacheService, 'set').mockImplementation(async (k, v) => { store.set(k, v); });
    const mw = httpCache('dashboard_summary_test', 60, { vary: (req) => req.summaryBlocks.join(',') });

    async function ask(blocks, body) {
      const req = { method: 'GET', orgId: 7, query: {}, summaryBlocks: blocks };
      const sent = [];
      const res = { statusCode: 200, setHeader: jest.fn(), json: (b) => { sent.push(b); return res; } };
      let reached = false;
      await mw(req, res, () => { reached = true; });
      if (reached) await res.json(body);
      return { reached, sent: sent[0] };
    }

    const full = await ask(['clients', 'tickets'], { data: { clients: { total: 9 }, tickets: { total: 3 } } });
    expect(full.reached).toBe(true);

    // Someone who may read only tickets must not be served the fuller copy.
    const narrow = await ask(['tickets'], { data: { clients: null, tickets: { total: 3 } } });
    expect(narrow.reached).toBe(true);
    expect(narrow.sent.data.clients).toBeNull();

    // The same set of blocks is a hit.
    const again = await ask(['tickets'], { data: 'not used' });
    expect(again.reached).toBe(false);
    expect(again.sent.data.clients).toBeNull();
  });
});

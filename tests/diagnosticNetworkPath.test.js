// When a customer reports a problem, the assistant checks their whole path.
// A fault in our network links them to its incident and gives no technician
// visit of their own; a full plan is explained as such.
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/customerPathService', () => ({ pathForContract: jest.fn() }));
jest.mock('../src/services/networkIncidentService', () => ({ recordCheck: jest.fn() }));

const db = require('../src/config/database');
const customerPath = require('../src/services/customerPathService');
const incidents = require('../src/services/networkIncidentService');
const engine = require('../src/services/diagnosticEngineService');

const path = (side, state, extra = {}) => ({ contract_id: 9, client_id: 3, conclusion: { side, state }, findings: [], hops: [], saturation: null, gaps: [], ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockImplementation(async (sql) => {
    if (/SELECT id FROM contracts/.test(sql)) return [[{ id: 9 }]];
    if (/SELECT channel FROM support_conversations/.test(sql)) return [[{ channel: 'whatsapp' }]];
    return [[]];
  });
  incidents.recordCheck.mockResolvedValue({ check_id: 300, summary: 's', incident_ids: [7] });
});

describe('what the customer is told', () => {
  test('a fault of ours: it is ours, technicians have it, nothing to do at home, no equipment named', () => {
    const off = engine._networkReply(path('access', 'off'));
    expect(off).toMatch(/falla en nuestra red/);
    expect(off).toMatch(/no necesitas hacer nada en tu equipo/);
    const slow = engine._networkReply(path('backhaul', 'degraded'));
    expect(slow).toMatch(/lento o inestable/);
    for (const text of [off, slow]) {
      expect(text).toMatch(/equipo técnico ya l[ao] tiene registrad[ao]/);
      expect(text).not.toMatch(/sector|OLT|PtP|antena|torre|\d+\.\d+\.\d+\.\d+/i);
      // Never says it is fixed, and only promises word when technicians close it.
      expect(text).not.toMatch(/ya quedó|resuelto ya|solucionad[ao]/i);
    }
  });

  test('a full plan: our network is fine and the plan is at its limit, with the numbers', () => {
    const text = engine._networkReply(path('customer_plan', 'degraded', { saturation: { mbps: 48, plan_mbps: 50, pct: 96, full: true } }));
    expect(text).toMatch(/nuestra red está funcionando bien/);
    expect(text).toMatch(/48 de 50 Mbps/);
  });

  test('anything else leaves the usual reply', () => {
    for (const side of ['customer_link', 'customer_equipment', 'none', 'unknown']) expect(engine._networkReply(path(side, 'degraded'))).toBeNull();
  });
});

describe('the check itself', () => {
  test('uses the client\'s active contract, keeps the evidence and marks the customer as a reporter on their channel', async () => {
    customerPath.pathForContract.mockResolvedValue(path('backhaul', 'degraded'));
    const out = await engine._checkNetworkPath({ orgId: 5, clientId: 3, conversationId: 88 });
    expect(db.query.mock.calls[0][1]).toEqual([3, 5]);
    expect(db.query.mock.calls[1][1]).toEqual([88, 5, 3]);
    expect(customerPath.pathForContract).toHaveBeenCalledWith(5, 9);
    expect(incidents.recordCheck).toHaveBeenCalledWith(5, expect.any(Object), { source: 'assistant', channel: 'whatsapp', conversationId: 88, reported: true });
    expect(out).toMatchObject({ check_id: 300, incident_ids: [7], ours: true });
  });

  test('never breaks the diagnosis: no contract, or a failure, gives nothing', async () => {
    db.query.mockResolvedValueOnce([[]]);
    await expect(engine._checkNetworkPath({ orgId: 5, clientId: 3, conversationId: null })).resolves.toBeNull();
    customerPath.pathForContract.mockRejectedValue(new Error('boom'));
    await expect(engine._checkNetworkPath({ orgId: 5, clientId: 3, conversationId: null })).resolves.toBeNull();
  });
});

describe('the reply to a technical message', () => {
  test('a fault of ours: no technician visit is opened for this customer', async () => {
    customerPath.pathForContract.mockResolvedValue(path('access', 'off'));
    const out = await engine.generateSupportResponse({ orgId: 5, clientId: 3, conversationId: 88, content: 'no tengo internet' });
    expect(out.escalate).toBe(false);
    expect(out.reply).toMatch(/falla en nuestra red/);
    expect(out.diagnosticResult.networkPath).toEqual({ side: 'access', state: 'off', check_id: 300, incident_ids: [7] });
  });

  test('a fault of ours that could not be tied to an incident keeps the usual reply and escalation', async () => {
    customerPath.pathForContract.mockResolvedValue(path('access', 'off'));
    incidents.recordCheck.mockResolvedValue({ check_id: 300, summary: 's', incident_ids: [] });
    const out = await engine.generateSupportResponse({ orgId: 5, clientId: 3, conversationId: 88, content: 'no tengo internet' });
    expect(out.reply).not.toMatch(/ya la tiene registrada/);
  });

  test('when the path cannot be checked the reply is the usual one', async () => {
    customerPath.pathForContract.mockRejectedValue(new Error('boom'));
    const out = await engine.generateSupportResponse({ orgId: 5, clientId: 3, conversationId: 88, content: 'internet lento' });
    expect(typeof out.reply).toBe('string');
    expect(out.diagnosticResult.networkPath).toBeUndefined();
  });
});

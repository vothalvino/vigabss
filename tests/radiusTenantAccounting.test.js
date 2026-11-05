// =============================================================================
// POST /radius/accounting/tenant — the FreeRADIUS accounting ingest
// =============================================================================
// The only HTTP accounting path (the install-wide shared-secret
// POST /radius/accounting was removed before the first release). An
// organization API token whose only scope is connection_logs:ingest fixes the
// organization; the NAS is looked up only inside it. The body arrives in
// rlm_rest's native {type, value: [...]} encoding or flat, and the whole ingest
// runs on the accounting pool.
// =============================================================================

const express = require('express');
const request = require('supertest');

let mockCurrentUser;

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withAccountingPool: jest.fn(callback => callback()),
}));
jest.mock('../src/middleware/auth', () => ({
  authenticate: (req, _res, next) => { req.user = mockCurrentUser; next(); },
}));
jest.mock('../src/middleware/orgScope', () => ({
  orgScope: (req, _res, next) => { req.orgId = req.user.organizationId; next(); },
}));
jest.mock('../src/middleware/rbac', () => ({
  requirePermission: () => (_req, _res, next) => next(),
}));
jest.mock('../src/services/radiusAccountingService', () => ({
  ingestAccounting: jest.fn(),
  recordInfrastructureAccounting: jest.fn(),
}));
jest.mock('../src/utils/opsMetrics', () => ({ noteRadiusAccounting: jest.fn() }));

const db = require('../src/config/database');
const accountingService = require('../src/services/radiusAccountingService');
const opsMetrics = require('../src/utils/opsMetrics');
const { normalizeAccountingBody } = require('../src/utils/radiusAccountingBody');

const app = express();
app.use(express.json());
app.use('/radius', require('../src/routes/radius'));
app.use((err, _req, res, _next) => {
  res.status(err.statusCode || 500).json({ error: { code: err.code, message: err.message } });
});

const collectorToken = {
  id: 9, role: 'technician', organizationId: 88, apiTokenId: 41, scopes: ['connection_logs:ingest'],
};
const attr = (type, value) => ({ type, value: [value] });
const post = body => request(app).post('/radius/accounting/tenant').send(body);

beforeEach(() => {
  jest.clearAllMocks();
  mockCurrentUser = { ...collectorToken };
  db.query.mockImplementation(async (sql, params) => {
    if (/FROM nas\s+WHERE organization_id = \? AND ip_address = \?/.test(sql)) {
      return [params[1] === '10.0.0.12' ? [{ id: 12, organization_id: 88 }] : []];
    }
    return [[]];
  });
  accountingService.ingestAccounting.mockResolvedValue({ action: 'insert', id: 91, macMove: false });
  accountingService.recordInfrastructureAccounting.mockResolvedValue({ action: 'noop' });
});

describe('who may ingest', () => {
  test('a staff session (no API token) is refused', async () => {
    mockCurrentUser = { ...collectorToken, apiTokenId: undefined };
    const res = await post({ 'Acct-Status-Type': 'Start', 'User-Name': 'alice', 'Acct-Session-Id': 's', 'NAS-IP-Address': '10.0.0.12' });
    expect(res.status).toBe(403);
    expect(accountingService.ingestAccounting).not.toHaveBeenCalled();
  });

  test('a token with any other scope is refused', async () => {
    mockCurrentUser = { ...collectorToken, scopes: ['connection_logs:ingest', 'clients:read'] };
    const res = await post({ 'Acct-Status-Type': 'Start', 'User-Name': 'alice', 'Acct-Session-Id': 's', 'NAS-IP-Address': '10.0.0.12' });
    expect(res.status).toBe(403);
  });

  test('the NAS is looked up only inside the token organization', async () => {
    await post({ 'Acct-Status-Type': 'Start', 'User-Name': 'alice', 'Acct-Session-Id': 's', 'NAS-IP-Address': '10.0.0.12' });
    const lookup = db.query.mock.calls.find(([sql]) => /FROM nas/.test(sql));
    expect(lookup[1]).toEqual([88, '10.0.0.12']);
  });

  test('an unknown NAS address is rejected before ingest', async () => {
    const res = await post({ 'Acct-Status-Type': 'Start', 'User-Name': 'alice', 'Acct-Session-Id': 's', 'NAS-IP-Address': '10.0.0.99' });
    expect(res.status).toBe(422);
    expect(accountingService.ingestAccounting).not.toHaveBeenCalled();
  });
});

describe('the FreeRADIUS body', () => {
  test('a flat Start is ingested for the token organization and NAS', async () => {
    const res = await post({ 'Acct-Status-Type': 'Start', 'User-Name': 'alice', 'Acct-Session-Id': 'session-1', 'NAS-IP-Address': '10.0.0.12' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, action: 'insert', id: 91 });
    expect(accountingService.ingestAccounting).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 88, nasId: 12, nasIpAddress: '10.0.0.12', userName: 'alice',
    }));
  });

  test('accepts the native FreeRADIUS 3 rlm_rest JSON attribute envelope', async () => {
    const res = await post({
      'Acct-Status-Type': attr('string', 'Interim-Update'),
      'User-Name': attr('string', 'alice'),
      'Acct-Session-Id': attr('string', 'session-1'),
      'NAS-IP-Address': attr('ipaddr', '10.0.0.12'),
      'Acct-Input-Octets': attr('integer', 2048),
    });
    expect(res.status).toBe(200);
    expect(accountingService.ingestAccounting).toHaveBeenCalledWith(expect.objectContaining({
      acctStatusType: 'Interim-Update', userName: 'alice', acctSessionId: 'session-1',
      nasIpAddress: '10.0.0.12', acctInputOctets: 2048, organizationId: 88, nasId: 12,
    }));
  });

  // REG-05: rlm_rest prints date attributes as zone-abbreviated text; the
  // stock setup's every packet was refused with 422.
  test('a native date-text Event-Timestamp is accepted and dated at receipt', async () => {
    const res = await post({
      'Acct-Status-Type': attr('string', 'Start'),
      'User-Name': attr('string', 'alice'),
      'Acct-Session-Id': attr('string', 'session-2'),
      'NAS-IP-Address': attr('ipaddr', '10.0.0.12'),
      'Event-Timestamp': attr('date', 'Oct 20 2026 12:00:00 CST'),
      'Acct-Delay-Time': attr('integer', 4),
    });
    expect(res.status).toBe(200);
    expect(accountingService.ingestAccounting).toHaveBeenCalledWith(expect.objectContaining({
      acctStatusType: 'Start', eventTimestamp: null, acctDelayTime: 4,
    }));
  });

  test.each([
    ['Oct 20 2026 12:00:00 CST', null],
    ['Oct  5 2026 09:03:00 UTC', null],
    ['1792500000', '1792500000'],
    ['2026-10-20T12:00:00Z', '2026-10-20T12:00:00Z'],
    ['not a date', 'not a date'],
  ])('Event-Timestamp %j is passed on as %j', (text, expected) => {
    expect(normalizeAccountingBody({ 'Event-Timestamp': { type: 'date', value: [text] } }).eventTimestamp).toBe(expected);
    expect(normalizeAccountingBody({ 'Event-Timestamp': text }).eventTimestamp).toBe(expected);
  });

  test.each(['Accounting-On', 'Accounting-Off'])(
    'accepts a native %s infrastructure event without subscriber/session attributes',
    async (status) => {
      const res = await post({
        'Acct-Status-Type': attr('string', status),
        'NAS-IP-Address': attr('ipaddr', '10.0.0.12'),
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, action: 'noop', reason: status });
      expect(accountingService.ingestAccounting).not.toHaveBeenCalled();
      expect(accountingService.recordInfrastructureAccounting).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 88, nasId: 12, acctStatusType: status }),
      );
    },
  );
});

describe('capacity and monitoring', () => {
  test('the ingest runs on the accounting pool', async () => {
    db.withAccountingPool.mockImplementationOnce((callback) => {
      expect(accountingService.ingestAccounting).not.toHaveBeenCalled();
      return callback();
    });
    await post({ 'Acct-Status-Type': 'Start', 'User-Name': 'alice', 'Acct-Session-Id': 's', 'NAS-IP-Address': '10.0.0.12' });
    expect(db.withAccountingPool).toHaveBeenCalledTimes(1);
    expect(accountingService.ingestAccounting).toHaveBeenCalledTimes(1);
  });

  test('every answered request is counted with its status type and result', async () => {
    await post({ 'Acct-Status-Type': 'Start', 'User-Name': 'alice', 'Acct-Session-Id': 's', 'NAS-IP-Address': '10.0.0.12' });
    await post({ 'Acct-Status-Type': 'Start', 'User-Name': 'alice', 'Acct-Session-Id': 's', 'NAS-IP-Address': '10.0.0.99' });
    expect(opsMetrics.noteRadiusAccounting).toHaveBeenCalledWith('Start', 200);
    expect(opsMetrics.noteRadiusAccounting).toHaveBeenCalledWith('Start', 422);
  });
});

// =============================================================================
// NPR-03 / NPR-05 — RouterOS rate order and safe .rsc exports
// =============================================================================
// NPR-03: Mikrotik-Rate-Limit and simple-queue max-limit pairs are rx/tx from
// the router's side, so the first value caps the client's upload. They were
// emitted download-first, swapping every asymmetric cap.
// NPR-05: the queue-tree, shaping and DSCP exports wrote stored names, parents,
// ports and marks into the script verbatim, so a quote, newline or `$[...]`
// in a saved value ran its own commands on /import.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));
jest.mock('../src/models/User');
jest.mock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/config/database');
const User = require('../src/models/User');
const { generateAttributes } = require('../src/services/radiusAttributeService');
const qosService = require('../src/services/qosService');
const { rosQuote } = require('../src/utils/routerosScript');

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
});

describe('rate pairs are upload-first', () => {
  test('Mikrotik-Rate-Limit for a 100 down / 20 up plan caps upload at 20M', () => {
    const attrs = generateAttributes({ radius_vendor: 'mikrotik', download_speed_mbps: 100, upload_speed_mbps: 20 });
    expect(attrs['Mikrotik-Rate-Limit']).toBe('20M/100M 40M/200M 20M/100M 8');
  });

  test('a template preview renders the same order', () => {
    expect(qosService.buildMikrotikRateString({ download_mbps: 50, upload_mbps: 10 }))
      .toBe('10M/50M 20M/100M 10M/50M 8');
  });
});

describe('rosQuote', () => {
  test.each([
    ['a quote that would end the string', 'x" ; /system reset-configuration "', '"x\\" ; /system reset-configuration \\""'],
    ['command substitution', 'q$[/user add name=evil group=full]', '"q\\$[/user add name=evil group=full]"'],
    ['a trailing backslash', 'name\\', '"name\\\\"'],
  ])('keeps %s inside one value', (_label, input, expected) => {
    expect(rosQuote(input)).toBe(expected);
  });

  test.each(['a\nb', 'a\rb', 'a\u0000b'])('refuses control characters (%j) with a 422', (input) => {
    expect(() => rosQuote(input)).toThrow(expect.objectContaining({ statusCode: 422 }));
  });
});

describe('exports cannot be broken out of', () => {
  // Every generated line must be one command: an unescaped quote leaves an odd
  // number of bare quotes, and an injected newline adds a line.
  const bareQuotes = line => line.replace(/\\./g, '').split('"').length - 1;

  test('queue tree names and parents are quoted and escaped', async () => {
    db.query.mockResolvedValueOnce([[
      { id: 1, queue_type: 'tree', name: 'x" parent=global ; /user add name=evil', parent_name: 'p$[:put 1]', priority: 8, queue_kind: 'pcq', max_limit_mbps: 10 },
      { id: 2, queue_type: 'simple', name: 'y"', priority: 8, queue_kind: 'sfq', max_limit_mbps: 5 },
    ]]);

    const { script } = await qosService.exportQueueTreeConfig(1);
    const adds = script.split('\n').filter(l => l.startsWith('add '));

    expect(adds).toHaveLength(2);
    expect(adds[0]).toContain('name="x\\" parent=global ; /user add name=evil"');
    expect(adds[0]).toContain('parent="p\\$[:put 1]"');
    for (const line of adds) expect(bareQuotes(line) % 2).toBe(0);
  });

  test('a stored newline in a name fails the export instead of adding a command', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, queue_type: 'tree', name: 'a\n/system reboot', priority: 8, queue_kind: 'pcq' }]]);
    await expect(qosService.exportQueueTreeConfig(1)).rejects.toMatchObject({ statusCode: 422 });
  });

  test('shaping rule ports must be port lists and names are quoted', async () => {
    db.query.mockResolvedValueOnce([[
      { id: 4, action: 'mark', protocol: 'tcp', dst_port_range: '80;/user add name=x', name: 'n', dscp_mark: 'EF' },
    ]]);
    await expect(qosService.exportShapingRulesConfig(1)).rejects.toMatchObject({ statusCode: 422 });

    db.query.mockResolvedValueOnce([[
      { id: 4, action: 'mark', protocol: 'tcp', dst_port_range: '80,443', name: 'Web" ; /x', dscp_mark: 'EF' },
      { id: 5, action: 'drop', name: 'drop"\n/system reboot' },
    ]]);
    const { script } = await qosService.exportShapingRulesConfig(1);
    expect(script).toContain('dst-port=80,443');
    expect(script).toContain('comment="Web\\" ; /x"');
    expect(script).not.toContain('/system reboot');
    for (const line of script.split('\n')) expect(bareQuotes(line) % 2).toBe(0);
  });

  test('DSCP marks and names are quoted', async () => {
    db.query.mockResolvedValueOnce([[{ id: 1, name: 'v"$[x]', dscp_name: 'EF" ; /x', dscp_value: 46 }]]);
    const script = await qosService.exportDscpConfig(1, 'text');
    expect(script).toContain('new-connection-mark="EF\\" ; /x"');
    expect(script).toContain('comment="v\\"\\$[x]"');
  });
});

describe('unsafe values are refused when saved', () => {
  const app = require('../src/app');
  const token = jwt.sign({ sub: 1, email: 'admin@test.com', role: 'admin', orgId: 1 }, config.jwt.secret, { expiresIn: '1h' });
  const post = (path, body) => request(app).post(`/api/v1${path}`)
    .set('Authorization', `Bearer ${token}`).set('X-Org-Id', '1').send(body);

  beforeEach(() => {
    User.findById.mockResolvedValue({ id: 1, email: 'admin@test.com', status: 'active', role: 'admin', organization_id: 1 });
  });

  test.each([
    ['/queue-tree-nodes', { name: 'a"b' }],
    ['/protocol-shaping-rules', { name: 'ok', dst_port_range: '80 ; /x' }],
    ['/dscp-marking-policies', { name: 'ok', dscp_value: 46, dscp_name: 'EF x' }],
    ['/dscp-marking-policies', { name: 'line\nbreak', dscp_value: 46 }],
  ])('POST %s %j is a 422', async (path, body) => {
    const res = await post(path, body);
    expect(res.status).toBe(422);
    expect(db.query.mock.calls.some(([sql]) => /^\s*INSERT/i.test(sql))).toBe(false);
  });
});

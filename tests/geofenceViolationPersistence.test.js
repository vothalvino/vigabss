// =============================================================================
// NPR-09 — geofence violations are recorded and alerted once
// =============================================================================
// evaluateAll found violations and only logged them; its WebSocket push called
// wsHub.broadcast, which wsHub does not export, so nothing was stored or sent.

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/eventBus', () => ({ emit: jest.fn(), on: jest.fn() }));

const db = require('../src/config/database');
const eventBus = require('../src/services/eventBus');
const { evaluateAll } = require('../src/services/geoFenceService');

// A 1 km circle around (19.43, -99.13); device 7 sits ~11 km north of it.
const GEOFENCE = { id: 3, name: 'CDMX centro', type: 'radius', center_lat: 19.43, center_lng: -99.13, radius_meters: 1000, device_id: null };
const INSIDE = { id: 6, name: 'cpe-in', latitude: '19.4300', longitude: '-99.1300' };
const OUTSIDE = { id: 7, name: 'cpe-out', latitude: '19.5300', longitude: '-99.1300' };

function wire({ insertAffected = 1, clearAffected = 0 } = {}) {
  db.query.mockImplementation(async (sql) => {
    if (/FROM map_geofences/.test(sql)) return [[GEOFENCE]];
    if (/FROM devices d/.test(sql)) return [[INSIDE, OUTSIDE]];
    if (/INSERT INTO geofence_violations/.test(sql)) return [{ affectedRows: insertAffected, insertId: 41 }];
    if (/UPDATE geofence_violations SET cleared_at/.test(sql)) return [{ affectedRows: clearAffected }];
    return [[]];
  });
}

beforeEach(() => jest.clearAllMocks());

test('a new violation is stored and emits geofence.violation once', async () => {
  wire();
  const result = await evaluateAll(5);

  expect(result).toMatchObject({ checked: 2, opened: 1 });
  const insert = db.query.mock.calls.find(([sql]) => /INSERT INTO geofence_violations/.test(sql));
  expect(insert[1]).toEqual([5, 3, 7, '19.5300', '-99.1300']);
  expect(eventBus.emit).toHaveBeenCalledTimes(1);
  expect(eventBus.emit).toHaveBeenCalledWith('geofence.violation', expect.objectContaining({
    organizationId: 5, violationId: 41, geofence_id: 3, device_id: 7,
  }));
});

test('a device still outside refreshes its open violation without re-alerting', async () => {
  wire({ insertAffected: 2 });
  const result = await evaluateAll(5);
  expect(result.opened).toBe(0);
  expect(eventBus.emit).not.toHaveBeenCalled();
});

test('devices back inside clear their open violations, the one outside stays open', async () => {
  wire({ clearAffected: 1 });
  const result = await evaluateAll(5);
  const [sql, params] = db.query.mock.calls.find(([q]) => /UPDATE geofence_violations SET cleared_at/.test(q));
  expect(sql).toMatch(/AND device_id NOT IN \(\?\)/);
  expect(params).toEqual([5, 3, 7]);
  expect(result.cleared).toBe(1);
});

test('the notification hook pushes, notifies staff and dispatches a webhook', async () => {
  jest.resetModules();
  const handlers = {};
  jest.doMock('../src/services/eventBus', () => ({ on: (name, fn) => { handlers[name] = fn; }, emit: jest.fn() }));
  const broadcast = jest.fn();
  jest.doMock('../src/routes/events', () => ({ broadcast }));
  const create = jest.fn(async () => ({}));
  jest.doMock('../src/models/Notification', () => ({ create }));
  const dispatch = jest.fn(async () => {});
  jest.doMock('../src/services/webhookService', () => ({ dispatch }));
  const dbMock = require('../src/config/database');
  dbMock.query.mockResolvedValue([[{ id: 2, email: 'noc@isp.test' }]]);

  require('../src/services/notificationHooks').registerHooks();
  await handlers['geofence.violation']({
    organizationId: 5, violationId: 41, geofence_id: 3, geofence_name: 'CDMX centro',
    device_id: 7, device_name: 'cpe-out', device_lat: '19.53', device_lng: '-99.13', detected_at: 'now',
  });

  expect(broadcast).toHaveBeenCalledWith('org:5:notifications', 'device.geofence_violation', expect.objectContaining({ device_id: 7 }));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ user_id: 2, type: 'alert', entity_type: 'devices', entity_id: 7 }));
  expect(dispatch).toHaveBeenCalledWith(5, 'geofence.violation', expect.objectContaining({ violation_id: 41 }));
});

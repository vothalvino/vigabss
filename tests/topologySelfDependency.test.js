// FE2-09 (server side) — a device cannot be its own dependency parent.
'use strict';

jest.mock('../src/config/database', () => ({ query: jest.fn() }));

const db = require('../src/config/database');
const svc = require('../src/services/topologyMapService');

test('a self edge is refused before any insert', async () => {
  await expect(svc.createDependencyEdge(1, { parent_device_id: 4, child_device_id: '4' }))
    .rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
  expect(db.query).not.toHaveBeenCalled();
});

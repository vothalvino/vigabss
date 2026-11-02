// =============================================================================
// ASY-22 — the drifted /api/v1/files router is gone, and no upload lands in
// the backup directory
// =============================================================================
// The File model and route expected organization_id, filename, size_bytes and
// path columns the files table never had, so every endpoint failed with a 500
// after multer had already written the upload, leaving orphan files; an
// entity_type of 'backup' wrote into the database-backup directory. Client
// documents and dispute evidence have working stores, so the router, model and
// schemas were removed. The files table stays: client documents use it.
// =============================================================================
'use strict';

jest.mock('../src/config/database', () => ({
  query: jest.fn().mockResolvedValue([[]]), queryReplica: jest.fn().mockResolvedValue([[]]),
  execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const { entityDir } = require('../src/middleware/upload');

test('/api/v1/files is not mounted', async () => {
  const res = await request(app).post('/api/v1/files/upload');
  expect(res.status).toBe(404);
});

test('the File model, route and schemas are gone', () => {
  for (const rel of ['src/routes/files.js', 'src/models/File.js', 'src/middleware/schemas/files.js']) {
    expect(fs.existsSync(path.join(__dirname, '..', rel))).toBe(false);
  }
});

test("an upload naming entity_type 'backup' goes to the generic uploads directory", () => {
  expect(entityDir('backup')).toBe('uploads');
  expect(entityDir('client')).toBe('clients');
});

'use strict';
// =============================================================================
// REG-11 — every served privacy notice text is archived
// =============================================================================
// Consents stored only the notice version and hash, and the text was rebuilt
// from the organization's current settings, so after an edit nothing could
// show what a subscriber had accepted. An organization could also change its
// notice text and keep the version, making old acceptances read as current.
// =============================================================================

const crypto = require('crypto');
const { getNotice, assertNoticeEditBumpsVersion } = require('../src/services/privacyNoticeService');

const ORG = {
  id: 5, name: 'Fibra Norte', legal_name: null, email: 'p@fibra.mx', phone: null, address: null,
  city: null, state: null, zip_code: null, country: 'MX', locale: 'MX',
  privacy_notice: '# Aviso propio', privacy_notice_version: '2026-11',
};
const sha = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

function runner({ archived = null } = {}) {
  const calls = [];
  let stored = archived;
  const run = jest.fn(async (sql, params) => {
    calls.push({ sql, params });
    if (/FROM organizations/.test(sql)) return [[ORG]];
    if (/^SELECT id FROM privacy_notice_versions/.test(sql)) return [stored ? [{ id: stored }] : []];
    if (/^INSERT IGNORE INTO privacy_notice_versions/.test(sql)) { stored = 31; return [{ affectedRows: 1 }]; }
    return [[]];
  });
  return { run, calls };
}

test('the first serve stores the exact text, keyed by its hash, and returns its row', async () => {
  const { run, calls } = runner();

  const notice = await getNotice(5, run);

  const insert = calls.find(c => /^INSERT IGNORE INTO privacy_notice_versions/.test(c.sql));
  expect(insert.params).toEqual([5, '2026-11', '# Aviso propio', sha('# Aviso propio'), 'org']);
  expect(notice).toMatchObject({ versionId: 31, organizationId: 5, hash: sha('# Aviso propio') });
});

test('a text already archived is not stored again', async () => {
  const { run, calls } = runner({ archived: 31 });

  const notice = await getNotice(5, run);

  expect(calls.some(c => /INSERT/.test(c.sql))).toBe(false);
  expect(notice.versionId).toBe(31);
});

describe('editing the notice text requires a new version', () => {
  test('changed text with the same version is refused', () => {
    expect(() => assertNoticeEditBumpsVersion(ORG, { privacy_notice: '# Aviso propio, con una finalidad nueva' }))
      .toThrow(expect.objectContaining({ statusCode: 422, code: 'PRIVACY_NOTICE_VERSION_REQUIRED' }));
    expect(() => assertNoticeEditBumpsVersion(ORG, { privacy_notice: '# Otro', privacy_notice_version: '2026-11' }))
      .toThrow(expect.objectContaining({ code: 'PRIVACY_NOTICE_VERSION_REQUIRED' }));
  });

  test('a new version, an unchanged text or no notice change is allowed', () => {
    expect(() => assertNoticeEditBumpsVersion(ORG, { privacy_notice: '# Otro', privacy_notice_version: '2026-12' })).not.toThrow();
    expect(() => assertNoticeEditBumpsVersion(ORG, { privacy_notice: '# Aviso propio  ' })).not.toThrow();
    expect(() => assertNoticeEditBumpsVersion(ORG, { name: 'Fibra Norte 2' })).not.toThrow();
  });

  test('the organization update route enforces it', async () => {
    jest.resetModules();
    jest.doMock('../src/config/database', () => ({
      query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
    }));
    jest.doMock('../src/middleware/rbac', () => ({
      requirePermission: () => (_req, _res, next) => next(),
      requireRole: () => (_req, _res, next) => next(),
      userHasPermission: async () => true,
    }));
    jest.doMock('../src/services/auditLog', () => ({ log: jest.fn().mockResolvedValue(undefined) }));
    const request = require('supertest');
    const jwt = require('./helpers/staffJwt');
    const config = require('../src/config');
    const db = require('../src/config/database');
    const { mockTxConnection } = require('./fixtures/mockTxConnection');
    const app = require('../src/app');
    db.query.mockImplementation(async (sql) => {
      if (String(sql).includes('`users`')) return [[{ id: 1, email: 'a@b.c', role: 'manager', status: 'active', organization_id: 5 }]];
      if (/^UPDATE `?organizations`?/i.test(sql)) return [{ affectedRows: 1 }];
      if (/FROM `?organizations`?/i.test(sql)) return [[{ ...ORG }]];
      return [[]];
    });
    db.execute.mockImplementation(db.query.getMockImplementation());
    mockTxConnection(db);
    const token = jwt.sign({ sub: 1, email: 'a@b.c', role: 'manager', orgId: 5 }, config.jwt.secret, { expiresIn: '1h' });

    const res = await request(app)
      .patch('/api/v1/organizations/5')
      .set('Authorization', `Bearer ${token}`)
      .send({ privacy_notice: '# Aviso propio, con una finalidad nueva' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PRIVACY_NOTICE_VERSION_REQUIRED');
    expect(db.query.mock.calls.some(([sql]) => /^UPDATE `?organizations`?/i.test(sql))).toBe(false);
  });
});

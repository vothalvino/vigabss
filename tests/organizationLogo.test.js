'use strict';
// =============================================================================
// A company's logo: upload, replace, remove, and who may read it
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() },
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const db = require('../src/config/database');
const logo = require('../src/services/organizationLogoService');
const { STORAGE_ROOT } = require('../src/middleware/upload');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(40, 3)]);

let tmp;
const made = [];
function fileWith(bytes, name = 'logo.png') {
  const dir = path.join(STORAGE_ROOT, 'organizations', 'logos');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `test-${Date.now()}-${Math.random().toString(16).slice(2)}${path.extname(name)}`);
  fs.writeFileSync(p, bytes);
  made.push(p);
  return { path: p, originalname: name, size: bytes.length };
}

beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-logo-')); });
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const p of made) { try { fs.unlinkSync(p); } catch { /* already removed */ } }
});
beforeEach(() => jest.clearAllMocks());

describe('reading the image type from the first bytes', () => {
  it('knows PNG, JPEG and WebP', () => {
    expect(logo.sniffImageType(PNG)).toBe('image/png');
    expect(logo.sniffImageType(JPEG)).toBe('image/jpeg');
    expect(logo.sniffImageType(WEBP)).toBe('image/webp');
  });

  it('refuses anything else, whatever it is called', () => {
    expect(logo.sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'))).toBeNull();
    expect(logo.sniffImageType(Buffer.from('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(logo.sniffImageType(Buffer.from('GIF89a'))).toBeNull();
  });
});

describe('replace', () => {
  it('stores the sniffed type, retires the previous logo and deletes its file', async () => {
    const old = fileWith(PNG, 'old.png');
    const fresh = fileWith(JPEG, 'named-like-a.png');
    const calls = [];
    db.query.mockImplementation((sql, params) => {
      calls.push([sql.replace(/\s+/g, ' ').trim(), params]);
      if (/^\s*SELECT id, file_path FROM files/.test(sql)) return Promise.resolve([[{ id: 3, file_path: path.relative(STORAGE_ROOT, old.path) }]]);
      if (/INSERT INTO files/.test(sql)) return Promise.resolve([{ insertId: 4 }]);
      if (/SELECT id, file_name/.test(sql)) return Promise.resolve([[{ id: 4, file_name: 'named-like-a.png', file_path: 'x', file_size: fresh.size, mime_type: 'image/jpeg', created_at: 'now' }]]);
      return Promise.resolve([{ affectedRows: 1 }]);
    });
    const row = await logo.replace(9, fresh, 77);
    expect(row.mime_type).toBe('image/jpeg');
    const insert = calls.find(([sql]) => sql.startsWith('INSERT INTO files'));
    expect(insert[1]).toEqual([9, 'named-like-a.png', path.relative(STORAGE_ROOT, fresh.path), fresh.size, 'image/jpeg', 77]);
    const retire = calls.find(([sql]) => sql.startsWith('UPDATE files SET deleted_at'));
    expect(retire[1]).toEqual([3, 9]);
    expect(fs.existsSync(old.path)).toBe(false);
    expect(fs.existsSync(fresh.path)).toBe(true);
  });

  it('refuses a file that is not an image and deletes it', async () => {
    const fake = fileWith(Buffer.from('<svg onload="alert(1)" xmlns="http://www.w3.org/2000/svg"/>'), 'evil.png');
    await expect(logo.replace(9, fake, 1)).rejects.toMatchObject({ code: 'NOT_AN_IMAGE' });
    expect(fs.existsSync(fake.path)).toBe(false);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('send', () => {
  function appFor(orgId, cache) {
    const app = express();
    app.get('/logo', (req, res, next) => logo.send(res, orgId, cache).catch(next));
    return app;
  }

  it('answers the image with its stored type, nosniff and the caller\'s caching', async () => {
    const f = fileWith(PNG);
    db.query.mockResolvedValue([[{ id: 1, file_name: 'logo.png', file_path: path.relative(STORAGE_ROOT, f.path), file_size: f.size, mime_type: 'image/png' }]]);
    const res = await request(appFor(9, 'private, max-age=300')).get('/logo');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(db.query.mock.calls[0][1]).toEqual([9]);
  });

  it('answers 404 when there is no logo, no company, or the file is gone', async () => {
    db.query.mockResolvedValue([[]]);
    expect((await request(appFor(9, 'x')).get('/logo')).status).toBe(404);
    expect((await request(appFor(null, 'x')).get('/logo')).status).toBe(404);
    db.query.mockResolvedValue([[{ id: 1, file_path: 'organizations/logos/missing.png', mime_type: 'image/png' }]]);
    expect((await request(appFor(9, 'x')).get('/logo')).status).toBe(404);
  });

  it('never follows a stored path out of the storage folder', async () => {
    db.query.mockResolvedValue([[{ id: 1, file_path: '../../package.json', mime_type: 'image/png' }]]);
    expect((await request(appFor(9, 'x')).get('/logo')).status).toBe(404);
  });
});

describe('describe', () => {
  it('never tells a screen where the file is on disk', () => {
    const out = logo.describe({ id: 1, file_name: 'a.png', file_path: 'organizations/logos/1.png', file_size: '10', mime_type: 'image/png', created_at: 'now' });
    expect(out).toEqual({ file_name: 'a.png', file_size: 10, mime_type: 'image/png', uploaded_at: 'now' });
    expect(logo.describe(null)).toBeNull();
  });
});

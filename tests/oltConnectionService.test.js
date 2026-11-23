'use strict';
// =============================================================================
// An OLT's saved login and the sessions opened from it
// =============================================================================
// The password is write-only, the SSH host key is pinned on first use, and
// one command-line session runs per OLT at a time.
// =============================================================================

jest.mock('../src/utils/logger', () => ({ child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/encryption', () => ({ encrypt: (v) => `enc(${v})`, decrypt: (v) => String(v).replace(/^enc\((.*)\)$/, '$1') }));

const db = require('../src/config/database');
const service = require('../src/services/olt/oltConnectionService');

/** A tiny olt_connections table for one organization. */
function fakeDb({ device = true, conn = null } = {}) {
  const state = { conn: conn && { ...conn }, statements: [] };
  db.query.mockImplementation(async (sql, params = []) => {
    state.statements.push([sql.replace(/\s+/g, ' ').trim(), params]);
    if (/FROM devices/.test(sql)) return [device ? [{ id: 7, name: 'OLT Norte', model: 'MA5800-X7' }] : []];
    if (/^\s*SELECT \* FROM olt_connections/.test(sql)) return [state.conn ? [{ ...state.conn }] : []];
    if (/INSERT INTO olt_connections/.test(sql)) {
      const [organization_id, device_id, driver, host, port, username, password_encrypted, legacy_algorithms] = params;
      state.conn = { organization_id, device_id, driver, host, port, username, password_encrypted, legacy_algorithms, host_key_fingerprint: null };
      return [{ insertId: 1 }];
    }
    if (/SET driver = \?/.test(sql)) {
      const [driver, host, port, username, password_encrypted, legacy_algorithms, host_key_fingerprint] = params;
      Object.assign(state.conn, { driver, host, port, username, password_encrypted, legacy_algorithms, host_key_fingerprint });
      return [{ affectedRows: 1 }];
    }
    if (/SET host_key_fingerprint = \? WHERE/.test(sql)) { state.conn.host_key_fingerprint = params[0]; return [{ affectedRows: 1 }]; }
    if (/SET host_key_fingerprint = NULL/.test(sql)) { state.conn.host_key_fingerprint = null; return [{ affectedRows: 1 }]; }
    if (/SET last_checked_at/.test(sql)) { state.conn.last_check_ok = params[0]; state.conn.last_check_message = params[1]; return [{ affectedRows: 1 }]; }
    if (/DELETE FROM olt_connections/.test(sql)) { state.conn = null; return [{ affectedRows: 1 }]; }
    return [[]];
  });
  return state;
}

const SAVED = { organization_id: 3, device_id: 7, driver: 'huawei_ma5800', host: '10.20.0.5', port: 22, username: 'vigabss', password_encrypted: 'enc(s3cret)', legacy_algorithms: 0, host_key_fingerprint: 'SHA256:aaa' };

beforeEach(() => db.query.mockReset());

describe('the saved login', () => {
  test('the password is never returned', async () => {
    fakeDb({ conn: SAVED });
    const view = await service.get(7, 3);
    expect(view).toMatchObject({ configured: true, host: '10.20.0.5', username: 'vigabss', has_password: true, host_key_fingerprint: 'SHA256:aaa' });
    expect(JSON.stringify(view)).not.toMatch(/s3cret|password_encrypted/);
  });

  test('an OLT of another organization, or a device that is not an OLT, is 404', async () => {
    fakeDb({ device: false });
    await expect(service.get(7, 3)).rejects.toMatchObject({ statusCode: 404 });
    expect(db.query.mock.calls[0][0]).toMatch(/WHERE id = \? AND organization_id = \? AND type = 'olt' AND deleted_at IS NULL/);
    expect(db.query.mock.calls[0][1]).toEqual([7, 3]);
  });

  test('a first save needs a password and stores it encrypted', async () => {
    const state = fakeDb();
    await expect(service.save(7, 3, { host: '10.20.0.5', username: 'vigabss' })).rejects.toThrow(/password is required/);
    await service.save(7, 3, { host: '10.20.0.5', username: 'vigabss', password: 's3cret' });
    expect(state.conn).toMatchObject({ organization_id: 3, device_id: 7, password_encrypted: 'enc(s3cret)', port: 22 });
  });

  test('a blank password keeps the saved one', async () => {
    const state = fakeDb({ conn: SAVED });
    await service.save(7, 3, { username: 'operator', password: '' });
    expect(state.conn).toMatchObject({ username: 'operator', password_encrypted: 'enc(s3cret)', host_key_fingerprint: 'SHA256:aaa' });
  });

  test('a new address forgets the pinned host key: it is another machine', async () => {
    const state = fakeDb({ conn: SAVED });
    await service.save(7, 3, { host: '10.20.0.9' });
    expect(state.conn.host_key_fingerprint).toBeNull();
  });

  test('addresses inside the platform, and hostnames, are refused', async () => {
    fakeDb();
    for (const host of ['127.0.0.1', '169.254.169.254', 'olt.example.com']) {
      await expect(service.save(7, 3, { host, username: 'u', password: 'p' })).rejects.toMatchObject({ statusCode: 422 });
    }
  });

  test('every statement on olt_connections is scoped to the organization', async () => {
    const state = fakeDb({ conn: SAVED });
    await service.save(7, 3, { username: 'x' });
    await service.forgetHostKey(7, 3);
    await service.remove(7, 3);
    const onTable = state.statements.filter(([sql]) => /olt_connections/.test(sql) && !/^INSERT/.test(sql));
    expect(onTable.length).toBeGreaterThanOrEqual(5);
    for (const [sql, params] of onTable) {
      expect(sql).toMatch(/device_id = \? AND organization_id = \?/);
      expect(params.slice(-2)).toEqual([7, 3]);
    }
  });
});

describe('a live session', () => {
  const fakeSession = () => {
    const typed = [];
    return { typed, closed: false, run: async (c) => { typed.push(c); return ''; }, close() { this.closed = true; } };
  };

  test('uses the saved login, pins the host key on the first connection, and closes the session', async () => {
    const state = fakeDb({ conn: { ...SAVED, host_key_fingerprint: null } });
    const session = fakeSession();
    const open = jest.fn(async () => ({ session, hostKeyFingerprint: 'SHA256:first' }));
    const result = await service.withDriver(7, 3, async (driver) => { await driver.session.run('display version'); return 'done'; }, { open });
    expect(result).toBe('done');
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ host: '10.20.0.5', username: 'vigabss', password: 's3cret', hostKeyFingerprint: null }));
    expect(state.conn.host_key_fingerprint).toBe('SHA256:first');
    expect(session.typed.slice(0, 1)).toEqual(['enable']);
    expect(session.closed).toBe(true);
    expect(state.conn.last_check_ok).toBe(1);
  });

  test('later connections present the pinned key to be checked', async () => {
    fakeDb({ conn: SAVED });
    const open = jest.fn(async () => ({ session: fakeSession(), hostKeyFingerprint: 'SHA256:aaa' }));
    await service.withDriver(7, 3, async () => null, { open });
    expect(open.mock.calls[0][0].hostKeyFingerprint).toBe('SHA256:aaa');
  });

  test('a failed connection is recorded and the session of a failed operation is still closed', async () => {
    const state = fakeDb({ conn: SAVED });
    const refused = Object.assign(new Error('The device refused the user name or password'), { name: 'CliError', code: 'AUTH_FAILED' });
    await expect(service.withDriver(7, 3, async () => null, { open: async () => { throw refused; } })).rejects.toBe(refused);
    expect(state.conn).toMatchObject({ last_check_ok: 0, last_check_message: 'The device refused the user name or password' });

    const session = fakeSession();
    await expect(service.withDriver(7, 3, async () => { throw new Error('boom'); }, { open: async () => ({ session, hostKeyFingerprint: 'SHA256:aaa' }) })).rejects.toThrow('boom');
    expect(session.closed).toBe(true);
  });

  test('an OLT with no login saved says so', async () => {
    fakeDb();
    await expect(service.withDriver(7, 3, async () => null, { open: jest.fn() })).rejects.toThrow(/no login saved/);
  });

  test('two requests for one OLT run one after the other', async () => {
    fakeDb({ conn: SAVED });
    const order = [];
    const open = async () => ({ session: fakeSession(), hostKeyFingerprint: 'SHA256:aaa' });
    const slow = service.withDriver(7, 3, async () => { order.push('a-start'); await new Promise((r) => setTimeout(r, 30)); order.push('a-end'); }, { open });
    const fast = service.withDriver(7, 3, async () => { order.push('b-start'); }, { open });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });
});

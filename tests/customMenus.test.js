// Menus people arrange themselves and the templates behind them: which menu
// a person gets, what a locked template stops, and that a menu is only ever
// a list of page addresses inside one organization.
jest.mock('../src/config/database', () => ({ query: jest.fn(), getConnection: jest.fn() }));

const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const menus = require('../src/services/menuService');

const layout = (name = 'My mornings', pages = ['/invoices', '/noc-dashboard']) => ({ groups: [{ name, pages }] });
const flat = (sql) => sql.replace(/\s+/g, ' ').trim();

/** Answer queries from a small in-memory picture of one organization. */
function world({ template = null, personal = null } = {}) {
  const calls = [];
  db.query.mockImplementation(async (sql, params) => {
    const text = flat(sql);
    calls.push([text, params]);
    if (/FROM menu_template_assignments a JOIN menu_templates t/.test(text)) return [template ? [{ id: 7, name: 'Billing desk', locked: 0, layout: JSON.stringify(layout('Desk')), user_id: null, ...template }] : []];
    if (/^SELECT layout FROM user_menus/.test(text)) return [personal ? [{ layout: JSON.stringify(personal) }] : []];
    return [{ affectedRows: 1 }];
  });
  return calls;
}

beforeEach(() => { db.query.mockReset(); db.getConnection.mockReset(); });

describe('cleanLayout', () => {
  test('keeps group names and page addresses, trimmed and without repeats', () => {
    expect(menus.cleanLayout({ groups: [{ name: '  Tower work ', pages: ['/devices', '/devices', '/admin/user-tunnels'], extra: 1 }] }))
      .toEqual({ groups: [{ name: 'Tower work', pages: ['/devices', '/admin/user-tunnels'] }] });
    expect(menus.cleanLayout({ groups: [] })).toEqual({ groups: [] });
  });

  test.each([
    [undefined, /list of groups/],
    [{ groups: [{ name: ' ', pages: [] }] }, /needs a name/],
    [{ groups: [{ name: 'a'.repeat(41), pages: [] }] }, /at most 40/],
    [{ groups: [{ name: 'A', pages: [] }, { name: 'a', pages: [] }] }, /Two groups/],
    [{ groups: [{ name: 'A', pages: ['invoices'] }] }, /by its address/],
    [{ groups: [{ name: 'A', pages: ['https://example.com/x'] }] }, /by its address/],
    [{ groups: [{ name: 'A', pages: ['/a?b=1'] }] }, /by its address/],
    [{ groups: [{ name: 'A', pages: [42] }] }, /by its address/],
    [{ groups: Array.from({ length: 21 }, (_, i) => ({ name: `G${i}`, pages: [] })) }, /at most 20 groups/],
    [{ groups: [{ name: 'A', pages: Array.from({ length: 31 }, (_, i) => `/p${i}`) }] }, /at most 30 pages/],
  ])('refuses %j', (input, message) => {
    expect(() => menus.cleanLayout(input)).toThrow(message);
  });
});

describe('which menu a person gets', () => {
  test('nothing set: the standard sidebar', async () => {
    world();
    expect(await menus.mine(5, 9)).toEqual({ layout: null, source: 'standard', template: null, can_edit: true });
  });

  test('a template given to their group, until they make their own', async () => {
    world({ template: {} });
    expect(await menus.mine(5, 9)).toEqual({
      layout: layout('Desk'), source: 'template', can_edit: true,
      template: { id: 7, name: 'Billing desk', locked: false, given_to: 'group' },
    });
    world({ template: {}, personal: layout() });
    expect(await menus.mine(5, 9)).toMatchObject({ layout: layout(), source: 'personal', can_edit: true, template: { id: 7 } });
  });

  test('a locked template wins over their own menu and cannot be changed', async () => {
    const calls = world({ template: { locked: 1, user_id: 9 }, personal: layout() });
    expect(await menus.mine(5, 9)).toEqual({
      layout: layout('Desk'), source: 'template', can_edit: false,
      template: { id: 7, name: 'Billing desk', locked: true, given_to: 'person' },
    });
    expect(calls.some(([sql]) => /user_menus/.test(sql))).toBe(false);
    await expect(menus.saveMine(5, 9, layout())).rejects.toMatchObject({ statusCode: 409 });
    expect(calls.some(([sql]) => /^INSERT INTO user_menus/.test(sql))).toBe(false);
  });

  test('a template given to the person comes before their group\'s, inside the organization', async () => {
    const calls = world();
    await menus.mine(5, 9);
    const [sql, params] = calls[0];
    expect(sql).toMatch(/WHERE a\.organization_id = \? AND \(a\.user_id = \? OR a\.role_id = \(SELECT u\.group_id FROM users u WHERE u\.id = \? AND u\.deleted_at IS NULL\)\)/);
    expect(sql).toMatch(/t\.organization_id = a\.organization_id/);
    expect(sql).toMatch(/ORDER BY \(a\.user_id IS NULL\), a\.id LIMIT 1/);
    expect(params).toEqual([5, 9, 9]);
  });
});

describe('a person\'s own menu', () => {
  test('is stored cleaned, for that person in that organization', async () => {
    const calls = world();
    await menus.saveMine(5, 9, { groups: [{ name: ' Mine ', pages: ['/invoices', '/invoices'] }] });
    const insert = calls.find(([sql]) => /^INSERT INTO user_menus/.test(sql));
    expect(insert[0]).toMatch(/ON DUPLICATE KEY UPDATE layout = VALUES\(layout\)/);
    expect(insert[1]).toEqual([5, 9, JSON.stringify({ groups: [{ name: 'Mine', pages: ['/invoices'] }] })]);
  });

  test('a bad menu is refused before anything is read or written', async () => {
    const calls = world();
    await expect(menus.saveMine(5, 9, { groups: [{ name: '', pages: [] }] })).rejects.toMatchObject({ statusCode: 422 });
    expect(calls).toEqual([]);
  });

  test('resetting removes only that person\'s menu', async () => {
    const calls = world({ template: {} });
    const out = await menus.resetMine(5, 9);
    expect(calls[0]).toEqual(['DELETE FROM user_menus WHERE organization_id = ? AND user_id = ?', [5, 9]]);
    expect(out.source).toBe('template');
  });
});

describe('templates', () => {
  const stored = [{ id: 7, name: 'Billing desk', locked: 1, layout: JSON.stringify(layout('Desk')) }];
  function templates({ taken = false, roles = [{ id: 3 }], users = [{ id: 9 }] } = {}) {
    const calls = [];
    db.query.mockImplementation(async (sql, params) => {
      const text = flat(sql);
      calls.push([text, params]);
      if (/^SELECT id, name, locked, layout FROM menu_templates/.test(text)) return [stored];
      if (/^SELECT a\.template_id/.test(text)) return [[{ template_id: 7, role_id: 3, user_id: null, role_name: 'billing', user_name: null, email: null }, { template_id: 7, role_id: null, user_id: 9, role_name: null, user_name: null, email: 'ana@example.com' }]];
      if (/^SELECT id FROM menu_templates WHERE organization_id = \? AND name = \?/.test(text)) return [taken ? [{ id: 8 }] : []];
      if (/^SELECT id FROM roles/.test(text)) return [roles];
      if (/^SELECT id FROM users/.test(text)) return [users];
      if (/^INSERT INTO menu_templates/.test(text)) return [{ insertId: 7 }];
      return [{ affectedRows: 1 }];
    });
    return calls;
  }
  function tx() {
    const calls = [];
    const conn = {
      calls, beginTransaction: jest.fn(async () => {}), commit: jest.fn(async () => {}), rollback: jest.fn(async () => {}), release: jest.fn(),
      query: jest.fn(async (sql, params) => { calls.push([flat(sql), params]); return [{ affectedRows: 1 }]; }),
    };
    db.getConnection.mockResolvedValue(conn);
    return conn;
  }

  test('are listed with who has them; a person without a name shows by email', async () => {
    const calls = templates();
    expect(await menus.listTemplates(5)).toEqual([{
      id: 7, name: 'Billing desk', locked: true, layout: layout('Desk'),
      groups: [{ id: 3, name: 'billing' }], people: [{ id: 9, name: 'ana@example.com' }],
    }]);
    expect(calls[0][1]).toEqual([5]);
    expect(calls[1][0]).toMatch(/u\.organization_id = a\.organization_id AND u\.deleted_at IS NULL WHERE a\.organization_id = \?/);
  });

  test('are created with a cleaned layout, and a name can be used once', async () => {
    const calls = templates();
    await menus.createTemplate(5, 1, { name: ' Billing desk ', locked: true, layout: layout('Desk') });
    const insert = calls.find(([sql]) => /^INSERT INTO menu_templates/.test(sql));
    expect(insert[1]).toEqual([5, 'Billing desk', 1, JSON.stringify(layout('Desk')), 1]);
    templates({ taken: true });
    await expect(menus.createTemplate(5, 1, { name: 'Billing desk', layout: layout() })).rejects.toMatchObject({ statusCode: 409 });
    await expect(menus.createTemplate(5, 1, { name: '', layout: layout() })).rejects.toMatchObject({ statusCode: 422 });
    await expect(menus.createTemplate(5, 1, { name: 'X' })).rejects.toMatchObject({ statusCode: 422 });
  });

  test('another organization\'s template is not found, to change or to delete', async () => {
    templates();
    await expect(menus.updateTemplate(5, 99, { name: 'X', layout: layout() })).rejects.toMatchObject({ statusCode: 404 });
    await expect(menus.deleteTemplate(5, 99)).rejects.toMatchObject({ statusCode: 404 });
    await expect(menus.assignTemplate(5, 99, {})).rejects.toMatchObject({ statusCode: 404 });
  });

  test('giving a template replaces who had it and moves a group or person off their old one', async () => {
    templates();
    const conn = tx();
    await menus.assignTemplate(5, '7', { group_ids: [3, 3], user_ids: [9] });
    expect(conn.calls).toEqual([
      ['DELETE FROM menu_template_assignments WHERE organization_id = ? AND template_id = ?', [5, '7']],
      ['DELETE FROM menu_template_assignments WHERE organization_id = ? AND role_id IN (?)', [5, 3]],
      ['DELETE FROM menu_template_assignments WHERE organization_id = ? AND user_id IN (?)', [5, 9]],
      ['INSERT INTO menu_template_assignments (organization_id, template_id, role_id, user_id) VALUES (?, ?, ?, ?), (?, ?, ?, ?)', [5, '7', 3, null, 5, '7', null, 9]],
    ]);
    expect(conn.commit).toHaveBeenCalled();
  });

  test('a template cannot be given to a person of another organization or to an unknown group', async () => {
    const calls = templates({ users: [] });
    await expect(menus.assignTemplate(5, 7, { user_ids: [44] })).rejects.toMatchObject({ statusCode: 422 });
    expect(calls.find(([sql]) => /^SELECT id FROM users/.test(sql))).toEqual(['SELECT id FROM users WHERE id IN (?) AND organization_id = ? AND deleted_at IS NULL', [44, 5]]);
    expect(db.getConnection).not.toHaveBeenCalled();
    const refused = templates({ roles: [] });
    await expect(menus.assignTemplate(5, 7, { group_ids: [77, 78] })).rejects.toMatchObject({ statusCode: 422 });
    // One placeholder per id, and a group that never sees the sidebar is refused too.
    expect(refused.find(([sql]) => /^SELECT id FROM roles/.test(sql))).toEqual([
      'SELECT id FROM roles WHERE id IN (?, ?) AND deleted_at IS NULL AND name NOT IN (?, ?, ?)',
      [77, 78, 'carrier', 'collector', 'reseller_admin'],
    ]);
    await expect(menus.assignTemplate(5, 7, { group_ids: 'all' })).rejects.toMatchObject({ statusCode: 422 });
  });

  test('offers the user groups that use the staff sidebar and the organization\'s active people', async () => {
    const calls = [];
    db.query.mockImplementation(async (sql, params) => {
      calls.push([flat(sql), params]);
      return [/FROM roles/.test(sql) ? [{ id: 3, name: 'billing' }] : [{ id: 9, email: 'ana@example.com', name: null }, { id: 10, email: 'b@example.com', name: 'Beto Ruiz' }]];
    });
    expect(await menus.audience(5)).toEqual({ groups: [{ id: 3, name: 'billing' }], people: [{ id: 9, name: 'ana@example.com' }, { id: 10, name: 'Beto Ruiz' }] });
    // Carriers, collectors and resellers work in their own apps, without this sidebar.
    expect(calls[0]).toEqual(['SELECT id, name FROM roles WHERE deleted_at IS NULL AND name NOT IN (?, ?, ?) ORDER BY name', ['carrier', 'collector', 'reseller_admin']]);
    expect(calls[1][0]).toMatch(/FROM users WHERE organization_id = \? AND deleted_at IS NULL AND status = 'active'/);
    expect(calls[1][1]).toEqual([5]);
  });

  test('giving it to nobody clears the list', async () => {
    templates();
    const conn = tx();
    await menus.assignTemplate(5, 7, {});
    expect(conn.calls).toHaveLength(1);
  });
});

describe('routes and seed', () => {
  const routes = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'menus.js'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', '031_custom_menus.sql'), 'utf8');

  test('a person\'s own menu needs no permission; every template route needs menu_templates.manage', () => {
    const lines = routes.split('\n').filter((line) => /^router\.(get|post|put|delete)\(/.test(line));
    expect(lines).toHaveLength(9);
    for (const line of lines) {
      const guarded = /, manage, /.test(line);
      expect(guarded).toBe(line.includes("'/templates"));
    }
    expect(routes).toMatch(/const manage = requirePermission\('menu_templates\.manage'\)/);
    expect(routes).toMatch(/router\.use\(authenticate\);\nrouter\.use\(orgScope\);/);
  });

  test('no list is handed to a single placeholder (prepared statements do not expand it)', () => {
    const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'menuService.js'), 'utf8');
    expect(service).not.toMatch(/IN \(\?\)/);
    expect(service).not.toMatch(/VALUES \?[^,)]/);
    // Every parameter list handed to the database is flat.
    for (const [, params] of [...service.matchAll(/\.query\([^;]*?,\s*(\[[^\]]*\[[^\]]*\][^\]]*\])\s*\)/g)]) expect(params).toBeUndefined();
  });

  test('the service never reads or writes permissions', () => {
    const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'menuService.js'), 'utf8');
    expect(service).not.toMatch(/role_permissions|FROM permissions|requirePermission/);
  });

  test('the permission is seeded for administrators only, in the settings module', () => {
    expect(migration).toMatch(/\('menu_templates\.manage', '[^']+', 'settings'\)/);
    expect(migration).toMatch(/JOIN permissions p ON p\.name IN \('menu_templates\.manage'\)\s+WHERE r\.name = 'admin'/);
    expect(migration.match(/INSERT IGNORE INTO role_permissions/g)).toHaveLength(1);
  });
});

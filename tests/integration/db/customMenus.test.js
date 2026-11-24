'use strict';
// =============================================================================
// Custom menus and menu templates against a real database (migration 031)
// =============================================================================
// The mocked tests check the SQL's shape; this runs it. db.query prepares its
// statements, and a prepared statement does not expand a list handed to one
// placeholder: the first release filtered and validated with `IN (?)`, which
// matched nothing, so no template could be given to anyone and the groups
// that never see the sidebar were still offered. These tests give a template
// to a group and a person, move them to another, lock it, and read back what
// each person gets.
//
// Runs only in CI's db-integration job (DB_INTEGRATION=1).
// =============================================================================

const { describeDb, relaxLimits, createOrgAdmin, teardown } = require('./realDb');

const ORG = 9501; // 9101-9102 sweep, 92xx money, 9301 RBAC matrix, 9401 IPv6
const OTHER_ORG = 9502;
const layout = (name, pages) => ({ groups: [{ name, pages }] });

describeDb('Custom menus against a real database', () => {
  let db;
  let menus;
  let admin;
  let colleague;
  let outsider;
  let groupId;

  async function addUser(org, email, group) {
    const [result] = await db.query(
      `INSERT INTO users (organization_id, first_name, last_name, email, password_hash, role, group_id, status)
       VALUES (?, 'Menu', 'Tester', ?, 'x', 'support', ?, 'active')`,
      [org, email, group],
    );
    return result.insertId;
  }

  beforeAll(async () => {
    relaxLimits();
    db = require('../../../src/config/database');
    menus = require('../../../src/services/menuService');
    admin = (await createOrgAdmin(db, ORG, 'MENUS')).userId;
    outsider = (await createOrgAdmin(db, OTHER_ORG, 'MENUSB')).userId;
    const [[group]] = await db.query('SELECT group_id FROM users WHERE id = ?', [admin]);
    groupId = group.group_id;
    // A colleague in no group that has a template of its own.
    const [[support]] = await db.query("SELECT id FROM roles WHERE name = 'support' AND deleted_at IS NULL");
    colleague = await addUser(ORG, 'menu-colleague-9501@example.com', support.id);
  }, 120000);

  afterAll(teardown);

  test('nobody has a menu to begin with', async () => {
    expect(await menus.mine(ORG, admin)).toEqual({ layout: null, source: 'standard', template: null, can_edit: true });
    expect(await menus.listTemplates(ORG)).toEqual([]);
  });

  test('the groups offered leave out those that never see the sidebar', async () => {
    const { groups, people } = await menus.audience(ORG);
    const names = groups.map((g) => g.name);
    expect(names).toEqual(expect.arrayContaining(['admin', 'billing', 'support', 'technician']));
    expect(names).not.toEqual(expect.arrayContaining(['carrier']));
    expect(names.filter((n) => ['carrier', 'collector', 'reseller_admin'].includes(n))).toEqual([]);
    // Only this organization's people.
    expect(people.map((p) => p.id).sort()).toEqual([admin, colleague].sort());
  });

  test('a template given to a group and to a person reaches them, and nobody else', async () => {
    const desk = await menus.createTemplate(ORG, admin, { name: 'Desk', layout: layout('Daily', ['/invoices', '/payments']) });
    const given = await menus.assignTemplate(ORG, desk.id, { group_ids: [groupId], user_ids: [colleague] });
    expect(given.groups.map((g) => g.id)).toEqual([groupId]);
    expect(given.people.map((p) => p.id)).toEqual([colleague]);

    expect(await menus.mine(ORG, admin)).toEqual({
      layout: layout('Daily', ['/invoices', '/payments']), source: 'template', can_edit: true,
      template: { id: desk.id, name: 'Desk', locked: false, given_to: 'group' },
    });
    expect((await menus.mine(ORG, colleague)).template).toMatchObject({ id: desk.id, given_to: 'person' });
    // The same group in another organization is untouched.
    expect(await menus.mine(OTHER_ORG, outsider)).toMatchObject({ layout: null, source: 'standard' });
    expect(await menus.listTemplates(OTHER_ORG)).toEqual([]);
  });

  test('a person\'s own menu comes before an unlocked template, and can be dropped', async () => {
    const own = await menus.saveMine(ORG, colleague, layout('Mine', ['/tickets']));
    expect(own).toMatchObject({ layout: layout('Mine', ['/tickets']), source: 'personal', can_edit: true });
    // Saving again replaces it; there is one row per person.
    await menus.saveMine(ORG, colleague, layout('Mine', ['/tickets', '/clients']));
    const [[count]] = await db.query('SELECT COUNT(*) AS n FROM user_menus WHERE organization_id = ? AND user_id = ?', [ORG, colleague]);
    expect(count.n).toBe(1);
    expect((await menus.mine(ORG, colleague)).layout).toEqual(layout('Mine', ['/tickets', '/clients']));
    expect(await menus.resetMine(ORG, colleague)).toMatchObject({ source: 'template' });
  });

  test('giving another template moves the group and the person to it', async () => {
    const [desk] = await menus.listTemplates(ORG);
    const field = await menus.createTemplate(ORG, admin, { name: 'Field', layout: layout('Tower', ['/devices']) });
    await menus.assignTemplate(ORG, field.id, { group_ids: [groupId], user_ids: [colleague] });
    const after = await menus.listTemplates(ORG);
    expect(after.find((t) => t.id === desk.id)).toMatchObject({ groups: [], people: [] });
    expect(after.find((t) => t.id === field.id).groups.map((g) => g.id)).toEqual([groupId]);
    expect((await menus.mine(ORG, admin)).template).toMatchObject({ id: field.id, name: 'Field' });
    const [[rows]] = await db.query('SELECT COUNT(*) AS n FROM menu_template_assignments WHERE organization_id = ?', [ORG]);
    expect(rows.n).toBe(2);
  });

  test('a locked template wins over a person\'s own menu and refuses changes', async () => {
    await menus.saveMine(ORG, colleague, layout('Mine', ['/tickets']));
    const field = (await menus.listTemplates(ORG)).find((t) => t.name === 'Field');
    await menus.updateTemplate(ORG, field.id, { name: 'Field', locked: true, layout: field.layout });
    expect(await menus.mine(ORG, colleague)).toMatchObject({ layout: layout('Tower', ['/devices']), source: 'template', can_edit: false });
    await expect(menus.saveMine(ORG, colleague, layout('Mine', ['/clients']))).rejects.toMatchObject({ statusCode: 409 });
    // Unlocked again, their own menu is back as they left it.
    await menus.updateTemplate(ORG, field.id, { name: 'Field', locked: false, layout: field.layout });
    expect(await menus.mine(ORG, colleague)).toMatchObject({ layout: layout('Mine', ['/tickets']), source: 'personal' });
  });

  test('a template cannot be given across organizations or to a group without the sidebar', async () => {
    const field = (await menus.listTemplates(ORG)).find((t) => t.name === 'Field');
    await expect(menus.assignTemplate(ORG, field.id, { user_ids: [outsider] })).rejects.toMatchObject({ statusCode: 422 });
    const [[carrier]] = await db.query("SELECT id FROM roles WHERE name = 'carrier' AND deleted_at IS NULL");
    await expect(menus.assignTemplate(ORG, field.id, { group_ids: [carrier.id] })).rejects.toMatchObject({ statusCode: 422 });
    await expect(menus.assignTemplate(OTHER_ORG, field.id, { group_ids: [groupId] })).rejects.toMatchObject({ statusCode: 404 });
    // A refused request changes nothing.
    expect((await menus.getTemplate(ORG, field.id)).groups.map((g) => g.id)).toEqual([groupId]);
  });

  test('names are unique per organization, and deleting a template frees its people', async () => {
    await expect(menus.createTemplate(ORG, admin, { name: 'Field', layout: layout('X', []) })).rejects.toMatchObject({ statusCode: 409 });
    // The same name is fine in another organization.
    const twin = await menus.createTemplate(OTHER_ORG, outsider, { name: 'Field', layout: layout('X', []) });
    expect(twin.name).toBe('Field');
    const field = (await menus.listTemplates(ORG)).find((t) => t.name === 'Field');
    await menus.deleteTemplate(ORG, field.id);
    expect(await menus.mine(ORG, admin)).toMatchObject({ layout: null, source: 'standard', template: null });
    const [[rows]] = await db.query('SELECT COUNT(*) AS n FROM menu_template_assignments WHERE organization_id = ?', [ORG]);
    expect(rows.n).toBe(0);
  });
});

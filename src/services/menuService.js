// =============================================================================
// VigaBSS 5.0 — menus people arrange themselves, and templates for them
// =============================================================================
// A menu is the sidebar arranged into groups a person names, each holding the
// pages they picked. An administrator can prepare one as a template and give
// it to a user group (a job role) or to one person.
//
// Which menu a person gets, first match wins:
//   1. the template given to them or to their group, when it is LOCKED
//   2. their own menu
//   3. the template given to them
//   4. the template given to their user group
//   5. none: the application shows its standard sidebar
//
// A menu is a list of page addresses and nothing else. It is never consulted
// by an access check: the application shows a page in a menu only to someone
// whose permissions already open it, so a template can safely name pages
// some of its people cannot use.
// =============================================================================

const db = require('../config/database');
const { ConflictError, NotFoundError, ValidationError } = require('../utils/errors');

const LIMITS = { groups: 20, pages: 30, name: 40, templateName: 80 };
const PAGE = /^\/[a-z0-9]+(?:[-/][a-z0-9]+)*$/;

/** A layout as stored: trimmed names, known shape, no repeated page in a group. */
function cleanLayout(input) {
  const groups = input && Array.isArray(input.groups) ? input.groups : null;
  if (!groups) throw new ValidationError('A menu is a list of groups');
  if (groups.length > LIMITS.groups) throw new ValidationError(`A menu has at most ${LIMITS.groups} groups`);
  const seen = new Set();
  return {
    groups: groups.map((group) => {
      const name = typeof group?.name === 'string' ? group.name.trim() : '';
      if (!name) throw new ValidationError('Every group needs a name');
      if (name.length > LIMITS.name) throw new ValidationError(`A group name has at most ${LIMITS.name} characters`);
      if (seen.has(name.toLowerCase())) throw new ValidationError(`Two groups are named "${name}"`);
      seen.add(name.toLowerCase());
      const pages = Array.isArray(group.pages) ? group.pages : [];
      if (pages.length > LIMITS.pages) throw new ValidationError(`A group holds at most ${LIMITS.pages} pages`);
      for (const page of pages) {
        if (typeof page !== 'string' || page.length > 120 || !PAGE.test(page)) throw new ValidationError('A page is named by its address, such as /invoices');
      }
      return { name, pages: [...new Set(pages)] };
    }),
  };
}

const asLayout = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const templateRow = (row) => ({ id: row.id, name: row.name, locked: Boolean(row.locked), layout: asLayout(row.layout) });

/** The template given to this person, or else to their user group. */
async function templateFor(orgId, userId) {
  const [rows] = await db.query(
    `SELECT t.id, t.name, t.locked, t.layout, a.user_id
       FROM menu_template_assignments a
       JOIN menu_templates t ON t.id = a.template_id AND t.organization_id = a.organization_id
      WHERE a.organization_id = ?
        AND (a.user_id = ? OR a.role_id = (SELECT u.group_id FROM users u WHERE u.id = ? AND u.deleted_at IS NULL))
      ORDER BY (a.user_id IS NULL), a.id
      LIMIT 1`,
    [orgId, userId, userId],
  );
  if (!rows[0]) return null;
  return { ...templateRow(rows[0]), given_to: rows[0].user_id ? 'person' : 'group' };
}

/** The menu this person sees, where it comes from, and whether they may change it. */
async function mine(orgId, userId) {
  const template = await templateFor(orgId, userId);
  const summary = template ? { id: template.id, name: template.name, locked: template.locked, given_to: template.given_to } : null;
  if (template?.locked) return { layout: template.layout, source: 'template', template: summary, can_edit: false };
  const [rows] = await db.query('SELECT layout FROM user_menus WHERE organization_id = ? AND user_id = ?', [orgId, userId]);
  if (rows[0]) return { layout: asLayout(rows[0].layout), source: 'personal', template: summary, can_edit: true };
  if (template) return { layout: template.layout, source: 'template', template: summary, can_edit: true };
  return { layout: null, source: 'standard', template: null, can_edit: true };
}

async function saveMine(orgId, userId, input) {
  const layout = cleanLayout(input);
  const template = await templateFor(orgId, userId);
  if (template?.locked) throw new ConflictError('Your menu is set by your organization and cannot be changed');
  await db.query(
    `INSERT INTO user_menus (organization_id, user_id, layout) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE layout = VALUES(layout)`,
    [orgId, userId, JSON.stringify(layout)],
  );
  return mine(orgId, userId);
}

/** Drop the person's own menu: back to their template, or the standard sidebar. */
async function resetMine(orgId, userId) {
  await db.query('DELETE FROM user_menus WHERE organization_id = ? AND user_id = ?', [orgId, userId]);
  return mine(orgId, userId);
}

// --- Templates ---------------------------------------------------------------

async function listTemplates(orgId) {
  const [templates] = await db.query(
    'SELECT id, name, locked, layout FROM menu_templates WHERE organization_id = ? ORDER BY name',
    [orgId],
  );
  const [given] = await db.query(
    `SELECT a.template_id, a.role_id, a.user_id, r.name AS role_name,
            NULLIF(TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))), '') AS user_name, u.email
       FROM menu_template_assignments a
       LEFT JOIN roles r ON r.id = a.role_id AND r.deleted_at IS NULL
       LEFT JOIN users u ON u.id = a.user_id AND u.organization_id = a.organization_id AND u.deleted_at IS NULL
      WHERE a.organization_id = ?
      ORDER BY a.id`,
    [orgId],
  );
  return templates.map((row) => ({
    ...templateRow(row),
    groups: given.filter((g) => g.template_id === row.id && g.role_id).map((g) => ({ id: g.role_id, name: g.role_name })),
    people: given.filter((g) => g.template_id === row.id && g.user_id).map((g) => ({ id: g.user_id, name: g.user_name || g.email })),
  }));
}

async function getTemplate(orgId, id) {
  const found = (await listTemplates(orgId)).find((t) => String(t.id) === String(id));
  if (!found) throw new NotFoundError('Menu template');
  return found;
}

function templateFields(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) throw new ValidationError('A template needs a name');
  if (name.length > LIMITS.templateName) throw new ValidationError(`A template name has at most ${LIMITS.templateName} characters`);
  return { name, locked: input.locked ? 1 : 0, layout: cleanLayout(input.layout) };
}

async function nameTaken(orgId, name, exceptId = null) {
  const [rows] = await db.query(
    'SELECT id FROM menu_templates WHERE organization_id = ? AND name = ? AND id <> ? LIMIT 1',
    [orgId, name, exceptId ?? 0],
  );
  return rows.length > 0;
}

async function createTemplate(orgId, userId, input) {
  const fields = templateFields(input);
  if (await nameTaken(orgId, fields.name)) throw new ConflictError('Another template already has that name');
  const [result] = await db.query(
    'INSERT INTO menu_templates (organization_id, name, locked, layout, created_by) VALUES (?, ?, ?, ?, ?)',
    [orgId, fields.name, fields.locked, JSON.stringify(fields.layout), userId ?? null],
  );
  return getTemplate(orgId, result.insertId);
}

async function updateTemplate(orgId, id, input) {
  await getTemplate(orgId, id);
  const fields = templateFields(input);
  if (await nameTaken(orgId, fields.name, id)) throw new ConflictError('Another template already has that name');
  await db.query(
    'UPDATE menu_templates SET name = ?, locked = ?, layout = ? WHERE organization_id = ? AND id = ?',
    [fields.name, fields.locked, JSON.stringify(fields.layout), orgId, id],
  );
  return getTemplate(orgId, id);
}

async function deleteTemplate(orgId, id) {
  await getTemplate(orgId, id);
  await db.query('DELETE FROM menu_templates WHERE organization_id = ? AND id = ?', [orgId, id]);
  return { deleted: true };
}

const idList = (value, what) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => !Number.isInteger(Number(v)) || Number(v) <= 0)) throw new ValidationError(`${what} must be a list of ids`);
  return [...new Set(value.map(Number))];
};

/**
 * Say who gets a template: these user groups and these people, replacing who
 * had it. A group or person that had another template moves to this one. The
 * people must belong to the organization.
 */
async function assignTemplate(orgId, id, input) {
  await getTemplate(orgId, id);
  const roleIds = idList(input?.group_ids, 'group_ids');
  const userIds = idList(input?.user_ids, 'user_ids');
  if (roleIds.length) {
    const [roles] = await db.query('SELECT id FROM roles WHERE id IN (?) AND deleted_at IS NULL', [roleIds]);
    if (roles.length !== roleIds.length) throw new ValidationError('A user group in the list does not exist');
  }
  if (userIds.length) {
    const [users] = await db.query('SELECT id FROM users WHERE id IN (?) AND organization_id = ? AND deleted_at IS NULL', [userIds, orgId]);
    if (users.length !== userIds.length) throw new ValidationError('A person in the list is not in this organization');
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM menu_template_assignments WHERE organization_id = ? AND template_id = ?', [orgId, id]);
    if (roleIds.length) await conn.query('DELETE FROM menu_template_assignments WHERE organization_id = ? AND role_id IN (?)', [orgId, roleIds]);
    if (userIds.length) await conn.query('DELETE FROM menu_template_assignments WHERE organization_id = ? AND user_id IN (?)', [orgId, userIds]);
    const rows = [...roleIds.map((roleId) => [orgId, id, roleId, null]), ...userIds.map((userId) => [orgId, id, null, userId])];
    if (rows.length) await conn.query('INSERT INTO menu_template_assignments (organization_id, template_id, role_id, user_id) VALUES ?', [rows]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getTemplate(orgId, id);
}

/** The user groups and people a template can be given to. */
async function audience(orgId) {
  const [groups] = await db.query('SELECT id, name FROM roles WHERE deleted_at IS NULL ORDER BY name');
  const [people] = await db.query(
    `SELECT id, email, NULLIF(TRIM(CONCAT(COALESCE(first_name, ''), ' ', COALESCE(last_name, ''))), '') AS name
       FROM users WHERE organization_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY first_name, last_name, email`,
    [orgId],
  );
  return { groups, people: people.map((p) => ({ id: p.id, name: p.name || p.email })) };
}

module.exports = {
  mine, saveMine, resetMine,
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate, assignTemplate, audience,
  // exported for tests
  cleanLayout, LIMITS,
};

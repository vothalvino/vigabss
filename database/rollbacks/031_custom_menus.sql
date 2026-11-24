-- Rollback 031 — drops menu templates, who they were given to, and every
-- person's own menu; everyone is back on the standard sidebar. Removes the
-- menu_templates.manage permission.

DROP TABLE IF EXISTS user_menus;
DROP TABLE IF EXISTS menu_template_assignments;
DROP TABLE IF EXISTS menu_templates;
DELETE rp FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE p.name = 'menu_templates.manage';
DELETE FROM permissions WHERE name = 'menu_templates.manage';

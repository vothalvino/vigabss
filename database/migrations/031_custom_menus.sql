-- =============================================================================
-- Migration 031 — menus people arrange themselves, and templates for them
-- =============================================================================
-- A person can arrange the sidebar into groups they name, each holding the
-- pages they pick. An administrator can prepare such a menu as a template
-- and give it to a user group (a job role) or to one person.
--
--   menu_templates             a prepared menu; `locked` stops the people who
--                              get it from changing their own
--   menu_template_assignments  who gets which template: at most one per user
--                              group and one per person in an organization
--   user_menus                 a person's own menu
--
-- A menu is a list of page addresses and nothing more. It grants no access:
-- the application shows a page in a menu only to someone whose permissions
-- already open it, and every route and API check is unchanged.
--
-- New permission menu_templates.manage (module settings) for administrators.
--
-- Safe to re-run: tables are created only when missing; the seeds INSERT
-- IGNORE.
-- =============================================================================

CREATE TABLE IF NOT EXISTS menu_templates (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id BIGINT UNSIGNED NOT NULL,
    name            VARCHAR(80)     NOT NULL,
    locked          TINYINT(1)      NOT NULL DEFAULT 0 COMMENT '1 = people given this template cannot change their own menu',
    layout          JSON            NOT NULL COMMENT '{"groups":[{"name":"...","pages":["/path",...]}]}: page addresses only, never a permission',
    created_by      BIGINT UNSIGNED NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_menu_templates_name (organization_id, name),
    CONSTRAINT fk_menu_templates_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    CONSTRAINT fk_menu_templates_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='A sidebar menu an administrator prepared for a job role or a person (migration 031)';

CREATE TABLE IF NOT EXISTS menu_template_assignments (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id BIGINT UNSIGNED NOT NULL,
    template_id     BIGINT UNSIGNED NOT NULL,
    role_id         BIGINT UNSIGNED NULL COMMENT 'roles.id: everyone in this user group gets the template',
    user_id         BIGINT UNSIGNED NULL COMMENT 'users.id: this person gets the template, ahead of their group''s',
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_menu_template_assignments_role (organization_id, role_id),
    UNIQUE KEY uq_menu_template_assignments_user (organization_id, user_id),
    KEY idx_menu_template_assignments_template (template_id),
    CONSTRAINT fk_menu_template_assignments_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    CONSTRAINT fk_menu_template_assignments_template FOREIGN KEY (template_id) REFERENCES menu_templates (id) ON DELETE CASCADE,
    CONSTRAINT fk_menu_template_assignments_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
    CONSTRAINT fk_menu_template_assignments_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Who gets which menu template: one per user group and one per person in an organization (migration 031)';

CREATE TABLE IF NOT EXISTS user_menus (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    organization_id BIGINT UNSIGNED NOT NULL,
    user_id         BIGINT UNSIGNED NOT NULL,
    layout          JSON            NOT NULL COMMENT 'Same shape as menu_templates.layout',
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_user_menus_user (organization_id, user_id),
    CONSTRAINT fk_user_menus_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE CASCADE,
    CONSTRAINT fk_user_menus_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='A person''s own sidebar menu in an organization (migration 031)';

INSERT IGNORE INTO permissions (name, description, module) VALUES
  ('menu_templates.manage', 'Prepare sidebar menus as templates and give them to user groups or people (a menu shows only pages a person may already open)', 'settings');

-- admin holds every non-platform permission (seed invariant).
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.name IN ('menu_templates.manage')
 WHERE r.name = 'admin'
   AND r.is_system = 1;

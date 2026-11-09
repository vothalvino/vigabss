-- Rollback 010 — removes the Manager user group and point_logins.create. The
-- group is removed only when no user belongs to it; a remaining one keeps the
-- group with no permissions (deny-all). Cash bags need nothing: a with_carrier
-- bag that names its point is still a valid bag for the earlier code (its
-- drop-off sets the point again). Roll back only to recover from a failed
-- deploy, then roll forward.

-- role_permissions rows go with the permission (ON DELETE CASCADE).
DELETE FROM permissions WHERE name IN ('point_logins.create');

DELETE rp
  FROM role_permissions rp
  JOIN roles r ON r.id = rp.role_id
 WHERE r.name = 'manager'
   AND r.is_system = 1;

DELETE r
  FROM roles r
  LEFT JOIN users u ON u.group_id = r.id
 WHERE r.name = 'manager'
   AND r.is_system = 1
   AND u.id IS NULL;

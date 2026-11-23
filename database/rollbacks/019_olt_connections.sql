-- Rollback 019 — drops olt_connections. The saved OLT logins (address, user,
-- encrypted password, pinned host key) are lost and must be entered again.

DROP TABLE IF EXISTS olt_connections;

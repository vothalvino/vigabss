-- =============================================================================
-- Migration 478 — scrub credentials from the router command history
-- =============================================================================
-- NET-10 (rest): POST /router-drivers/:id/dispatch stored its params verbatim
-- in device_command_executions, and GET /router-drivers/command-executions/list
-- returns them to every device_command_executions.view holder. pppoe_create
-- carries the subscriber's PPPoE password as `secretPassword`, so each one
-- dispatched that way stayed readable in the history. New rows are redacted
-- before insert and the list redacts on read; this replaces the stored values
-- of the credential keys the mapped commands and router connections use.
-- =============================================================================

UPDATE device_command_executions
   SET params = JSON_SET(params, '$.secretPassword', '[REDACTED]')
 WHERE params IS NOT NULL
   AND JSON_VALID(params)
   AND JSON_CONTAINS_PATH(params, 'one', '$.secretPassword')
   AND JSON_TYPE(JSON_EXTRACT(params, '$.secretPassword')) = 'STRING';

UPDATE device_command_executions
   SET params = JSON_SET(params, '$.password', '[REDACTED]')
 WHERE params IS NOT NULL
   AND JSON_VALID(params)
   AND JSON_CONTAINS_PATH(params, 'one', '$.password')
   AND JSON_TYPE(JSON_EXTRACT(params, '$.password')) = 'STRING';

UPDATE device_command_executions
   SET params = JSON_SET(params, '$.secret', '[REDACTED]')
 WHERE params IS NOT NULL
   AND JSON_VALID(params)
   AND JSON_CONTAINS_PATH(params, 'one', '$.secret')
   AND JSON_TYPE(JSON_EXTRACT(params, '$.secret')) = 'STRING';

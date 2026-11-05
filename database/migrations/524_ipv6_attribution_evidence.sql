-- =============================================================================
-- Migration 524 — IPv6 in the legal IP attribution evidence
-- =============================================================================
-- The case-gated attribution lookup and government ip_traceability requests
-- accepted IPv4 only. IPv6 attribution needs evidence the append-only
-- radius_accounting_events rows did not keep: they stored one prefix,
-- COALESCE(Framed-IPv6-Prefix, Delegated-IPv6-Prefix), so with both present
-- the delegated prefix (the subscriber's LAN, where most addresses a request
-- names live) was lost, and the subscriber's IPv6 WAN address
-- (Framed-IPv6-Address) was never recorded; a change of either wrote no new
-- evidence either.
--
--   1. radius_accounting_events keeps the delegated prefix and the IPv6
--      address beside the existing column (whose meaning is unchanged).
--   2. Both evidence triggers record them, include them in the dedupe key
--      and the integrity-hashed raw attributes, and write new evidence when
--      either changes.
--   3. connection_logs gets organization-leading indexes on the two prefix
--      columns: the lookup matches an address against every prefix that
--      contains it.
--   4. ip_attribution_case_evidence takes IPv6: evidence_type
--      'direct_ipv6_assignment', ip_address for either family (public_ipv4
--      stays for IPv4 and becomes nullable).
-- =============================================================================

DROP PROCEDURE IF EXISTS migration_524_ipv6_attribution;
DELIMITER //
CREATE PROCEDURE migration_524_ipv6_attribution()
BEGIN
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'radius_accounting_events' AND COLUMN_NAME = 'delegated_ipv6_prefix') THEN
    ALTER TABLE radius_accounting_events
      ADD COLUMN delegated_ipv6_prefix VARCHAR(64) NULL COMMENT 'Delegated-IPv6-Prefix (DHCPv6-PD) at this event (migration 524)' AFTER framed_ipv6_prefix;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'radius_accounting_events' AND COLUMN_NAME = 'framed_ipv6_address') THEN
    ALTER TABLE radius_accounting_events
      ADD COLUMN framed_ipv6_address VARCHAR(45) NULL COMMENT 'Framed-IPv6-Address (the WAN address) at this event (migration 524)' AFTER delegated_ipv6_prefix;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connection_logs' AND INDEX_NAME = 'idx_conn_logs_org_framed_ipv6_prefix') THEN
    ALTER TABLE connection_logs ADD KEY idx_conn_logs_org_framed_ipv6_prefix (organization_id, framed_ipv6_prefix);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connection_logs' AND INDEX_NAME = 'idx_conn_logs_org_delegated_ipv6_prefix') THEN
    ALTER TABLE connection_logs ADD KEY idx_conn_logs_org_delegated_ipv6_prefix (organization_id, ipv6_delegated_prefix);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'connection_logs' AND INDEX_NAME = 'idx_conn_logs_org_ipv6_address') THEN
    ALTER TABLE connection_logs ADD KEY idx_conn_logs_org_ipv6_address (organization_id, ipv6_address);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_attribution_case_evidence'
       AND COLUMN_NAME = 'evidence_type' AND COLUMN_TYPE LIKE '%''direct_ipv6_assignment''%') THEN
    ALTER TABLE ip_attribution_case_evidence
      MODIFY COLUMN evidence_type ENUM('cgnat_binding','direct_public_assignment','direct_ipv6_assignment') NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ip_attribution_case_evidence' AND COLUMN_NAME = 'ip_address') THEN
    ALTER TABLE ip_attribution_case_evidence
      ADD COLUMN ip_address VARCHAR(45) NULL COMMENT 'The looked-up address, IPv4 or IPv6, canonical (migration 524)' AFTER query_key,
      MODIFY COLUMN public_ipv4 VARCHAR(15) NULL;
    UPDATE ip_attribution_case_evidence SET ip_address = public_ipv4 WHERE ip_address IS NULL;
  END IF;
END //
DELIMITER ;

CALL migration_524_ipv6_attribution();
DROP PROCEDURE IF EXISTS migration_524_ipv6_attribution;

DROP TRIGGER IF EXISTS trg_connection_logs_after_insert_evidence;
DELIMITER //
CREATE TRIGGER trg_connection_logs_after_insert_evidence
AFTER INSERT ON connection_logs
FOR EACH ROW
BEGIN
  DECLARE v_event_at TIMESTAMP(3);
  DECLARE v_observed_at TIMESTAMP(3);
  DECLARE v_dedupe CHAR(64);
  DECLARE v_integrity CHAR(64);
  DECLARE v_raw JSON;
  DECLARE v_is_milestone BOOLEAN DEFAULT FALSE;
  SET v_event_at = COALESCE(NEW.last_accounting_at, NEW.event_at);
  SET v_observed_at = COALESCE(NEW.last_accounting_received_at, CURRENT_TIMESTAMP(3));
  SET v_is_milestone = NEW.session_instance_id IS NOT NULL
    OR NEW.event_type IN ('start', 'stop');
  IF NEW.organization_id IS NOT NULL AND v_is_milestone THEN
    SET v_raw = JSON_OBJECT('event_type', NEW.event_type,
      'ip_address', COALESCE(NEW.framed_ip, NEW.ip_address),
      'ipv6_prefix', COALESCE(NEW.framed_ipv6_prefix, NEW.ipv6_delegated_prefix),
      'ipv6_delegated_prefix', NEW.ipv6_delegated_prefix,
      'ipv6_address', NEW.ipv6_address,
      'acct_delay_seconds', NEW.acct_delay_seconds);
    SET v_dedupe = SHA2(CAST(JSON_ARRAY(
      NEW.organization_id, NULLIF(NEW.contract_id, 0), NULLIF(NEW.client_id, 0),
      NEW.nas_id, NEW.username, NEW.session_instance_id,
      COALESCE(NEW.acct_session_id, NEW.session_id), NEW.event_type,
      ROUND(UNIX_TIMESTAMP(v_event_at) * 1000), NEW.nas_ip_address,
      NEW.nas_port_id, NEW.called_station_id, NEW.calling_station_id,
      COALESCE(NEW.framed_ip, NEW.ip_address),
      COALESCE(NEW.framed_ipv6_prefix, NEW.ipv6_delegated_prefix),
      NEW.ipv6_delegated_prefix, NEW.ipv6_address,
      NEW.bytes_in, NEW.bytes_out, NEW.packets_in, NEW.packets_out,
      NEW.session_duration, NEW.terminate_cause, NEW.acct_delay_seconds
    ) AS CHAR), 256);
    SET v_integrity = SHA2(CAST(JSON_ARRAY(v_dedupe, NEW.id,
      ROUND(UNIX_TIMESTAMP(v_observed_at) * 1000), 'connection_log_trigger', v_raw) AS CHAR), 256);
    INSERT INTO radius_accounting_events
      (organization_id, connection_log_id, contract_id, client_id, nas_id,
       username, acct_session_id, session_instance_id, status_type, event_at, observed_at, nas_ip_address,
       nas_port_id, called_station_id, calling_station_id, framed_ip,
       framed_ipv6_prefix, delegated_ipv6_prefix, framed_ipv6_address,
       bytes_in, bytes_out, packets_in, packets_out,
       session_duration, terminate_cause, acct_delay_seconds, source, dedupe_key, integrity_hash,
       raw_attributes)
    VALUES (NEW.organization_id, NEW.id, NULLIF(NEW.contract_id, 0), NULLIF(NEW.client_id, 0), NEW.nas_id,
       NEW.username, COALESCE(NEW.acct_session_id, NEW.session_id), NEW.session_instance_id,
       NEW.event_type, v_event_at, v_observed_at, NEW.nas_ip_address, NEW.nas_port_id, NEW.called_station_id,
       NEW.calling_station_id, COALESCE(NEW.framed_ip, NEW.ip_address),
       COALESCE(NEW.framed_ipv6_prefix, NEW.ipv6_delegated_prefix),
       NEW.ipv6_delegated_prefix, NEW.ipv6_address,
       NEW.bytes_in, NEW.bytes_out, NEW.packets_in, NEW.packets_out,
       NEW.session_duration, NEW.terminate_cause, NEW.acct_delay_seconds,
       'connection_log_trigger', v_dedupe, v_integrity, v_raw)
    ON DUPLICATE KEY UPDATE id = id;
  END IF;
END //
DELIMITER ;

DROP TRIGGER IF EXISTS trg_connection_logs_after_update_evidence;
DELIMITER //
CREATE TRIGGER trg_connection_logs_after_update_evidence
AFTER UPDATE ON connection_logs
FOR EACH ROW
BEGIN
  DECLARE v_event_at TIMESTAMP(3);
  DECLARE v_observed_at TIMESTAMP(3);
  DECLARE v_dedupe CHAR(64);
  DECLARE v_integrity CHAR(64);
  DECLARE v_raw JSON;
  IF NEW.organization_id IS NOT NULL AND (
       NOT (NEW.event_type <=> OLD.event_type)
    OR NOT (NEW.framed_ip <=> OLD.framed_ip)
    OR NOT (NEW.framed_ipv6_prefix <=> OLD.framed_ipv6_prefix)
    OR NOT (NEW.ipv6_delegated_prefix <=> OLD.ipv6_delegated_prefix)
    OR NOT (NEW.ipv6_address <=> OLD.ipv6_address)
    OR NOT (NEW.calling_station_id <=> OLD.calling_station_id)
    OR (NEW.event_type = 'stop' AND OLD.event_type = 'stop'
        AND (NOT (NEW.bytes_in <=> OLD.bytes_in)
          OR NOT (NEW.bytes_out <=> OLD.bytes_out)
          OR NOT (NEW.packets_in <=> OLD.packets_in)
          OR NOT (NEW.packets_out <=> OLD.packets_out)
          OR NOT (NEW.session_duration <=> OLD.session_duration)
          OR NOT (NEW.terminate_cause <=> OLD.terminate_cause)
          OR NOT (NEW.framed_ip <=> OLD.framed_ip)
          OR NOT (NEW.framed_ipv6_prefix <=> OLD.framed_ipv6_prefix)
          OR NOT (NEW.ipv6_delegated_prefix <=> OLD.ipv6_delegated_prefix)
          OR NOT (NEW.ipv6_address <=> OLD.ipv6_address)
          OR NOT (NEW.acct_delay_seconds <=> OLD.acct_delay_seconds)))
  ) THEN
    SET v_event_at = COALESCE(NEW.last_accounting_at, NEW.event_at);
    SET v_observed_at = COALESCE(NEW.last_accounting_received_at, CURRENT_TIMESTAMP(3));
    SET v_raw = JSON_OBJECT('event_type', NEW.event_type,
      'ip_address', COALESCE(NEW.framed_ip, NEW.ip_address),
      'ipv6_prefix', COALESCE(NEW.framed_ipv6_prefix, NEW.ipv6_delegated_prefix),
      'ipv6_delegated_prefix', NEW.ipv6_delegated_prefix,
      'ipv6_address', NEW.ipv6_address,
      'acct_delay_seconds', NEW.acct_delay_seconds);
    SET v_dedupe = SHA2(CAST(JSON_ARRAY(
      NEW.organization_id, NULLIF(NEW.contract_id, 0), NULLIF(NEW.client_id, 0),
      NEW.nas_id, NEW.username, NEW.session_instance_id,
      COALESCE(NEW.acct_session_id, NEW.session_id), NEW.event_type,
      ROUND(UNIX_TIMESTAMP(v_event_at) * 1000), NEW.nas_ip_address,
      NEW.nas_port_id, NEW.called_station_id, NEW.calling_station_id,
      COALESCE(NEW.framed_ip, NEW.ip_address),
      COALESCE(NEW.framed_ipv6_prefix, NEW.ipv6_delegated_prefix),
      NEW.ipv6_delegated_prefix, NEW.ipv6_address,
      NEW.bytes_in, NEW.bytes_out, NEW.packets_in, NEW.packets_out,
      NEW.session_duration, NEW.terminate_cause, NEW.acct_delay_seconds
    ) AS CHAR), 256);
    SET v_integrity = SHA2(CAST(JSON_ARRAY(v_dedupe, NEW.id,
      ROUND(UNIX_TIMESTAMP(v_observed_at) * 1000), 'connection_log_trigger', v_raw) AS CHAR), 256);
    INSERT INTO radius_accounting_events
      (organization_id, connection_log_id, contract_id, client_id, nas_id,
       username, acct_session_id, session_instance_id, status_type, event_at, observed_at, nas_ip_address,
       nas_port_id, called_station_id, calling_station_id, framed_ip,
       framed_ipv6_prefix, delegated_ipv6_prefix, framed_ipv6_address,
       bytes_in, bytes_out, packets_in, packets_out,
       session_duration, terminate_cause, acct_delay_seconds, source, dedupe_key, integrity_hash,
       raw_attributes)
    VALUES (NEW.organization_id, NEW.id, NULLIF(NEW.contract_id, 0), NULLIF(NEW.client_id, 0), NEW.nas_id,
       NEW.username, COALESCE(NEW.acct_session_id, NEW.session_id), NEW.session_instance_id,
       NEW.event_type, v_event_at, v_observed_at, NEW.nas_ip_address, NEW.nas_port_id, NEW.called_station_id,
       NEW.calling_station_id, COALESCE(NEW.framed_ip, NEW.ip_address),
       COALESCE(NEW.framed_ipv6_prefix, NEW.ipv6_delegated_prefix),
       NEW.ipv6_delegated_prefix, NEW.ipv6_address,
       NEW.bytes_in, NEW.bytes_out, NEW.packets_in, NEW.packets_out,
       NEW.session_duration, NEW.terminate_cause, NEW.acct_delay_seconds,
       'connection_log_trigger', v_dedupe, v_integrity, v_raw)
    ON DUPLICATE KEY UPDATE id = id;
  END IF;
END //
DELIMITER ;

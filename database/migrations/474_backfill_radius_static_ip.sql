-- =============================================================================
-- Migration 474 — copy PPPoE static IPs from the contract to its RADIUS account
-- =============================================================================
-- NPR-02: for PPPoE the contract form is the only UI for a static IP, but
-- provisioning never copied contracts.ip_address into radius.ip_address, and
-- RADIUS sends radius.ip_address as Framed-IP-Address. Every PPPoE static IP
-- set before this release therefore never reached the NAS. New contracts and
-- contract edits now keep the two in step; this fills in the existing live
-- accounts that have no address of their own. Only IPv4 values are copied
-- (Framed-IP-Address is IPv4), and an address already set on the account is
-- never overwritten.
-- =============================================================================

UPDATE radius r
  JOIN contracts c ON c.id = r.contract_id
   SET r.ip_address = c.ip_address
 WHERE r.deleted_at IS NULL
   AND c.deleted_at IS NULL
   AND (r.ip_address IS NULL OR r.ip_address = '')
   AND c.ip_address IS NOT NULL
   AND c.connection_type IN ('pppoe', 'pppoe_dual')
   AND c.ip_address REGEXP '^[0-9]{1,3}([.][0-9]{1,3}){3}$';

-- =============================================================================
-- Rollback 525 — Every SNMP profile VigaBSS ships is a system profile
-- =============================================================================

UPDATE snmp_profiles
   SET is_system = FALSE
 WHERE organization_id IS NULL
   AND is_system = TRUE
   AND name IN (
    'Cisco BNG',
    'Cisco IOS',
    'Environmental Sensors',
    'Generic Switch',
    'Generic UPS',
    'Huawei OLT',
    'Huawei VRP',
    'Juniper BNG',
    'Juniper JunOS',
    'SFP Diagnostics',
    'Ubiquiti LiteBeam 5AC Gen2',
    'Ubiquiti PowerBeam M5-400',
    'Ubiquiti airCube ISP',
    'Ubiquiti airOS v6 (airMAX M)',
    'Ubiquiti airOS v8 (airMAX AC)',
    'ZTE OLT',
    'ZTE ZXAN'
   );

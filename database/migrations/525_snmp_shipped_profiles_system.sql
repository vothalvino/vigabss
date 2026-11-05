-- =============================================================================
-- Migration 525 — Every SNMP profile VigaBSS ships is a system profile
-- =============================================================================
-- Migration 440 split snmp_profiles into SYSTEM profiles (is_system = 1,
-- organization_id NULL: visible to every tenant, editable by none) and tenant
-- profiles, but marked only the eight it listed by name. The other seventeen
-- seeded vendor profiles (031, 252, 264, 280, 413, 414) stayed is_system = 0
-- with no owner, so the API treated them as unattributed legacy rows: the
-- first tenant to edit, delete or restore one adopted it, and it vanished
-- from every other tenant's library. They are shipped profiles; mark them so.
-- tests/snmpSystemProfiles.test.js keeps every seeded name in this list.
-- =============================================================================

UPDATE snmp_profiles
   SET is_system = TRUE
 WHERE organization_id IS NULL
   AND is_system = FALSE
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

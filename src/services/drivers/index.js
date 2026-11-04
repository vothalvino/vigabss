// =============================================================================
// VigaBSS — device driver registry (NET-30)
// =============================================================================
// One interface for every vendor. A driver is
//   { vendor, protocols[], toConnection(creds), test(conn), commands: { name(conn, params) } }
// and is registered here. A vendor without a driver is not an error to hide:
// callers record the command as not_dispatched and say so, because nothing was
// sent to the device. tests/deviceDrivers.test.js holds every registered
// driver to the contract.
//
// The vendors router_driver_configs.vendor allows; only those with an entry
// in DRIVERS can talk to a device.
// =============================================================================

const VENDORS = ['mikrotik', 'cisco_ios', 'cisco_iosxe', 'juniper_junos', 'zte', 'huawei', 'generic_rest'];

const DRIVERS = {
  mikrotik: require('./mikrotik'),
};

/** The driver for a vendor, or null when none is implemented. */
function getDriver(vendor) {
  return Object.prototype.hasOwnProperty.call(DRIVERS, vendor) ? DRIVERS[vendor] : null;
}

function implementedVendors() {
  return Object.keys(DRIVERS);
}

module.exports = { VENDORS, getDriver, implementedVendors };

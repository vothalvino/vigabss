// =============================================================================
// VigaBSS 5.0 — FreeRADIUS accounting attributes
// =============================================================================
// Turns a FreeRADIUS rlm_rest accounting body (hyphenated or camelCase
// attribute names, flat or rlm_rest's native {type, value: [...]} shape) into
// the attribute object radiusAccountingService.ingestAccounting takes. Used by
// POST /radius/accounting/tenant (src/routes/radius.js).
// =============================================================================

const { ValidationError } = require('./errors');

// ---------------------------------------------------------------------------
// Attribute normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Read a value from req.body by checking both the hyphenated RADIUS attribute
 * name and the camelCase variant that the FreeRADIUS rest module may send.
 *
 * @param {object} body
 * @param {string} hyphenated  - e.g. 'Acct-Status-Type'
 * @param {string} camelCase   - e.g. 'acctStatusType'
 * @returns {string|undefined}
 */
function unwrapRadiusValue(value) {
  // FreeRADIUS 3 rlm_rest's native `body = 'json'` encoding is:
  //   "User-Name": { "type": "string", "value": ["alice"] }
  // Keep accepting the flat form used by hand-written shippers and older
  // VigaBSS examples, but consume the real module wire shape directly.
  if (value && typeof value === 'object' && !Array.isArray(value)
      && Array.isArray(value.value)) {
    return value.value[0];
  }
  if (Array.isArray(value)) return value[0];
  return value;
}

function pick(body, hyphenated, camelCase) {
  const raw = body[hyphenated] !== undefined ? body[hyphenated] : body[camelCase];
  return unwrapRadiusValue(raw);
}

// FreeRADIUS 3 rlm_rest prints `date` attributes as text in the server's
// local zone ('%b %e %Y %H:%M:%S %Z', e.g. "Oct 20 2026 12:00:00 CST"), so
// the documented setup sent every Event-Timestamp that way and ingest
// rejected the packet with 422 (REG-05). The zone abbreviation is ambiguous
// (CST is UTC-6 or UTC+8), so the text is not trusted: it is dropped, and
// ingest dates the event at receipt time minus Acct-Delay-Time, exactly as
// for a packet that carries no Event-Timestamp.
const RLM_REST_DATE_TEXT = /^[A-Z][a-z]{2} {1,2}\d{1,2} \d{4} \d{2}:\d{2}:\d{2}(?: [A-Za-z0-9+:-]{1,10})?$/;

function pickEventTimestamp(body) {
  const value = pick(body, 'Event-Timestamp', 'eventTimestamp');
  if (typeof value === 'string' && RLM_REST_DATE_TEXT.test(value)) return null;
  return value || null;
}

/**
 * Parse a body value as integer, returning null if absent or not a number.
 * @param {object} body
 * @param {string} hyphenated
 * @param {string} camelCase
 * @param {number} [defaultValue=null]
 * @returns {number|null}
 */
function pickInt(body, hyphenated, camelCase, defaultValue = null) {
  const raw = pick(body, hyphenated, camelCase);
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  if ((typeof raw !== 'number' && typeof raw !== 'string')
      || !/^\d+$/.test(String(raw)) || !Number.isSafeInteger(Number(raw))) {
    throw new ValidationError(`Invalid ${hyphenated}`, [{
      field: hyphenated,
      message: `${hyphenated} must be a non-negative safe integer`,
    }]);
  }
  return Number(raw);
}

function normalizeAccountingBody(body = {}) {
  return {
    acctStatusType: pick(body, 'Acct-Status-Type', 'acctStatusType'),
    userName: pick(body, 'User-Name', 'userName'),
    acctSessionId: pick(body, 'Acct-Session-Id', 'acctSessionId'),
    nasIpAddress: pick(body, 'NAS-IP-Address', 'nasIpAddress'),
    nasPort: pickInt(body, 'NAS-Port', 'nasPort'),
    nasPortId: pick(body, 'NAS-Port-Id', 'nasPortId') || null,
    calledStationId: pick(body, 'Called-Station-Id', 'calledStationId') || null,
    callingStationId: pick(body, 'Calling-Station-Id', 'callingStationId') || null,
    framedIpAddress: pick(body, 'Framed-IP-Address', 'framedIpAddress') || null,
    framedIpv6Prefix: pick(body, 'Framed-IPv6-Prefix', 'framedIpv6Prefix') || null,
    delegatedIpv6Prefix: pick(body, 'Delegated-IPv6-Prefix', 'delegatedIpv6Prefix') || null,
    framedIpv6Address: pick(body, 'Framed-IPv6-Address', 'framedIpv6Address') || null,
    acctInputOctetsV6: pickInt(body, 'Acct-Input-Octets-IPv6', 'acctInputOctetsV6'),
    acctOutputOctetsV6: pickInt(body, 'Acct-Output-Octets-IPv6', 'acctOutputOctetsV6'),
    acctInputOctets: pickInt(body, 'Acct-Input-Octets', 'acctInputOctets'),
    acctOutputOctets: pickInt(body, 'Acct-Output-Octets', 'acctOutputOctets'),
    acctInputPackets: pickInt(body, 'Acct-Input-Packets', 'acctInputPackets'),
    acctOutputPackets: pickInt(body, 'Acct-Output-Packets', 'acctOutputPackets'),
    // Preserve absence. A missing counter pair is not a zero counter and must
    // not reset the monotonic usage baseline.
    acctInputGigawords: pickInt(body, 'Acct-Input-Gigawords', 'acctInputGigawords'),
    acctOutputGigawords: pickInt(body, 'Acct-Output-Gigawords', 'acctOutputGigawords'),
    acctSessionTime: pickInt(body, 'Acct-Session-Time', 'acctSessionTime'),
    acctTerminateCause: pick(body, 'Acct-Terminate-Cause', 'acctTerminateCause') || null,
    eventTimestamp: pickEventTimestamp(body),
    acctDelayTime: pickInt(body, 'Acct-Delay-Time', 'acctDelayTime'),
  };
}

module.exports = { normalizeAccountingBody };

// =============================================================================
// VigaBSS 5.0 — Legal IP attribution lookup: the form's input
// =============================================================================
// The case-gated lookup takes the exact address and instant an approved
// ip_traceability case names. IPv4 is a direct public assignment, or CGNAT
// with the public port and protocol; IPv6 has no CGNAT, so it is looked up by
// address alone (the server matches the session whose WAN address it is or
// whose delegated or framed prefix contains it). Kept apart from
// ConnectionLogList so that page does not grow.
// =============================================================================

export type AttributionValidation =
  | 'caseRequired' | 'ipv4Invalid' | 'ipv6NoPort' | 'portInvalid' | 'protocolRequired' | 'timestampRequired';

/**
 * The page's form state. Read here: gov_data_request_id, public_ipv4 (the
 * address field, IPv4 or IPv6), observed_at, attribution_mode, public_port
 * and protocol.
 */
export type AttributionInput = Record<string, string>;

function isIpv4(value: string): boolean {
  const octets = value.split('.');
  return octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

/** Whether the browser parses `value` as an IPv6 address (no zone, no brackets). */
export function isIpv6(value: string): boolean {
  if (!value.includes(':') || /[[\]%/]/.test(value)) return false;
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

export function validateAttributionLookup(values: AttributionInput): AttributionValidation | null {
  const caseId = Number(values.gov_data_request_id);
  if (!Number.isSafeInteger(caseId) || caseId <= 0) return 'caseRequired';
  const address = values.public_ipv4.trim();
  const v6 = isIpv6(address);
  if (!v6 && !isIpv4(address)) return 'ipv4Invalid';
  if (values.attribution_mode !== 'direct') {
    if (v6) return 'ipv6NoPort';
    const port = Number(values.public_port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'portInvalid';
    if (!['tcp', 'udp'].includes(values.protocol)) return 'protocolRequired';
  }
  if (!values.observed_at.trim() || !Number.isFinite(new Date(values.observed_at).getTime())) return 'timestampRequired';
  return null;
}

export function attributionRequestPayload(values: AttributionInput): Record<string, unknown> {
  const address = values.public_ipv4.trim();
  const observedAt = new Date(values.observed_at).toISOString();
  const caseId = Number(values.gov_data_request_id);
  // An IPv4 lookup is sent exactly as before; IPv6 goes by ip_address.
  if (isIpv6(address)) return { gov_data_request_id: caseId, ip_address: address, observed_at: observedAt };
  return {
    gov_data_request_id: caseId,
    public_ipv4: address,
    observed_at: observedAt,
    ...(values.attribution_mode === 'direct' ? {} : {
      public_port: Number(values.public_port),
      protocol: values.protocol,
    }),
  };
}

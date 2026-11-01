'use strict';

const net = require('net');

function canonicalIpv6(value) {
  if (typeof value !== 'string' || net.isIP(value) !== 6) {
    throw new TypeError('Expected an IPv6 address');
  }
  // WHATWG URL host parsing applies RFC 5952-compatible zero compression and
  // lowercase hex. Strip the brackets added for an IPv6 URL host.
  const host = new URL(`http://[${value}]/`).hostname;
  return host.slice(1, -1).toLowerCase();
}

function canonicalIpv6Prefix(value) {
  if (typeof value !== 'string') throw new TypeError('Expected an IPv6 prefix');
  const match = value.trim().match(/^(.+)\/(\d{1,3})$/);
  if (!match) throw new TypeError('Expected an IPv6 CIDR prefix');
  const prefixLength = Number(match[2]);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 128) {
    throw new TypeError('Invalid IPv6 prefix length');
  }
  return `${canonicalIpv6(match[1])}/${prefixLength}`;
}

/** Canonicalize valid IPs for exact equality across equivalent text forms. */
function normalizeIpAddress(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (net.isIP(trimmed) === 4) return trimmed;
  if (net.isIP(trimmed) !== 6) return trimmed.toLowerCase();
  try {
    const canonical = canonicalIpv6(trimmed);
    const mapped = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mapped) {
      const hi = parseInt(mapped[1], 16);
      const lo = parseInt(mapped[2], 16);
      return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    }
    return canonical;
  } catch (_) {
    return trimmed.toLowerCase();
  }
}

function ipv6ToBigInt(value) {
  const canonical = canonicalIpv6(value);
  const [head, tail = ''] = canonical.split('::');
  const left = head ? head.split(':') : [];
  const right = canonical.includes('::') && tail ? tail.split(':') : [];
  const groups = canonical.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n);
}

function bigIntToIpv6(n) {
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  return canonicalIpv6(groups.join(':'));
}

/**
 * Every canonical "network/length" prefix, for lengths minLength..maxLength,
 * that contains `address`. connection_logs stores IPv6 prefixes canonical, so
 * "which session's prefix contains this address" is an IN over this list.
 */
function containingIpv6Prefixes(address, { minLength = 0, maxLength = 128 } = {}) {
  const n = ipv6ToBigInt(address);
  const all = (1n << 128n) - 1n;
  const out = [];
  for (let len = minLength; len <= maxLength; len++) {
    const mask = len === 0 ? 0n : (all << BigInt(128 - len)) & all;
    out.push(`${bigIntToIpv6(n & mask)}/${len}`);
  }
  return out;
}

module.exports = { canonicalIpv6, canonicalIpv6Prefix, normalizeIpAddress, containingIpv6Prefixes };

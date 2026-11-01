// =============================================================================
// VigaBSS 5.0 — Which addresses a router management connection may target
// =============================================================================
// NAS and device management addresses are tenant-editable, and test-connection
// and seed open a TCP connection to them and reported the raw socket error. Any
// devices.update user could point a NAS at 127.0.0.1, the database, Redis or
// 169.254.169.254 and use those routes as a port scanner and DNS oracle against
// the platform's own network (NET-21).
//
// Routers legitimately live on private space (RFC 1918, CGNAT 100.64/10, the
// WireGuard tunnel range), so this is narrower than the webhook SSRF guard: it
// requires a literal IP (no hostname, so no DNS oracle) and refuses loopback,
// unspecified, link-local/metadata, multicast and broadcast, plus any CIDR the
// install operator lists in MANAGEMENT_TARGET_DENY_CIDRS (for example the app's
// own container or VPC network). MANAGEMENT_TARGET_ALLOW_CIDRS admits an IPv4
// range explicitly, ahead of both.
// =============================================================================

const net = require('net');
const { ValidationError } = require('./errors');

function ipv4ToInt(ip) {
  return ip.split('.').reduce((n, o) => (n * 256) + Number(o), 0);
}

function parseCidr(cidr) {
  const [base, bitsRaw] = String(cidr).trim().split('/');
  if (net.isIP(base) !== 4) return null;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (ipv4ToInt(base) & mask) >>> 0, mask };
}

const ALWAYS_DENIED_V4 = ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '255.255.255.255/32']
  .map(parseCidr);

function cidrsFromEnv(name) {
  return String(process.env[name] || '')
    .split(',').map((c) => c.trim()).filter(Boolean).map(parseCidr).filter(Boolean);
}

function inAny(ip, cidrs) {
  const n = ipv4ToInt(ip) >>> 0;
  return cidrs.some((c) => ((n & c.mask) >>> 0) === c.net);
}

/**
 * Why `host` may not be a management target, or null when it may.
 * @param {string} host
 * @returns {string|null}
 */
function managementTargetProblem(host) {
  const value = String(host ?? '').trim();
  const family = net.isIP(value);
  if (family === 0) return 'must be a literal IP address, not a hostname';
  if (family === 4) {
    // An install operator can admit a range explicitly (a router reached over
    // a local tunnel endpoint, a lab on loopback).
    if (inAny(value, cidrsFromEnv('MANAGEMENT_TARGET_ALLOW_CIDRS'))) return null;
    if (inAny(value, ALWAYS_DENIED_V4)) return 'is a loopback, link-local, multicast or reserved address';
    if (inAny(value, cidrsFromEnv('MANAGEMENT_TARGET_DENY_CIDRS'))) return 'is in a range this installation reserves';
    return null;
  }
  const v6 = value.toLowerCase().split('%')[0];
  const mapped = v6.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return managementTargetProblem(mapped[1]);
  if (v6 === '::' || v6 === '::1') return 'is a loopback or unspecified address';
  if (/^fe[89ab]/.test(v6) || /^ff/.test(v6)) return 'is a link-local or multicast address';
  return null;
}

/** Throw a 422 when `host` may not be a management target. */
function assertManagementTarget(host, field = 'ip_address') {
  const problem = managementTargetProblem(host);
  if (problem) {
    throw new ValidationError('Validation failed', [{ field, message: `${field} ${problem}` }]);
  }
}

module.exports = { managementTargetProblem, assertManagementTarget };

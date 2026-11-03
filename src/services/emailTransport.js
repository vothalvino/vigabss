// =============================================================================
// VigaBSS 5.0 — bounded, tenant-safe SMTP delivery
// =============================================================================
// Tenant SMTP settings are untrusted egress configuration. Every tenant send
// resolves and pins a public destination, requires TLS, rechecks the peer, and
// owns the exact socket so an absolute timeout really stops delivery. The
// install-controlled relay has a separate trusted path for local relays.
// Client-directed messages also pass the authoritative DND/consent check at
// the last practical boundary before SMTP I/O.
// =============================================================================

const db = require('../config/database');
const logger = require('../utils/logger').child({ service: 'emailTransport' });
const { decryptStrict } = require('../utils/encryption');
const {
  sendTenantSmtp,
  sendTrustedSmtp,
  DEFAULT_SMTP_CONNECTION_TIMEOUT_MS,
  DEFAULT_SMTP_GREETING_TIMEOUT_MS,
  DEFAULT_SMTP_SOCKET_TIMEOUT_MS,
} = require('../utils/safeSmtpSender');
const communicationPreferences = require('./clientCommunicationPreferenceService');

const DEFAULT_FUNCTION = 'general';
const SMTP_CONNECTION_TIMEOUT_MS = DEFAULT_SMTP_CONNECTION_TIMEOUT_MS;
const SMTP_GREETING_TIMEOUT_MS = DEFAULT_SMTP_GREETING_TIMEOUT_MS;
const SMTP_SOCKET_TIMEOUT_MS = DEFAULT_SMTP_SOCKET_TIMEOUT_MS;

function withTenant(organizationId, callback) {
  return organizationId === null || organizationId === undefined
    || typeof db.withTenantContext !== 'function'
    ? callback()
    : db.withTenantContext(Number(organizationId), callback);
}

function normalizePort(value, fallback = 587) {
  const port = Number(value || fallback);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function formatFrom(row, fallback) {
  if (!row) return fallback;
  const address = row.from_email || row.smtp_user || fallback;
  return row.from_name ? `${row.from_name} <${address}>` : address;
}

async function loadEffectiveSettings(organizationId, emailFunction) {
  const EmailSettings = require('../models/EmailSettings');
  return withTenant(organizationId, async () => {
    const requested = await EmailSettings.findRawByOrgId(organizationId, emailFunction);
    if (requested?.enabled && requested.smtp_host) return requested;
    if (emailFunction !== DEFAULT_FUNCTION) {
      const general = await EmailSettings.findRawByOrgId(organizationId, DEFAULT_FUNCTION);
      if (general?.enabled && general.smtp_host) return general;
    }
    return null;
  });
}

async function getOrgTransport(organizationId, emailFunction = DEFAULT_FUNCTION) {
  const row = await loadEffectiveSettings(organizationId, emailFunction);
  if (!row) return null;
  const password = row.smtp_password_encrypted
    ? decryptStrict(row.smtp_password_encrypted)
    : null;
  return {
    host: row.smtp_host,
    port: normalizePort(row.smtp_port, 587),
    secure: Boolean(row.smtp_secure),
    auth: row.smtp_user ? { user: row.smtp_user, pass: password || '' } : undefined,
    from: formatFrom(row, process.env.SMTP_FROM || 'noreply@vigabss.local'),
  };
}

// Preserved as a compatibility hook for EmailSettings.upsert and older test
// doubles. One-shot transports intentionally have no long-lived cache.
function invalidateOrgTransport() {}

function init() {
  // Kept for the existing boot/test API. The actual transport is deliberately
  // constructed per send so settings, DNS, TLS and revocations are fresh.
  return true;
}

function safeFailure(err, sanitizeFailure) {
  const rawCode = String(err?.code || 'EMAIL_DELIVERY_FAILED');
  const allowedCodes = new Set([
    'EMAIL_DELIVERY_TIMEOUT',
    'EMAIL_SETTINGS_CHANGED',
    'ENCRYPTION_NOT_CONFIGURED',
    'ENCRYPTED_SECRET_INVALID',
    'INVALID_SMTP_CONFIG',
    'SMTP_PEER_INVALID',
    'UNSAFE_HOST',
    'ORGANIZATION_INACTIVE',
    'CLIENT_ATTRIBUTION_REQUIRED',
  ]);
  const code = allowedCodes.has(rawCode) ? rawCode : 'EMAIL_DELIVERY_FAILED';
  if (sanitizeFailure) return { error: 'Email delivery failed.', code };
  const messages = {
    EMAIL_DELIVERY_TIMEOUT: 'Email delivery timed out.',
    ENCRYPTION_NOT_CONFIGURED: 'The saved SMTP credential is unavailable.',
    ENCRYPTED_SECRET_INVALID: 'The saved SMTP credential is unavailable.',
    INVALID_SMTP_CONFIG: 'The SMTP configuration is invalid.',
    SMTP_PEER_INVALID: 'The SMTP destination could not be verified.',
    UNSAFE_HOST: 'The SMTP destination is not permitted.',
    ORGANIZATION_INACTIVE: 'The organization is not active.',
    CLIENT_ATTRIBUTION_REQUIRED: 'Client delivery authorization is unavailable.',
  };
  return { error: messages[code] || 'Email delivery failed.', code };
}

async function writeLog(organizationId, sql, params) {
  const execute = () => db.query(sql, params);
  return withTenant(organizationId, execute);
}

async function logOutcome({
  organizationId,
  clientId,
  to,
  subject,
  status,
  error,
  messageClass,
  organizationEpoch = 0,
  clientContactEpoch = 0,
}) {
  if (status === 'sent') {
    return writeLog(
      organizationId,
      `INSERT INTO email_logs
         (recipient, subject, channel, status, sent_at, organization_id,
          organization_epoch, client_id, client_contact_epoch, message_class)
       VALUES (?, ?, 'email', 'sent', NOW(), ?, ?, ?, ?, ?)`,
      [to, subject, organizationId ?? null, organizationEpoch, clientId ?? null, clientContactEpoch, messageClass],
    );
  }
  return writeLog(
    organizationId,
    `INSERT INTO email_logs
       (recipient, subject, channel, status, error_message, organization_id,
        organization_epoch, client_id, client_contact_epoch, message_class)
     VALUES (?, ?, 'email', 'failed', ?, ?, ?, ?, ?, ?)`,
    [to, subject, error, organizationId ?? null, organizationEpoch, clientId ?? null, clientContactEpoch, messageClass],
  );
}

/** Send one email. Client messages require a server-owned messageClass. */
async function sendEmail({
  to,
  subject,
  html,
  text,
  attachments,
  organizationId = null,
  clientId = null,
  messageClass = null,
  emailFunction = DEFAULT_FUNCTION,
  absoluteTimeoutMs = null,
  installTransportOnly = false,
  operationalRecipient = false,
  sanitizeFailure = false,
  suppressLog = false,
  expectedClientContactEpoch = null,
}) {
  let failure;
  let organizationState = { active: true, epoch: 0 };
  let clientContactEpoch = 0;

  try {
    const hasClient = clientId !== null && clientId !== undefined;
    if ((hasClient && (operationalRecipient || !messageClass))
        || (!hasClient && (!operationalRecipient || messageClass))) {
      throw Object.assign(new Error('Client and operational recipient lanes must be explicit.'), {
        code: 'CLIENT_ATTRIBUTION_REQUIRED',
      });
    }
    organizationState = await communicationPreferences.getOrganizationDeliveryState(organizationId);
    if (!organizationState.active) {
      throw Object.assign(new Error('Organization is inactive.'), { code: 'ORGANIZATION_INACTIVE' });
    }

    if (hasClient) {
      const preference = await communicationPreferences.evaluateClientCommunication({
        organizationId,
        clientId,
        channel: 'email',
        destination: to,
        messageClass,
      });
      if (!preference.allowed) {
        const blocked = communicationPreferences.blockedResult(preference.code);
        if (!suppressLog) await logOutcome({
          organizationId,
          clientId,
          to,
          subject,
          status: 'failed',
          error: blocked.error,
          messageClass,
          organizationEpoch: organizationState.epoch || 0,
        });
        return blocked;
      }
      clientContactEpoch = Number(preference.contactEpoch || 0);
      if (expectedClientContactEpoch !== null
          && Number(expectedClientContactEpoch) !== clientContactEpoch) {
        const blocked = communicationPreferences.blockedResult(
          communicationPreferences.BLOCK_CODES.CONTACT_MISMATCH,
        );
        return blocked;
      }
    }

    const fallbackFrom = process.env.SMTP_FROM || 'noreply@vigabss.local';
    const tenant = organizationId && !installTransportOnly
      ? await getOrgTransport(organizationId, emailFunction)
      : null;
    const message = {
      from: tenant?.from || fallbackFrom,
      to,
      subject,
      html,
      text,
      attachments,
    };
    const finalOrganizationState = await communicationPreferences.getOrganizationDeliveryState(organizationId);
    if (!finalOrganizationState.active
        || Number(finalOrganizationState.epoch) !== Number(organizationState.epoch)) {
      throw Object.assign(new Error('Organization delivery state changed.'), {
        code: 'ORGANIZATION_INACTIVE',
      });
    }
    if (hasClient) {
      const finalPreference = await communicationPreferences.evaluateClientCommunication({
        organizationId,
        clientId,
        channel: 'email',
        destination: to,
        messageClass,
      });
      const finalEpoch = Number(finalPreference.contactEpoch || 0);
      if (!finalPreference.allowed
          || finalEpoch !== clientContactEpoch
          || (expectedClientContactEpoch !== null
            && Number(expectedClientContactEpoch) !== finalEpoch)) {
        const code = finalPreference.allowed
          ? communicationPreferences.BLOCK_CODES.CONTACT_MISMATCH
          : finalPreference.code;
        const blocked = communicationPreferences.blockedResult(code);
        if (!suppressLog) await logOutcome({
          organizationId,
          clientId,
          to,
          subject,
          status: 'failed',
          error: blocked.error,
          messageClass,
          organizationEpoch: organizationState.epoch || 0,
          clientContactEpoch,
        });
        return blocked;
      }
    }
    const info = tenant
      ? await sendTenantSmtp({
        ...tenant,
        message,
        absoluteTimeoutMs,
      })
      : await sendTrustedSmtp({
        host: process.env.SMTP_HOST || 'localhost',
        port: normalizePort(process.env.SMTP_PORT, 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' }
          : undefined,
        requireTls: process.env.SMTP_REQUIRE_TLS === 'true'
          || Boolean(process.env.SMTP_USER),
        message,
        absoluteTimeoutMs,
      });

    if (!suppressLog) await logOutcome({
      organizationId,
      clientId,
      to,
      subject,
      status: 'sent',
      messageClass,
      organizationEpoch: organizationState.epoch || 0,
      clientContactEpoch,
    });
    return { success: true, messageId: info.messageId };
  } catch (err) {
    failure = safeFailure(err, sanitizeFailure);
    logger.warn({ code: failure.code }, 'Email delivery failed');
    if (!suppressLog) await logOutcome({
      organizationId,
      clientId,
      to,
      subject,
      status: 'failed',
      error: failure.error,
      messageClass,
      organizationEpoch: organizationState.epoch || 0,
      clientContactEpoch,
    });
    return { success: false, ...failure };
  }
}

module.exports = {
  init,
  sendEmail,
  getOrgTransport,
  invalidateOrgTransport,
  SMTP_CONNECTION_TIMEOUT_MS,
  SMTP_GREETING_TIMEOUT_MS,
  SMTP_SOCKET_TIMEOUT_MS,
};

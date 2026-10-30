// =============================================================================
// VigaBSS 5.0 — SSO Service (P2.1)
// =============================================================================
// Handles SAML 2.0 and OIDC authentication flows for per-organization SSO.
//
// Flow:
//   SAML: generateSamlLoginUrl() → processSamlAssertion() → mintTokens()
//   OIDC: generateOidcLoginUrl() → processOidcCallback()  → mintTokens()
//
// Both flows end by calling findOrCreateSsoUser() which resolves the local
// VigaBSS user (creating one on first login when auto_provision=1) and maps
// IdP group memberships to VigaBSS roles via the group-mappings table.
// =============================================================================

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../config/database');
const { encrypt, decrypt } = require('../utils/encryption');
const { UnauthorizedError, NotFoundError, ForbiddenError, ValidationError } = require('../utils/errors');
const { assertSafeOutboundUrl } = require('../utils/safeOutboundUrl');
const { hasGlobalOrganizationAccessUser } = require('./globalOrganizationAccess');

/**
 * Roles an SSO config may hand out (default_role and group mappings). Mirrors
 * the organization_sso_* ENUMs. Never 'owner', 'super_admin' or any custom
 * group: an IdP must not be able to mint installation-wide or owner authority.
 */
const SSO_ROLES = ['admin', 'manager', 'technician', 'billing', 'readonly'];

// SAML standard attribute namespace prefixes (WS-Federation / Active Directory)
const SAML_NS_EMAIL      = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress';
const SAML_NS_GIVENNAME  = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname';
const SAML_NS_SURNAME    = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname';

// Refresh token lifetime in seconds (re-use authService parsing logic inline)
function parseExpiry(str) {
  if (!str) return 604800;
  const m = String(str).match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!m) return 604800;
  const n = parseInt(m[1], 10);
  switch (m[2].toLowerCase()) {
    case 's': return n;
    case 'm': return n * 60;
    case 'h': return n * 3600;
    case 'd': return n * 86400;
    default:  return 604800;
  }
}

const REFRESH_SECONDS = parseExpiry(config.jwt.refreshExpiresIn);
const ACCESS_SECONDS  = parseExpiry(config.jwt.accessExpiresIn);

/**
 * Accept only same-application relative paths for the post-login redirect.
 * WHATWG URL parsing is intentional: browsers normalize tabs and backslashes
 * before navigation, so prefix checks alone can miss protocol-relative URLs.
 *
 * @param {unknown} redirectTo
 * @returns {string|null}
 */
function normalizeOidcRedirectPath(redirectTo) {
  if (typeof redirectTo !== 'string' || !redirectTo.startsWith('/')) return null;
  if (redirectTo.startsWith('//') || redirectTo.startsWith('/\\')) return null;

  const safeOrigin = 'https://fireisp.invalid';
  try {
    const parsed = new URL(redirectTo, safeOrigin);
    if (parsed.origin !== safeOrigin) return null;
  } catch (_err) {
    return null;
  }

  return redirectTo;
}

// ---------------------------------------------------------------------------
// Config CRUD
// ---------------------------------------------------------------------------

/**
 * Retrieve the SSO config for an organization + provider type.
 * Returns null when no config exists.
 *
 * @param {number} orgId
 * @param {'saml'|'oidc'} providerType
 */
async function getConfig(orgId, providerType) {
  const [rows] = await db.query(
    'SELECT * FROM organization_sso_configs WHERE organization_id = ? AND provider_type = ?',
    [orgId, providerType],
  );
  if (!rows.length) return null;
  const row = rows[0];
  // Decrypt sensitive fields before returning
  if (row.oidc_client_secret) row.oidc_client_secret = decrypt(row.oidc_client_secret);
  if (row.saml_sp_private_key) row.saml_sp_private_key = decrypt(row.saml_sp_private_key);
  return row;
}

/**
 * Create or update the SSO config for an organization.
 *
 * @param {number} orgId
 * @param {'saml'|'oidc'} providerType
 * @param {object} fields  Writable fields from the request body
 */
async function saveConfig(orgId, providerType, fields) {
  await validateConfigUrls(fields);

  // Encrypt sensitive fields before storage
  const encClientSecret  = (fields.oidc_client_secret  !== null && fields.oidc_client_secret  !== undefined && fields.oidc_client_secret  !== '') ? encrypt(fields.oidc_client_secret)  : undefined;
  const encSpPrivateKey  = (fields.saml_sp_private_key  !== null && fields.saml_sp_private_key  !== undefined && fields.saml_sp_private_key  !== '') ? encrypt(fields.saml_sp_private_key)  : undefined;

  const existing = await db.query(
    'SELECT id FROM organization_sso_configs WHERE organization_id = ? AND provider_type = ?',
    [orgId, providerType],
  );

  const writableFields = {
    is_enabled:         fields.is_enabled        !== null && fields.is_enabled        !== undefined ? (fields.is_enabled ? 1 : 0) : undefined,
    saml_entity_id:     fields.saml_entity_id,
    saml_sso_url:       fields.saml_sso_url,
    saml_slo_url:       fields.saml_slo_url,
    saml_x509_cert:     fields.saml_x509_cert,
    saml_sign_requests: fields.saml_sign_requests !== null && fields.saml_sign_requests !== undefined ? (fields.saml_sign_requests ? 1 : 0) : undefined,
    saml_sp_private_key: encSpPrivateKey,
    oidc_issuer:        fields.oidc_issuer,
    oidc_client_id:     fields.oidc_client_id,
    oidc_client_secret: encClientSecret,
    oidc_scopes:        fields.oidc_scopes,
    attribute_mapping:  fields.attribute_mapping !== null && fields.attribute_mapping !== undefined ? JSON.stringify(fields.attribute_mapping) : undefined,
    idp_group_attribute: fields.idp_group_attribute,
    auto_provision:     fields.auto_provision    !== null && fields.auto_provision    !== undefined ? (fields.auto_provision ? 1 : 0) : undefined,
    default_role:       fields.default_role,
  };

  // Remove undefined keys so we don't clobber existing values
  const defined = Object.fromEntries(
    Object.entries(writableFields).filter(([, v]) => v !== undefined),
  );

  if (existing[0].length > 0) {
    // UPDATE existing row
    const setClauses = Object.keys(defined).map(k => `${k} = ?`).join(', ');
    const values     = [...Object.values(defined), orgId, providerType];
    await db.query(
      `UPDATE organization_sso_configs SET ${setClauses} WHERE organization_id = ? AND provider_type = ?`,
      values,
    );
  } else {
    // INSERT new row
    defined.organization_id = orgId;
    defined.provider_type   = providerType;
    const cols   = Object.keys(defined).join(', ');
    const params = Object.keys(defined).map(() => '?').join(', ');
    await db.query(
      `INSERT INTO organization_sso_configs (${cols}) VALUES (${params})`,
      Object.values(defined),
    );
  }

  return getConfig(orgId, providerType);
}

/** A browser-facing IdP endpoint: absolute https URL without credentials. */
function assertHttpsUrl(raw, field) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch (_err) {
    throw new ValidationError(`${field} must be a valid URL`);
  }
  if (url.protocol !== 'https:') throw new ValidationError(`${field} must use https`);
  if (url.username || url.password) throw new ValidationError(`${field} must not include credentials`);
}

/**
 * Validate tenant-supplied IdP URLs. The OIDC issuer is fetched server-side
 * (discovery), so it must also resolve only to public addresses (SSRF). SAML
 * URLs are only ever browser redirects, so they need https but may point at an
 * intranet IdP.
 */
async function validateConfigUrls(fields) {
  if (fields.oidc_issuer !== undefined && fields.oidc_issuer !== null && fields.oidc_issuer !== '') {
    await assertSafeOutboundUrl(fields.oidc_issuer, 'oidc_issuer');
  }
  for (const field of ['saml_sso_url', 'saml_slo_url']) {
    if (fields[field] !== undefined && fields[field] !== null && fields[field] !== '') {
      assertHttpsUrl(fields[field], field);
    }
  }
}

// ---------------------------------------------------------------------------
// Group mappings CRUD
// ---------------------------------------------------------------------------

/**
 * Validate a group-mapping replacement body. Every item needs a non-empty IdP
 * group name and a role from SSO_ROLES; anything else is rejected rather than
 * stored (an unvalidated role reached users.group_id at the next login).
 */
function assertValidGroupMappings(mappings) {
  if (!Array.isArray(mappings)) throw new ValidationError('mappings must be an array');
  if (mappings.length > 500) throw new ValidationError('mappings must contain at most 500 items');
  const seen = new Set();
  const errors = [];
  mappings.forEach((m, i) => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      errors.push({ field: `mappings[${i}]`, message: 'must be an object' });
      return;
    }
    if (typeof m.idp_group !== 'string' || m.idp_group.trim() === '' || m.idp_group.length > 255) {
      errors.push({ field: `mappings[${i}].idp_group`, message: 'must be a non-empty string of at most 255 characters' });
    } else if (seen.has(m.idp_group)) {
      errors.push({ field: `mappings[${i}].idp_group`, message: 'is duplicated' });
    } else {
      seen.add(m.idp_group);
    }
    if (!SSO_ROLES.includes(m.fireisp_role)) {
      errors.push({ field: `mappings[${i}].fireisp_role`, message: `must be one of: ${SSO_ROLES.join(', ')}` });
    }
  });
  if (errors.length) throw new ValidationError('Validation failed', errors);
  return mappings.map(m => ({ idp_group: m.idp_group, fireisp_role: m.fireisp_role }));
}

/**
 * Return all group mappings for a given SSO config ID.
 */
async function getGroupMappings(ssoConfigId) {
  const [rows] = await db.query(
    'SELECT id, idp_group, fireisp_role FROM organization_sso_group_mappings WHERE sso_config_id = ? ORDER BY idp_group',
    [ssoConfigId],
  );
  return rows;
}

/**
 * Replace all group mappings for a config in a single transaction.
 *
 * @param {number} ssoConfigId
 * @param {Array<{idp_group: string, fireisp_role: string}>} mappings
 */
async function saveGroupMappings(ssoConfigId, rawMappings) {
  const mappings = assertValidGroupMappings(rawMappings);
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'DELETE FROM organization_sso_group_mappings WHERE sso_config_id = ?',
      [ssoConfigId],
    );
    if (mappings.length > 0) {
      const values = mappings.map(m => [ssoConfigId, m.idp_group, m.fireisp_role]);
      // NOTE: this is `conn.query()` (the raw mysql2 PoolConnection's real
      // text-protocol query method), NOT `db.query()`/`db.queryReplica()`
      // from src/config/database.js — those wrap mysql2's `execute()`
      // (prepared statements), which cannot expand a single `?` bound to a
      // 2-D array of rows into `(a,b),(c,d),...` the way `query()` can.
      // `conn.query()` here supports the bulk `VALUES ?` array form
      // correctly; do not "fix" this to buildBulkValues() or route it
      // through db.query() — either change would be a regression for a
      // site that was never actually broken.
      await conn.query(
        'INSERT INTO organization_sso_group_mappings (sso_config_id, idp_group, fireisp_role) VALUES ?',
        [values],
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return getGroupMappings(ssoConfigId);
}

// ---------------------------------------------------------------------------
// SAML flow
// ---------------------------------------------------------------------------

/**
 * Build a lazy-initialized SAML strategy instance from the org's SSO config.
 * Returns null when SSO is not configured / not enabled.
 *
 * @param {object} cfg  Row from organization_sso_configs
 * @param {number} orgId
 * @returns {import('@node-saml/node-saml').SAML|null}
 */
function buildSamlInstance(cfg, orgId) {
  const { SAML } = require('@node-saml/node-saml');
  const spEntityId = `${config.appUrl}/api/v1/sso/${orgId}/saml/metadata`;
  const callbackUrl = `${config.appUrl}/api/v1/sso/${orgId}/saml/acs`;

  const samlOptions = {
    entryPoint:      cfg.saml_sso_url,
    issuer:          spEntityId,
    callbackUrl,
    cert:            cfg.saml_x509_cert,
    identifierFormat: null,
    wantAuthnResponseSigned: true,
    wantAssertionsSigned:    false,
  };

  if (cfg.saml_sign_requests && cfg.saml_sp_private_key) {
    samlOptions.privateKey = cfg.saml_sp_private_key;
    samlOptions.signatureAlgorithm = 'sha256';
  }

  return new SAML(samlOptions);
}

/**
 * Generate the SAML SP metadata XML for an organization.
 */
async function getSamlMetadata(orgId) {
  const cfg = await getConfig(orgId, 'saml');
  if (!cfg) throw new NotFoundError('SSO configuration');

  const saml = buildSamlInstance(cfg, orgId);
  const callbackUrl = `${config.appUrl}/api/v1/sso/${orgId}/saml/acs`;

  const decryptionCerts = [];
  if (cfg.saml_sp_private_key) {
    // Include the SP public certificate (derived from private key) if available.
    // In most deployments the SP cert is provided separately; if not configured
    // the metadata is emitted without an encryption key.
    decryptionCerts.push('');
  }

  return saml.generateServiceProviderMetadata(
    cfg.saml_sp_private_key || null,
    callbackUrl,
  );
}

/**
 * Generate the URL to redirect the user to the IdP for SAML authentication.
 *
 * @param {number} orgId
 * @returns {string} Redirect URL
 */
async function generateSamlLoginUrl(orgId) {
  const cfg = await getConfig(orgId, 'saml');
  if (!cfg || !cfg.is_enabled) {
    throw new ForbiddenError('SSO is not enabled for this organization');
  }
  if (!cfg.saml_sso_url || !cfg.saml_x509_cert) {
    throw new ValidationError('SAML configuration is incomplete (saml_sso_url, saml_x509_cert required)');
  }

  const saml = buildSamlInstance(cfg, orgId);
  const { context } = await saml.getAuthorizeUrlAsync('', '', {});
  return context;
}

/**
 * Validate an incoming SAML assertion (HTTP POST binding from the IdP).
 * Returns a normalized profile object.
 *
 * @param {number} orgId
 * @param {object} body  Express request body (must include SAMLResponse)
 */
async function processSamlAssertion(orgId, body) {
  const cfg = await getConfig(orgId, 'saml');
  if (!cfg || !cfg.is_enabled) {
    throw new UnauthorizedError('SSO is not enabled for this organization');
  }

  const saml = buildSamlInstance(cfg, orgId);
  const { profile } = await saml.validatePostResponseAsync(body);

  const attrMap = parseAttributeMapping(cfg.attribute_mapping);
  const normalized = normalizeSamlProfile(profile, attrMap, cfg.idp_group_attribute || 'groups');
  if (!normalized.issuer) normalized.issuer = cfg.saml_entity_id || '';
  return normalized;
}

/** Parse the JSON attribute mapping stored in the DB, defaulting to empty object. */
function parseAttributeMapping(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_e) { return {}; }
}

/**
 * Normalize a raw SAML profile into a common shape.
 */
function normalizeSamlProfile(profile, attrMap, groupAttr) {
  const get = (key, fallback) => {
    const mapped = attrMap[key];
    if (mapped && profile[mapped] !== undefined) return profile[mapped];
    return profile[key] !== undefined ? profile[key] : fallback;
  };

  const email = get('email', profile.nameID || profile[SAML_NS_EMAIL]);
  const firstName = get('firstName', profile.givenname || profile[SAML_NS_GIVENNAME] || '');
  const lastName  = get('lastName',  profile.sn || profile.surname || profile[SAML_NS_SURNAME] || '');

  const rawGroups = profile[groupAttr] || profile['groups'] || [];
  const groups = Array.isArray(rawGroups) ? rawGroups : [rawGroups].filter(Boolean);

  // The stable IdP identity is (issuer, NameID); the email is only a hint.
  const issuer = typeof profile.issuer === 'string' ? profile.issuer : '';
  const subject = typeof profile.nameID === 'string' ? profile.nameID : '';

  return { email, firstName, lastName, groups, issuer, subject, emailVerified: null, raw: profile };
}

// ---------------------------------------------------------------------------
// OIDC flow
// ---------------------------------------------------------------------------

/** In-memory Issuer cache to avoid repeated discovery calls. */
const issuerCache = new Map();

async function getOidcClient(cfg, orgId) {
  const { Issuer } = require('openid-client');
  const redirectUri = `${config.appUrl}/api/v1/sso/${orgId}/oidc/callback`;

  let issuer = issuerCache.get(cfg.oidc_issuer);
  if (!issuer) {
    // Re-check at use time too: rows saved before write-time validation, or a
    // hostname that has since started resolving to a private address.
    await assertSafeOutboundUrl(cfg.oidc_issuer, 'oidc_issuer');
    issuer = await Issuer.discover(cfg.oidc_issuer);
    issuerCache.set(cfg.oidc_issuer, issuer);
  }

  return new issuer.Client({
    client_id:     cfg.oidc_client_id,
    client_secret: cfg.oidc_client_secret,
    redirect_uris: [redirectUri],
    response_types: ['code'],
  });
}

/**
 * Generate the OIDC authorization URL and persist the state+nonce to the DB.
 * The state is stored in `sso_auth_states` so the callback can verify it.
 *
 * @param {number} orgId
 * @param {string} [redirectTo]  Optional deep-link to return the user to post-auth
 * @returns {string} Authorization URL
 */
async function generateOidcLoginUrl(orgId, redirectTo) {
  const cfg = await getConfig(orgId, 'oidc');
  if (!cfg || !cfg.is_enabled) {
    throw new ForbiddenError('SSO is not enabled for this organization');
  }
  if (!cfg.oidc_issuer || !cfg.oidc_client_id) {
    throw new ValidationError('OIDC configuration is incomplete (oidc_issuer, oidc_client_id required)');
  }

  const { generators } = require('openid-client');
  const state = generators.state();
  const nonce = generators.nonce();
  const safeRedirectTo = normalizeOidcRedirectPath(redirectTo);

  // Persist state for 10 minutes
  await db.query(
    `INSERT INTO sso_auth_states (state, nonce, organization_id, redirect_to, expires_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))`,
    [state, nonce, orgId, safeRedirectTo],
  );

  const oidcClient = await getOidcClient(cfg, orgId);
  const scopes = cfg.oidc_scopes || 'openid profile email';

  return oidcClient.authorizationUrl({
    scope: scopes,
    state,
    nonce,
  });
}

/**
 * Process the OIDC authorization code callback.
 *
 * @param {number} orgId
 * @param {object} req  Express request object
 * @returns {{ profile: object, redirectTo: string|null }}
 */
async function processOidcCallback(orgId, req) {
  const cfg = await getConfig(orgId, 'oidc');
  if (!cfg || !cfg.is_enabled) {
    throw new UnauthorizedError('SSO is not enabled for this organization');
  }

  const oidcClient = await getOidcClient(cfg, orgId);
  const redirectUri = `${config.appUrl}/api/v1/sso/${orgId}/oidc/callback`;

  // Look up and validate the stored state
  const params = oidcClient.callbackParams(req);
  if (!params.state) throw new UnauthorizedError('Missing OAuth state parameter');

  const [stateRows] = await db.query(
    'SELECT * FROM sso_auth_states WHERE state = ? AND expires_at > NOW()',
    [params.state],
  );
  if (!stateRows.length) {
    throw new UnauthorizedError('Invalid or expired OAuth state');
  }
  const stateRecord = stateRows[0];
  if (Number(stateRecord.organization_id) !== Number(orgId)) {
    throw new UnauthorizedError('OAuth state organization mismatch');
  }

  // Clean up the used state
  await db.query('DELETE FROM sso_auth_states WHERE state = ?', [params.state]);

  const tokenSet = await oidcClient.callback(redirectUri, params, {
    state: stateRecord.state,
    nonce: stateRecord.nonce,
  });

  const userinfo = await oidcClient.userinfo(tokenSet);

  const attrMap = parseAttributeMapping(cfg.attribute_mapping);
  const groupAttr = cfg.idp_group_attribute || 'groups';
  const profile = normalizeOidcProfile(userinfo, attrMap, groupAttr);
  // Namespace the subject by the configured issuer (userinfo carries no iss).
  profile.issuer = cfg.oidc_issuer || '';

  // Re-validate on read as defense in depth for states persisted before this
  // validation was introduced (or inserted outside the application).
  return { profile, redirectTo: normalizeOidcRedirectPath(stateRecord.redirect_to) };
}

/**
 * Normalize a raw OIDC userinfo object into a common shape.
 */
function normalizeOidcProfile(userinfo, attrMap, groupAttr) {
  const get = (key, fallback) => {
    const mapped = attrMap[key];
    if (mapped && userinfo[mapped] !== undefined) return userinfo[mapped];
    return userinfo[key] !== undefined ? userinfo[key] : fallback;
  };

  // No preferred_username fallback: it is a free-form, often user-editable
  // display handle, never proof of control of a mailbox.
  const email      = get('email', userinfo.email || '');
  const firstName  = get('firstName', userinfo.given_name || userinfo.name?.split(' ')[0] || '');
  const lastName   = get('lastName',  userinfo.family_name || userinfo.name?.split(' ').slice(1).join(' ') || '');
  const rawGroups  = userinfo[groupAttr] || userinfo.groups || [];
  const groups     = Array.isArray(rawGroups) ? rawGroups : [rawGroups].filter(Boolean);
  const subject    = typeof userinfo.sub === 'string' ? userinfo.sub : '';
  // Only an explicit "not verified" is refused; many IdPs omit the claim.
  let emailVerified = null;
  if (userinfo.email_verified === false || userinfo.email_verified === 'false') emailVerified = false;
  else if (userinfo.email_verified === true || userinfo.email_verified === 'true') emailVerified = true;

  return { email, firstName, lastName, groups, subject, emailVerified, raw: userinfo };
}

// ---------------------------------------------------------------------------
// User resolution and token minting
// ---------------------------------------------------------------------------

function identityHash(issuer, subject) {
  return crypto.createHash('sha256').update(`${issuer}\n${subject}`).digest('hex');
}

/**
 * Decide whether an existing account may be signed in through THIS
 * organization's IdP. The IdP is configured by that organization's admins, so
 * it may only ever vouch for accounts that belong to that organization alone:
 *
 *   - never an installation-global identity (install operator, system
 *     super_admin, INSTALL_OPERATOR_USER_IDS);
 *   - never an account homed in, or holding a live membership in, any other
 *     organization (the minted session is the whole account and could switch
 *     into that organization);
 *   - never an account whose membership in this organization was removed
 *     (SSO does not resurrect deleted memberships);
 *   - an account with no home org needs a live membership here.
 *
 * Throws ForbiddenError (403) when the account is not eligible.
 */
async function assertSsoEligibleUser(orgId, user) {
  if (!user || user.status !== 'active') {
    throw new UnauthorizedError('User account is inactive');
  }
  if (await hasGlobalOrganizationAccessUser(user)) {
    throw new ForbiddenError('This account cannot sign in through organization SSO');
  }
  const homeOrgId = user.organization_id === null || user.organization_id === undefined
    ? null
    : Number(user.organization_id);
  if (homeOrgId !== null && homeOrgId !== Number(orgId)) {
    throw new ForbiddenError('This account belongs to another organization and cannot sign in through this SSO');
  }

  const [memberships] = await db.query(
    'SELECT organization_id, deleted_at FROM organization_users WHERE user_id = ?',
    [user.id],
  );
  let liveHere = false;
  for (const m of memberships) {
    const sameOrg = Number(m.organization_id) === Number(orgId);
    if (m.deleted_at === null || m.deleted_at === undefined) {
      if (!sameOrg) {
        throw new ForbiddenError('This account belongs to another organization and cannot sign in through this SSO');
      }
      liveHere = true;
    }
  }
  if (!liveHere && memberships.some(m => Number(m.organization_id) === Number(orgId))) {
    throw new ForbiddenError('This account was removed from the organization');
  }
  if (homeOrgId === null && !liveHere) {
    throw new ForbiddenError('This account is not a member of the organization');
  }
}

/**
 * Resolve (or auto-create) a VigaBSS user from an SSO profile.
 *
 * Matching strategy:
 *   1. A linked identity: (organization, provider, sha256(issuer, subject)) in
 *      user_sso_identities. This is the authoritative binding once it exists.
 *   2. First sign-in for an existing account: match the asserted email, but
 *      only for an account eligible for THIS organization (see
 *      assertSsoEligibleUser) that is not already linked to a different
 *      identity here. An IdP-asserted email never reaches another tenant's
 *      account or an install operator.
 *   3. No account with that email anywhere on the install and
 *      auto_provision=true: create one homed in this organization.
 *   4. Link the identity, ensure a live membership (never resurrecting a
 *      deleted one) and map IdP groups to a role from SSO_ROLES.
 *
 * @param {number}   orgId
 * @param {object}   profile    Normalized SSO profile (email, subject, issuer, groups, ...)
 * @param {object}   cfg        organization_sso_configs row
 * @param {object[]} mappings   organization_sso_group_mappings rows
 * @returns {{ user: object, orgRole: string }}
 */
async function findOrCreateSsoUser(orgId, profile, cfg, mappings) {
  const email = typeof profile.email === 'string' ? profile.email.trim() : '';
  if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new UnauthorizedError('IdP did not provide an email address — cannot authenticate user');
  }
  if (profile.emailVerified === false) {
    throw new UnauthorizedError('IdP reports that this email address is not verified');
  }
  const issuer = typeof profile.issuer === 'string' ? profile.issuer.trim() : '';
  const subject = typeof profile.subject === 'string' ? profile.subject.trim() : '';
  if (!issuer || !subject) {
    throw new UnauthorizedError('IdP did not provide a stable subject identifier — cannot authenticate user');
  }
  const providerType = cfg.provider_type === 'saml' ? 'saml' : 'oidc';
  const hash = identityHash(issuer, subject);

  const bcrypt = require('bcryptjs');

  // 1. Linked identity
  let user = null;
  let linked = false;
  const [linkRows] = await db.query(
    `SELECT user_id FROM user_sso_identities
      WHERE organization_id = ? AND provider_type = ? AND identity_hash = ?`,
    [orgId, providerType, hash],
  );
  if (linkRows.length) {
    const [rows] = await db.query(
      'SELECT * FROM users WHERE id = ? AND deleted_at IS NULL',
      [linkRows[0].user_id],
    );
    user = rows[0] || null;
    if (!user) throw new UnauthorizedError('The linked account no longer exists');
    linked = true;
  }

  // 2. Email match on first sign-in
  if (!user) {
    const [userRows] = await db.query(
      'SELECT * FROM users WHERE email = ? AND deleted_at IS NULL',
      [email],
    );
    user = userRows[0] || null;
    if (user) {
      const [otherLink] = await db.query(
        `SELECT id FROM user_sso_identities
          WHERE organization_id = ? AND provider_type = ? AND user_id = ?`,
        [orgId, providerType, user.id],
      );
      if (otherLink.length) {
        throw new ForbiddenError('This account is already linked to a different identity at this IdP');
      }
    }
  }

  // 3. Auto-provision (the email is unused install-wide at this point)
  if (!user) {
    if (!cfg.auto_provision) {
      throw new UnauthorizedError('User not found and auto-provisioning is disabled for this organization');
    }
    // Random unusable password (SSO users authenticate via IdP only)
    const randomPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
    const [insertResult] = await db.query(
      `INSERT INTO users (organization_id, first_name, last_name, email, password_hash, role, group_id, status)
       VALUES (?, ?, ?, ?, ?, 'support',
               (SELECT id FROM roles WHERE name = 'support' AND deleted_at IS NULL LIMIT 1), 'active')`,
      [orgId, profile.firstName || '', profile.lastName || '', email, randomPassword],
    );
    const [newUserRows] = await db.query(
      'SELECT * FROM users WHERE id = ?',
      [insertResult.insertId],
    );
    user = newUserRows[0];
  }

  await assertSsoEligibleUser(orgId, user);

  // 4a. Link the identity (first sign-in). The UNIQUE key makes a concurrent
  //     link race harmless; a mismatch means another account won it.
  if (!linked) {
    await db.query(
      `INSERT IGNORE INTO user_sso_identities
         (organization_id, provider_type, issuer, subject, identity_hash, user_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [orgId, providerType, issuer.slice(0, 500), subject.slice(0, 500), hash, user.id],
    );
    const [check] = await db.query(
      `SELECT user_id FROM user_sso_identities
        WHERE organization_id = ? AND provider_type = ? AND identity_hash = ?`,
      [orgId, providerType, hash],
    );
    if (!check.length || Number(check[0].user_id) !== Number(user.id)) {
      throw new ForbiddenError('This IdP identity is linked to a different account');
    }
  }

  // 4b. Effective role from group mappings (first match wins), restricted to
  //     SSO_ROLES even if a bad row predates validation.
  let orgRole = SSO_ROLES.includes(cfg.default_role) ? cfg.default_role : 'readonly';
  if (profile.groups && profile.groups.length > 0 && mappings.length > 0) {
    for (const group of profile.groups) {
      const match = mappings.find(m => m.idp_group === group && SSO_ROLES.includes(m.fireisp_role));
      if (match) {
        orgRole = match.fireisp_role;
        break;
      }
    }
  }

  // 4c. Ensure a live membership. assertSsoEligibleUser already refused a
  //     removed (soft-deleted) membership, so this never resurrects one.
  await db.query(
    `INSERT INTO organization_users (organization_id, user_id, role)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role)`,
    [orgId, user.id, orgRole],
  );

  // 4d. Keep the user's GROUP in step with the SSO mapping (migration 378 made
  //     users.group_id the authoritative permission source, so leaving the
  //     provisioning default in place would make group mappings / default_role
  //     permission-inert). users.group_id is install-global, so it is only
  //     managed for accounts homed in this organization. The mapped role names
  //     a same-named SYSTEM group; 'manager' has no group row and leaves the
  //     current group alone. A CUSTOM (non-system) group assigned by an admin is
  //     never overwritten — SSO only manages users it left on system groups.
  if (user.organization_id !== null && user.organization_id !== undefined
      && Number(user.organization_id) === Number(orgId)) {
    await db.query(
      `UPDATE users u
       LEFT JOIN roles cur ON cur.id = u.group_id AND cur.deleted_at IS NULL
       JOIN roles target ON target.name = ? AND target.is_system = TRUE AND target.deleted_at IS NULL
       SET u.group_id = target.id,
           u.role = COALESCE(target.kind, u.role)
       WHERE u.id = ? AND u.organization_id = ? AND (cur.id IS NULL OR cur.is_system = TRUE)`,
      [orgRole, user.id, orgId],
    );
  }

  return { user, orgRole };
}

/**
 * Issue an access token + refresh token pair for a successfully authenticated
 * SSO user and return the same shape as authService.login().
 *
 * @param {object} user    users table row
 * @param {number} orgId   Organization the user is signing into
 * @returns {{ accessToken, refreshToken, expiresIn, user, organizations }}
 */
async function mintTokens(user, orgId) {
  const accessToken = jwt.sign(
    {
      sub:   user.id,
      email: user.email,
      role:  user.role,
      orgId,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.accessExpiresIn, algorithm: config.jwt.algorithm },
  );

  const refreshTokenValue = crypto.randomBytes(32).toString('hex');
  const refreshHash       = crypto.createHash('sha256').update(refreshTokenValue).digest('hex');
  const family            = crypto.randomUUID();

  await db.query(
    `INSERT INTO user_sessions (user_id, token_hash, token_family, ip_address, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [user.id, refreshHash, family, null, null, REFRESH_SECONDS],
  );

  // Update last_login_at
  await db.query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);

  const [orgRows] = await db.query(`
    SELECT o.*, ou.role AS membership_role
    FROM organization_users ou
    JOIN organizations o ON o.id = ou.organization_id
    WHERE ou.user_id = ? AND ou.deleted_at IS NULL AND o.deleted_at IS NULL
  `, [user.id]);

  const { password_hash: _pw, ...safeUser } = user;
  return {
    accessToken,
    refreshToken:  refreshTokenValue,
    expiresIn:     ACCESS_SECONDS,
    user:          safeUser,
    organizations: orgRows,
  };
}

// ---------------------------------------------------------------------------
// Cleanup helper (called by scheduled task or migration smoke test)
// ---------------------------------------------------------------------------

/**
 * Delete expired sso_auth_states rows.
 */
async function purgeExpiredStates() {
  const [result] = await db.query('DELETE FROM sso_auth_states WHERE expires_at <= NOW()');
  return result.affectedRows || 0;
}

module.exports = {
  getConfig,
  saveConfig,
  getGroupMappings,
  saveGroupMappings,
  getSamlMetadata,
  generateSamlLoginUrl,
  processSamlAssertion,
  generateOidcLoginUrl,
  processOidcCallback,
  findOrCreateSsoUser,
  assertSsoEligibleUser,
  assertValidGroupMappings,
  mintTokens,
  purgeExpiredStates,
  // Exported for testing
  normalizeSamlProfile,
  normalizeOidcProfile,
  normalizeOidcRedirectPath,
  parseAttributeMapping,
  SSO_ROLES,
};

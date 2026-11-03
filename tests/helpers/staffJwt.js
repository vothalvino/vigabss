'use strict';
// =============================================================================
// jsonwebtoken for tests that mint staff access tokens by hand (SEC-23)
// =============================================================================
// Staff tokens must carry type 'staff', the staff audience, the issuer and a
// jti. Tests that build one with jwt.sign(payload, config.jwt.secret, opts)
// get those claims added here, exactly as signStaffAccessToken sets them.
// Anything the test sets itself wins (a test of a portal-typed token keeps its
// type), and tokens signed with any other key pass through unchanged. Tests
// of the rejection rules use jsonwebtoken directly.
// =============================================================================

const crypto = require('crypto');
const jsonwebtoken = require('jsonwebtoken');
const config = require('../../src/config');
const { STAFF_AUDIENCE, TOKEN_ISSUER } = require('../../src/utils/accessTokens');

function sign(payload, key, options, callback) {
  if (key !== config.jwt.secret || !payload || typeof payload !== 'object' || Buffer.isBuffer(payload)) {
    return jsonwebtoken.sign(payload, key, options, callback);
  }
  const opts = { ...(typeof options === 'object' && options ? options : {}) };
  if (payload.aud === undefined && opts.audience === undefined) opts.audience = STAFF_AUDIENCE;
  if (payload.iss === undefined && opts.issuer === undefined) opts.issuer = TOKEN_ISSUER;
  if (payload.jti === undefined && opts.jwtid === undefined) opts.jwtid = crypto.randomUUID();
  return jsonwebtoken.sign({ type: 'staff', ...payload }, key, opts, typeof options === 'function' ? options : callback);
}

module.exports = { ...jsonwebtoken, sign };

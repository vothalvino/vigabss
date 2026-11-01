// =============================================================================
// WHK-13 (+ SEC-05's SAML part) — a SAML response is accepted once, and
// expired OIDC states are purged
// =============================================================================
// node-saml validated the signature and time window but remembered nothing,
// so a captured SAMLResponse could be posted again until NotOnOrAfter and
// each post signed someone in. Expired sso_auth_states rows were never
// deleted: purgeExpiredStates had no caller.
// =============================================================================

const mockQuery = jest.fn();
jest.mock('../src/config/database', () => ({ query: (...a) => mockQuery(...a), execute: jest.fn(), getConnection: jest.fn(), close: jest.fn(), pool: { end: jest.fn() } }));
jest.mock('@node-saml/node-saml', () => ({
  SAML: jest.fn().mockImplementation(() => ({
    validatePostResponseAsync: async () => ({ profile: { nameID: 'ana@isp.mx', issuer: 'https://idp.example' } }),
  })),
}));
jest.mock('openid-client', () => ({ generators: { state: () => 's1', nonce: () => 'n1' }, Issuer: { discover: jest.fn() } }));

const ssoService = require('../src/services/ssoService');

const SAML_CFG = { id: 3, is_enabled: 1, provider_type: 'saml', saml_sso_url: 'https://idp.example/sso', saml_x509_cert: 'CERT' };
const response = (id, notOnOrAfter) => Buffer.from(
  `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${id}" Version="2.0">`
  + `<saml:Assertion ID="a-${id}"><saml:Conditions NotBefore="2026-11-01T00:00:00Z" NotOnOrAfter="${notOnOrAfter}"/></saml:Assertion>`
  + '</samlp:Response>',
).toString('base64');

let seen;
beforeEach(() => {
  seen = new Set();
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql, params) => {
    if (/FROM organization_sso_configs/.test(sql)) return [[SAML_CFG]];
    if (/INSERT IGNORE INTO sso_saml_assertions_seen/.test(sql)) {
      const key = `${params[0]}:${params[1]}`;
      if (seen.has(key)) return [{ affectedRows: 0 }];
      seen.add(key);
      return [{ affectedRows: 1 }];
    }
    return [{ affectedRows: 0 }];
  });
});

test('a verified SAML response signs in once; posting it again is refused', async () => {
  const body = { SAMLResponse: response('_r1', '2026-11-01T00:05:00Z') };
  await expect(ssoService.processSamlAssertion(1, body)).resolves.toMatchObject({ email: 'ana@isp.mx' });
  await expect(ssoService.processSamlAssertion(1, body)).rejects.toMatchObject({ statusCode: 401 });
  const insert = mockQuery.mock.calls.find(([sql]) => /INSERT IGNORE INTO sso_saml_assertions_seen/.test(sql));
  expect(insert[1].slice(0, 2)).toEqual([1, '_r1']);
  expect(insert[1][2].toISOString()).toBe('2026-11-01T00:05:00.000Z');
});

test('a response without an ID is refused, and expired records are purged first', async () => {
  const noId = Buffer.from('<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"/>').toString('base64');
  await expect(ssoService.processSamlAssertion(1, { SAMLResponse: noId })).rejects.toMatchObject({ statusCode: 401 });

  await ssoService.processSamlAssertion(1, { SAMLResponse: response('_r2', '2026-11-01T00:05:00Z') });
  const purge = mockQuery.mock.calls.findIndex(([sql]) => /DELETE FROM sso_saml_assertions_seen WHERE expires_at < NOW\(\)/.test(sql));
  const insert = mockQuery.mock.calls.findIndex(([sql]) => /INSERT IGNORE INTO sso_saml_assertions_seen/.test(sql));
  expect(purge).toBeGreaterThan(-1);
  expect(insert).toBeGreaterThan(purge);
});

test('starting an OIDC login clears expired states before storing a new one', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'services', 'ssoService.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function generateOidcLoginUrl'), src.indexOf('INSERT INTO sso_auth_states'));
  expect(fn).toMatch(/DELETE FROM sso_auth_states WHERE expires_at <= NOW\(\) LIMIT 500/);
});

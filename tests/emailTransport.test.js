'use strict';

const mockQuery = jest.fn();
const mockGetConnection = jest.fn();
const mockWithTenantContext = jest.fn(async (_organizationId, callback) => callback());
const mockWithPrimaryContext = jest.fn(async callback => callback());

jest.mock('../src/config/database', () => ({
  query: mockQuery,
  getConnection: mockGetConnection,
  withTenantContext: mockWithTenantContext,
  withPrimaryContext: mockWithPrimaryContext,
}));

const mockFindRawByOrgId = jest.fn();
jest.mock('../src/models/EmailSettings', () => ({
  findRawByOrgId: mockFindRawByOrgId,
}));

const mockDecryptStrict = jest.fn(value => `plain:${value}`);
jest.mock('../src/utils/encryption', () => ({
  decryptStrict: mockDecryptStrict,
}));

const mockSendTenantSmtp = jest.fn();
const mockSendTrustedSmtp = jest.fn();
jest.mock('../src/utils/safeSmtpSender', () => ({
  sendTenantSmtp: mockSendTenantSmtp,
  sendTrustedSmtp: mockSendTrustedSmtp,
  DEFAULT_SMTP_CONNECTION_TIMEOUT_MS: 30000,
  DEFAULT_SMTP_GREETING_TIMEOUT_MS: 30000,
  DEFAULT_SMTP_SOCKET_TIMEOUT_MS: 60000,
}));

const mockGetOrganizationDeliveryState = jest.fn();
const mockEvaluateClientCommunication = jest.fn();
const mockBlockedResult = jest.fn(code => ({
  success: false,
  skipped: true,
  code,
  error: 'Client communication preference blocks this delivery.',
}));
const mockBlockCodes = Object.freeze({
  ORGANIZATION_INACTIVE: 'ORGANIZATION_INACTIVE',
  CLIENT_NOT_FOUND: 'CLIENT_NOT_FOUND',
  CONTACT_MISMATCH: 'CLIENT_COMMUNICATION_CONTACT_MISMATCH',
  OPTED_OUT: 'CLIENT_COMMUNICATION_OPTED_OUT',
  CONSENT_REQUIRED: 'CLIENT_MARKETING_CONSENT_REQUIRED',
});
jest.mock('../src/services/clientCommunicationPreferenceService', () => ({
  getOrganizationDeliveryState: mockGetOrganizationDeliveryState,
  evaluateClientCommunication: mockEvaluateClientCommunication,
  blockedResult: mockBlockedResult,
  BLOCK_CODES: mockBlockCodes,
}));

const EmailSettings = require('../src/models/EmailSettings');
const emailTransport = require('../src/services/emailTransport');

const ACTIVE = { active: true, epoch: 12 };

describe('emailTransport — one-shot SMTP and client-communication enforcement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOrganizationDeliveryState.mockReset().mockResolvedValue(ACTIVE);
    mockEvaluateClientCommunication.mockReset().mockResolvedValue({ allowed: true, code: null, contactEpoch: 19 });
    mockFindRawByOrgId.mockReset().mockResolvedValue(null);
    mockSendTenantSmtp.mockReset().mockResolvedValue({ messageId: '<tenant@test>' });
    mockSendTrustedSmtp.mockReset().mockResolvedValue({ messageId: '<trusted@test>' });
    mockQuery.mockReset().mockResolvedValue([{ affectedRows: 1, insertId: 1 }]);
  });

  test('uses the one-shot trusted relay and records the authoritative epoch', async () => {
    const result = await emailTransport.sendEmail({
      organizationId: 7,
      to: 'operator@example.com',
      subject: 'Operational notice',
      text: 'hello',
      installTransportOnly: true,
      operationalRecipient: true,
    });

    expect(result).toEqual({ success: true, messageId: '<trusted@test>' });
    expect(mockSendTrustedSmtp).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.objectContaining({ to: 'operator@example.com', subject: 'Operational notice' }),
    }));
    expect(mockSendTenantSmtp).not.toHaveBeenCalled();
    expect(mockFindRawByOrgId).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('organization_epoch'),
      expect.arrayContaining(['operator@example.com', 'Operational notice', 7, 12]),
    );
  });

  test('uses fresh tenant settings, strict decryption, mandatory-safe tenant sender', async () => {
    mockFindRawByOrgId.mockResolvedValueOnce({
      organization_id: 7,
      email_function: 'billing',
      enabled: 1,
      smtp_host: 'smtp.example.com',
      smtp_port: 465,
      smtp_secure: 1,
      smtp_user: 'billing-user',
      smtp_password_encrypted: 'ciphertext',
      from_email: 'billing@example.com',
      from_name: 'Billing',
    });

    const result = await emailTransport.sendEmail({
      organizationId: 7,
      emailFunction: 'billing',
      to: 'staff@example.net',
      subject: 'Invoice report',
      text: 'hello',
      operationalRecipient: true,
    });

    expect(result.success).toBe(true);
    expect(mockDecryptStrict).toHaveBeenCalledWith('ciphertext');
    expect(mockSendTenantSmtp).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'billing-user', pass: 'plain:ciphertext' },
      message: expect.objectContaining({ from: 'Billing <billing@example.com>' }),
    }));
    expect(mockSendTrustedSmtp).not.toHaveBeenCalled();
  });

  test('falls back requested function to the general tenant identity', async () => {
    mockFindRawByOrgId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        enabled: 1,
        smtp_host: 'general.smtp.example',
        smtp_port: 587,
        smtp_secure: 0,
        smtp_user: null,
        smtp_password_encrypted: null,
        from_email: 'general@example.com',
      });

    await emailTransport.sendEmail({
      organizationId: 7,
      emailFunction: 'noc',
      to: 'staff@example.net',
      subject: 'NOC',
      text: 'hello',
      operationalRecipient: true,
    });

    expect(EmailSettings.findRawByOrgId).toHaveBeenNthCalledWith(1, 7, 'noc');
    expect(EmailSettings.findRawByOrgId).toHaveBeenNthCalledWith(2, 7, 'general');
    expect(mockSendTenantSmtp).toHaveBeenCalledWith(expect.objectContaining({
      host: 'general.smtp.example',
    }));
  });

  test('DND blocks transactional client email before either SMTP sender', async () => {
    mockEvaluateClientCommunication.mockResolvedValueOnce({
      allowed: false,
      code: 'CLIENT_COMMUNICATION_OPTED_OUT',
    });

    const result = await emailTransport.sendEmail({
      organizationId: 7,
      clientId: 44,
      messageClass: 'transactional',
      to: 'client@example.com',
      subject: 'Invoice',
      text: 'hello',
    });

    expect(result).toMatchObject({
      success: false,
      skipped: true,
      code: 'CLIENT_COMMUNICATION_OPTED_OUT',
    });
    expect(mockEvaluateClientCommunication).toHaveBeenCalledWith({
      organizationId: 7,
      clientId: 44,
      channel: 'email',
      destination: 'client@example.com',
      messageClass: 'transactional',
    });
    expect(mockSendTenantSmtp).not.toHaveBeenCalled();
    expect(mockSendTrustedSmtp).not.toHaveBeenCalled();
  });

  test.each([
    [null, 'CLIENT_ORGANIZATION_REQUIRED'],
    [7, 'CLIENT_INACTIVE'],
  ])('client email is blocked before SMTP for unavailable ownership/lifecycle (%s)', async (organizationId, code) => {
    mockEvaluateClientCommunication.mockResolvedValueOnce({ allowed: false, code });

    const result = await emailTransport.sendEmail({
      organizationId,
      clientId: 44,
      messageClass: 'transactional',
      to: 'client@example.com',
      subject: 'Client notice',
      text: 'hello',
    });

    expect(result).toMatchObject({ success: false, skipped: true, code });
    expect(mockEvaluateClientCommunication).toHaveBeenCalledWith(expect.objectContaining({
      organizationId,
      clientId: 44,
    }));
    expect(mockSendTenantSmtp).not.toHaveBeenCalled();
    expect(mockSendTrustedSmtp).not.toHaveBeenCalled();
  });

  test('a lifecycle change during preparation prevents SMTP I/O', async () => {
    mockGetOrganizationDeliveryState
      .mockResolvedValueOnce({ active: true, epoch: 12 })
      .mockResolvedValueOnce({ active: true, epoch: 13 });

    const result = await emailTransport.sendEmail({
      organizationId: 7,
      to: 'staff@example.net',
      subject: 'Stale work',
      text: 'hello',
      installTransportOnly: true,
      operationalRecipient: true,
    });

    expect(result).toMatchObject({ success: false, code: 'ORGANIZATION_INACTIVE' });
    expect(mockSendTrustedSmtp).not.toHaveBeenCalled();
    expect(mockSendTenantSmtp).not.toHaveBeenCalled();
  });

  test('sanitized delivery failures neither return nor persist raw socket details', async () => {
    const sentinel = 'ECONNREFUSED 10.0.0.5:25 SECRET_SOCKET_DETAIL';
    mockSendTrustedSmtp.mockRejectedValueOnce(Object.assign(new Error(sentinel), {
      code: 'ECONNREFUSED',
    }));

    const result = await emailTransport.sendEmail({
      organizationId: 7,
      to: 'staff@example.net',
      subject: 'Test',
      text: 'hello',
      installTransportOnly: true,
      operationalRecipient: true,
      sanitizeFailure: true,
    });

    expect(result).toEqual({
      success: false,
      error: 'Email delivery failed.',
      code: 'EMAIL_DELIVERY_FAILED',
    });
    expect(JSON.stringify(mockQuery.mock.calls)).not.toContain(sentinel);
  });

  test.each([
    [{ organizationId: 7, to: 'nobody@example.test', subject: 'Missing lane' }],
    [{ organizationId: 7, clientId: 44, operationalRecipient: true, messageClass: 'transactional', to: 'client@example.test', subject: 'Mixed lane' }],
    [{ organizationId: 7, messageClass: 'transactional', to: 'client@example.test', subject: 'Missing client' }],
  ])('rejects ambiguous client/operational lane pairing before SMTP I/O', async options => {
    await expect(emailTransport.sendEmail(options)).resolves.toMatchObject({
      success: false,
      code: 'CLIENT_ATTRIBUTION_REQUIRED',
    });
    expect(mockSendTenantSmtp).not.toHaveBeenCalled();
    expect(mockSendTrustedSmtp).not.toHaveBeenCalled();
  });
});

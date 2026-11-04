// =============================================================================
// ASY-36 — batch email and SMS go through the message outbox
// =============================================================================
// send_email and send_sms batch jobs failed every item ("not implemented"),
// and so did rate_limit, send_notification, apply_tag and remove_tag, after
// the job had been stored and queued.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  withPrimaryContext: fn => fn(),
  withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/services/messageOutbox', () => ({ enqueue: jest.fn() }));
jest.mock('../src/utils/advisoryLock', () => ({ withAdvisoryLock: jest.fn(async (_key, fn) => { await fn(); return true; }) }));
jest.mock('../src/services/jobQueueService', () => ({ add: jest.fn(async () => ({ status: 'queued' })) }));

const db = require('../src/config/database');
const messageOutbox = require('../src/services/messageOutbox');
const automation = require('../src/services/automationService');

const CONTACT = { contract_id: 10, client_id: 7, name: 'Ana', email: 'ana@example.com', phone: '+525512345678' };

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM contracts c\s+JOIN clients cl/.test(sql)) {
      return [params[0] === 10 && params[1] === 1 ? [CONTACT] : (params[0] === 11 ? [{ ...CONTACT, contract_id: 11, email: null }] : [])];
    }
    return [{ affectedRows: 1, insertId: 1 }];
  });
  messageOutbox.enqueue.mockResolvedValue({ queued: true, id: 55 });
});

const item = (over = {}) => ({ id: 900, entity_id: 10, entity_type: 'contract', ...over });

test('send_sms queues one outbox SMS for the contract\'s client, keyed to the item', async () => {
  const outcome = await automation.applyBatchOperation(1, 'send_sms', item(), { message: 'Hola {{client.name}}, mantenimiento hoy' }, 3);
  expect(messageOutbox.enqueue).toHaveBeenCalledWith({
    channel: 'sms', organizationId: 1, clientId: 7, messageClass: 'transactional',
    recipient: '+525512345678', bodyText: 'Hola Ana, mantenimiento hoy',
    sourceType: 'batch_job_item', sourceId: 900, dedupeKey: 'batch_job_item:1:900',
  });
  expect(outcome).toEqual({ message: 'SMS queued (outbox #55)' });
});

test('send_email carries the subject and an escaped HTML body', async () => {
  await automation.applyBatchOperation(1, 'send_email', item(), { subject: 'Aviso', message: 'a < b', message_class: 'marketing' }, 3);
  expect(messageOutbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
    channel: 'email', recipient: 'ana@example.com', subject: 'Aviso', bodyText: 'a < b',
    bodyHtml: '<p>a &lt; b</p>', messageClass: 'marketing',
  }));
});

test('a client with no address, or whose preferences block the message, is a skipped item', async () => {
  expect(await automation.applyBatchOperation(1, 'send_email', item({ entity_id: 11 }), { subject: 's', message: 'm' }))
    .toEqual({ skipped: true, message: 'Client #7 has no email address' });
  messageOutbox.enqueue.mockResolvedValue({ queued: false, skipped: true, code: 'CLIENT_OPTED_OUT' });
  expect(await automation.applyBatchOperation(1, 'send_sms', item(), { message: 'm' }))
    .toEqual({ skipped: true, message: 'Not sent: CLIENT_OPTED_OUT' });
});

test('a contract of another organization is a failure, and nothing is queued', async () => {
  await expect(automation.applyBatchOperation(2, 'send_sms', item(), { message: 'm' })).rejects.toThrow(/not found in organization/);
  expect(messageOutbox.enqueue).not.toHaveBeenCalled();
});

test('the job records a skipped item as skipped, not as a failure', async () => {
  messageOutbox.enqueue.mockResolvedValue({ queued: false, code: 'CLIENT_OPTED_OUT' });
  let served = false;
  db.query.mockImplementation(async (sql) => {
    if (/SELECT \* FROM batch_jobs WHERE id = \?/.test(sql)) return [[{ id: 5, status: 'pending', operation: 'send_sms', operation_params: { message: 'm' } }]];
    if (/SELECT status FROM batch_jobs/.test(sql)) return [[{ status: 'running' }]];
    if (/FROM batch_job_items\s+WHERE batch_job_id = \? AND status = 'pending'/.test(sql)) {
      if (served) return [[]];
      served = true;
      return [[{ id: 900, entity_type: 'contract', entity_id: 10 }]];
    }
    if (/FROM contracts c\s+JOIN clients cl/.test(sql)) return [[CONTACT]];
    return [{ affectedRows: 1 }];
  });
  await automation.processBatchJob(5, 1);
  const [, params] = db.query.mock.calls.find(([sql]) => /UPDATE batch_job_items SET status = \?, result_message = \?/.test(sql));
  expect(params).toEqual(['skipped', 'Not sent: CLIENT_OPTED_OUT', 900]);
});

describe('createBatchJob', () => {
  test.each(['rate_limit', 'send_notification', 'apply_tag', 'remove_tag'])(
    "refuses '%s' with 501 before storing anything",
    async (operation) => {
      await expect(automation.createBatchJob(1, { name: 'x', operation, filter_criteria: {} }))
        .rejects.toMatchObject({ statusCode: 501, code: 'BATCH_OPERATION_NOT_IMPLEMENTED' });
      expect(db.query.mock.calls.some(([sql]) => /INSERT INTO batch_jobs/.test(sql))).toBe(false);
    },
  );

  test.each([
    ['send_sms', {}, /requires operation_params.message/],
    ['send_email', { message: 'm' }, /requires operation_params.subject/],
    ['send_sms', { message: 'm', message_class: 'security' }, /message_class must be one of/],
  ])('%s with %j is a validation error', async (operation, params, message) => {
    await expect(automation.createBatchJob(1, { name: 'x', operation, filter_criteria: {}, operation_params: params }))
      .rejects.toThrow(message);
  });
});

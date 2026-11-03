// =============================================================================
// VigaBSS 5.0 — Communication Campaigns Tests — §1.4
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  getConnection: jest.fn(),
  withTenantContext: jest.fn(async (_organizationId, callback) => callback()),
  withPrimaryContext: jest.fn(async callback => callback()),
}));

// Campaign messages are handed to the message outbox (ASY-33), which
// delivers them; its rules are tested in tests/messageOutbox.test.js.
const mockEnqueue = jest.fn();
jest.mock('../src/services/messageOutbox', () => ({ enqueue: (...a) => mockEnqueue(...a) }));

const mockGetOrganizationDeliveryState = jest.fn().mockResolvedValue({ active: true, epoch: 0 });
jest.mock('../src/services/clientCommunicationPreferenceService', () => ({
  getOrganizationDeliveryState: mockGetOrganizationDeliveryState,
}));

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

const db = require('../src/config/database');
const logger = require('../src/utils/logger');
const {
  buildRecipientList,
  dispatchCampaign,
  processQueue,
  handleDeliveryCallback,
} = require('../src/services/campaignService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mockQuery(results) {
  db.query.mockResolvedValueOnce(results);
}

beforeEach(() => {
  mockGetOrganizationDeliveryState.mockResolvedValue({ active: true, epoch: 0 });
});

// ---------------------------------------------------------------------------
// buildRecipientList
// ---------------------------------------------------------------------------
describe('buildRecipientList', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns email recipients for email channel, excluding DND opt-outs', async () => {
    // db.query called once to get clients
    mockQuery([
      [
        { client_id: 1, recipient: 'alice@example.com' },
        { client_id: 2, recipient: 'bob@example.com' },
      ],
    ]);

    const campaign = {
      organization_id: 1,
      channel: 'email',
      filter_status: null,
      filter_plan_id: null,
      filter_tag: null,
    };

    const result = await buildRecipientList(campaign);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ client_id: 1, recipient: 'alice@example.com', client_contact_epoch: 0, channel: 'email' });
    expect(result[1]).toEqual({ client_id: 2, recipient: 'bob@example.com', client_contact_epoch: 0, channel: 'email' });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/EXISTS[\s\S]*subscriber_consents[\s\S]*purpose = 'marketing'/);
    expect(sql).toMatch(/communication_channel = \?/);
    expect(sql).toMatch(/withdrawn_at IS NULL/);
    expect(sql).toMatch(/c\.deleted_at IS NULL/);
    expect(sql).toMatch(/c\.status <> 'inactive'/);
    expect(params).toEqual([1, 'email', 'email']);
  });

  test('returns SMS recipients for sms channel', async () => {
    mockQuery([[{ client_id: 5, recipient: '+521234567890' }]]);

    const campaign = {
      organization_id: 1,
      channel: 'sms',
      filter_status: 'active',
      filter_plan_id: null,
      filter_tag: null,
    };

    const result = await buildRecipientList(campaign);

    expect(result).toHaveLength(1);
    expect(result[0].channel).toBe('sms');
    expect(result[0].recipient).toBe('+521234567890');
  });

  test('returns empty array when no recipients', async () => {
    mockQuery([[]]);

    const campaign = {
      organization_id: 1,
      channel: 'email',
      filter_status: null,
      filter_plan_id: null,
      filter_tag: null,
    };

    const result = await buildRecipientList(campaign);
    expect(result).toHaveLength(0);
  });

  test('builds SQL with filter_plan_id when provided', async () => {
    mockQuery([[{ client_id: 10, recipient: 'test@example.com' }]]);

    const campaign = {
      organization_id: 2,
      channel: 'email',
      filter_status: null,
      filter_plan_id: 7,
      filter_tag: null,
    };

    await buildRecipientList(campaign);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('contracts ct');
    expect(params).toContain(7);
  });

  test('builds SQL with filter_tag when provided', async () => {
    mockQuery([[{ client_id: 10, recipient: 'test@example.com' }]]);

    const campaign = {
      organization_id: 2,
      channel: 'email',
      filter_status: null,
      filter_plan_id: null,
      filter_tag: 'vip',
    };

    await buildRecipientList(campaign);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('client_groups');
    expect(params).toContain('vip');
  });
});

// ---------------------------------------------------------------------------
// dispatchCampaign
// ---------------------------------------------------------------------------
describe('dispatchCampaign', () => {
  let conn;

  beforeEach(() => {
    jest.clearAllMocks();
    // The template check (ASY-21) reads message_templates in the same
    // transaction; it is answered here and left out of txCalls() so the call
    // order below stays the dispatch's own.
    const queued = [];
    let campaignChannel = 'email';
    conn = {
      beginTransaction: jest.fn().mockResolvedValue(undefined),
      execute: jest.fn(async (sql) => {
        if (/FROM message_templates/.test(sql)) return [[{ id: 42, channel: campaignChannel, body: 'Hola' }]];
        const result = queued.shift();
        if (/FROM communication_campaigns[\s\S]*FOR UPDATE/.test(sql)) campaignChannel = result?.[0]?.[0]?.channel || 'email';
        return result;
      }),
      queued,
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      release: jest.fn(),
    };
    db.getConnection.mockResolvedValue(conn);
  });

  const mockTxQuery = result => conn.queued.push(result);
  const txCalls = () => conn.execute.mock.calls.filter(([sql]) => !/FROM message_templates/.test(sql));

  test('locks, guarded-transitions, and inserts the recipient snapshot in one transaction', async () => {
    mockGetOrganizationDeliveryState.mockResolvedValue({ active: true, epoch: 23 });
    mockTxQuery([[{
      id: 1,
      organization_id: 1,
      template_id: 42,
      channel: 'email',
      status: 'draft',
      filter_status: null,
      filter_plan_id: null,
      filter_tag: null,
    }]]);
    mockTxQuery([[]]);
    mockTxQuery([[
      { client_id: 1, recipient: 'a@example.com', client_contact_epoch: 31 },
      { client_id: 2, recipient: 'b@example.com', client_contact_epoch: 32 },
    ]]);
    mockTxQuery([{ affectedRows: 1 }]);
    mockTxQuery([{ affectedRows: 2 }]);

    const result = await dispatchCampaign(1, 1);

    expect(result).toEqual({ queued: 2 });
    expect(conn.beginTransaction).toHaveBeenCalledTimes(1);
    expect(conn.commit).toHaveBeenCalledTimes(1);
    expect(conn.rollback).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();

    const lockCall = txCalls()[0];
    expect(lockCall[0]).toMatch(/communication_campaigns[\s\S]*FOR UPDATE/);
    expect(lockCall[0]).toMatch(/organization_id <=> \?/);

    const transitionCall = txCalls()[3];
    expect(transitionCall[0]).toMatch(/status = \?[\s\S]*status = \?/);
    expect(transitionCall[1]).toEqual(['sending', 2, 1, 1, 'draft']);

    const insertCall = txCalls()[4];
    expect(insertCall[0]).toContain('campaign_messages');
    expect(insertCall[0]).not.toContain('VALUES ?');
    const expectedPlaceholders = Array(2).fill(`(${Array(9).fill('?').join(', ')})`).join(', ');
    expect(insertCall[0]).toContain(`VALUES ${expectedPlaceholders}`);
    expect(insertCall[1]).toHaveLength(18);
    expect(insertCall[1].slice(0, 8)).toEqual([1, 23, 1, 1, 31, 'a@example.com', 'email', 'queued']);
    expect(insertCall[1][8]).toBeInstanceOf(Date);
    expect(insertCall[1].slice(9, 17)).toEqual([1, 23, 1, 2, 32, 'b@example.com', 'email', 'queued']);
    expect(insertCall[1][17]).toBeInstanceOf(Date);
  });

  test('marks campaign as sent immediately when no recipients', async () => {
    mockTxQuery([[{
      id: 2,
      organization_id: 1,
      template_id: 42,
      channel: 'sms',
      status: 'draft',
      filter_status: 'suspended',
      filter_plan_id: null,
      filter_tag: null,
    }]]);
    mockTxQuery([[]]);
    mockTxQuery([[]]);
    mockTxQuery([{ affectedRows: 1 }]);

    const result = await dispatchCampaign(2, 1);

    expect(result).toEqual({ queued: 0 });
    const updateCall = txCalls()[3];
    expect(updateCall[1][0]).toBe('sent');
    expect(updateCall[0]).toContain('completed_at = NOW()');
    expect(conn.commit).toHaveBeenCalledTimes(1);
  });

  test('throws when campaign not found', async () => {
    mockTxQuery([[]]);

    await expect(dispatchCampaign(999, 1)).rejects.toThrow('Campaign 999 not found');
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
  });

  test('throws when campaign is already in sending status', async () => {
    mockTxQuery([[{ id: 3, organization_id: 1, template_id: 42, status: 'sending' }]]);

    await expect(dispatchCampaign(3, 1)).rejects.toThrow('cannot be dispatched');
    expect(conn.execute).toHaveBeenCalledTimes(1);
    expect(conn.rollback).toHaveBeenCalledTimes(1);
  });

  test('retires stale queued rows before redispatching a cancelled campaign', async () => {
    mockTxQuery([[
      {
        id: 5,
        organization_id: 1,
        template_id: 42,
        channel: 'sms',
        status: 'cancelled',
        filter_status: null,
        filter_plan_id: null,
        filter_tag: null,
      },
    ]]);
    mockTxQuery([[]]);
    mockTxQuery([{ affectedRows: 3 }]);
    mockTxQuery([[{ client_id: 8, recipient: '+521111111111' }]]);
    mockTxQuery([{ affectedRows: 1 }]);
    mockTxQuery([{ affectedRows: 1 }]);

    await expect(dispatchCampaign(5, 1)).resolves.toEqual({ queued: 1 });

    const [retireSql, retireParams] = txCalls()[2];
    expect(retireSql).toMatch(/UPDATE campaign_messages/);
    expect(retireSql).toMatch(/status = 'queued'/);
    expect(retireParams).toEqual(['Superseded by campaign redispatch', 5, 1]);
    expect(conn.commit).toHaveBeenCalledTimes(1);
  });

  test('rolls back recipient inserts when the guarded state transition loses a race', async () => {
    mockTxQuery([[
      {
        id: 4,
        organization_id: 1,
        template_id: 42,
        channel: 'email',
        status: 'draft',
        filter_status: null,
        filter_plan_id: null,
        filter_tag: null,
      },
    ]]);
    mockTxQuery([[]]);
    mockTxQuery([[{ client_id: 1, recipient: 'a@example.com' }]]);
    mockTxQuery([{ affectedRows: 0 }]);

    await expect(dispatchCampaign(4, 1)).rejects.toThrow('state changed');

    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
    expect(txCalls().some(([sql]) => /INSERT INTO campaign_messages/.test(sql))).toBe(false);
  });

  test.each([
    'Delivery claimed; awaiting provider result',
    'Provider invocation started; delivery outcome is unknown',
  ])('refuses redispatch while a prior row has ambiguous provider state: %s', async errorMessage => {
    mockTxQuery([[
      {
        id: 6,
        organization_id: 1,
        template_id: 42,
        channel: 'email',
        status: 'failed',
      },
    ]]);
    mockTxQuery([[{ id: 601, error_message: errorMessage }]]);

    await expect(dispatchCampaign(6, 1)).rejects.toThrow('unresolved provider outcome');

    expect(txCalls()).toHaveLength(2);
    const [unresolvedSql, unresolvedParams] = txCalls()[1];
    expect(unresolvedSql).toMatch(/status = 'failed' AND error_message IN \(\?, \?\)/);
    expect(unresolvedSql).toMatch(/LIMIT 1 FOR UPDATE/);
    expect(unresolvedParams).toEqual([
      6,
      1,
      'Delivery claimed; awaiting provider result',
      'Provider invocation started; delivery outcome is unknown',
    ]);
    expect(conn.rollback).toHaveBeenCalledTimes(1);
    expect(conn.commit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processQueue
// ---------------------------------------------------------------------------
describe('processQueue', () => {
  const deliveryClaimMarker = 'Delivery claimed; awaiting provider result';
  const deliveryOutcomeUnknown = 'Provider invocation started; delivery outcome is unknown';
  const handedOff = 'Queued in the message outbox';

  const queuedMessage = overrides => ({
    id: 10,
    campaign_id: 1,
    campaign_org_id: 1,
    // Every dispatched campaign has a usable template (ASY-21).
    campaign_template_id: 42,
    organization_epoch: 0,
    client_contact_epoch: 9,
    channel: 'email',
    recipient: 'alice@example.com',
    client_id: 1,
    ...overrides,
  });

  let conn;
  function installQueueMock({
    queued = [],
    templates = [{ id: 42, subject: 'Aviso', body: 'Hola' }],
    clients = [],
    staleAffected = 0,
    claimAffected = 1,
    terminalAffected = 1,
    finalizeAffected = 0,
  } = {}) {
    db.query.mockImplementation(async (sql) => {
      if (/FROM organization_database_configs/.test(sql)) return [[]];
      if (/SET cm\.status = 'queued', cm\.error_message = NULL/.test(sql)) return [{ affectedRows: staleAffected }];
      if (/SELECT cm\.\*, cc\.template_id AS campaign_template_id/.test(sql)) return [queued];
      if (/FROM message_templates/.test(sql)) return [templates];
      if (/SELECT \* FROM clients/.test(sql)) return [clients];
      if (/UPDATE campaign_messages\s+SET status = 'failed'/.test(sql)) return [{ affectedRows: terminalAffected }];
      if (/UPDATE communication_campaigns\s+SET failed_count/.test(sql)) return [{ affectedRows: 1 }];
      if (/UPDATE communication_campaigns cc/.test(sql)) return [{ affectedRows: finalizeAffected }];
      throw new Error(`Unexpected campaign queue SQL: ${sql}`);
    });
    // The claim and the outbox row commit together on one connection.
    conn = {
      beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(async () => {}), release: jest.fn(),
      execute: jest.fn(async (sql) => {
        if (/UPDATE campaign_messages cm[\s\S]*JOIN clients c/.test(sql)) return [{ affectedRows: claimAffected }];
        return [{ affectedRows: 1 }];
      }),
    };
    db.getConnection.mockResolvedValue(conn);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockReset();
    mockEnqueue.mockReset().mockResolvedValue({ queued: true, id: 501 });
    mockGetOrganizationDeliveryState.mockReset().mockResolvedValue({ active: true, epoch: 0 });
  });

  test('claims the snapshot and hands it to the outbox in the same transaction', async () => {
    installQueueMock({ queued: [queuedMessage({ campaign_channel: 'sms' })] });

    await expect(processQueue(1)).resolves.toEqual({ handed_off: 1, failed: 0, total: 1 });

    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'email', organizationId: 1, clientId: 1, messageClass: 'marketing', recipient: 'alice@example.com',
      subject: 'Aviso', bodyHtml: 'Hola', sourceType: 'campaign_message', sourceId: 10,
      dedupeKey: 'campaign_message:1:10',
    }), { exec: expect.any(Function) });
    expect(conn.commit).toHaveBeenCalledTimes(1);

    const [queueSql] = db.query.mock.calls.find(([sql]) => /SELECT cm\.\*/.test(sql));
    expect(queueSql).toMatch(/cm\.status = 'queued'/);
    expect(queueSql).toMatch(/cc\.status = 'sending'/);
    expect(queueSql).toMatch(/cc\.deleted_at IS NULL/);
    expect(queueSql).toMatch(/cc\.organization_id <=> cm\.organization_id/);

    const [claimSql, claimParams] = conn.execute.mock.calls.find(([sql]) => /JOIN clients c/.test(sql));
    expect(claimSql).toMatch(/c\.deleted_at IS NULL/);
    expect(claimSql).toMatch(/c\.status <> 'inactive'/);
    expect(claimSql).toMatch(/c\.email = cm\.recipient/);
    expect(claimSql).toMatch(/subscriber_consents/);
    expect(claimSql).toMatch(/client_dnd_preferences/);
    expect(claimSql).toMatch(/cm\.client_contact_epoch = CASE/);
    expect(claimSql).toMatch(/cc\.status = 'sending' AND cc\.deleted_at IS NULL/);
    expect(claimParams).toEqual([handedOff, 10, 1, 'email', 'alice@example.com']);
  });

  test('an SMS snapshot is handed off as text', async () => {
    installQueueMock({ queued: [queuedMessage({ channel: 'sms', recipient: '+5215555555555' })] });

    await processQueue(1);

    const [message] = mockEnqueue.mock.calls[0];
    expect(message).toMatchObject({ channel: 'sms', recipient: '+5215555555555', bodyText: 'Hola', messageClass: 'marketing' });
    expect(message.subject).toBeUndefined();
  });

  test('loads tenant-scoped template/client data and interpolates variables', async () => {
    installQueueMock({
      queued: [queuedMessage()],
      templates: [{ id: 42, subject: 'Hola {{name}}', body: 'Su saldo es {{balance}}' }],
      clients: [{ id: 1, name: 'Alice', balance: '100.00' }],
    });

    await processQueue(1);

    const [templateSql, templateParams] = db.query.mock.calls.find(([sql]) => /FROM message_templates/.test(sql));
    expect(templateSql).toMatch(/organization_id <=> \? OR organization_id IS NULL/);
    expect(templateParams).toEqual([42, 1]);
    expect(mockEnqueue.mock.calls[0][0]).toMatchObject({ subject: 'Hola Alice', bodyHtml: 'Su saldo es 100.00' });
  });

  test('HTML-escapes email merge values without touching template markup', async () => {
    installQueueMock({
      queued: [queuedMessage()],
      templates: [{ id: 42, subject: 'Hi {{name}}', body: '<p>Hi <b>{{name}}</b></p>' }],
      clients: [{ id: 1, name: '<script>x</script>' }],
    });

    await processQueue(1);

    expect(mockEnqueue.mock.calls[0][0].bodyHtml).toBe('<p>Hi <b>&lt;script&gt;x&lt;/script&gt;</b></p>');
  });

  test('keeps SMS merge values as plain text', async () => {
    installQueueMock({
      queued: [queuedMessage({ channel: 'sms', recipient: '+5215555555555' })],
      templates: [{ id: 42, body: 'Hola {{name}} & co' }],
      clients: [{ id: 1, name: "O'Brien <Ltd>" }],
    });

    await processQueue(1);

    expect(mockEnqueue.mock.calls[0][0].bodyText).toBe("Hola O'Brien <Ltd> & co");
  });

  test('a snapshot the live contact/consent/DND claim rejects is never handed off', async () => {
    installQueueMock({ queued: [queuedMessage()], claimAffected: 0 });

    await expect(processQueue(1)).resolves.toEqual({ handed_off: 0, failed: 1, total: 1 });

    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(conn.rollback).toHaveBeenCalled();
    const skip = db.query.mock.calls.find(([sql]) => /UPDATE campaign_messages\s+SET status = 'failed'[\s\S]*status = 'queued'/.test(sql));
    expect(skip[1][0]).toBe('Recipient or email permission changed; message skipped');
  });

  test('a row claimed by another worker is left alone and not counted', async () => {
    installQueueMock({ queued: [queuedMessage()], claimAffected: 0, terminalAffected: 0 });

    await expect(processQueue(1)).resolves.toEqual({ handed_off: 0, failed: 0, total: 1 });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('a message the outbox\'s own consent check blocks is recorded failed in the same transaction', async () => {
    installQueueMock({ queued: [queuedMessage()] });
    mockEnqueue.mockResolvedValueOnce({ queued: false, skipped: true, code: 'CLIENT_MARKETING_CONSENT_REQUIRED' });

    await expect(processQueue(1)).resolves.toEqual({ handed_off: 0, failed: 1, total: 1 });

    const sqls = conn.execute.mock.calls.map(([sql]) => sql);
    expect(sqls.some(sql => /UPDATE campaign_messages SET status = 'failed'/.test(sql))).toBe(true);
    expect(sqls.some(sql => /failed_count = failed_count \+ 1/.test(sql))).toBe(true);
    expect(conn.commit).toHaveBeenCalled();
  });

  test('does not hand off a snapshot after an organization epoch change', async () => {
    mockGetOrganizationDeliveryState.mockResolvedValue({ active: true, epoch: 3 });
    installQueueMock({ queued: [queuedMessage()] });

    await expect(processQueue(1)).resolves.toEqual({ handed_off: 0, failed: 1, total: 1 });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  test('a failure before the hand-off marks the message failed, not lost', async () => {
    installQueueMock({ queued: [queuedMessage()] });
    mockEnqueue.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(processQueue(1)).resolves.toEqual({ handed_off: 0, failed: 1, total: 1 });
    expect(conn.rollback).toHaveBeenCalled();
    const failure = db.query.mock.calls.find(([sql, params]) => /UPDATE campaign_messages/.test(sql) && params?.[0] === 'Campaign message could not be queued for delivery');
    expect(failure).toBeDefined();
  });

  test('recovers only stale pre-I/O claims and never outcome-unknown rows', async () => {
    installQueueMock({ staleAffected: 2 });

    await expect(processQueue(44)).resolves.toEqual({ handed_off: 0, failed: 0, total: 0 });

    const [recoverySql, recoveryParams] = db.query.mock.calls.find(([sql]) => /SET cm\.status = 'queued'/.test(sql));
    expect(recoverySql).toMatch(/cm\.error_message = \?/);
    expect(recoveryParams).toEqual([deliveryClaimMarker, 44]);
    expect(recoveryParams).not.toContain(deliveryOutcomeUnknown);
    expect(recoveryParams).not.toContain(handedOff);
  });

  test('a campaign stays sending while its messages are in the outbox, and fails on an unknown outcome', async () => {
    installQueueMock();

    await processQueue(1);

    const [finalizeSql, finalizeParams] = db.query.mock.calls.find(([sql]) => /UPDATE communication_campaigns cc/.test(sql));
    expect(finalizeSql).toMatch(/THEN 'failed'/);
    expect(finalizeParams.slice(0, 3)).toEqual([deliveryOutcomeUnknown, deliveryClaimMarker, handedOff]);
  });

  test('fans out the shared queue and each isolated organization queue', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM organization_database_configs/.test(sql)) return [[{ organization_id: 77 }]];
      if (/SET cm\.status = 'queued'/.test(sql)) return [{ affectedRows: 0 }];
      if (/SELECT cm\.\*/.test(sql)) return [[]];
      if (/UPDATE communication_campaigns cc/.test(sql)) return [{ affectedRows: 0 }];
      throw new Error(`Unexpected isolated campaign SQL: ${sql}`);
    });

    await expect(processQueue()).resolves.toEqual({ handed_off: 0, failed: 0, total: 0 });

    expect(db.withPrimaryContext).toHaveBeenCalledTimes(2);
    expect(db.withTenantContext).toHaveBeenCalledWith(77, expect.any(Function));
    const queueReads = db.query.mock.calls.filter(([sql]) => /SELECT cm\.\*/.test(sql));
    expect(queueReads.map(([, params]) => params)).toEqual([[77], [77]]);
  });
});

// ---------------------------------------------------------------------------
// handleDeliveryCallback
// ---------------------------------------------------------------------------
describe('handleDeliveryCallback', () => {
  beforeEach(() => jest.clearAllMocks());

  test('updates message status to delivered and increments campaign counter', async () => {
    mockQuery([[{ id: 50, campaign_id: 1, status: 'sent' }]]);
    mockQuery([{ affectedRows: 1 }]); // UPDATE campaign_messages
    mockQuery([{ affectedRows: 1 }]); // UPDATE communication_campaigns

    const result = await handleDeliveryCallback('msg-sid-123', 'delivered', {});

    expect(result).toEqual({ updated: true });
    const updateMsgCall = db.query.mock.calls[1];
    expect(updateMsgCall[0]).toContain('delivered_at');
    const updateCampaignCall = db.query.mock.calls[2];
    expect(updateCampaignCall[0]).toContain('delivered_count');
  });

  test('updates message status to bounced', async () => {
    mockQuery([[{ id: 51, campaign_id: 1, status: 'sent' }]]);
    mockQuery([{ affectedRows: 1 }]);
    mockQuery([{ affectedRows: 1 }]);

    const result = await handleDeliveryCallback('msg-sid-456', 'bounced');

    expect(result.updated).toBe(true);
    const updateCampaignCall = db.query.mock.calls[2];
    expect(updateCampaignCall[0]).toContain('bounced_count');
  });

  test('updates message status to opened', async () => {
    mockQuery([[{ id: 52, campaign_id: 2, status: 'delivered' }]]);
    mockQuery([{ affectedRows: 1 }]);
    mockQuery([{ affectedRows: 1 }]);

    const result = await handleDeliveryCallback('msg-sid-789', 'opened');

    expect(result.updated).toBe(true);
    const updateCampaignCall = db.query.mock.calls[2];
    expect(updateCampaignCall[0]).toContain('opened_count');
  });

  test('returns updated: false when message not found', async () => {
    mockQuery([[]]); // no rows

    const result = await handleDeliveryCallback('unknown-sid', 'delivered');

    expect(result).toEqual({ updated: false });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('returns updated: false when providerMessageId is null', async () => {
    const result = await handleDeliveryCallback(null, 'delivered');

    expect(result).toEqual({ updated: false });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('returns updated: false for unknown status', async () => {
    const result = await handleDeliveryCallback('some-sid', 'unknown_status');

    expect(result).toEqual({ updated: false });
    expect(logger.warn).toHaveBeenCalled();
  });
});

// =============================================================================
// VigaBSS 5.0 — WhatsApp bot: voice notes
// =============================================================================
// A voice note from a linked customer is transcribed with the organization's
// OpenAI provider and answered like the same words typed. Anything that
// prevents that ends in a request to type instead, never an error.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/models/AiPolicy', () => ({ findByOrgId: jest.fn() }));
jest.mock('../src/services/aiBudgetService', () => ({ assertWithinBudget: jest.fn(), recordUsage: jest.fn(), overBudget: jest.fn() }));
const mockCreate = jest.fn();
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({ audio: { transcriptions: { create: mockCreate } } })),
  toFile: jest.fn(async (data, name, opts) => ({ name, type: opts.type, size: data.length })),
}));
jest.mock('../src/utils/logger', () => {
  const m = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn(() => m) };
  return m;
});

const db = require('../src/config/database');
const config = require('../src/config');
const AiPolicy = require('../src/models/AiPolicy');
const aiBudget = require('../src/services/aiBudgetService');
const { OpenAI } = require('openai');
const llm = require('../src/services/llmProviderService');
const voice = require('../src/services/whatsappVoice');
const webhookSvc = require('../src/services/whatsappWebhookService');

const POLICY = { enabled: 1, enabled_channels: { whatsapp: true } };
const PROVIDER = { id: 9, organization_id: 3, kind: 'openai', api_key_encrypted: 'example-openai-key', timeout_ms: 20000 };
const AUDIO = Buffer.alloc(300000, 1); // about two minutes of voice note

beforeEach(() => {
  jest.clearAllMocks();
  AiPolicy.findByOrgId.mockResolvedValue(POLICY);
  aiBudget.assertWithinBudget.mockResolvedValue();
  db.query.mockResolvedValue([[PROVIDER]]);
  mockCreate.mockResolvedValue({ text: ' No tengo internet desde ayer. ' });
  config.whatsapp.accessToken = 'example-meta-token';
  delete process.env.AI_TRANSCRIPTION_MODEL;
  delete process.env.AI_TRANSCRIPTION_USD_PER_MINUTE;
});
afterAll(() => { config.whatsapp.accessToken = ''; });

describe('llmProviderService.transcribe', () => {
  test('uses the organization\'s enabled OpenAI provider and returns the text', async () => {
    const result = await llm.transcribe({ orgId: 3, audio: AUDIO, mimeType: 'audio/ogg; codecs=opus', language: 'es' });
    expect(result).toEqual({ text: 'No tengo internet desde ayer.', providerId: 9, cost_usd: 0.012 });
    expect(db.query.mock.calls[0][0]).toMatch(/organization_id = \? AND kind = 'openai' AND enabled = 1 AND deleted_at IS NULL/);
    expect(db.query.mock.calls[0][1]).toEqual([3]);
    expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'example-openai-key' }));
    expect(mockCreate).toHaveBeenCalledWith({
      file: { name: 'voice.ogg', type: 'audio/ogg', size: 300000 }, model: 'gpt-transcribe', language: 'es',
    });
  });

  test('counts against the AI budget: checked before, recorded after', async () => {
    await llm.transcribe({ orgId: 3, audio: AUDIO });
    expect(aiBudget.assertWithinBudget).toHaveBeenCalledWith(3);
    expect(aiBudget.recordUsage).toHaveBeenCalledWith(3, { providerId: 9, operation: 'transcribe', costUsd: 0.012 });

    jest.clearAllMocks();
    aiBudget.assertWithinBudget.mockRejectedValue(Object.assign(new Error('over'), { code: 'AI_BUDGET_EXCEEDED' }));
    db.query.mockResolvedValue([[PROVIDER]]);
    await expect(llm.transcribe({ orgId: 3, audio: AUDIO })).rejects.toMatchObject({ code: 'AI_BUDGET_EXCEEDED' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('the model and the price can be set from the environment', async () => {
    process.env.AI_TRANSCRIPTION_MODEL = 'another-model';
    process.env.AI_TRANSCRIPTION_USD_PER_MINUTE = '0.003';
    const result = await llm.transcribe({ orgId: 3, audio: AUDIO });
    expect(mockCreate.mock.calls[0][0].model).toBe('another-model');
    expect(result.cost_usd).toBe(0.006);
  });

  test('refuses without an OpenAI provider, without audio, or with a format the model does not take', async () => {
    await expect(llm.transcribe({ orgId: 3, audio: AUDIO, mimeType: 'audio/amr' })).rejects.toMatchObject({ code: 'LLM_TRANSCRIBE_UNSUPPORTED_AUDIO' });
    await expect(llm.transcribe({ orgId: 3, audio: Buffer.alloc(0) })).rejects.toMatchObject({ code: 'LLM_MISSING_AUDIO' });
    await expect(llm.transcribe({ audio: AUDIO })).rejects.toMatchObject({ code: 'LLM_MISSING_ORG' });
    db.query.mockResolvedValue([[]]);
    await expect(llm.transcribe({ orgId: 3, audio: AUDIO })).rejects.toMatchObject({ code: 'LLM_TRANSCRIBE_NOT_CONFIGURED' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('whatsappVoice.transcribe', () => {
  const download = jest.fn();
  const fakeLlm = { transcriptionProvider: jest.fn(), transcribe: jest.fn() };
  const run = (over = {}) => voice.transcribe(
    { orgId: 3, provider: 'meta', audio: { id: 'media123', mimeType: 'audio/ogg' }, locale: 'es', ...over },
    { download, llm: fakeLlm },
  );
  beforeEach(() => {
    download.mockReset().mockResolvedValue({ audio: AUDIO, mimeType: 'audio/ogg; codecs=opus' });
    fakeLlm.transcriptionProvider.mockReset().mockResolvedValue(PROVIDER);
    fakeLlm.transcribe.mockReset().mockResolvedValue({ text: 'no  tengo\ninternet' });
  });

  test('downloads the note and returns its text on one line', async () => {
    expect(await run()).toBe('no tengo internet');
    expect(download).toHaveBeenCalledWith('media123');
    expect(fakeLlm.transcribe).toHaveBeenCalledWith({ orgId: 3, audio: AUDIO, mimeType: 'audio/ogg; codecs=opus', language: 'es' });
  });

  test('is not attempted when the assistant is off for WhatsApp', async () => {
    AiPolicy.findByOrgId.mockResolvedValue({ enabled: 1, enabled_channels: { whatsapp: false, portal: true } });
    expect(await run()).toBeNull();
    AiPolicy.findByOrgId.mockResolvedValue({ enabled: 0, enabled_channels: { whatsapp: true } });
    expect(await run()).toBeNull();
    expect(download).not.toHaveBeenCalled();
    expect(fakeLlm.transcribe).not.toHaveBeenCalled();
  });

  test('is not attempted without an OpenAI provider, an organization, or on Twilio', async () => {
    fakeLlm.transcriptionProvider.mockResolvedValue(null);
    expect(await run()).toBeNull();
    fakeLlm.transcriptionProvider.mockResolvedValue(PROVIDER);
    expect(await run({ orgId: null })).toBeNull();
    expect(await run({ provider: 'twilio' })).toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  test('every failure is a null, never an error', async () => {
    download.mockRejectedValue(new Error('media is larger than the limit'));
    expect(await run()).toBeNull();
    download.mockResolvedValue({ audio: AUDIO, mimeType: 'audio/ogg' });
    fakeLlm.transcribe.mockRejectedValue(new Error('provider down'));
    expect(await run()).toBeNull();
    fakeLlm.transcribe.mockResolvedValue({ text: '   ' });
    expect(await run()).toBeNull();
  });

  test('a very long transcript is cut', async () => {
    fakeLlm.transcribe.mockResolvedValue({ text: 'a'.repeat(5000) });
    expect((await run()).length).toBe(voice.MAX_TRANSCRIPT_CHARS);
  });
});

describe('downloading from Meta', () => {
  const meta = body => Buffer.from(JSON.stringify(body));

  test('asks Meta where the file is, then fetches it with the same token', async () => {
    const fetch = jest.fn()
      .mockResolvedValueOnce(meta({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'audio/ogg; codecs=opus', file_size: 300000 }))
      .mockResolvedValueOnce(AUDIO);
    const result = await voice.downloadMetaMedia('media123', { fetch });
    expect(result).toEqual({ audio: AUDIO, mimeType: 'audio/ogg; codecs=opus' });
    expect(fetch.mock.calls[0][0]).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/media123$/);
    expect(fetch.mock.calls[1]).toEqual(['https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', 'example-meta-token', { maxBytes: voice.MAX_AUDIO_BYTES }]);
  });

  test('never sends the token to a host that is not Meta\'s', async () => {
    for (const url of ['https://files.example.com/a.ogg', 'http://lookaside.fbsbx.com/a.ogg', 'https://fbsbx.com.example.com/a.ogg', '']) {
      const fetch = jest.fn().mockResolvedValueOnce(meta({ url, mime_type: 'audio/ogg', file_size: 1000 }));
      await expect(voice.downloadMetaMedia('media123', { fetch })).rejects.toThrow(/media URL/);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  test('refuses a note over the size limit before downloading it, and a malformed media id', async () => {
    const fetch = jest.fn().mockResolvedValueOnce(meta({ url: 'https://lookaside.fbsbx.com/x', file_size: voice.MAX_AUDIO_BYTES + 1 }));
    await expect(voice.downloadMetaMedia('media123', { fetch })).rejects.toThrow(/larger than the limit/);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(voice.downloadMetaMedia('../v1/secret', { fetch: jest.fn() })).rejects.toThrow(/invalid media id/);
  });
});

test('a Meta audio message is parsed with its media id and no text', () => {
  const req = { body: { entry: [{ changes: [{ value: { metadata: { display_phone_number: '5215500000000' }, messages: [
    { id: 'wamid.9', from: '5215512345678', type: 'audio', audio: { id: 'media123', mime_type: 'audio/ogg; codecs=opus', voice: true } },
  ] } }] }] } };
  expect(webhookSvc.parseInboundMessages('meta', req)).toEqual([
    { providerMessageId: 'wamid.9', from: '5215512345678', to: '5215500000000', body: '', audio: { id: 'media123', mimeType: 'audio/ogg; codecs=opus' } },
  ]);
});

test('migration 015 adds the transcribe operation only when missing', () => {
  const fs = require('fs');
  const path = require('path');
  const read = dir => fs.readFileSync(path.join(__dirname, '..', 'database', dir, '015_ai_usage_transcribe.sql'), 'utf8');
  expect(read('migrations')).toMatch(/NOT LIKE '%''transcribe''%'[\s\S]*ENUM\('chat','embed','transcribe'\)/);
  expect(read('rollbacks')).toMatch(/DELETE FROM ai_usage_events WHERE operation = 'transcribe'[\s\S]*ENUM\('chat','embed'\)/);
});

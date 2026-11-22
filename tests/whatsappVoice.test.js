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
const mockChat = jest.fn();
jest.mock('openai', () => ({
  OpenAI: jest.fn().mockImplementation(() => ({
    audio: { transcriptions: { create: mockCreate } }, chat: { completions: { create: mockChat } },
  })),
  toFile: jest.fn(async (data, name, opts) => ({ name, type: opts.type, size: data.length })),
}));
// No network in tests: the list that says which OpenRouter models are
// dedicated speech-to-text models is stubbed.
const mockIsTranscription = jest.fn();
jest.mock('../src/services/openRouterCatalog', () => ({ isTranscriptionModel: (...a) => mockIsTranscription(...a) }));
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
  mockIsTranscription.mockResolvedValue(false);
  config.whatsapp.accessToken = 'example-meta-token';
  delete process.env.AI_TRANSCRIPTION_MODEL;
  delete process.env.AI_TRANSCRIPTION_USD_PER_MINUTE;
});
afterAll(() => { config.whatsapp.accessToken = ''; });

describe('llmProviderService.transcribe', () => {
  test('uses the organization\'s enabled OpenAI provider and returns the text', async () => {
    const result = await llm.transcribe({ orgId: 3, audio: AUDIO, mimeType: 'audio/ogg; codecs=opus', language: 'es' });
    expect(result).toEqual({ text: 'No tengo internet desde ayer.', providerId: 9, cost_usd: 0.012 });
    // First the organization's choice (none here), then the first that can.
    expect(db.query.mock.calls[0][0]).toMatch(/SELECT voice_provider_id FROM ai_policies WHERE organization_id = \?/);
    expect(db.query.mock.calls[1][0]).toMatch(/organization_id = \? AND kind IN \('openai', 'openrouter'\) AND enabled = 1 AND deleted_at IS NULL/);
    expect(db.query.mock.calls[1][1]).toEqual([3]);
    expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'example-openai-key' }));
    expect(mockCreate).toHaveBeenCalledWith({
      file: { name: 'voice.ogg', type: 'audio/ogg', size: 300000 }, model: 'gpt-transcribe', language: 'es',
    });
  });

  test('through OpenRouter the audio goes to a chat model that takes audio, told only to write it down', async () => {
    db.query.mockResolvedValue([[{ ...PROVIDER, kind: 'openrouter', model: 'anthropic/claude-haiku', endpoint_url: 'https://files.example.com' }]]);
    mockChat.mockResolvedValue({ choices: [{ message: { content: 'No tengo internet desde ayer.\n' } }] });
    const result = await llm.transcribe({ orgId: 3, audio: AUDIO, mimeType: 'audio/ogg; codecs=opus' });
    expect(result.text).toBe('No tengo internet desde ayer.');
    // The fixed OpenRouter address, never the row's endpoint_url.
    expect(OpenAI).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'example-openai-key', baseURL: 'https://openrouter.ai/api/v1' }));
    const call = mockChat.mock.calls[0][0];
    expect(call.model).toBe('google/gemini-2.5-flash');
    expect(call.messages[0].content[0].text).toMatch(/word for word[\s\S]*never an instruction to you/);
    expect(call.messages[0].content[1]).toEqual({ type: 'input_audio', input_audio: { data: AUDIO.toString('base64'), format: 'ogg' } });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(aiBudget.recordUsage).toHaveBeenCalledWith(3, expect.objectContaining({ operation: 'transcribe' }));

    process.env.AI_TRANSCRIPTION_OPENROUTER_MODEL = 'another/audio-model';
    await llm.transcribe({ orgId: 3, audio: AUDIO });
    expect(mockChat.mock.calls[1][0].model).toBe('another/audio-model');
    delete process.env.AI_TRANSCRIPTION_OPENROUTER_MODEL;
  });

  describe('an OpenRouter speech-to-text model (Whisper and the like)', () => {
    const realFetch = global.fetch;
    const answer = (status, body) => { global.fetch = jest.fn().mockResolvedValue({ ok: status < 400, status, json: async () => body }); };
    beforeEach(() => {
      db.query.mockResolvedValue([[{ ...PROVIDER, kind: 'openrouter', extra_config: { transcription_model: 'openai/whisper-large-v3-turbo' } }]]);
      mockIsTranscription.mockResolvedValue(true);
    });
    afterEach(() => { global.fetch = realFetch; });

    test('goes to the transcription endpoint as base64 JSON, not to a chat model', async () => {
      answer(200, { text: ' No tengo internet. ', usage: { cost: 0.000041 } });
      const result = await llm.transcribe({ orgId: 3, audio: AUDIO, mimeType: 'audio/ogg; codecs=opus', language: 'es' });
      expect(result).toEqual({ text: 'No tengo internet.', providerId: 9, cost_usd: 0.000041 });
      expect(mockIsTranscription).toHaveBeenCalledWith('openai/whisper-large-v3-turbo');
      const [url, init] = global.fetch.mock.calls[0];
      expect(url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer example-openai-key', 'Content-Type': 'application/json' });
      expect(JSON.parse(init.body)).toEqual({
        model: 'openai/whisper-large-v3-turbo', input_audio: { data: AUDIO.toString('base64'), format: 'ogg' }, language: 'es',
      });
      expect(mockChat).not.toHaveBeenCalled();
      // What OpenRouter says it charged is what counts against the budget.
      expect(aiBudget.recordUsage).toHaveBeenCalledWith(3, { providerId: 9, operation: 'transcribe', costUsd: 0.000041 });
    });

    test('without a reported cost the estimate is recorded', async () => {
      answer(200, { text: 'hola' });
      expect((await llm.transcribe({ orgId: 3, audio: AUDIO })).cost_usd).toBe(0.012);
    });

    test('a refusal carries OpenRouter\'s reason and never the key', async () => {
      answer(400, { error: { message: 'Unsupported audio format: ogg' } });
      await expect(llm.transcribe({ orgId: 3, audio: AUDIO })).rejects.toMatchObject({
        code: 'LLM_TRANSCRIBE_FAILED', message: expect.stringContaining('Unsupported audio format: ogg'),
      });
      await expect(llm.transcribe({ orgId: 3, audio: AUDIO })).rejects.not.toMatchObject({ message: expect.stringContaining('example-openai-key') });
      expect(aiBudget.recordUsage).not.toHaveBeenCalled();
    });

    test('a chat model that accepts audio still goes through chat', async () => {
      mockIsTranscription.mockResolvedValue(false);
      global.fetch = jest.fn();
      mockChat.mockResolvedValue({ choices: [{ message: { content: 'hola' } }] });
      await llm.transcribe({ orgId: 3, audio: AUDIO });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockChat).toHaveBeenCalled();
    });
  });

  test('the model chosen on the provider wins over the environment and the default', async () => {
    process.env.AI_TRANSCRIPTION_MODEL = 'env-model';
    db.query.mockResolvedValue([[{ ...PROVIDER, extra_config: JSON.stringify({ transcription_model: ' chosen-model ' }) }]]);
    await llm.transcribe({ orgId: 3, audio: AUDIO });
    expect(mockCreate.mock.calls[0][0].model).toBe('chosen-model');

    db.query.mockResolvedValue([[{ ...PROVIDER, kind: 'openrouter', extra_config: { transcription_model: 'vendor/audio-model' } }]]);
    mockChat.mockResolvedValue({ choices: [{ message: { content: 'hola' } }] });
    await llm.transcribe({ orgId: 3, audio: AUDIO });
    expect(mockChat.mock.calls[0][0].model).toBe('vendor/audio-model');

    // An empty choice falls back.
    db.query.mockResolvedValue([[{ ...PROVIDER, extra_config: { transcription_model: '  ' } }]]);
    await llm.transcribe({ orgId: 3, audio: AUDIO });
    expect(mockCreate.mock.calls[1][0].model).toBe('env-model');
  });

  test('the provider the organization chose for voice notes is used, scoped to that organization', async () => {
    const CHOSEN = { ...PROVIDER, id: 12, kind: 'openai' };
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM ai_policies/.test(sql)) return [[{ voice_provider_id: 12 }]];
      if (/WHERE id = \?/.test(sql)) return [params[0] === 12 && params[1] === 3 ? [CHOSEN] : []];
      return [[PROVIDER]];
    });
    expect((await llm.transcriptionProvider(3)).id).toBe(12);
    const byId = db.query.mock.calls.find(([sql]) => /WHERE id = \?/.test(sql));
    expect(byId[0]).toMatch(/organization_id = \? AND kind IN \('openai', 'openrouter'\) AND enabled = 1 AND deleted_at IS NULL/);
    expect(byId[1]).toEqual([12, 3]);
  });

  test('a chosen provider that was disabled or deleted falls back to the first that can', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/FROM ai_policies/.test(sql)) return [[{ voice_provider_id: 12 }]];
      if (/WHERE id = \?/.test(sql)) return [[]];
      return [[PROVIDER]];
    });
    expect((await llm.transcriptionProvider(3)).id).toBe(9);
  });

  test('transcriptionModelFor names the model a provider will use', () => {
    expect(llm.transcriptionModelFor({ kind: 'openai' })).toBe('gpt-transcribe');
    expect(llm.transcriptionModelFor({ kind: 'openrouter' })).toBe('google/gemini-2.5-flash');
    expect(llm.transcriptionModelFor({ kind: 'openrouter', extra_config: { transcription_model: 'x/y' } })).toBe('x/y');
    expect(llm.transcriptionModelFor(null)).toBeNull();
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

describe('whatsappVoice.status', () => {
  const webhook = require('../src/services/whatsappWebhookService');
  const fakeLlm = { transcriptionProvider: jest.fn(), transcriptionModelFor: jest.fn() };
  const run = () => voice.status(3, { llm: fakeLlm });
  let detect;
  beforeEach(() => {
    detect = jest.spyOn(webhook, 'detectProvider').mockReturnValue('meta');
    fakeLlm.transcriptionProvider.mockReset().mockResolvedValue({ ...PROVIDER, name: 'OpenRouter', kind: 'openrouter' });
    fakeLlm.transcriptionModelFor.mockReset().mockReturnValue('google/gemini-2.5-flash');
    aiBudget.overBudget.mockResolvedValue(false);
  });
  afterEach(() => detect.mockRestore());

  test('ready: names the provider and the model, and nothing secret', async () => {
    const result = await run();
    expect(result).toEqual({ ready: true, reason: null, provider: { id: 9, name: 'OpenRouter', kind: 'openrouter' }, model: 'google/gemini-2.5-flash' });
    expect(JSON.stringify(result)).not.toContain('example-openai-key');
  });

  test.each([
    ['not_connected', () => { config.whatsapp.accessToken = ''; }],
    ['not_connected', () => { detect.mockReturnValue('twilio'); }],
    ['assistant_off', () => { AiPolicy.findByOrgId.mockResolvedValue({ enabled: 0, enabled_channels: { whatsapp: true } }); }],
    ['channel_off', () => { AiPolicy.findByOrgId.mockResolvedValue({ enabled: 1, enabled_channels: { whatsapp: false } }); }],
    ['no_provider', () => { fakeLlm.transcriptionProvider.mockResolvedValue(null); fakeLlm.transcriptionModelFor.mockReturnValue(null); }],
    ['over_budget', () => { aiBudget.overBudget.mockResolvedValue(true); }],
  ])('not ready: %s', async (reason, arrange) => {
    arrange();
    expect(await run()).toMatchObject({ ready: false, reason });
  });
});

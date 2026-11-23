'use strict';
// =============================================================================
// The command-line session an OLT driver runs on
// =============================================================================
// An OLT has no API: it is driven through its interactive command line. The
// session must cope with what that command line does (pagers, parameter
// hints) and must never answer a yes/no question, since a command that asks
// one is changing something.
// =============================================================================

jest.mock('../src/utils/logger', () => ({ child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));

const { CliSession, fingerprintOf, openSsh, clean } = require('../src/services/olt/cliSession');
const { scriptedOlt } = require('./helpers/scriptedOlt');

async function sessionWith(answers, opts) {
  const olt = scriptedOlt(answers, opts);
  const session = new CliSession(olt.stream, { timeoutMs: 500 });
  const banner = await session.ready();
  return { session, olt, banner };
}

describe('running a command', () => {
  test('returns what the device printed, without the echo or the prompt', async () => {
    const { session, banner } = await sessionWith({ 'display version': '  VERSION : MA5800V100R019C10\n  PRODUCT : MA5800-X7' });
    expect(banner).toMatch(/Huawei Integrated Access Software/);
    // Indentation is kept: the drivers read aligned tables.
    await expect(session.run('display version')).resolves.toBe('  VERSION : MA5800V100R019C10\n  PRODUCT : MA5800-X7');
    expect(session.prompt).toBe('MA5800-X7>');
  });

  test('follows the prompt into privileged and nested modes', async () => {
    const { session } = await sessionWith({ enable: '' });
    await session.run('enable');
    expect(session.prompt).toBe('MA5800-X7#');
    for (const prompt of ['MA5800-X7(config)#', 'MA5800-X7(config-if-gpon-0/1)#', 'olt-norte.core>']) {
      expect(/(?:^|\n)([\w.-]{1,64}(?:\([\w./-]{1,64}\))?[>#])[ \t]*$/.test(`output\n${prompt}`)).toBe(true);
    }
  });

  test('pages through long output and joins it', async () => {
    const { session, olt } = await sessionWith({ 'display board 0': { pages: ['line 1\r\nline 2', 'line 3', 'line 4'] } });
    const out = await session.run('display board 0');
    expect(out.split('\n').map((l) => l.trim()).filter(Boolean)).toEqual(['line 1', 'line 2', 'line 3', 'line 4']);
    expect(out).not.toMatch(/More/);
    expect(olt.typed).toEqual(['display board 0']);
  });

  test('answers a parameter hint with Enter, once', async () => {
    const { session } = await sessionWith({ 'display ont autofind all': { hint: '{ <cr>|brief<K> }:', output: '  Number : 1' } });
    await expect(session.run('display ont autofind all')).resolves.toBe('  Number : 1');
  });

  test('never answers a yes/no question', async () => {
    const { session } = await sessionWith({ 'reboot system': { ask: ' Are you sure to reboot system? (y/n)[n]:' } });
    await expect(session.run('reboot system')).rejects.toMatchObject({ code: 'CONFIRMATION_REQUESTED' });
    // The session is unusable afterwards rather than left mid-question.
    await expect(session.run('display version')).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
  });

  test('one call is one line: control characters and newlines are refused before anything is sent', async () => {
    const { session, olt } = await sessionWith({});
    for (const bad of ['display version\nreboot system', 'display\x03', '   ', 'a\rb']) {
      await expect(session.run(bad)).rejects.toMatchObject({ code: 'INVALID_COMMAND' });
    }
    expect(olt.typed).toEqual([]);
  });

  test('a silent device times out', async () => {
    const { Duplex } = require('stream');
    const stream = new Duplex({ read() {}, write(_c, _e, done) { done(); } });
    const session = new CliSession(stream, { timeoutMs: 30 });
    await expect(session.ready()).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  test('terminal control sequences are removed', () => {
    expect(clean('\x1b[37Dabc\r\ndef\x08\x08')).toBe('abc\ndef');
  });
});

describe('SSH transport', () => {
  class FakeClient {
    constructor() { this.handlers = {}; FakeClient.last = this; }
    on(event, fn) { this.handlers[event] = fn; return this; }
    end() { this.ended = true; }
    shell(_opts, cb) { cb(null, scriptedOlt({}).stream); }
    connect(options) {
      this.options = options;
      const accepted = options.hostVerifier(Buffer.from(FakeClient.hostKey));
      if (accepted) setImmediate(() => this.handlers.ready());
    }
  }

  test('reports the host key it saw, so the first connection can pin it', async () => {
    FakeClient.hostKey = 'key-one';
    const opened = await openSsh({ host: '10.20.0.5', username: 'vigabss', password: 'x' }, { Client: FakeClient });
    expect(opened.hostKeyFingerprint).toBe(fingerprintOf(Buffer.from('key-one')));
    expect(opened.hostKeyFingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    opened.session.close();
    expect(FakeClient.last.ended).toBe(true);
  });

  test('a different key than the pinned one is refused before the shell is opened', async () => {
    FakeClient.hostKey = 'key-two';
    await expect(openSsh({
      host: '10.20.0.5', username: 'vigabss', password: 'x', hostKeyFingerprint: fingerprintOf(Buffer.from('key-one')),
    }, { Client: FakeClient })).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED', seenFingerprint: fingerprintOf(Buffer.from('key-two')) });
  });

  test('old ciphers are offered only when asked for, after the modern ones', async () => {
    FakeClient.hostKey = 'key-one';
    (await openSsh({ host: '10.20.0.5', username: 'u', password: 'x' }, { Client: FakeClient })).session.close();
    expect(FakeClient.last.options.algorithms).toBeUndefined();
    (await openSsh({ host: '10.20.0.5', username: 'u', password: 'x', legacyAlgorithms: true }, { Client: FakeClient })).session.close();
    expect(FakeClient.last.options.algorithms.kex).toEqual({ append: expect.arrayContaining(['diffie-hellman-group1-sha1']) });
  });

  test('the platform\'s own network is not a valid OLT address', () => {
    for (const host of ['127.0.0.1', '169.254.169.254', 'olt.example.com']) {
      expect(() => openSsh({ host, username: 'u', password: 'x' }, { Client: FakeClient })).toThrow();
    }
  });
});

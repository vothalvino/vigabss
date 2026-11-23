// =============================================================================
// VigaBSS 5.0 — an interactive command-line session with a network device
// =============================================================================
// An OLT is managed through its command line: there is no API. This drives
// that command line over SSH the way an operator does, one command at a time:
// send the command, read until the prompt comes back, hand the text to a
// parser.
//
// Three things an interactive CLI does that a script must answer:
//   - a pager ("---- More ( Press 'Q' to break ) ----"): send a space;
//   - a parameter hint ("{ <cr>|ontid<U><0,255> }:"), shown when a command
//     could take more words: send Enter to run it as typed;
//   - a yes/no question: NEVER answered here. A command that asks one is not
//     a read, so the session fails instead of confirming anything.
//
// The session is transport-agnostic (any duplex stream), so the same code is
// exercised in tests against a scripted OLT. openSsh() is the SSH transport.
//
// Host keys are pinned on first use: the fingerprint seen on the first
// connection is stored by the caller and every later connection must present
// the same key, so a device (or anything pretending to be it) that answers
// with another key is refused before the password is sent.
// =============================================================================

const crypto = require('node:crypto');
const { assertManagementTarget } = require('../../utils/managementTarget');

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g; // eslint-disable-line no-control-regex
// hostname, optionally a mode in brackets, then > (user) or # (privileged).
const PROMPT = /(?:^|\n)([\w.-]{1,64}(?:\([\w./-]{1,64}\))?[>#])[ \t]*$/;
const PAGER = /-{2,}\s*More\s*\([^)]*\)\s*-{2,}[ \t]*$/;
const PARAM_HINT = /\{[^{}\n]*\}:[ \t]*$/;
const YES_NO = /\((?:y\/n|yes\/no)\)\s*(?:\[[yn]\])?\s*:?[ \t]*$/i;

class CliError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** Remove terminal control sequences and normalise line endings. */
function clean(text) {
  return String(text).replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/\x08+/g, ''); // eslint-disable-line no-control-regex
}

class CliSession {
  /**
   * @param {import('node:stream').Duplex} stream
   * @param {{ timeoutMs?: number, maxOutputBytes?: number, onClose?: Function }} [opts]
   */
  constructor(stream, opts = {}) {
    this.stream = stream;
    this.timeoutMs = opts.timeoutMs || 15000;
    this.maxOutputBytes = opts.maxOutputBytes || 4 * 1024 * 1024;
    this.onClose = opts.onClose || (() => {});
    this.buffer = '';
    this.waiter = null;
    this.closed = false;
    this.prompt = null;
    this.transcript = [];
    stream.on('data', (chunk) => this._onData(chunk));
    stream.on('close', () => this._fail(new CliError('The device closed the session', 'SESSION_CLOSED')));
    stream.on('error', (err) => this._fail(new CliError(`Session error: ${err.message}`, 'SESSION_ERROR')));
  }

  _fail(err) {
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) { clearTimeout(waiter.timer); waiter.reject(err); }
  }

  _onData(chunk) {
    this.buffer += clean(chunk.toString('utf8'));
    if (this.buffer.length > this.maxOutputBytes) {
      this._fail(new CliError('The device sent more output than expected', 'OUTPUT_TOO_LARGE'));
      return;
    }
    if (!this.waiter) return;
    if (YES_NO.test(this.buffer)) {
      this._fail(new CliError('The device asked for a confirmation; nothing was confirmed', 'CONFIRMATION_REQUESTED'));
      return;
    }
    if (PAGER.test(this.buffer)) {
      this.buffer = this.buffer.replace(PAGER, '');
      this.stream.write(' ');
      return;
    }
    if (PARAM_HINT.test(this.buffer)) {
      // Run the command as typed. Only once per command: a second hint would
      // mean the device wants something this code does not know about.
      if (this.waiter.hinted) {
        this._fail(new CliError('The device asked for more parameters than expected', 'UNEXPECTED_PROMPT'));
        return;
      }
      this.waiter.hinted = true;
      this.buffer = this.buffer.replace(PARAM_HINT, '');
      this.stream.write('\n');
      return;
    }
    const match = PROMPT.exec(this.buffer);
    if (!match) return;
    const waiter = this.waiter;
    this.waiter = null;
    clearTimeout(waiter.timer);
    this.prompt = match[1];
    const output = this.buffer.slice(0, match.index);
    this.buffer = '';
    waiter.resolve(output);
  }

  _wait(timeoutMs) {
    if (this.closed) return Promise.reject(new CliError('The session is closed', 'SESSION_CLOSED'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new CliError('The device did not answer in time', 'TIMEOUT'));
      }, timeoutMs || this.timeoutMs);
      this.waiter = { resolve, reject, timer, hinted: false };
      // Data may already be buffered (the banner and first prompt).
      this._onData(Buffer.alloc(0));
    });
  }

  /** Wait for the first prompt after login. Returns the banner text. */
  async ready(timeoutMs) {
    return this._wait(timeoutMs);
  }

  /**
   * Run one command and return what it printed (without the echoed command).
   * A control character or a newline in `command` is refused: one call sends
   * exactly one line.
   */
  async run(command, { timeoutMs } = {}) {
    const line = String(command);
    if (!line.trim() || /[\x00-\x1f\x7f]/.test(line)) { // eslint-disable-line no-control-regex
      throw new CliError('A command must be one line of printable characters', 'INVALID_COMMAND');
    }
    this.buffer = '';
    const pending = this._wait(timeoutMs);
    this.stream.write(`${line}\n`);
    const raw = await pending;
    this.transcript.push(line);
    // Drop the echo of the command (the first line) and surrounding blanks.
    const lines = raw.split('\n');
    if (lines.length && lines[0].trim().endsWith(line.trim())) lines.shift();
    return lines.join('\n').replace(/^\n+|\s+$/g, '');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.stream.end(); } catch (_) { /* already gone */ }
    this.onClose();
  }
}

// Older OLT software only offers key exchange and ciphers current SSH clients
// have dropped. They are added AFTER the modern ones, and only when asked for.
const LEGACY_ALGORITHMS = Object.freeze({
  kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group1-sha1'],
  cipher: ['aes128-cbc', 'aes256-cbc', '3des-cbc'],
  serverHostKey: ['ssh-rsa', 'ssh-dss'],
  hmac: ['hmac-sha1'],
});

/** SHA-256 fingerprint of a host key, in OpenSSH's form. */
function fingerprintOf(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Open a CLI session over SSH.
 *
 * @param {object} conn
 * @param {string} conn.host        literal IP; checked against the management-target rules
 * @param {number} [conn.port=22]
 * @param {string} conn.username
 * @param {string} conn.password
 * @param {string|null} [conn.hostKeyFingerprint]  pinned key; null accepts and reports the one seen
 * @param {boolean} [conn.legacyAlgorithms=false]
 * @param {number} [conn.timeoutMs=15000]
 * @returns {Promise<{ session: CliSession, hostKeyFingerprint: string, banner: string }>}
 */
function openSsh(conn, { Client = require('ssh2').Client } = {}) {
  assertManagementTarget(conn && conn.host, 'host');
  const timeoutMs = conn.timeoutMs || 15000;
  const client = new Client();
  let seenFingerprint = null;

  const algorithms = conn.legacyAlgorithms
    ? Object.fromEntries(Object.entries(LEGACY_ALGORITHMS).map(([k, v]) => [k, { append: v }]))
    : undefined;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(err);
    };
    client.on('error', (err) => {
      const unreachable = ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(err.code) || err.level === 'client-timeout';
      const authFailed = err.level === 'client-authentication';
      fail(new CliError(
        authFailed ? 'The device refused the user name or password' : `Could not connect: ${err.message}`,
        authFailed ? 'AUTH_FAILED' : unreachable ? 'UNREACHABLE' : 'CONNECT_FAILED',
      ));
    });
    client.on('ready', () => {
      client.shell({ term: 'vt100', cols: 250, rows: 1000 }, (err, stream) => {
        if (err) { fail(new CliError(`Could not open a command line: ${err.message}`, 'SHELL_FAILED')); return; }
        const session = new CliSession(stream, { timeoutMs, onClose: () => client.end() });
        session.ready(timeoutMs).then((banner) => {
          settled = true;
          resolve({ session, hostKeyFingerprint: seenFingerprint, banner });
        }, fail);
      });
    });
    client.connect({
      host: conn.host,
      port: conn.port || 22,
      username: conn.username,
      password: conn.password,
      // Huawei's SSH server offers "password"; some builds only keyboard-interactive.
      tryKeyboard: true,
      readyTimeout: timeoutMs,
      keepaliveInterval: 0,
      algorithms,
      hostVerifier: (key) => {
        seenFingerprint = fingerprintOf(key);
        if (conn.hostKeyFingerprint && conn.hostKeyFingerprint !== seenFingerprint) {
          fail(new CliError(
            'The device presented a different host key than the one saved for it. Nothing was sent.',
            'HOST_KEY_CHANGED',
            { seenFingerprint },
          ));
          return false;
        }
        return true;
      },
    });
    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => conn.password));
    });
  });
}

module.exports = { CliSession, CliError, openSsh, fingerprintOf, clean, LEGACY_ALGORITHMS };

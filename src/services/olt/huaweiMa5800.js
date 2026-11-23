// =============================================================================
// VigaBSS 5.0 — Huawei MA5800 / EA5800 OLT driver (read operations)
// =============================================================================
// Talks to the OLT's command line through a CliSession. This file knows two
// things: which command answers a question, and how to read what the OLT
// prints back. Reading is done by small pure functions (parse*), so they are
// tested on their own against captured output.
//
// STATUS: written from Huawei's command reference and exercised against a
// scripted OLT. It has NOT run against real hardware. Output layouts differ
// between software releases, so every operation also returns the raw text it
// parsed (`raw`): when a release prints something this code does not
// recognise, the operator still sees what the OLT said, and the parser can be
// corrected from it.
//
// Only "display" commands are sent, plus the three that set up the session
// (enable, undo smart, scroll). Nothing here changes the OLT's configuration.
// =============================================================================

const { CliError } = require('./cliSession');

const FSP = /^(\d{1,2})\/(\d{1,2})\/(\d{1,3})$/;

/** "0/1/3" -> { frame, slot, port }, or a CliError for anything else. */
function parseFsp(value) {
  const m = FSP.exec(String(value ?? '').replace(/\s+/g, ''));
  if (!m) throw new CliError('A PON port is written frame/slot/port, for example 0/1/0', 'INVALID_PORT');
  return { frame: Number(m[1]), slot: Number(m[2]), port: Number(m[3]) };
}

/** The OLT's own error line ("Failure: ..." or "% ..."), or null. */
function failureOf(output) {
  const line = String(output).split('\n').map((l) => l.trim())
    .find((l) => /^Failure\s*:/i.test(l) || /^%\s*\S/.test(l));
  return line ? line.replace(/^Failure\s*:\s*/i, '').replace(/^%\s*/, '') : null;
}

const num = (text) => {
  const n = Number(String(text).trim());
  return Number.isFinite(n) && String(text).trim() !== '' && String(text).trim() !== '-' ? n : null;
};
const dash = (text) => {
  const t = String(text ?? '').trim();
  return t === '' || t === '-' ? null : t;
};

/**
 * `display version`
 *   VERSION : MA5800V100R019C10
 *   PATCH   : SPH210
 *   PRODUCT : MA5800-X7
 *   Uptime is 12 day(s), 3 hour(s), 4 minute(s), 5 second(s)
 */
function parseVersion(output) {
  const field = (name) => {
    const m = new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, 'im').exec(output);
    return m ? m[1] : null;
  };
  const uptime = /Uptime is\s+(.+?)\s*$/im.exec(output);
  return { version: field('VERSION'), patch: field('PATCH'), product: field('PRODUCT'), uptime: uptime ? uptime[1] : null };
}

/**
 * `display board 0`
 *   SlotID  BoardName  Status          SubType0 SubType1    Online/Offline
 *   -----------------------------------------------------------------------
 *   0
 *   1       H901GPHF   Normal
 *   8       H901MPLA   Active_normal
 * A slot with no board name is empty and is left out.
 */
function parseBoards(output) {
  const boards = [];
  for (const line of String(output).split('\n')) {
    const m = /^\s*(\d{1,2})\s+([A-Z0-9]{4,})\s+(\S+)(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[4].trim().split(/\s+/).filter(Boolean);
    const online = rest.find((w) => /^(online|offline)$/i.test(w));
    const name = m[2];
    boards.push({
      slot: Number(m[1]),
      board: name,
      status: m[3],
      online: online ? online.toLowerCase() === 'online' : null,
      // GP* boards are GPON, XG*/TW*/CG* carry XG(S)-PON; MP*/SC* are control.
      kind: /^H\d{3}(GP|XG|TW|CG|CS)/.test(name) ? 'pon' : /^H\d{3}(MP|SC)/.test(name) ? 'control' : 'other',
    });
  }
  return boards;
}

/**
 * `display ont autofind all` prints one block per ONU that is connected but
 * not yet authorised:
 *   Number              : 1
 *   F/S/P               : 0/1/0
 *   Ont SN              : 48575443A1B2C3D4 (HWTC-A1B2C3D4)
 *   VendorID            : HWTC
 *   Ont EquipmentID     : HG8245H
 *   Ont autofind time   : 2026-01-05 10:00:00+08:00
 */
function parseAutofind(output) {
  const found = [];
  let current = null;
  const flush = () => { if (current && current.serial_number && current.port) found.push(current); current = null; };
  for (const line of String(output).split('\n')) {
    const m = /^\s*([A-Za-z/ ]+?)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const value = m[2];
    if (key === 'number') { flush(); current = {}; continue; }
    if (!current) continue;
    if (key === 'f/s/p') current.port = value.replace(/\s+/g, '');
    else if (key === 'ont sn') {
      const sn = /^([0-9A-Fa-f]{16})(?:\s*\(([^)]+)\))?/.exec(value);
      if (sn) { current.serial_number = sn[1].toUpperCase(); current.serial_display = sn[2] || null; }
    } else if (key === 'vendorid') current.vendor_id = dash(value);
    else if (key === 'ont equipmentid') current.model = dash(value);
    else if (key === 'ont softwareversion') current.software_version = dash(value);
    else if (key === 'ont version') current.hardware_version = dash(value);
    else if (key === 'loid') current.loid = dash(value);
    else if (key === 'ont autofind time') current.found_at = dash(value);
  }
  flush();
  return found;
}

/**
 * `display ont info summary <F/S/P>` prints two tables for one PON port:
 *
 *   ONT  Run     Last                Last                Last
 *   ID   State   UpTime              DownTime            DownCause
 *   0    online  2026-01-05 10:00:00 2026-01-03 09:00:00 dying-gasp
 *   1    offline -                   2026-01-03 09:00:00 LOSi/LOBi
 *
 *   ONT        SN        Type          Distance Rx/Tx power  Description
 *   ID                                    (m)      (dBm)
 *   0   48575443A1B2C3D4 HG8245H       1500     -18.52/2.31  client-123
 *   1   48575443A1B2C3D5 HG8310M       -        -/-          client-124
 */
function parseOntSummary(output) {
  const byId = new Map();
  const get = (id) => {
    if (!byId.has(id)) byId.set(id, { ont_id: id });
    return byId.get(id);
  };
  const stamp = '(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}|-)';
  const stateRow = new RegExp(`^\\s*(\\d{1,3})\\s+(online|offline)\\s+${stamp}\\s+${stamp}\\s*(.*?)\\s*$`, 'i');
  const detailRow = /^\s*(\d{1,3})\s+([0-9A-Fa-f]{16})\s+(\S+)\s+(\S+)\s+(-?[\d.]+|-)\s*\/\s*(-?[\d.]+|-)\s*(.*?)\s*$/;
  for (const line of String(output).split('\n')) {
    let m = stateRow.exec(line);
    if (m) {
      Object.assign(get(Number(m[1])), {
        state: m[2].toLowerCase(), last_up: dash(m[3]), last_down: dash(m[4]), last_down_cause: dash(m[5]),
      });
      continue;
    }
    m = detailRow.exec(line);
    if (m) {
      Object.assign(get(Number(m[1])), {
        serial_number: m[2].toUpperCase(), model: dash(m[3]), distance_m: num(m[4]),
        rx_power_dbm: num(m[5]), tx_power_dbm: num(m[6]), description: dash(m[7]),
      });
    }
  }
  const total = /total of ONTs are:\s*(\d+),\s*online:\s*(\d+)/i.exec(output);
  return {
    onus: [...byId.values()].sort((a, b) => a.ont_id - b.ont_id),
    reported_total: total ? Number(total[1]) : null,
    reported_online: total ? Number(total[2]) : null,
  };
}

class HuaweiMa5800 {
  /** @param {import('./cliSession').CliSession} session */
  constructor(session) {
    this.session = session;
  }

  /**
   * Enter privileged mode and make output script-friendly. The two tuning
   * commands are best-effort: where a release lacks one, the session's own
   * handling of pagers and parameter hints covers it.
   */
  async prepare() {
    const out = await this.session.run('enable');
    const failed = failureOf(out);
    if (failed) throw new CliError(`The OLT refused privileged mode: ${failed}`, 'ENABLE_FAILED');
    await this.session.run('undo smart').catch(() => {});
    await this.session.run('scroll 512').catch(() => {});
  }

  async _display(command) {
    if (!/^display [\w ./-]+$/.test(command)) throw new CliError('Only display commands are sent', 'NOT_A_READ');
    return this.session.run(command);
  }

  async systemInfo() {
    const raw = await this._display('display version');
    return { ...parseVersion(raw), raw };
  }

  async boards(frame = 0) {
    const raw = await this._display(`display board ${Number(frame) || 0}`);
    const failed = failureOf(raw);
    if (failed) throw new CliError(`The OLT answered: ${failed}`, 'COMMAND_FAILED', { raw });
    return { boards: parseBoards(raw), raw };
  }

  /** ONUs that are connected but not yet authorised on any port. */
  async unregisteredOnus() {
    const raw = await this._display('display ont autofind all');
    const failed = failureOf(raw);
    // "The automatically found ONTs do not exist" is the OLT's way of saying none.
    if (failed && !/do(es)? not exist/i.test(failed)) throw new CliError(`The OLT answered: ${failed}`, 'COMMAND_FAILED', { raw });
    return { onus: failed ? [] : parseAutofind(raw), raw };
  }

  /** Authorised ONUs on one PON port, with state and optical power. */
  async onusOnPort(fsp) {
    const { frame, slot, port } = parseFsp(fsp);
    const raw = await this._display(`display ont info summary ${frame}/${slot}/${port}`);
    const failed = failureOf(raw);
    if (failed && !/do(es)? not exist|no ont/i.test(failed)) throw new CliError(`The OLT answered: ${failed}`, 'COMMAND_FAILED', { raw });
    const parsed = failed ? { onus: [], reported_total: 0, reported_online: 0 } : parseOntSummary(raw);
    return { port: `${frame}/${slot}/${port}`, ...parsed, raw };
  }
}

module.exports = {
  HuaweiMa5800, parseFsp, failureOf, parseVersion, parseBoards, parseAutofind, parseOntSummary,
};

// =============================================================================
// VigaBSS 5.0 — Huawei MA5800 / EA5800: changes to the OLT
// =============================================================================
// Every change is a PLAN first: an ordered list of the exact command lines,
// built by pure functions from validated values. A plan can be shown to an
// operator before anything is sent, and `apply` then sends exactly those
// lines, checks each answer and stops at the first refusal.
//
// Nothing here answers a yes/no question from the OLT (the session refuses),
// and no value reaches a command line without passing the checks below, so a
// description or a serial number cannot smuggle in another command.
//
// STATUS: command forms follow Huawei's documented provisioning sequence
// (traffic table, ont add, native VLAN, service-port; undo service-port,
// ont delete). They have NOT run against hardware. `ont deactivate` and
// `ont activate` are the least certain. A refused command changes nothing
// and its text is kept in the operation log.
//
// How speed is applied: one service-port per ONU carries the subscriber's
// traffic, and it names two traffic tables (rate limits in kbps): inbound is
// the subscriber's upload, outbound the download. Changing speed replaces
// the service-port with one naming the new tables.
// =============================================================================

const { CliError } = require('./cliSession');
const { parseFsp, failureOf } = require('./huaweiMa5800');

const bad = (message) => new CliError(message, 'INVALID_VALUE');

function int(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}
function serialOf(value) {
  const s = String(value ?? '').trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(s)) throw bad('An ONU serial number is 16 hexadecimal digits');
  return s;
}
/** Free text for a description: letters, digits and a few separators only. */
function descriptionOf(value) {
  // Spaces become dashes; a line break or any other control character is refused.
  const s = String(value ?? '').trim().replace(/ +/g, '-');
  if (!/^[A-Za-z0-9._#-]{1,64}$/.test(s)) throw bad('A description is 1 to 64 letters, digits, dots, dashes or underscores');
  return s;
}

const step = (command, note) => ({ command, note });

/**
 * Create a traffic table (a rate limit) when the OLT does not have it yet.
 * cir = committed, pir = peak, both in kbps; equal here: the plan speed.
 */
function planTrafficTable({ index, name, kbps }) {
  const i = int(index, 'traffic table index', 7, 1023);
  const rate = int(kbps, 'speed', 64, 10000000);
  const label = descriptionOf(name);
  return [
    step('config', 'configuration mode'),
    step(`traffic table ip index ${i} name "${label}" cir ${rate} pir ${rate} priority 0 priority-policy local-setting`, `rate limit of ${rate} kbps`),
    step('quit', 'leave configuration mode'),
  ];
}

/**
 * Authorise an ONU on a PON port and give it service.
 * The ONT id is chosen by the caller (the lowest free one on the port), so
 * the plan is complete before it runs.
 */
function planAuthorise(p) {
  const { frame, slot, port } = parseFsp(p.port);
  const ontId = int(p.ontId, 'ONT id', 0, 255);
  const serial = serialOf(p.serial);
  const line = int(p.lineProfileId, 'line profile', 0, 8191);
  const srv = int(p.srvProfileId, 'service profile', 0, 8191);
  const vlan = int(p.vlan, 'service VLAN', 1, 4093);
  const userVlan = int(p.userVlan ?? p.vlan, 'user VLAN', 1, 4093);
  const gem = int(p.gemPort, 'GEM port', 0, 1023);
  const up = int(p.upTableIndex, 'upload traffic table', 0, 1023);
  const down = int(p.downTableIndex, 'download traffic table', 0, 1023);
  const description = descriptionOf(p.description);
  const steps = [
    step('config', 'configuration mode'),
    step(`interface gpon ${frame}/${slot}`, `board ${frame}/${slot}`),
    step(`ont add ${port} ${ontId} sn-auth "${serial}" omci ont-lineprofile-id ${line} ont-srvprofile-id ${srv} desc "${description}"`, 'authorise the ONU'),
  ];
  if (p.nativeVlanEthPort !== undefined && p.nativeVlanEthPort !== null) {
    const eth = int(p.nativeVlanEthPort, 'ONU Ethernet port', 1, 8);
    steps.push(step(`ont port native-vlan ${port} ${ontId} eth ${eth} vlan ${userVlan} priority 0`, `untagged traffic on the ONU's port ${eth}`));
  }
  steps.push(
    step('quit', 'leave the board'),
    step(`service-port vlan ${vlan} gpon ${frame}/${slot}/${port} ont ${ontId} gemport ${gem} multi-service user-vlan ${userVlan} tag-transform translate inbound traffic-table index ${up} outbound traffic-table index ${down}`, 'carry its traffic, with the speed limits'),
    step('quit', 'leave configuration mode'),
  );
  return steps;
}

/** Replace an ONU's service-port with one naming other traffic tables. */
function planSetSpeed(p) {
  const { frame, slot, port } = parseFsp(p.port);
  const ontId = int(p.ontId, 'ONT id', 0, 255);
  const index = int(p.servicePortIndex, 'service-port', 0, 65535);
  const vlan = int(p.vlan, 'service VLAN', 1, 4093);
  const userVlan = int(p.userVlan ?? p.vlan, 'user VLAN', 1, 4093);
  const gem = int(p.gemPort, 'GEM port', 0, 1023);
  const up = int(p.upTableIndex, 'upload traffic table', 0, 1023);
  const down = int(p.downTableIndex, 'download traffic table', 0, 1023);
  return [
    step('config', 'configuration mode'),
    step(`undo service-port ${index}`, 'remove the old speed limits'),
    step(`service-port ${index} vlan ${vlan} gpon ${frame}/${slot}/${port} ont ${ontId} gemport ${gem} multi-service user-vlan ${userVlan} tag-transform translate inbound traffic-table index ${up} outbound traffic-table index ${down}`, 'the same service with the new speed limits'),
    step('quit', 'leave configuration mode'),
  ];
}

/** Take an ONU off the OLT: its service-ports first, then the ONU. */
function planRemove(p) {
  const { frame, slot, port } = parseFsp(p.port);
  const ontId = int(p.ontId, 'ONT id', 0, 255);
  const indexes = (p.servicePortIndexes || []).map((i) => int(i, 'service-port', 0, 65535));
  return [
    step('config', 'configuration mode'),
    ...indexes.map((i) => step(`undo service-port ${i}`, 'stop carrying its traffic')),
    step(`interface gpon ${frame}/${slot}`, `board ${frame}/${slot}`),
    step(`ont delete ${port} ${ontId}`, 'remove the ONU'),
    step('quit', 'leave the board'),
    step('quit', 'leave configuration mode'),
  ];
}

/** Switch an ONU off or back on without removing it. */
function planSetActive(p) {
  const { frame, slot, port } = parseFsp(p.port);
  const ontId = int(p.ontId, 'ONT id', 0, 255);
  return [
    step('config', 'configuration mode'),
    step(`interface gpon ${frame}/${slot}`, `board ${frame}/${slot}`),
    step(`ont ${p.active ? 'activate' : 'deactivate'} ${port} ${ontId}`, p.active ? 'switch the ONU back on' : 'switch the ONU off'),
    step('quit', 'leave the board'),
    step('quit', 'leave configuration mode'),
  ];
}

/**
 * `display service-port port F/S/P ont N`: rows start with the service-port
 * index and its VLAN, e.g. "  1002  200 common   gpon 0/1 /0  5    2  vlan ..."
 */
function parseServicePorts(output) {
  const found = [];
  for (const line of String(output).split('\n')) {
    const m = /^\s*(\d{1,5})\s+(\d{1,4})\s+\S+\s+gpon\b/i.exec(line);
    if (m) found.push({ index: Number(m[1]), vlan: Number(m[2]) });
  }
  return found;
}

/** "ONTID :100" in the answer to `ont add`. */
function parseAddedOntId(output) {
  const m = /ONTID\s*:\s*(\d+)/i.exec(String(output));
  return m ? Number(m[1]) : null;
}

/**
 * Send a plan. Each line is sent as written; an answer the OLT marks as a
 * failure stops the run. Returns what was sent and what came back, for the
 * operation log. On a failure the session is left wherever the OLT was: the
 * caller closes it, which drops any mode it was in.
 *
 * @param {import('./cliSession').CliSession} session
 * @param {Array<{command:string, note?:string}>} plan
 * @returns {Promise<{ok:boolean, transcript:Array<{command:string, output:string, failed?:string}>, failedAt?:number}>}
 */
async function apply(session, plan) {
  const transcript = [];
  for (let i = 0; i < plan.length; i += 1) {
    const { command } = plan[i];
    let output;
    try {
      output = await session.run(command);
    } catch (err) {
      transcript.push({ command, output: '', failed: err.message });
      return { ok: false, transcript, failedAt: i };
    }
    const failed = failureOf(output);
    transcript.push({ command, output, ...(failed ? { failed } : {}) });
    if (failed) return { ok: false, transcript, failedAt: i };
  }
  return { ok: true, transcript };
}

module.exports = {
  planTrafficTable, planAuthorise, planSetSpeed, planRemove, planSetActive,
  parseServicePorts, parseAddedOntId, apply, serialOf, descriptionOf,
};

// =============================================================================
// VigaBSS 5.0 — CWMP XML Parser/Builder (§8.1/§8.3)
// =============================================================================
// Hand-rolled CWMP/SOAP XML subset. No external XML library.
// Handles: Inform, GetParameterValues/Names/Response, SetParameterValues/Response,
//          Download/Response, TransferComplete, Fault envelopes,
//          FactoryReset, IPPingDiagnostics, TraceRouteDiagnostics (§8.3).
//
// /acs/cwmp is reachable without a session, so parsing must stay linear in
// the body size (NET-05): the old regex helpers rescanned from every '<' and
// a 100 KB body of '<' blocked the event loop for ~25 s. The tokenizer below
// walks the input once with indexOf, ignores namespace prefixes, refuses
// DOCTYPE/ENTITY declarations and caps elements and depth.
// =============================================================================

'use strict';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const MAX_ELEMENTS = 20000;
const MAX_DEPTH = 64;

class CwmpParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CwmpParseError';
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g, (whole, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] !== undefined ? ENTITIES[ref] : whole;
  });
}

const localName = qname => {
  const colon = qname.indexOf(':');
  return (colon === -1 ? qname : qname.slice(colon + 1)).toLowerCase();
};

// Index of the '>' that closes the tag starting at `from`, skipping quoted
// attribute values. Each character is visited once.
function tagEnd(xml, from) {
  let quote = null;
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/**
 * Parse XML into a light element tree: { name (local, lower-case), children, text }.
 * Lenient like the old parser (unclosed or stray end tags are tolerated) but
 * linear, with no entity or DTD processing beyond the five XML entities.
 */
function parseTree(xml) {
  const root = { name: '#document', children: [], text: '' };
  const stack = [root];
  let elements = 0;
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt === -1 ? xml.length : lt;
    if (textEnd > i) stack[stack.length - 1].text += decodeEntities(xml.slice(i, textEnd));
    if (lt === -1) break;

    if (xml.startsWith('<!--', lt)) {
      const close = xml.indexOf('-->', lt + 4);
      i = close === -1 ? xml.length : close + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const close = xml.indexOf(']]>', lt + 9);
      stack[stack.length - 1].text += xml.slice(lt + 9, close === -1 ? xml.length : close);
      i = close === -1 ? xml.length : close + 3;
    } else if (xml.startsWith('<!', lt)) {
      throw new CwmpParseError('DOCTYPE and ENTITY declarations are not accepted');
    } else if (xml.startsWith('<?', lt)) {
      const close = xml.indexOf('?>', lt + 2);
      i = close === -1 ? xml.length : close + 2;
    } else {
      const gt = tagEnd(xml, lt + 1);
      if (gt === -1) break; // truncated tag: ignore the rest
      const inner = xml.slice(lt + 1, gt);
      i = gt + 1;
      if (inner[0] === '/') {
        const name = localName(inner.slice(1).trim());
        // Close up to the matching open element; ignore a stray end tag.
        for (let depth = stack.length - 1; depth > 0; depth--) {
          if (stack[depth].name === name) {
            stack.length = depth;
            break;
          }
        }
        continue;
      }
      const selfClosing = inner.endsWith('/');
      const qname = inner.slice(0, selfClosing ? -1 : undefined).trim().split(/\s/, 1)[0];
      if (!qname) continue;
      if (++elements > MAX_ELEMENTS) throw new CwmpParseError('Too many XML elements');
      const node = { name: localName(qname), children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) {
        if (stack.length > MAX_DEPTH) throw new CwmpParseError('XML nesting is too deep');
        stack.push(node);
      }
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// Tree helpers (tag names match without namespace prefix, case-insensitively)
// ---------------------------------------------------------------------------

/** First descendant element named `tag`, depth-first in document order. */
function findFirst(node, tag) {
  if (!node) return null;
  const want = tag.toLowerCase();
  const pending = [...node.children].reverse();
  while (pending.length) {
    const current = pending.pop();
    if (current.name === want) return current;
    for (let k = current.children.length - 1; k >= 0; k--) pending.push(current.children[k]);
  }
  return null;
}

/** All descendants named `tag` that are not nested inside another match. */
function findAll(node, tag) {
  const want = tag.toLowerCase();
  const results = [];
  const pending = [...node.children].reverse();
  while (pending.length) {
    const current = pending.pop();
    if (current.name === want) {
      results.push(current);
      continue;
    }
    for (let k = current.children.length - 1; k >= 0; k--) pending.push(current.children[k]);
  }
  return results;
}

/** Trimmed text of the first descendant named `tag`, or null. */
function textOf(node, tag) {
  const found = findFirst(node, tag);
  return found ? found.text.trim() : null;
}

/**
 * Escape XML special characters.
 */
function xmlEscape(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const MESSAGE_TYPES = [
  'Inform', 'GetParameterValuesResponse', 'SetParameterValuesResponse',
  'GetParameterNamesResponse', 'DownloadResponse', 'TransferCompleteResponse', 'Fault',
];
const MESSAGE_TYPE_BY_NAME = new Map(MESSAGE_TYPES.map(t => [t.toLowerCase(), t]));

/**
 * Detect the CWMP message type: the first known RPC element in the SOAP Body
 * (or anywhere, when there is no Body).
 */
function detectMessageType(tree) {
  const body = findFirst(tree, 'Body') || tree;
  const pending = [...body.children].reverse();
  while (pending.length) {
    const current = pending.pop();
    const type = MESSAGE_TYPE_BY_NAME.get(current.name);
    if (type) return { type, node: current };
    for (let k = current.children.length - 1; k >= 0; k--) pending.push(current.children[k]);
  }
  return { type: 'Unknown', node: body };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseParameterValues(node) {
  return findAll(node, 'ParameterValueStruct').map(block => ({
    name: textOf(block, 'Name') || '',
    value: textOf(block, 'Value') || '',
  }));
}

function parseInform(node) {
  const devIdBlock = findFirst(node, 'DeviceId');
  const pick = tag => (devIdBlock && textOf(devIdBlock, tag)) || textOf(node, tag) || '';
  const deviceId = {
    manufacturer: pick('Manufacturer'),
    oui: pick('OUI'),
    productClass: pick('ProductClass'),
    serialNumber: pick('SerialNumber'),
    hwVersion: textOf(node, 'HardwareVersion') || '',
    swVersion: textOf(node, 'SoftwareVersion') || '',
  };

  const events = findAll(node, 'EventStruct').map(block => ({
    code: textOf(block, 'EventCode') || '',
    commandKey: textOf(block, 'CommandKey') || '',
  }));

  return { deviceId, events, parameters: parseParameterValues(node) };
}

function parseGetParameterValuesResponse(node) {
  return { parameterList: parseParameterValues(node) };
}

function parseSetParameterValuesResponse(node) {
  const statusStr = textOf(node, 'Status') || '0';
  return { status: parseInt(statusStr, 10) || 0 };
}

function parseGetParameterNamesResponse(node) {
  const parameterList = findAll(node, 'ParameterInfoStruct').map((block) => {
    const writable = textOf(block, 'Writable');
    return { name: textOf(block, 'Name') || '', writable: writable === '1' || writable === 'true' };
  });
  return { parameterList };
}

function parseFault(node) {
  // The CWMP fault sits inside <detail>; the outer SOAP <faultcode> is generic.
  const inner = findFirst(node, 'detail') || node;
  return {
    faultCode: textOf(inner, 'FaultCode') || '',
    faultString: textOf(inner, 'FaultString') || '',
  };
}

// ---------------------------------------------------------------------------
// Public: parseCwmpEnvelope
// ---------------------------------------------------------------------------

/**
 * Parse a CWMP SOAP envelope string.
 * @param {string} xmlString
 * @returns {{ messageType: string, id: string, payload: object }}
 * @throws {CwmpParseError} on a DOCTYPE/ENTITY declaration or an oversized tree
 */
function parseCwmpEnvelope(xmlString) {
  const tree = parseTree(String(xmlString || ''));
  const { type, node } = detectMessageType(tree);
  const id = textOf(tree, 'ID') || `ID-${Date.now()}`;

  let messageType = type;
  let payload;
  switch (type) {
    case 'Inform':
      payload = parseInform(node);
      // §8.3: a DiagnosticsComplete arrives as an Inform with event code
      // '8 DIAGNOSTICS COMPLETE'.
      if (payload.events.some(e => e.code.toUpperCase() === '8 DIAGNOSTICS COMPLETE')) {
        messageType = 'DiagnosticsComplete';
      }
      break;
    case 'GetParameterValuesResponse':
      payload = parseGetParameterValuesResponse(node);
      break;
    case 'SetParameterValuesResponse':
      payload = parseSetParameterValuesResponse(node);
      break;
    case 'GetParameterNamesResponse':
      payload = parseGetParameterNamesResponse(node);
      break;
    case 'Fault':
      payload = parseFault(node);
      break;
    default:
      payload = {};
  }

  return { messageType, id, payload };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const SOAP_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:cwmp="urn:dslforum-org:cwmp-1-0"
                  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`;

function wrapEnvelope(messageId, bodyContent) {
  return `${SOAP_HEADER}
  <soapenv:Header>
    <cwmp:ID soapenv:mustUnderstand="1">${xmlEscape(messageId)}</cwmp:ID>
  </soapenv:Header>
  <soapenv:Body>
    ${bodyContent}
  </soapenv:Body>
</soapenv:Envelope>`;
}

function buildInformResponse(messageId) {
  return wrapEnvelope(messageId, `<cwmp:InformResponse>
      <MaxEnvelopes>1</MaxEnvelopes>
    </cwmp:InformResponse>`);
}

function buildGetParameterValues(messageId, params) {
  const names = (params.parameterNames || [])
    .map(n => `      <string>${xmlEscape(n)}</string>`)
    .join('\n');
  return wrapEnvelope(messageId, `<cwmp:GetParameterValues>
      <ParameterNames soapenv:arrayType="xsd:string[${(params.parameterNames || []).length}]">
${names}
      </ParameterNames>
    </cwmp:GetParameterValues>`);
}

function buildSetParameterValues(messageId, params) {
  const items = (params.parameterValueList || [])
    .map(p => `      <ParameterValueStruct>
        <Name>${xmlEscape(p.name)}</Name>
        <Value xsi:type="${xmlEscape(p.type || 'xsd:string')}">${xmlEscape(p.value)}</Value>
      </ParameterValueStruct>`)
    .join('\n');
  const count = (params.parameterValueList || []).length;
  return wrapEnvelope(messageId, `<cwmp:SetParameterValues>
      <ParameterList soapenv:arrayType="cwmp:ParameterValueStruct[${count}]">
${items}
      </ParameterList>
      <ParameterKey></ParameterKey>
    </cwmp:SetParameterValues>`);
}

function buildGetParameterNames(messageId, params) {
  return wrapEnvelope(messageId, `<cwmp:GetParameterNames>
      <ParameterPath>${xmlEscape(params.parameterPath || '')}</ParameterPath>
      <NextLevel>${params.nextLevel ? '1' : '0'}</NextLevel>
    </cwmp:GetParameterNames>`);
}

function buildDownload(messageId, params) {
  return wrapEnvelope(messageId, `<cwmp:Download>
      <CommandKey>${xmlEscape(params.commandKey || '')}</CommandKey>
      <FileType>${xmlEscape(params.fileType || '1 Firmware Upgrade Image')}</FileType>
      <URL>${xmlEscape(params.url || '')}</URL>
      <Username></Username>
      <Password></Password>
      <FileSize>${params.fileSize || 0}</FileSize>
      <TargetFileName></TargetFileName>
      <DelaySeconds>0</DelaySeconds>
      <SuccessURL></SuccessURL>
      <FailureURL></FailureURL>
    </cwmp:Download>`);
}

function buildReboot(messageId) {
  return wrapEnvelope(messageId, `<cwmp:Reboot>
      <CommandKey>reboot</CommandKey>
    </cwmp:Reboot>`);
}

// §8.3 — FactoryReset RPC
function buildFactoryReset(messageId) {
  return wrapEnvelope(messageId, '<cwmp:FactoryReset></cwmp:FactoryReset>');
}

// §8.3 — IPPingDiagnostics: first SetParameterValues to configure, then GetParameterValues for results.
// We use a SetParameterValues to kick off the diagnostic by writing DiagnosticsState=Requested.
function buildStartPingDiagnostic(messageId, params) {
  const host = params.host || '8.8.8.8';
  const count = params.numberOfRepetitions || 3;
  const timeout = params.timeout || 1000;
  // Standard TR-098/TR-181 diagnostic path
  const basePath = params.basePath || 'InternetGatewayDevice.IPPingDiagnostics.';
  const pvList = [
    { name: `${basePath}DiagnosticsState`, value: 'Requested', type: 'xsd:string' },
    { name: `${basePath}Host`,             value: String(host), type: 'xsd:string' },
    { name: `${basePath}NumberOfRepetitions`, value: String(count), type: 'xsd:unsignedInt' },
    { name: `${basePath}Timeout`,          value: String(timeout), type: 'xsd:unsignedInt' },
  ];
  return buildSetParameterValues(messageId, { parameterValueList: pvList });
}

// §8.3 — TraceRouteDiagnostics: SetParameterValues to start
function buildStartTracerouteDiagnostic(messageId, params) {
  const host = params.host || '8.8.8.8';
  const maxHops = params.maxHopCount || 30;
  const basePath = params.basePath || 'InternetGatewayDevice.TraceRouteDiagnostics.';
  const pvList = [
    { name: `${basePath}DiagnosticsState`, value: 'Requested', type: 'xsd:string' },
    { name: `${basePath}Host`,             value: String(host), type: 'xsd:string' },
    { name: `${basePath}MaxHopCount`,      value: String(maxHops), type: 'xsd:unsignedInt' },
  ];
  return buildSetParameterValues(messageId, { parameterValueList: pvList });
}

// §8.3 — Read diagnostic results: GetParameterValues for the results subtree
function buildGetDiagnosticResults(messageId, params) {
  const paths = params.paths || [];
  return buildGetParameterValues(messageId, { parameterNames: paths });
}

function buildEmpty(messageId) {
  return wrapEnvelope(messageId, '');
}

// ---------------------------------------------------------------------------
// Public: buildCwmpResponse
// ---------------------------------------------------------------------------

/**
 * Build a CWMP SOAP response/request XML string.
 * @param {string} messageId
 * @param {string} type - 'InformResponse'|'GetParameterValues'|'SetParameterValues'|
 *                        'GetParameterNames'|'Download'|'Reboot'|'FactoryReset'|
 *                        'StartPingDiagnostic'|'StartTracerouteDiagnostic'|
 *                        'GetDiagnosticResults'|'Empty'
 * @param {object} [params]
 * @returns {string}
 */
function buildCwmpResponse(messageId, type, params = {}) {
  switch (type) {
    case 'InformResponse':              return buildInformResponse(messageId);
    case 'GetParameterValues':          return buildGetParameterValues(messageId, params);
    case 'SetParameterValues':          return buildSetParameterValues(messageId, params);
    case 'GetParameterNames':           return buildGetParameterNames(messageId, params);
    case 'Download':                    return buildDownload(messageId, params);
    case 'Reboot':                      return buildReboot(messageId);
    case 'FactoryReset':                return buildFactoryReset(messageId);
    case 'StartPingDiagnostic':         return buildStartPingDiagnostic(messageId, params);
    case 'StartTracerouteDiagnostic':   return buildStartTracerouteDiagnostic(messageId, params);
    case 'GetDiagnosticResults':        return buildGetDiagnosticResults(messageId, params);
    case 'Empty':
    default:                            return buildEmpty(messageId);
  }
}

module.exports = {
  parseCwmpEnvelope,
  CwmpParseError,
  buildCwmpResponse,
  // Export individual builders for diagnostics service
  buildStartPingDiagnostic,
  buildStartTracerouteDiagnostic,
  buildGetDiagnosticResults,
  buildFactoryReset,
};

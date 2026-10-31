// =============================================================================
// VigaBSS 5.0 — Safe values for generated RouterOS scripts (.rsc)
// =============================================================================
// Exported scripts are run with /import on a MikroTik, so every stored string
// written into one must stay a single value. Free text (names, comments,
// parents, marks) goes through rosQuote, which wraps it in double quotes and
// escapes the characters RouterOS treats specially inside quotes: backslash,
// double quote and `$` (variable expansion, including `$[...]` command
// substitution). Control characters (CR/LF end the command) are refused.
// Unquoted tokens such as ports go through rosToken with a strict pattern.
// =============================================================================

const { ValidationError } = require('./errors');

// U+0000-U+001F and U+007F, built from char codes because a literal control
// range in a regex trips no-control-regex.
const CONTROL_RANGE = `${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}`;
const CONTROL_CHARS = new RegExp(`[${CONTROL_RANGE}]`);

// A stored value that cannot be written safely fails the export with a 422
// instead of producing a script that runs something else.
class RouterosScriptError extends ValidationError {
  constructor(message) {
    super(message);
    this.name = 'RouterosScriptError';
  }
}

/**
 * Quote a value for use in a RouterOS script.
 * @param {*} value
 * @returns {string} the value wrapped in double quotes
 */
function rosQuote(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (CONTROL_CHARS.test(text)) {
    throw new RouterosScriptError('RouterOS script values cannot contain control characters or line breaks');
  }
  return `"${text.replace(/[\\"$]/g, ch => `\\${ch}`)}"`;
}

/**
 * Return value unchanged when it matches pattern, otherwise throw. For values
 * written unquoted (ports, numbers, keys, addresses).
 * @param {*} value
 * @param {RegExp} pattern
 * @param {string} label
 */
function rosToken(value, pattern, label) {
  const text = String(value);
  if (!pattern.test(text)) {
    throw new RouterosScriptError(`${label} is not a valid RouterOS value`);
  }
  return text;
}

// Shared patterns, also used by the request schemas so bad values are refused
// when saved rather than when exported.
const PORT_RANGE_PATTERN = /^[0-9]{1,5}(-[0-9]{1,5})?(,[0-9]{1,5}(-[0-9]{1,5})?)*$/;
const MARK_PATTERN = /^[A-Za-z0-9_.-]{1,20}$/;
const SAFE_NAME_PATTERN = new RegExp(`^[^${CONTROL_RANGE}"\\\\$]+$`);

// Edit forms send '' for a cleared optional field; the exports skip it.
const blankOr = pattern => new RegExp(`^(?:${pattern.source.slice(1, -1)})?$`);

module.exports = {
  rosQuote,
  rosToken,
  RouterosScriptError,
  PORT_RANGE_PATTERN,
  MARK_PATTERN,
  SAFE_NAME_PATTERN,
  blankOr,
};

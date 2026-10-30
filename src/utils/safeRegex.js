// =============================================================================
// VigaBSS 5.0 — Safe user-supplied regular expressions
// =============================================================================
// Tenant admins author config-compliance rules whose `pattern` is compiled with
// `new RegExp()` and run against a whole device config export. V8's backtracking
// engine has no timeout, so a catastrophic pattern such as `(a+)+$` against a
// long non-matching line blocks the event loop for every tenant on the process.
//
// No RE2 / safe-regex dependency is installed, and adding one is out of scope,
// so this module applies three cheap, conservative guards instead:
//   1. a hard pattern-length cap;
//   2. a structural heuristic that rejects the classic super-linear shapes —
//      an unbounded quantifier applied to a group that itself contains an
//      unbounded quantifier (`(a+)+`, `(a*)*`, `(\w+\s?)*`, `(?:x{2,})+`), and
//      backreferences (which make matching NP-hard in general);
//   3. a per-evaluation cap on the subject length (see MAX_REGEX_SUBJECT_LENGTH).
// It is a heuristic, not a proof: it errs toward rejecting, and anything it
// rejects is recorded as a rule `error` rather than evaluated.
// =============================================================================

const MAX_REGEX_PATTERN_LENGTH = 500;
// RouterOS / IOS exports are typically tens to a few hundred KB; 2 MiB leaves
// generous headroom while bounding the work a single regex evaluation can do.
const MAX_REGEX_SUBJECT_LENGTH = 2 * 1024 * 1024;

/**
 * Classify the quantifier starting at pattern[i], if any.
 * @returns {{ length: number, unbounded: boolean } | null}
 */
function readQuantifier(pattern, i) {
  const ch = pattern[i];
  let length;
  let unbounded = false;
  if (ch === '*' || ch === '+') {
    length = 1;
    unbounded = true;
  } else if (ch === '?') {
    length = 1;
  } else if (ch === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i, i + 32));
    if (!m) return null; // literal '{'
    length = m[0].length;
    // {n,} is unbounded; {n,m} with a large m behaves like one for backtracking.
    unbounded = m[2] !== undefined && (m[3] === '' || Number(m[3]) > 32);
  } else {
    return null;
  }
  // Lazy / possessive-looking suffix does not change the backtracking shape.
  if (pattern[i + length] === '?') length += 1;
  return { length, unbounded };
}

/**
 * Return a human-readable reason the pattern is unsafe, or null if it passes.
 * Does NOT check syntax — call compileSafeRegex for that.
 * @param {string} pattern
 * @returns {string|null}
 */
function findUnsafeReason(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return 'pattern must be a non-empty string';
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return `pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} characters`;
  }

  // Stack of open groups; each frame records whether an unbounded quantifier
  // occurs anywhere inside it.
  const stack = [{ hasUnbounded: false }];
  let inClass = false;
  let lastClosedGroup = null; // frame of a group that just closed

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];

    if (ch === '\\') {
      const next = pattern[i + 1];
      if (!inClass && next !== undefined && /[1-9]/.test(next)) return 'backreferences are not allowed';
      if (!inClass && next === 'k' && pattern[i + 2] === '<') return 'backreferences are not allowed';
      i += 1; // skip escaped char
      lastClosedGroup = null;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      lastClosedGroup = null;
      continue;
    }
    if (ch === '(') {
      stack.push({ hasUnbounded: false });
      lastClosedGroup = null;
      continue;
    }
    if (ch === ')') {
      if (stack.length > 1) {
        const frame = stack.pop();
        if (frame.hasUnbounded) stack[stack.length - 1].hasUnbounded = true;
        lastClosedGroup = frame;
      }
      continue;
    }

    const q = readQuantifier(pattern, i);
    if (q) {
      if (q.unbounded) {
        if (lastClosedGroup && lastClosedGroup.hasUnbounded) {
          return 'nested unbounded quantifiers (e.g. (a+)+) are not allowed';
        }
        stack[stack.length - 1].hasUnbounded = true;
      }
      i += q.length - 1;
      lastClosedGroup = null;
      continue;
    }
    lastClosedGroup = null;
  }
  return null;
}

/**
 * Validate and compile a user-supplied pattern.
 * @param {string} pattern
 * @returns {{ ok: true, regex: RegExp } | { ok: false, reason: string }}
 */
function compileSafeRegex(pattern) {
  const reason = findUnsafeReason(pattern);
  if (reason) return { ok: false, reason };
  try {
    return { ok: true, regex: new RegExp(pattern) };
  } catch (err) {
    return { ok: false, reason: `invalid regular expression: ${err.message}` };
  }
}

module.exports = {
  MAX_REGEX_PATTERN_LENGTH,
  MAX_REGEX_SUBJECT_LENGTH,
  findUnsafeReason,
  compileSafeRegex,
};

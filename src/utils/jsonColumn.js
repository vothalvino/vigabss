// =============================================================================
// JSON column values
// =============================================================================
// mysql2 returns a JSON column already decoded (an object, array or scalar);
// JSON.parse on that value throws or, for an array of strings, re-parses its
// text. Older rows, test doubles and VARCHAR columns hand back the JSON text.
// Accept both (DB-05).
// =============================================================================

/**
 * @param {*} value     a JSON column value as the driver returned it
 * @param {*} fallback  returned for NULL / empty
 */
function parseJsonColumn(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (Buffer.isBuffer(value)) return parseJsonColumn(value.toString('utf8'), fallback);
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

module.exports = { parseJsonColumn };

'use strict';

// =============================================================================
// CSV cells for files staff open in a spreadsheet (TNA-25)
// =============================================================================
// A cell that starts with = + - @ (or a tab, CR, LF or space before one) is
// run as a formula by Excel, LibreOffice and Google Sheets, so a client name
// such as =HYPERLINK(...) planted by anyone with clients.update executed on the
// machine of whoever exported it. Such text gets a leading apostrophe, which
// spreadsheets show as plain text. A number is left alone: -150.00 is a value,
// not a formula, and must stay numeric.
//
// Not for machine-read wire formats with a fixed layout (the SNII batch file):
// the apostrophe would change the submitted data.
// =============================================================================

const FORMULA_START = /^[\t\r\n =+\-@]/;
const NUMERIC = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;

// DATE/DATETIME columns arrive from mysql2 as Date objects; String(d) dumps
// "Wed Aug 12 2026 00:00:00 GMT+0000 (…)". A DATE is UTC midnight, so it is
// written as the bare day; anything with a time keeps "YYYY-MM-DD HH:mm:ss".
function formatValue(value) {
  if (!(value instanceof Date)) return String(value);
  const iso = value.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = formatValue(value);
  if (typeof value === 'string' && FORMULA_START.test(text) && !NUMERIC.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {object[]} rows
 * @param {string[]} [columns] - defaults to the first row's keys
 * @param {{ eol?: string }} [opts]
 */
function toCsv(rows, columns, { eol = '\n' } = {}) {
  if (!rows || rows.length === 0) return '';
  const cols = columns || Object.keys(rows[0]);
  return [cols.map(csvCell).join(','), ...rows.map((row) => cols.map((c) => csvCell(row[c])).join(','))].join(eol);
}

module.exports = { csvCell, toCsv, formatValue };

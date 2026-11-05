'use strict';

// =============================================================================
// Business dates (BIL-34)
// =============================================================================
// The containers and every MySQL session run in UTC, so CURRENT_DATE,
// CURDATE() and new Date().toISOString().slice(0, 10) all gave the UTC day.
// In Mexico City (UTC-6) that is tomorrow from 18:00: a payment taken at
// 19:00 on 31 March was dated 1 April, an invoice issued that evening fell in
// the next month, and an invoice due "today" was overdue six hours early.
//
// A business date is the calendar day in BUSINESS_TIMEZONE (default
// America/Mexico_City). Timestamps stay UTC; only calendar days (payment,
// issue, entry and start dates, "due before today") use this.
// =============================================================================

const DEFAULT_TIMEZONE = 'America/Mexico_City';

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

let warned = false;

/** The configured business time zone (an IANA name). */
function businessTimezone() {
  const configured = (process.env.BUSINESS_TIMEZONE || '').trim();
  if (!configured) return DEFAULT_TIMEZONE;
  if (isValidTimezone(configured)) return configured;
  if (!warned) {
    warned = true;
    require('./logger').warn({ BUSINESS_TIMEZONE: configured }, `Unknown BUSINESS_TIMEZONE; using ${DEFAULT_TIMEZONE}`);
  }
  return DEFAULT_TIMEZONE;
}

const formatters = new Map();
function formatterFor(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }));
  }
  return formatters.get(tz);
}

/**
 * The business calendar day of an instant, as YYYY-MM-DD.
 * @param {Date|number|string} [instant] - defaults to now
 */
function businessDate(instant = new Date(), tz = businessTimezone()) {
  const date = instant instanceof Date ? instant : new Date(instant);
  // en-CA formats as YYYY-MM-DD.
  return formatterFor(tz).format(date);
}

/** Today's business date, YYYY-MM-DD. */
function businessToday() {
  return businessDate(new Date());
}

/**
 * A business date `days` after (or before, if negative) another, YYYY-MM-DD.
 * Calendar arithmetic on the day itself, so no time zone is involved.
 * @param {string} ymd
 * @param {number} days
 */
function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The first day of the business month containing `ymd` (default today). */
function startOfMonth(ymd = businessToday()) {
  return `${ymd.slice(0, 7)}-01`;
}

/** The last day of the business month containing `ymd` (default today). */
function endOfMonth(ymd = businessToday()) {
  const d = new Date(`${ymd.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d.toISOString().slice(0, 10);
}

const offsetFormatters = new Map();
// Minutes the zone is ahead of UTC at an instant (Mexico City: -360).
function offsetMinutes(instant, tz) {
  if (!offsetFormatters.has(tz)) {
    offsetFormatters.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }));
  }
  const name = offsetFormatters.get(tz).formatToParts(instant).find(p => p.type === 'timeZoneName')?.value || 'GMT';
  const m = name.match(/^GMT([+-])(\d{2}):?(\d{2})?$/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/**
 * The UTC instant a business day begins: midnight of `ymd` in the business
 * zone. For a range of TIMESTAMP columns stored in UTC, such as "paid in
 * January" = [start of 1 Jan, start of 1 Feb).
 * @param {string} ymd
 */
function businessDayStartUtc(ymd, tz = businessTimezone()) {
  const [y, m, d] = ymd.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d);
  // The offset at the guess, then at the corrected instant (a DST change on
  // that day moves it once).
  let instant = wall - offsetMinutes(new Date(wall), tz) * 60000;
  instant = wall - offsetMinutes(new Date(instant), tz) * 60000;
  return new Date(instant);
}

/**
 * Today's business date as a SQL DATE literal, for comparisons such as
 * `due_date < ${sqlBusinessToday()}` in place of CURDATE() or NOW(), which
 * are the UTC day. The value comes from businessDate's own formatter and is
 * checked, so it is safe to inline.
 */
function sqlBusinessToday() {
  const today = businessToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error(`Unexpected business date: ${today}`);
  return `DATE('${today}')`;
}

module.exports = {
  DEFAULT_TIMEZONE, businessTimezone, businessDate, businessToday, sqlBusinessToday, addDays, startOfMonth, endOfMonth, isValidTimezone,
  businessDayStartUtc,
};

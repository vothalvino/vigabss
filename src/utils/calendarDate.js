// =============================================================================
// VigaBSS 5.0 — calendar dates that do not depend on the machine's time zone
// =============================================================================
// A calendar date (a billing period's first day, an invoice's due date, the
// first of the month) is kept as a JS Date at 00:00 UTC of that day. That is
// what the database driver returns for a DATE column and what it writes back
// (its `timezone` is '+00:00'), and what 'YYYY-MM-DD' parses to.
//
// JavaScript's plain getters and setters (getDate, setMonth, new Date(y, m,
// d), ...) work in the PROCESS's time zone. The application's container runs
// in UTC, where the two agree, so nothing was wrong there; on a machine in
// another zone the same code landed on other days: a period that should
// start on the 1st was stored as the last day of the month before, and the
// row just written could not be found again.
//
// Everything here uses the UTC calendar, so a process in any time zone gets
// the result a UTC process gets. Month arithmetic keeps JavaScript's own
// overflow rule (31 January plus one month is 3 March, or 2 March in a leap
// year), as the code it replaces did.
// =============================================================================

/** 00:00 UTC of the UTC calendar day `value` falls on. */
function utcDay(value = new Date()) {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** `value` moved by whole days; the time of day is kept. */
function addDays(value, days) {
  const d = new Date(value);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** `value` moved by whole months; the day of the month and time of day are kept. */
function addMonths(value, months) {
  const d = new Date(value);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/** `value` on another day of its month. */
function onDayOfMonth(value, day) {
  const d = new Date(value);
  d.setUTCDate(day);
  return d;
}

/** 'YYYY-MM-DD' of the UTC calendar day. */
function ymd(value = new Date()) {
  return new Date(value).toISOString().slice(0, 10);
}

/** 'YYYY-MM-01' of the month `offset` months from the one `value` is in. */
function firstOfMonth(value = new Date(), offset = 0) {
  const d = new Date(value);
  return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)));
}

/** 'YYYY-MM-DD' of the last day of the month `offset` months from the one `value` is in. */
function lastOfMonth(value = new Date(), offset = 0) {
  const d = new Date(value);
  return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset + 1, 0)));
}

/** Whole calendar months from `from` to `to` (negative when `to` is earlier). */
function monthsBetween(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

module.exports = { utcDay, addDays, addMonths, onDayOfMonth, ymd, firstOfMonth, lastOfMonth, monthsBetween };

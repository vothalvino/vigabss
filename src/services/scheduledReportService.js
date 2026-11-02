// =============================================================================
// VigaBSS 5.0 — Scheduled Report Service
// =============================================================================
// Generates reports per schedule and emails them to recipients.
// =============================================================================

const { toCsv: sharedToCsv } = require('../utils/csv');
const db = require('../config/database');
const reportService = require('./reportService');
const emailTransport = require('./emailTransport');
const logger = require('../utils/logger');
// schedule.report_def_name (below) is DB-stored text interpolated raw into
// the HTML report-delivery email — escape it.
const { escapeHtmlForTemplate: esc } = require('./notificationService');
const { orgScopeFilter } = require('./organizationFanOut');
const { parseJsonColumn } = require('../utils/jsonColumn');
const cron = require('node-cron');
const cronParser = require('cron-parser');
const { ValidationError } = require('../utils/errors');

/**
 * The next time a schedule's cron_expression fires after `from`, in the
 * process timezone the task scheduler uses. Reports were re-run every hour
 * whatever the schedule said (ASY-13).
 */
function nextRunAt(cronExpression, from = new Date()) {
  return cronParser.parseExpression(cronExpression, { currentDate: from }).next().toDate();
}

const MAX_RECIPIENTS = 20;

/**
 * Who may receive an organization's scheduled reports: its active staff who
 * can view reports. The attachment can carry subscriber identities, IPs and
 * fiscal data, so an arbitrary external address is refused (ASY-14).
 * @returns {Promise<Map<string, number>>} lower-cased email → user id
 */
async function allowedRecipients(organizationId) {
  const User = require('../models/User');
  const staff = await User.getUsersWithPermission(organizationId, 'reports.view');
  return new Map(staff.filter(u => u.email).map(u => [String(u.email).toLowerCase(), u.id]));
}

/**
 * Validate a recipients list for a schedule of `organizationId`.
 * @returns {Promise<string[]>} the normalized addresses
 */
async function assertValidRecipients(organizationId, recipients) {
  if (recipients === null || recipients === undefined) return [];
  if (!Array.isArray(recipients) || recipients.length > MAX_RECIPIENTS
    || !recipients.every(r => typeof r === 'string' && /^[^\s@]+@[^\s@]+$/.test(r.trim()))) {
    throw new ValidationError(`recipients must be a list of at most ${MAX_RECIPIENTS} email addresses`);
  }
  const normalized = [...new Set(recipients.map(r => r.trim().toLowerCase()))];
  const allowed = await allowedRecipients(organizationId);
  const refused = normalized.filter(email => !allowed.has(email));
  if (refused.length) {
    throw new ValidationError(
      `Scheduled reports can only be sent to active staff of this organization who can view reports: ${refused.join(', ')}`,
    );
  }
  return normalized;
}

/**
 * A schedule acts with its creator's authority: it stops when the creator is
 * archived or inactive or no longer holds reports.schedule.
 */
async function creatorMayStillSchedule(schedule) {
  if (!schedule.created_by) return false;
  const User = require('../models/User');
  const { runInPrimaryContext } = require('../utils/primaryContext');
  const [[creator]] = await runInPrimaryContext(() => db.query(
    'SELECT id, status FROM users WHERE id = ? AND deleted_at IS NULL LIMIT 1',
    [schedule.created_by],
  ));
  if (!creator || creator.status !== 'active') return false;
  return User.hasEffectivePermission(creator.id, schedule.organization_id, 'reports.schedule');
}

/** Throws a 422 unless `cronExpression` is a five-field cron the scheduler can run. */
function assertValidCron(cronExpression) {
  const valid = typeof cronExpression === 'string'
    && cronExpression.trim().split(/\s+/).length === 5
    && cron.validate(cronExpression);
  if (valid) {
    try {
      nextRunAt(cronExpression);
      return;
    } catch (_err) { /* fall through */ }
  }
  throw new ValidationError('cron_expression must be a valid five-field cron expression, e.g. "0 8 * * 1"');
}

/**
 * Process all due scheduled reports.
 * Finds enabled schedules where next_run_at <= NOW(), generates report, emails recipients.
 */
async function processScheduledReports() {
  // Skips isolated organizations' stale primary rows during an install-wide
  // run's primary pass; their own database is processed separately (ASY-06).
  const scope = orgScopeFilter('sr.organization_id', null);
  const [schedules] = await db.query(`
    SELECT sr.*, o.name AS org_name
    FROM scheduled_reports sr
    JOIN organizations o ON o.id = sr.organization_id
    WHERE sr.is_enabled = 1
      AND sr.deleted_at IS NULL
      AND (sr.next_run_at IS NULL OR sr.next_run_at <= NOW())${scope.sql}
  `, scope.params);

  let processed = 0;
  let failed = 0;

  for (const schedule of schedules) {
    try {
      await runSchedule(schedule);
      processed++;
    } catch (err) {
      logger.error({ err, scheduleId: schedule.id }, 'Scheduled report failed');
      // A failed run still waits for its next slot instead of retrying hourly.
      await db.query(
        'UPDATE scheduled_reports SET last_run_at = NOW(), last_status = \'failed\', next_run_at = ? WHERE id = ?',
        [safeNextRunAt(schedule), schedule.id],
      );
      failed++;
    }
  }

  return { processed, failed, total: schedules.length };
}

/**
 * next_run_at after a run. A stored expression the parser rejects (written
 * before validation existed) waits a day rather than re-running every hour.
 */
function safeNextRunAt(schedule) {
  try {
    return nextRunAt(schedule.cron_expression);
  } catch (err) {
    logger.warn({ err, scheduleId: schedule.id, cronExpression: schedule.cron_expression },
      'Scheduled report has an invalid cron_expression');
    return new Date(Date.now() + 24 * 60 * 60 * 1000);
  }
}

/**
 * Run a single schedule: generate report data, format, insert history, email.
 */
async function runSchedule(schedule) {
  const params = parseJsonColumn(schedule.parameters, {});

  if (!await creatorMayStillSchedule(schedule)) {
    await db.query(
      "UPDATE scheduled_reports SET is_enabled = 0, last_run_at = NOW(), last_status = 'failed' WHERE id = ?",
      [schedule.id],
    );
    logger.warn({ scheduleId: schedule.id, createdBy: schedule.created_by },
      'Scheduled report disabled: its creator is inactive or can no longer schedule reports');
    return { reportId: null, recipients: 0, disabled: true };
  }
  // Re-checked at send time: a recipient who left or lost reports.view since
  // the schedule was saved is dropped.
  const allowed = await allowedRecipients(schedule.organization_id);
  const recipients = parseJsonColumn(schedule.recipients, [])
    .map(r => String(r).trim().toLowerCase())
    .filter(email => allowed.has(email));

  // Generate report data
  const data = await generateReportData(schedule.organization_id, schedule.report_def_name, params);

  // Format content
  const { buffer, contentType, extension } = await formatReport(data, schedule.report_def_name, schedule.format);

  // Insert history record
  const [histResult] = await db.query(
    `INSERT INTO generated_reports
       (organization_id, scheduled_report_id, report_def_name, format, status, generated_at)
     VALUES (?, ?, ?, ?, 'completed', NOW())`,
    [schedule.organization_id, schedule.id, schedule.report_def_name, schedule.format],
  );
  const reportId = histResult.insertId;

  // Email recipients
  if (recipients.length > 0) {
    for (const email of recipients) {
      try {
        await emailTransport.sendEmail({
          organizationId: schedule.organization_id,
          operationalRecipient: true,
          to: email,
          subject: `[VigaBSS] Scheduled Report: ${schedule.report_def_name}`,
          html: `<p>Your scheduled report <strong>${esc(schedule.report_def_name)}</strong> is attached.</p>
                 <p>Generated: ${new Date().toLocaleString()}</p>`,
          attachments: [{
            filename: `${schedule.report_def_name}-${new Date().toISOString().slice(0, 10)}.${extension}`,
            content: buffer,
            contentType,
          }],
        });
        await db.query(
          `INSERT INTO report_access_logs
             (organization_id, user_id, report_type, entity_type, entity_id, parameters)
           VALUES (?, ?, ?, 'scheduled_reports', ?, ?)`,
          [schedule.organization_id, allowed.get(email), schedule.report_def_name, schedule.id,
            JSON.stringify({ delivery: 'email', recipient: email, generated_report_id: reportId, created_by: schedule.created_by })],
        );
      } catch (emailErr) {
        logger.warn({ emailErr, email }, 'Failed to email report');
      }
    }
  }

  await db.query(
    `UPDATE scheduled_reports
     SET last_run_at = NOW(), last_status = 'completed', next_run_at = ?
     WHERE id = ?`,
    [safeNextRunAt(schedule), schedule.id],
  );

  return { reportId, recipients: recipients.length };
}

/**
 * Generate report data by dispatching to reportService.
 */
async function generateReportData(organizationId, reportName, params) {
  const from = params.from;
  const to = params.to;
  const months = params.months ? parseInt(params.months, 10) : 12;

  switch (reportName) {
    case 'aging': return reportService.agingReport(organizationId, params);
    case 'financial': return reportService.financialSummary(organizationId, { from, to });
    case 'technicians': return reportService.technicianReport(organizationId, { from, to });
    case 'subscriber-growth': return reportService.subscriberGrowthReport(organizationId, { months });
    case 'revenue-by-period': return reportService.revenueByPeriod(organizationId, params);
    case 'revenue-by-plan': return reportService.revenueByPlan(organizationId, { from, to });
    case 'revenue-by-region': return reportService.revenueByRegion(organizationId, { from, to });
    case 'revenue-by-agent': return reportService.revenueByAgent(organizationId, { from, to });
    case 'cash-flow': return reportService.cashFlowReport(organizationId, { from, to });
    case 'payment-methods': return reportService.paymentMethodBreakdown(organizationId, { from, to });
    case 'churn-revenue': return reportService.churnRevenueImpact(organizationId, { months });
    case 'agent-commissions': return reportService.agentCommissions(organizationId, params);
    case 'tax-summary': return reportService.taxSummary(organizationId, { from, to });
    case 'sat-export': return reportService.satExport(organizationId, { from, to });
    case 'subscriber-counts': return reportService.subscriberCounts(organizationId, { from, to });
    case 'arpu': return reportService.arpuReport(organizationId, { months });
    case 'bandwidth-utilization': return reportService.bandwidthUtilization(organizationId, params);
    case 'top-consumers': return reportService.topConsumers(organizationId, params);
    case 'uptime-by-area': return reportService.uptimeByArea(organizationId, params);
    case 'mttr': return reportService.mttrReport(organizationId, { from, to });
    case 'installation-completion': return reportService.installationCompletion(organizationId, { from, to });
    case 'congested-links': return reportService.congestedLinks(organizationId, params);
    case 'sfp-lifespan': return reportService.sfpLifespan(organizationId);
    case 'optical-degradation': return reportService.opticalDegradation(organizationId, params);
    case 'device-reboots': return reportService.deviceReboots(organizationId, params);
    case 'snmp-poll-success': return reportService.snmpPollSuccess(organizationId, params);
    case 'alert-frequency': return reportService.alertFrequency(organizationId, params);
    case 'capacity-forecast': return reportService.capacityForecast(organizationId, params);
    case 'pon-utilization': return reportService.ponUtilization(organizationId);
    case 'data-retention-compliance': return reportService.dataRetentionCompliance(organizationId);
    case 'ip-assignment-log': return reportService.ipAssignmentLog(organizationId, params);
    case 'subscriber-identity': return reportService.subscriberIdentity(organizationId, { from, to });
    case 'interception-readiness': return reportService.interceptionReadiness(organizationId);
    case 'regulatory-export': return reportService.regulatoryExport(organizationId, { from, to });
    default:
      throw new Error(`Unknown report: ${reportName}`);
  }
}

/**
 * Format report data as CSV, XLSX, or PDF buffer.
 */
async function formatReport(data, reportName, format) {
  const rows = data.rows || data.details || data.months || data.technicians || [];

  if (format === 'csv') {
    const csv = toCSV(rows);
    return { buffer: Buffer.from(csv, 'utf8'), contentType: 'text/csv', extension: 'csv' };
  }

  if (format === 'xlsx') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(reportName);
    if (rows.length > 0) {
      ws.columns = Object.keys(rows[0]).map(k => ({ header: k, key: k }));
      ws.addRows(rows);
    }
    const buffer = await wb.xlsx.writeBuffer();
    return { buffer, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', extension: 'xlsx' };
  }

  if (format === 'pdf') {
    const PDFDocument = require('pdfkit');
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 40 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: 'application/pdf', extension: 'pdf' }));
      doc.on('error', reject);

      doc.fontSize(16).text(`Report: ${reportName}`, { align: 'center' });
      doc.moveDown();
      doc.fontSize(10);

      if (rows.length > 0) {
        const headers = Object.keys(rows[0]);
        doc.text(headers.join(' | '));
        doc.moveDown(0.3);
        for (const row of rows.slice(0, 100)) {
          doc.text(headers.map(h => fmtCell(row[h] ?? '')).join(' | '));
        }
        if (rows.length > 100) doc.text(`... and ${rows.length - 100} more rows`);
      } else {
        doc.text('No data for this report.');
      }

      doc.end();
    });
  }

  throw new Error(`Unsupported format: ${format}`);
}

// DATE/DATETIME columns arrive from mysql2 as JS Date objects; String(d) dumps
// the full "Wed Aug 12 2026 00:00:00 GMT+0000 (…)" form into report cells (CSV
// and the PDF branch above — XLSX is safe, exceljs date-types Date instances).
// A DATE column is UTC midnight → render the bare day; else keep date+time.
function fmtCell(v) {
  if (!(v instanceof Date)) return String(v ?? '');
  const iso = v.toISOString();
  return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

/**
 * Convert array of objects to CSV string.
 */
// utils/csv neutralizes spreadsheet formulas in text cells (TNA-25).
function toCSV(rows) {
  return sharedToCsv(rows);
}

/**
 * Run an on-demand report: generate data, format, insert into generated_reports.
 * Used by POST /reports/generate and POST /scheduled-reports/:id/run.
 *
 * @param {object} opts
 * @param {number} opts.organizationId
 * @param {string} opts.reportDefName  - report slug (e.g. 'aging', 'revenue-by-period')
 * @param {string} opts.format         - 'csv' | 'xlsx' | 'pdf'
 * @param {object} opts.parameters     - optional runtime params { from, to, months, ... }
 * @param {number|null} opts.scheduledReportId - null for pure on-demand
 * @param {number|null} opts.generatedBy       - user id who triggered
 * @returns {{ reportId: number, status: string }}
 */
async function runOnDemand({ organizationId, reportDefName, format = 'csv', parameters = {}, scheduledReportId = null, generatedBy = null }) {
  // Insert a pending history row first so we always have a record
  const [pendingResult] = await db.query(
    `INSERT INTO generated_reports
       (organization_id, scheduled_report_id, report_def_name, format, status, generated_by, generated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, NOW())`,
    [organizationId, scheduledReportId, reportDefName, format, generatedBy],
  );
  const reportId = pendingResult.insertId;

  try {
    // Nothing stores generated files, so the requester receives the report by
    // email, as schedule recipients do (ASY-24). Without an address to send
    // to, the run fails instead of reporting a file nobody can get.
    const [requesters] = generatedBy
      ? await db.query("SELECT email FROM users WHERE id = ? AND status = 'active'", [generatedBy])
      : [[]];
    const email = requesters[0]?.email;
    if (!email) throw new ValidationError('The requesting user has no active email address to receive the report');

    const data = await generateReportData(organizationId, reportDefName, parameters);
    // formatReport is async (xlsx/pdf use streams)
    const { buffer, contentType, extension } = await formatReport(data, reportDefName, format);
    const sent = await emailTransport.sendEmail({
      organizationId,
      operationalRecipient: true,
      to: email,
      subject: `[VigaBSS] Report: ${reportDefName}`,
      html: `<p>The report <strong>${esc(reportDefName)}</strong> you requested is attached.</p>
             <p>Generated: ${new Date().toLocaleString()}</p>`,
      attachments: [{
        filename: `${reportDefName}-${new Date().toISOString().slice(0, 10)}.${extension}`,
        content: buffer,
        contentType,
      }],
    });
    if (!sent?.success) throw new Error(`Report email was not sent: ${sent?.error || 'delivery failed'}`);
    await db.query(
      `INSERT INTO report_access_logs
         (organization_id, user_id, report_type, entity_type, entity_id, parameters)
       VALUES (?, ?, ?, 'generated_reports', ?, ?)`,
      [organizationId, generatedBy, reportDefName, reportId,
        JSON.stringify({ delivery: 'email', recipient: email, scheduled_report_id: scheduledReportId })],
    );
    await db.query(
      'UPDATE generated_reports SET status = \'completed\', file_size = ? WHERE id = ?',
      [buffer.length, reportId],
    );
    return { reportId, status: 'completed' };
  } catch (err) {
    await db.query(
      'UPDATE generated_reports SET status = \'failed\', error_message = ? WHERE id = ?',
      [err.message, reportId],
    );
    throw err;
  }
}

module.exports = {
  processScheduledReports,
  runSchedule,
  generateReportData,
  formatReport,
  toCSV,
  runOnDemand,
  nextRunAt,
  assertValidCron,
  assertValidRecipients,
};

// =============================================================================
// FE-23 — pages use the shared StatusBadge and formatMoney
// =============================================================================
// About seventy pages declared their own StatusBadge and a dozen their own
// fmtAmount/fmtMoney. Fifty badges and the es-MX currency formatters became
// components/ui/StatusBadge and lib/money's formatMoney. The copies left differ
// (their own markup, a browser-locale or no-currency format); no other file
// may declare one, and a file that drops its copy leaves the list.
// =============================================================================
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '..');

const LOCAL_STATUS_BADGES = new Set([
  'components/ui/StatusBadge.tsx',
  'pages/AiSupportPage.tsx',
  'pages/ApiTokenList.tsx',
  'pages/AutomationPage.tsx',
  'pages/BackupSettings.tsx',
  'pages/CfdiList.tsx',
  'pages/ClientDetail.tsx',
  'pages/ConcessionTitleList.tsx',
  'pages/ConnectionLogList.tsx',
  'pages/CoverageZoneMap.tsx',
  'pages/IntegrationsPage.tsx',
  'pages/OrganizationList.tsx',
  'pages/OutageList.tsx',
  'pages/ResellerPage.tsx',
  'pages/ScheduledTaskList.tsx',
  'pages/TechnicianDashboard.tsx',
  'pages/TicketDetail.tsx',
  'pages/TicketList.tsx',
  'pages/TrapForwardingRuleList.tsx',
  'pages/UserList.tsx',
  'pages/WorkOrders.tsx',
]);
const LOCAL_MONEY_FORMATTERS = new Set([
  'pages/CashReconciliationList.tsx',
  'pages/ChargebackList.tsx',
  'pages/ClientGroupList.tsx',
  'pages/PaymentPlanList.tsx',
  'pages/RefundRequestList.tsx',
]);

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'test') tsxFiles(p, out); continue; }
    if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) out.push(p);
  }
  return out;
}

function declaring(pattern: RegExp, except: string[] = []): string[] {
  return tsxFiles(SRC)
    .map(f => relative(SRC, f).split('\\').join('/'))
    .filter(f => !except.includes(f) && pattern.test(readFileSync(join(SRC, f), 'utf8')))
    .sort();
}

describe.each([
  ['StatusBadge', declaring(/^(export )?function StatusBadge\(/m), LOCAL_STATUS_BADGES],
  ['fmtAmount/fmtMoney', declaring(/^(export )?function (fmtAmount|fmtMoney)\(/m, ['pages/crudStyles.tsx']), LOCAL_MONEY_FORMATTERS],
] as const)('local %s copies', (_name, found, allowed) => {
  it('no other file declares one', () => {
    expect(found.filter(f => !allowed.has(f))).toEqual([]);
  });

  it('the list only holds files that still do', () => {
    expect([...allowed].filter(f => !found.includes(f))).toEqual([]);
  });
});

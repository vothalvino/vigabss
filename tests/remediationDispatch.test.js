// =============================================================================
// ASY-36 — a remediation reboot reaches the device through its driver
// =============================================================================
// Every remediation action was recorded 'not_dispatched' ("live device
// dispatch is not yet implemented"). NET-30 gave devices vendor drivers; a
// reboot rule now sends the driver's reboot command to the breaching device.
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(), withPrimaryContext: fn => fn(), withTenantContext: (_id, fn) => fn(),
}));
jest.mock('../src/services/routerDriverService', () => ({ dispatchCommand: jest.fn() }));

const db = require('../src/config/database');
const routerDriverService = require('../src/services/routerDriverService');
const automation = require('../src/services/automationService');

let rule;
let configs;
beforeEach(() => {
  jest.clearAllMocks();
  rule = {
    id: 1, organization_id: 1, action_type: 'reboot', condition_metric: 'cpu_usage', condition_operator: 'gt',
    condition_threshold: 90, cooldown_minutes: 30, last_triggered_at: null, is_enabled: 1,
  };
  configs = [{ id: 31, vendor: 'mikrotik' }];
  db.query.mockImplementation(async (sql, params) => {
    if (/FROM remediation_rules/.test(sql)) return [[rule]];
    if (/FROM snmp_metrics m/.test(sql)) return [[{ device_id: 7, metric_value: '97', polled_at: new Date() }]];
    if (/FROM router_driver_configs/.test(sql)) return [params[0] === 7 && params[1] === 1 ? configs : []];
    return [{ affectedRows: 1, insertId: 1 }];
  });
  routerDriverService.dispatchCommand.mockResolvedValue({ status: 'success', execution_id: 88 });
});

const execution = () => db.query.mock.calls.find(([sql]) => /INSERT INTO remediation_executions/.test(sql))[1];

test('a reboot rule sends reboot to the breaching device\'s driver config and records success', async () => {
  const result = await automation.evaluateRemediationRules(1);
  expect(result).toEqual({ evaluated: 1, triggered: 1 });
  expect(routerDriverService.dispatchCommand).toHaveBeenCalledWith(31, 1, 'reboot', {}, null);
  expect(execution().slice(2, 6)).toEqual([7, 'reboot', 'success', expect.stringContaining('driver execution #88')]);
});

test('a refused command is a failure with the device\'s answer', async () => {
  routerDriverService.dispatchCommand.mockResolvedValue({ status: 'failure', error_message: 'login failed' });
  await automation.evaluateRemediationRules(1);
  expect(execution().slice(4, 6)).toEqual(['failure', 'login failed']);
});

test('a device whose driver cannot reboot it is not_dispatched, and nothing is sent', async () => {
  configs = [{ id: 32, vendor: 'ubiquiti' }];
  await automation.evaluateRemediationRules(1);
  expect(routerDriverService.dispatchCommand).not.toHaveBeenCalled();
  expect(execution()[4]).toBe('not_dispatched');
});

test('an action with no device command stays not_dispatched', async () => {
  rule.action_type = 'restart_service';
  await automation.evaluateRemediationRules(1);
  expect(routerDriverService.dispatchCommand).not.toHaveBeenCalled();
  expect(execution().slice(4, 6)).toEqual(['not_dispatched', expect.stringMatching(/only reboot/)]);
});

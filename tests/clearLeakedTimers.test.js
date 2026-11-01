// =============================================================================
// A suite that loads the rate limiters does not retain its module registry
// =============================================================================
// CI runs jest in-band (--detectOpenHandles), so a suite whose modules stay
// reachable after it ends adds to one process's heap for the rest of the run.
// express-rate-limit's MemoryStore interval kept every app-loading suite alive
// and exhausted the 10 GiB coverage heap on main. tests/setup/clearLeakedTimers
// clears such timers; this runs a fixture under jest's own --detectLeaks with
// the repository's config to prove the registry is released.
// =============================================================================

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

test('the rate-limit fixture passes jest --detectLeaks', () => {
  const config = {
    ...require('../jest.config'),
    rootDir: ROOT,
    testMatch: ['<rootDir>/tests/fixtures/rateLimitLeak.fixture.js'],
    collectCoverageFrom: undefined,
    coverageThreshold: undefined,
  };
  const run = spawnSync(process.execPath, [
    require.resolve('jest/bin/jest'), '--ci', '--runInBand', '--detectLeaks', '--config', JSON.stringify(config),
  ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  expect(run.stderr).not.toMatch(/leaking memory/);
  expect(run.stderr).toMatch(/Tests:\s+1 passed, 1 total/);
  expect(run.status).toBe(0);
}, 60000);

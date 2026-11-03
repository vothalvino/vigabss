// =============================================================================
// VigaBSS 5.0 — speed-test jobs have no runner yet (TNA-40)
// =============================================================================
// subscriber_speed_test_jobs could be queued from the portal and the staff API
// ("Results will be available shortly"), but no executor exists: the
// subscriber_speed_test_run task is a disabled stub, so every job stayed
// 'queued' forever. Both create paths refuse until a runner ships; recorded
// speed_tests results are unaffected.
// =============================================================================

const { AppError } = require('./errors');

function speedTestJobsUnavailable() {
  return new AppError(
    'Speed tests cannot be run yet: no speed-test runner is installed, so a queued test would never complete.',
    501,
    'SPEED_TEST_UNAVAILABLE',
  );
}

module.exports = { speedTestJobsUnavailable };

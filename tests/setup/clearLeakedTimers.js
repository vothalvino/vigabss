// =============================================================================
// Clear the timers a test file leaves behind, so its module registry can be freed
// =============================================================================
// CI runs jest with --detectOpenHandles, which runs every suite in-band in one
// process (workerIdleMemoryLimit never applies). A timer still pending after a
// suite keeps its callback alive, and through the callback's scope the whole
// module registry that suite loaded — even when the timer is unref'd, so
// --detectOpenHandles never reports it. express-rate-limit's MemoryStore
// cleanup interval did exactly that for every suite that loads src/app: about
// 20 MB (65 MB under --coverage) retained per suite, which exhausted the
// 10 GiB coverage heap once there were enough suites.
//
// Wrap the timer functions before the test file's modules load and clear
// whatever is still pending once the file's tests are done.
// =============================================================================

const pending = new Map();

function track(set, clear) {
  const original = global[set];
  const originalClear = global[clear];
  global[set] = function trackedTimer(...args) {
    const handle = original.apply(this, args);
    pending.set(handle, originalClear);
    return handle;
  };
  global[clear] = function trackedClear(handle) {
    pending.delete(handle);
    return originalClear.call(this, handle);
  };
}

track('setInterval', 'clearInterval');
track('setTimeout', 'clearTimeout');

afterAll(() => {
  for (const [handle, clear] of pending) clear(handle);
  pending.clear();
});

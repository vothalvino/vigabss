// Run by tests/clearLeakedTimers.test.js under --detectLeaks: loading the rate
// limiters starts express-rate-limit MemoryStore intervals, which must not keep
// this file's module registry alive after it finishes.
test('loads the rate limiters', () => {
  require('../../src/middleware/rateLimit');
});

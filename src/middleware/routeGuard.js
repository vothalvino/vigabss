// Marks a guard so tests/routeSecurityInventory.test.js can tell which
// permissions, roles or channels protect each route (SEC-22).
const GUARD = Symbol.for('vigabss.routeGuard');

function tagGuard(fn, info) {
  fn[GUARD] = info;
  return fn;
}

module.exports = { GUARD, tagGuard };

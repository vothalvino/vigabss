'use strict';
// =============================================================================
// Route inventory: every method + path the app serves, with the middleware
// that runs before its handler (SEC-22).
// =============================================================================
// Express 5 layers do not keep the path they were mounted at, so install()
// records it on each layer as routers are built. Call install() before the app
// is required, then list(app).
// =============================================================================

const Router = require(require.resolve('router', { paths: [require.resolve('express')] }));

const MOUNT = Symbol('mountPath');

function install() {
  if (Router.prototype.use[MOUNT]) return;
  const originalUse = Router.prototype.use;
  const patched = function use(...args) {
    const mountPath = typeof args[0] === 'string' || args[0] instanceof RegExp || Array.isArray(args[0])
      && args[0].every(p => typeof p === 'string')
      ? args[0]
      : '/';
    const before = this.stack.length;
    const result = originalUse.apply(this, args);
    for (const layer of this.stack.slice(before)) layer[MOUNT] = mountPath;
    return result;
  };
  patched[MOUNT] = true;
  Router.prototype.use = patched;
}

function join(prefix, path) {
  const p = String(path);
  const joined = `${prefix.replace(/\/$/, '')}/${p.replace(/^\//, '')}`;
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

// A middleware mounted at /a/:id applies to every path under it.
function covers(middlewarePath, path) {
  if (middlewarePath === '/' || middlewarePath === '') return true;
  const pattern = middlewarePath.split('/').map(seg => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/');
  return new RegExp(`^${pattern}(/|$)`).test(path);
}

function walk(stack, prefix, inherited, out) {
  const active = [...inherited];
  for (const layer of stack) {
    if (layer.route) {
      const path = join(prefix, layer.route.path);
      const before = active.filter(m => m.paths.some(p => covers(p, path))).map(m => m.fn);
      const own = layer.route.stack.map(l => l.handle);
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        const ownForMethod = layer.route.stack.filter(l => !l.method || l.method === method).map(l => l.handle);
        out.push({ method: method.toUpperCase(), path, chain: [...before, ...ownForMethod.slice(0, -1)], handler: own.at(-1) });
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      for (const mount of [].concat(layer[MOUNT] ?? '/')) walk(layer.handle.stack, join(prefix, mount), active, out);
    } else {
      active.push({ paths: [].concat(layer[MOUNT] ?? '/').map(mount => join(prefix, mount)), fn: layer.handle });
    }
  }
  return out;
}

function list(app) {
  return walk(app.router.stack, '/', [], []);
}

module.exports = { install, list };

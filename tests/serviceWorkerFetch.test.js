// The service worker must leave other sites' requests alone, and must never
// answer a failed image, script or style with the cached page.
//
// Map tiles come from another site. A worker's own fetch is governed by
// connect-src 'self', so fetching them from the worker was refused, and the
// fallback answered each tile with the cached portal page: status 200, not an
// image. Every map had a grey background wherever the worker was active.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'public', 'sw.js'), 'utf8');

function worker({ fetchImpl, cached = {} }) {
  const listeners = {};
  const sandbox = {
    URL,
    Promise,
    Response: { error: () => ({ type: 'error' }) },
    fetch: fetchImpl,
    caches: {
      open: async () => ({ put: jest.fn(), add: async () => {} }),
      keys: async () => [],
      delete: async () => true,
      match: async (key) => cached[typeof key === 'string' ? key : key.url] || undefined,
    },
    self: {
      location: { origin: 'https://isp.example.com' },
      addEventListener: (name, fn) => { listeners[name] = fn; },
      skipWaiting: () => {},
      clients: { claim: () => {} },
      registration: {},
    },
  };
  vm.runInNewContext(source, sandbox);
  return async (request) => {
    let answer;
    listeners.fetch({ request, respondWith: (p) => { answer = p; } });
    return answer === undefined ? 'left to the browser' : answer;
  };
}
const get = (url, mode = 'no-cors') => ({ method: 'GET', url, mode });

test('a map tile from another site is left to the browser', async () => {
  const fetchImpl = jest.fn();
  const handle = worker({ fetchImpl });
  await expect(handle(get('https://a.tile.openstreetmap.org/15/7360/14579.png'))).resolves.toBe('left to the browser');
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('API calls and non-GET requests are still left alone', async () => {
  const handle = worker({ fetchImpl: jest.fn() });
  await expect(handle(get('https://isp.example.com/api/v1/clients'))).resolves.toBe('left to the browser');
  await expect(handle({ method: 'POST', url: 'https://isp.example.com/portal', mode: 'cors' })).resolves.toBe('left to the browser');
});

test('a same-site asset that cannot be fetched fails as itself, not as the cached page', async () => {
  const handle = worker({ fetchImpl: async () => { throw new Error('offline'); }, cached: { '/portal': { shell: true } } });
  await expect(handle(get('https://isp.example.com/assets/logo.png'))).resolves.toEqual({ type: 'error' });
  await expect(handle(get('https://isp.example.com/assets/app.js', 'cors'))).resolves.toEqual({ type: 'error' });
});

test('a page that cannot be fetched still falls back to the cached shell, and a cached asset is still served', async () => {
  const logo = { cachedLogo: true };
  const handle = worker({ fetchImpl: async () => { throw new Error('offline'); }, cached: { '/portal': { shell: true }, 'https://isp.example.com/assets/logo.png': logo } });
  await expect(handle(get('https://isp.example.com/portal/invoices', 'navigate'))).resolves.toEqual({ shell: true });
  await expect(handle(get('https://isp.example.com/assets/logo.png'))).resolves.toBe(logo);
});

test('online, a same-site request is fetched and returned', async () => {
  const response = { status: 200, clone: () => ({}) };
  const handle = worker({ fetchImpl: async () => response });
  await expect(handle(get('https://isp.example.com/assets/app.js'))).resolves.toBe(response);
});

test('the cache name changed, so installs drop what the old worker stored', () => {
  expect(source).toMatch(/const CACHE_NAME = 'vigabss-portal-v3';/);
});

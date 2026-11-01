// =============================================================================
// OPS-12 — third-party images are pinned, current, refreshed and scanned
// =============================================================================
// redis:7-alpine and nginx:1.27-alpine floated, and redeploy pulled only the
// app, so they stayed at whatever install.sh first fetched; nginx 1.27 is an
// end-of-life mainline; and nothing scanned any image but the app's.
// =============================================================================

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const thirdParty = (file) => [...read(file).matchAll(/^\s+image:\s+(\S+)\s*$/gm)]
  .map((m) => m[1])
  .filter((img) => !img.includes('VIGABSS_IMAGE') && !img.startsWith('mcr.microsoft.com/playwright'));

test.each(['docker-compose.prod.yml', 'docker-compose.yml', 'docker-compose.test.yml', 'docker-compose.e2e.yml'])(
  '%s pins every third-party image by exact version and digest',
  (file) => {
    for (const img of thirdParty(file)) expect(img).toMatch(/^[\w./-]+:v?\d+\.\d+\.\d+[\w.-]*@sha256:[0-9a-f]{64}$/);
  },
);

test('the bundled nginx is on the current stable line, not the end-of-life 1.27 mainline', () => {
  const nginx = thirdParty('docker-compose.prod.yml').find((i) => i.startsWith('nginx:'));
  const [major, minor] = nginx.slice('nginx:'.length).split('.').map(Number);
  expect(major).toBe(1);
  expect(minor % 2).toBe(0);
  expect(minor).toBeGreaterThanOrEqual(30);
  expect(read('nginx/nginx.conf')).not.toMatch(/^\s*listen\b[^;\n]*\bhttp2\b/m);
});

test('the scheduled scan reads its image list from docker-compose.prod.yml', () => {
  const sched = read('.github/workflows/security-scan.yml');
  const list = sched.slice(sched.indexOf('  third-party-image-list:'), sched.indexOf('  third-party-images:'));
  expect(list).toMatch(/grep -E '\^\\s\+image:\\s' docker-compose\.prod\.yml/);
  expect(list).toMatch(/grep -v 'VIGABSS_IMAGE'/);
  expect(sched).toMatch(/image: \$\{\{ fromJSON\(needs\.third-party-image-list\.outputs\.images\) \}\}/);

  // The same filter, run here, yields exactly the pinned third-party images.
  const derived = [...new Set(read('docker-compose.prod.yml').split('\n')
    .filter((l) => /^\s+image:\s/.test(l)).map((l) => l.trim().split(/\s+/)[1])
    .filter((i) => !i.includes('VIGABSS_IMAGE')))].sort();
  expect(derived).toEqual([...new Set(thirdParty('docker-compose.prod.yml'))].sort());
  expect(derived.length).toBeGreaterThanOrEqual(5);
});

test('redeploy refreshes the supporting images, and Dependabot bumps the compose pins', () => {
  const redeploy = read('redeploy.sh');
  expect(redeploy).toMatch(/dc pull --quiet --ignore-pull-failures "\$\{SUPPORT_SERVICES\[@\]\}"/);
  expect(redeploy.indexOf('dc pull --quiet --ignore-pull-failures')).toBeLessThan(redeploy.indexOf('dc up -d db-primary redis'));
  expect(read('.github/dependabot.yml')).toContain('package-ecosystem: docker-compose');
});

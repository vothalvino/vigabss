// =============================================================================
// Supported host releases: Ubuntu 24.04 LTS and 26.04 LTS
// =============================================================================
// Both are installed for real in CI (.github/workflows/ci.yml: installer-deps
// in a clean image of the release, installer-smoke on a machine of it). This
// keeps either release from being dropped from those jobs by accident: 24.04
// stays supported until its standard support ends, and 26.04 is the current
// LTS.
// =============================================================================

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const ci = yaml.load(fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'));
const SUPPORTED = ['24.04', '26.04'];

test('the installer\'s dependencies are installed in a clean image of each supported release', () => {
  const job = ci.jobs['installer-deps'];
  expect(job.strategy.matrix.ubuntu).toEqual(SUPPORTED);
  expect(job.container.image).toBe('ubuntu:${{ matrix.ubuntu }}');
  const run = job.steps.find(s => /install\.sh/.test(s.run || ''));
  expect(run.env.INSTALL_DEPS_ONLY).toBe('1');
  // The job proves it ran on the release it names.
  expect(job.steps.some(s => /VERSION_ID.*matrix\.ubuntu/.test(s.run || ''))).toBe(true);
});

test('a complete install runs on a machine of each supported release', () => {
  const job = ci.jobs['installer-smoke'];
  expect(job.strategy.matrix.ubuntu).toEqual(SUPPORTED);
  expect(job['runs-on']).toBe('ubuntu-${{ matrix.ubuntu }}');
  expect(job.strategy['fail-fast']).toBe(false);
  const steps = job.steps.map(s => s.run || '').join('\n');
  expect(steps).toMatch(/bash install\.sh/);
  expect(steps).toMatch(/health\/ready/);
  expect(job.steps.some(s => /VERSION_ID.*matrix\.ubuntu/.test(s.run || ''))).toBe(true);
});

test('deps-only mode stops before anything is downloaded, configured or started', () => {
  const sh = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const exitAt = sh.indexOf('INSTALL_DEPS_ONLY=1: stopping here');
  expect(exitAt).toBeGreaterThan(0);
  // After Docker and Compose are in place, before the first prompt, the
  // clone, the env file and the stack.
  expect(exitAt).toBeGreaterThan(sh.indexOf('Ensure Docker Compose v2 plugin is available'));
  for (const later of ['Collect required configuration', 'Clone / update repository', 'Write .env.prod', 'Start the stack']) {
    expect(sh.indexOf(later)).toBeGreaterThan(exitAt);
  }
  // It does not try to start a daemon either.
  expect(sh).toMatch(/\[\[ "\$\{INSTALL_DEPS_ONLY:-0\}" != "1" \]\] && ! docker info/);
});

test('the documentation names the supported releases', () => {
  for (const file of ['README.md', path.join('docs', 'deployment.md')]) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    expect(text).toMatch(/Ubuntu 24\.04 LTS and 26\.04 LTS/);
  }
});

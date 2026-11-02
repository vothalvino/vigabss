'use strict';
// =============================================================================
// OPS-24 — installs and redeploys follow releases, not every commit to main
// =============================================================================
// install.sh cloned main and redeploy.sh checked out and pulled main, so every
// merge reached production on the next redeploy, and the installer pulled
// :latest whatever it had checked out. Both now take the newest v* release
// (VIGABSS_CHANNEL=release, the default) and fall back to main while no
// release is tagged; VIGABSS_CHANNEL=main follows main.
// =============================================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const REDEPLOY = path.join(ROOT, 'redeploy.sh');
const INSTALL = path.join(ROOT, 'install.sh');

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

let dir;
let origin;
let app;
const commits = {};

// origin: main with three commits, releases on the first two.
function setUp({ tags = true } = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-channel-'));
  origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  git(dir, 'init', '--bare', origin);
  git(dir, 'clone', origin, work);
  for (const name of ['one', 'two', 'three']) {
    fs.writeFileSync(path.join(work, name), name);
    git(work, 'add', name);
    git(work, 'commit', '-m', name);
    commits[name] = git(work, 'rev-parse', 'HEAD');
    if (tags && name === 'one') git(work, 'tag', 'v0.1.0-rc.1');
    if (tags && name === 'two') git(work, 'tag', 'v0.1.0');
  }
  git(work, 'push', '--tags', 'origin', 'main');
  app = path.join(dir, 'app');
  git(dir, 'clone', '--depth', '1', `file://${origin}`, app);
}

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function updateSource(env = {}) {
  const res = spawnSync('bash', ['-c', 'source "$1" && update_source && echo "RELEASE=$SOURCE_RELEASE"', 'bash', REDEPLOY], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, VIGABSS_LIB_ONLY: '1', VIGABSS_DIR: app, ...env },
  });
  return { ...res, head: git(app, 'rev-parse', 'HEAD'), release: (/RELEASE=(.*)/.exec(res.stdout) || [])[1] };
}

describe('redeploy', () => {
  test('deploys the newest release by default', () => {
    setUp();
    const res = updateSource();
    expect(res.status).toBe(0);
    expect(res.release).toBe('v0.1.0');
    expect(res.head).toBe(commits.two);
  });

  test('VIGABSS_CHANNEL=main, from the environment or .env.prod, follows main', () => {
    setUp();
    expect(updateSource({ VIGABSS_CHANNEL: 'main' }).head).toBe(commits.three);

    git(app, 'checkout', '--detach', 'HEAD~0');
    fs.writeFileSync(path.join(app, '.env.prod'), 'VIGABSS_CHANNEL=main # follow main\n');
    const res = updateSource();
    expect(res.release).toBe('');
    expect(res.head).toBe(commits.three);
  });

  test('with no release tagged yet it follows main', () => {
    setUp({ tags: false });
    const res = updateSource();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/no release is tagged yet; following main/);
    expect(res.head).toBe(commits.three);
  });

  test('an unknown channel stops the deploy', () => {
    setUp();
    const res = updateSource({ VIGABSS_CHANNEL: 'nightly' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/must be 'release' or 'main'/);
  });

  test('a release deploys its :<version> image', () => {
    const script = fs.readFileSync(REDEPLOY, 'utf8');
    expect(script).toContain('SOURCE_TAG="${SOURCE_RELEASE:+${SOURCE_RELEASE#v}}"');
    expect(script).toContain('TAG="${1:-${PINNED_ENV_TAG:-${SOURCE_TAG:-$(git -C "$APP_DIR" rev-parse HEAD)}}}"');
  });
});

describe('install.sh', () => {
  const fn = () => {
    const src = fs.readFileSync(INSTALL, 'utf8');
    return src.slice(src.indexOf('latest_remote_release() {'), src.indexOf('\n}\n', src.indexOf('latest_remote_release() {')) + 3);
  };

  test('finds the newest release on the remote, a final version after its release candidates', () => {
    setUp();
    const out = execFileSync('bash', ['-c', `${fn()}\nlatest_remote_release "$1"`, 'bash', `file://${origin}`], { encoding: 'utf8' }).trim();
    expect(out).toBe('v0.1.0');
  });

  test('pulls the image of what it checked out, not :latest', () => {
    const src = fs.readFileSync(INSTALL, 'utf8');
    const pinAt = src.indexOf('export VIGABSS_IMAGE="ghcr.io/vothalvino/vigabss:${SOURCE_RELEASE#v}"');
    expect(pinAt).toBeGreaterThan(0);
    expect(src.indexOf('$COMPOSE pull', pinAt)).toBeGreaterThan(pinAt);
    expect(src).toContain('VIGABSS_CHANNEL=${VIGABSS_CHANNEL}');
  });
});

test('images are published only after every test job passed', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = ci.slice(ci.indexOf('\n  publish-manifest:'), ci.indexOf('\n    steps:', ci.indexOf('\n  publish-manifest:')));
  for (const need of ['container-scan', 'lint-and-test', 'frontend-test', 'e2e', 'database-tests', 'migration-runner-tests']) {
    expect(job).toContain(`- ${need}`);
  }
});

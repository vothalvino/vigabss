// =============================================================================
// The installer's questions
// =============================================================================
// The install command is always the same (`curl … | bash`), so everything the
// installer needs it asks: the domain, the email, the organization's name and
// where it operates, chosen from a list (Mexico or Global) instead of typed
// as a country code. This runs the installer's own prompt functions, taken
// from install.sh between its markers, against a file of answers.
// =============================================================================

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALL = fs.readFileSync(path.join(__dirname, '..', 'install.sh'), 'utf8');
const PROMPTS = INSTALL.slice(INSTALL.indexOf('# >>> prompts'), INSTALL.indexOf('# <<< prompts'));

/** Run `body` after the installer's prompt functions, answering from `answers` (one per line). */
function ask(body, answers, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-prompts-'));
  const input = path.join(dir, 'answers');
  if (answers !== null) fs.writeFileSync(input, answers.map(a => `${a}\n`).join(''));
  const script = `set -euo pipefail
BOLD=''; RESET=''
die() { echo "DIE: $*" >&2; exit 1; }
${PROMPTS}
${body}`;
  const out = spawnSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH, VIGABSS_PROMPT_INPUT: answers === null ? path.join(dir, 'missing') : input, ...env },
    encoding: 'utf8',
  });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr };
}

test('the markers are there and the country is chosen, not typed', () => {
  expect(PROMPTS).toMatch(/choose_country\(\)/);
  expect(INSTALL).toMatch(/^ {2}choose_country$/m);
  expect(INSTALL).not.toMatch(/prompt ORG_COUNTRY/);
});

test.each([
  ['1', 'MX'], ['', 'MX'], ['2', 'GLOBAL'], ['global', 'GLOBAL'], ['mx', 'MX'],
])('answering %j chooses %s', (answer, country) => {
  const out = ask('choose_country; echo "COUNTRY=$ORG_COUNTRY"', [answer]);
  expect(out.status).toBe(0);
  expect(out.stdout).toContain('1) Mexico');
  expect(out.stdout).toContain('2) Global');
  expect(out.stdout).toContain(`COUNTRY=${country}`);
});

test('anything else is asked again until it is one of the two', () => {
  const out = ask('choose_country; echo "COUNTRY=$ORG_COUNTRY"', ['US', '3', '2']);
  expect(out.status).toBe(0);
  expect(out.stdout.match(/Type 1 for Mexico or 2 for Global\./g)).toHaveLength(2);
  expect(out.stdout).toContain('COUNTRY=GLOBAL');
});

test.each([
  ['MX', 'MX'], ['mx', 'MX'], ['global', 'GLOBAL'], ['GLOBAL', 'GLOBAL'], ['US', 'US'],
])('ORG_COUNTRY=%s given up front is not asked about', (given, country) => {
  // No answers file at all: asking would fail.
  const out = ask('choose_country; echo "COUNTRY=$ORG_COUNTRY"', null, { ORG_COUNTRY: given });
  expect(out.status).toBe(0);
  expect(out.stdout).not.toContain('Where does this ISP operate');
  expect(out.stdout).toContain(`COUNTRY=${country}`);
});

test('the domain, email and organization are asked in turn; a required one is asked until answered', () => {
  const out = ask(
    `prompt DOMAIN "Public domain name"
prompt EMAIL "Administrator email"
prompt ORG_NAME "Your organization (ISP) name" "My ISP"
choose_country
echo "RESULT=$DOMAIN|$EMAIL|$ORG_NAME|$ORG_COUNTRY"`,
    ['', 'isp.example.com', 'ops@example.com', '', '2'],
  );
  expect(out.status).toBe(0);
  expect(out.stdout).toContain('RESULT=isp.example.com|ops@example.com|My ISP|GLOBAL');
});

test('a value given up front is not asked for, so the rest of the answers line up', () => {
  const out = ask(
    `prompt DOMAIN "Public domain name"
prompt EMAIL "Administrator email"
echo "RESULT=$DOMAIN|$EMAIL"`,
    ['ops@example.com'],
    { DOMAIN: 'given.example.com' },
  );
  expect(out.stdout).toContain('RESULT=given.example.com|ops@example.com');
});

test('with nowhere to ask, the installer says how to pass the values instead of hanging', () => {
  const out = ask('prompt DOMAIN "Public domain name"', null);
  expect(out.status).toBe(1);
  expect(out.stderr).toMatch(/no terminal to ask it on/);
  expect(out.stderr).toMatch(/DOMAIN=isp\.example\.com EMAIL=you@example\.com/);
});

test('answers that run out stop the installer instead of looping', () => {
  expect(ask('prompt DOMAIN "Public domain name"', []).stderr).toMatch(/DIE: No answer was given for: Public domain name/);
  expect(ask('choose_country', []).stderr).toMatch(/DIE: No answer was given for where the ISP operates/);
});

// Reported on a first install: nobody saw the organization questions or the
// first password. Both exist, but the questions came minutes into the run and
// the password sat in the middle of the closing summary.
test('a first install asks about the organization with the other questions, before any long work', () => {
  const email = INSTALL.indexOf('prompt EMAIL ');
  const early = INSTALL.indexOf('prompt ORG_NAME ');
  const firstWork = INSTALL.search(/^\$COMPOSE |^ {2}\$COMPOSE /m);
  expect(email).toBeGreaterThan(-1);
  expect(early).toBeGreaterThan(email);
  expect(INSTALL.indexOf('choose_country', early)).toBeGreaterThan(early);
  expect(INSTALL.slice(email, early)).toMatch(/SAVED_BOOTSTRAP_STATE" == "pending"/);
  expect(firstWork).toBeGreaterThan(early);
});

test('the first sign-in details are the last thing the installer prints', () => {
  const password = INSTALL.lastIndexOf('Admin password:');
  expect(password).toBeGreaterThan(-1);
  expect(INSTALL.match(/Admin password:/g)).toHaveLength(1);
  // Nothing is echoed after the sign-in block closes.
  const after = INSTALL.slice(INSTALL.indexOf('\nfi\n', password));
  expect(after).not.toMatch(/^\s*echo /m);
  // The password leaves the env file only after it was printed.
  expect(INSTALL.indexOf('remove_env_key "$ENV_FILE" ADMIN_PASSWORD')).toBeGreaterThan(password);
});

// Reported on a clean server: the one-line install asked for the domain and
// email and then ended without creating the organization or showing a
// password. Piped into bash, the script is read a piece at a time, and the
// first container command that read its own input took the rest of it.
describe('run through a pipe', () => {
  const piped = (script) => spawnSync('bash', [], { input: script, encoding: 'utf8', env: { PATH: process.env.PATH } });
  // `cat` stands in for docker compose run/exec: it reads whatever input it is given.
  const BODY = 'echo before\ncat >/dev/null\necho after\n';

  test('a command that reads its input ends an unguarded piped script early, without an error', () => {
    const out = piped(BODY);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe('before\n');
  });

  test('the installer\'s guard lets the same script run to its end', () => {
    const guard = INSTALL.slice(INSTALL.indexOf('# >>> piped-run guard'), INSTALL.indexOf('# <<< piped-run guard'));
    expect(guard).toMatch(/^\{$/m);
    expect(guard).toMatch(/^exec <\/dev\/null$/m);
    const out = piped(`${guard}\n${BODY}exit 0\n}\n`);
    expect(out.status).toBe(0);
    expect(out.stdout).toBe('before\nafter\n');
  });

  test('the guard opens before the first command and closes on the last line', () => {
    const lines = INSTALL.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    expect(lines.slice(0, 3)).toEqual(['set -euo pipefail', '{', 'exec </dev/null']);
    expect(lines.slice(-2)).toEqual(['exit 0', '}']);
  });
});

// Reported on a new server: Settings → Version said the update agent had not
// reported in and offered no way to turn it on. Only `redeploy` installed the
// agent; the installer now does, with redeploy's own routine.
describe('updates from the web interface', () => {
  const start = INSTALL.indexOf('# ── Updates from the web interface');
  const BLOCK = INSTALL.slice(start, INSTALL.indexOf('# ── Summary', start));
  const repo = path.join(__dirname, '..');

  function runBlock(envFileText) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigabss-agent-'));
    const units = path.join(dir, 'units');
    const bin = path.join(dir, 'bin');
    const app = path.join(dir, 'app');
    fs.mkdirSync(units); fs.mkdirSync(bin); fs.mkdirSync(path.join(app, 'deploy'), { recursive: true });
    for (const f of ['redeploy.sh', 'deploy/vigabss-deploy-agent.service', 'deploy/vigabss-deploy-agent.timer']) {
      fs.copyFileSync(path.join(repo, f), path.join(app, f));
    }
    fs.writeFileSync(path.join(app, 'docker-compose.prod.yml'), '');
    fs.writeFileSync(path.join(app, '.env.prod'), envFileText);
    // A stand-in systemctl that records what it was asked and reports success.
    fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "$*" >> "${dir}/systemctl.log"\nexit 0\n`, { mode: 0o755 });
    const script = `set -euo pipefail
info() { echo "INFO: $*"; }; warn() { echo "WARN: $*"; }
INSTALL_DIR="${app}"
${BLOCK}
echo REACHED-THE-SUMMARY`;
    const out = spawnSync('bash', ['-c', script], {
      env: { PATH: `${bin}:${process.env.PATH}`, VIGABSS_SYSTEMD_UNIT_DIR: units },
      encoding: 'utf8',
    });
    const log = fs.existsSync(path.join(dir, 'systemctl.log')) ? fs.readFileSync(path.join(dir, 'systemctl.log'), 'utf8') : '';
    return { out, log, units, app };
  }

  test('the installer installs the agent units for its own directory and starts the timer', () => {
    expect(start).toBeGreaterThan(-1);
    const { out, log, units, app } = runBlock('DOMAIN=example.com\n');
    expect(out.stdout).toContain('REACHED-THE-SUMMARY');
    expect(out.stdout).not.toContain('WARN:');
    const service = fs.readFileSync(path.join(units, 'vigabss-deploy-agent.service'), 'utf8');
    expect(service).toContain(`ExecStart="${app}/deploy-agent.sh"`);
    expect(service).not.toContain('__VIGABSS_INSTALL_DIR__');
    expect(fs.existsSync(path.join(units, 'vigabss-deploy-agent.timer'))).toBe(true);
    expect(log).toMatch(/^enable --now vigabss-deploy-agent\.timer$/m);
  });

  test('VIGABSS_DEPLOY_AGENT=0 in .env.prod still opts out', () => {
    const { out, log, units } = runBlock('VIGABSS_DEPLOY_AGENT=0\n');
    expect(out.stdout).toContain('REACHED-THE-SUMMARY');
    expect(fs.existsSync(path.join(units, 'vigabss-deploy-agent.timer'))).toBe(false);
    expect(log).not.toMatch(/^enable /m);
  });

  test('it runs after the stack is up and before the closing summary', () => {
    expect(start).toBeGreaterThan(INSTALL.indexOf('log "Containers started."'));
    expect(start).toBeLessThan(INSTALL.indexOf('YOUR FIRST SIGN-IN'));
  });
});

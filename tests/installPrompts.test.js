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

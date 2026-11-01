// =============================================================================
// OPS-08 — privileged CI jobs run SHA-pinned actions with only the scopes
// they use
// =============================================================================
// Every action was pinned to a mutable tag (trivy-action's tags were
// reportedly force-pushed in March 2026); container-scan held id-token: write
// though it never signs; helm-release held contents: write on every push and
// pull request.
// =============================================================================

const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', '.github', 'workflows');
const workflows = fs.readdirSync(dir).filter((f) => f.endsWith('.yml')).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
const ci = fs.readFileSync(path.join(dir, 'ci.yml'), 'utf8');

function job(name) {
  const start = ci.indexOf(`\n  ${name}:\n`);
  const next = ci.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? ci.slice(start) : ci.slice(start, start + 1 + next);
}

test.each(workflows)('%s pins every action to a full commit SHA with its tag in a comment', (_f, text) => {
  const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)];
  expect(uses.length).toBeGreaterThan(0);
  for (const [, ref, rest] of uses) {
    expect(ref).toMatch(/@[0-9a-f]{40}$/);
    expect(rest).toMatch(/^ # v?\d+\.\d+\.\d+$/);
  }
});

test('container-scan does not hold id-token: write; publish-manifest, which signs, does', () => {
  expect(job('container-scan')).not.toMatch(/^\s+id-token: write/m);
  expect(job('publish-manifest')).toMatch(/id-token: write/);
});

test('only the tag-gated helm-release job can write repository contents', () => {
  expect(job('helm-lint')).toMatch(/^\s+contents: read$/m);
  expect(job('helm-lint')).not.toMatch(/^\s+contents: write/m);
  const release = job('helm-release');
  expect(release).toMatch(/contents: write/);
  expect(release).toMatch(/\n {4}if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
});

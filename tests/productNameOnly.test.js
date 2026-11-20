// The product was renamed before its first release, and the earlier name
// survived in about a thousand places: cookie names, the WireGuard hub
// interface, router object names, env fallbacks, test fixtures. They were all
// renamed in one pass. This keeps the earlier name from coming back through a
// copied snippet or a generated file.

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Assembled from two halves so this file is not itself a match.
const RETIRED = ['fire', 'isp'].join('');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // `git grep` exits 1 when nothing matches.
    if (err.status === 1) return '';
    throw err;
  }
}

test('no tracked file mentions the retired product name', () => {
  const files = git(['grep', '-ilI', RETIRED]).split('\n').filter(Boolean);
  expect(files).toEqual([]);
});

test('no tracked path contains the retired product name', () => {
  const paths = git(['ls-files']).split('\n').filter(f => f.toLowerCase().includes(RETIRED));
  expect(paths).toEqual([]);
});

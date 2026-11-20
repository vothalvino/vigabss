// "What's New" used to read a fixed JSON list that was never updated with
// releases, so it showed six old entries and none of the actual releases. It
// is now built from CHANGELOG.md, which every release already updates.

const fs = require('fs');
const path = require('path');
const { parseReleaseNotes, loadReleaseNotes, MAX_ENTRIES } = require('../src/utils/releaseNotes');
const product = require('../src/product');

const SAMPLE = `# Changelog

Intro text that is not a release.

## Unreleased

- **Not out yet.** This must not be shown.

## 1.2.0 — 2026-03-02

- **Invoices can be sorted.** Click a column header on the
  \`Invoices\` list; see [the guide](https://example.com/guide).
- A plain bullet with no bold summary.

## 1.1.0 — 2026-02-01

- **Older change:** details here.
`;

test('one entry per bullet of each released version, newest release first', () => {
  const entries = parseReleaseNotes(SAMPLE);
  expect(entries.map(e => e.id)).toEqual(['1.2.0-1', '1.2.0-2', '1.1.0-1']);
  expect(entries[0]).toEqual({
    id: '1.2.0-1',
    date: '2026-03-02T00:00:00.000Z',
    title: 'Invoices can be sorted',
    body: 'Click a column header on the Invoices list; see the guide.',
    tags: ['1.2.0'],
  });
});

test('a bullet without a bold summary is titled with its version', () => {
  const [, plainBullet] = parseReleaseNotes(SAMPLE);
  expect(plainBullet.title).toBe('VigaBSS 1.2.0');
  expect(plainBullet.body).toBe('A plain bullet with no bold summary.');
});

test('the Unreleased section and the preamble are left out', () => {
  const text = JSON.stringify(parseReleaseNotes(SAMPLE));
  expect(text).not.toMatch(/Not out yet/);
  expect(text).not.toMatch(/Intro text/);
});

test('the summary loses its closing punctuation, the body keeps its text', () => {
  const older = parseReleaseNotes(SAMPLE)[2];
  expect(older.title).toBe('Older change');
  expect(older.body).toBe('details here.');
});

test('an empty or unrelated document gives no entries', () => {
  expect(parseReleaseNotes('')).toEqual([]);
  expect(parseReleaseNotes('# Notes\n\n- a bullet outside any release\n')).toEqual([]);
});

test('a missing file gives no entries instead of failing the app start', () => {
  expect(loadReleaseNotes(path.join(__dirname, 'no-such-changelog.md'))).toEqual([]);
});

test('the shipped changelog yields the current release first, within the size limit', () => {
  const entries = loadReleaseNotes();
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.length).toBeLessThanOrEqual(MAX_ENTRIES);
  expect(entries[0].tags).toEqual([product.version]);
  expect(new Set(entries.map(e => e.id)).size).toBe(entries.length);
});

test('the image keeps CHANGELOG.md despite the *.md exclusion', () => {
  const ignore = fs.readFileSync(path.join(__dirname, '..', '.dockerignore'), 'utf8').split('\n');
  expect(ignore).toContain('!CHANGELOG.md');
  expect(ignore.indexOf('!CHANGELOG.md')).toBeGreaterThan(ignore.indexOf('*.md'));
});

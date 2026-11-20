// =============================================================================
// VigaBSS 5.0 — Release notes for the in-app "What's New" panel
// =============================================================================
// Turns CHANGELOG.md into the entries the panel shows: one entry per bullet of
// each released version, newest release first. The panel used to read a fixed
// JSON list that nobody updated with releases, so it never showed one.
//
// CHANGELOG.md is the single source: a release section is
//   ## <version> — <YYYY-MM-DD>
// followed by top-level "- " bullets. "## Unreleased" is skipped: those changes
// are not in the running build's release.
// =============================================================================

const fs = require('fs');
const path = require('path');

const CHANGELOG_PATH = path.join(__dirname, '../../CHANGELOG.md');
// Enough for several releases without sending the whole history to every browser.
const MAX_ENTRIES = 60;

const SECTION = /^## +(\S+) +[—–-] +(\d{4}-\d{2}-\d{2})\s*$/;

/** Markdown to the plain text the panel renders: no emphasis marks, code ticks or link targets. */
function plain(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function toEntry(version, date, index, raw) {
  const text = raw.replace(/\s+/g, ' ').trim();
  // A bullet normally opens with a bold one-line summary.
  const lead = /^\*\*(.+?)\*\*\s*/.exec(text);
  const title = lead ? plain(lead[1]).replace(/[.:]$/, '') : `VigaBSS ${version}`;
  const body = plain(lead ? text.slice(lead[0].length) : text);
  return {
    id: `${version}-${index}`,
    date: `${date}T00:00:00.000Z`,
    title,
    body,
    tags: [version],
  };
}

/**
 * @param {string} markdown the contents of CHANGELOG.md
 * @returns {Array<{id: string, date: string, title: string, body: string, tags: string[]}>}
 *          newest release first, bullets in the order they are written
 */
function parseReleaseNotes(markdown) {
  const entries = [];
  let release = null;   // { version, date, count } while inside a released section
  let bullet = null;    // lines of the bullet being read

  const flush = () => {
    if (release && bullet) {
      release.count += 1;
      entries.push(toEntry(release.version, release.date, release.count, bullet.join(' ')));
    }
    bullet = null;
  };

  for (const line of String(markdown).split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      flush();
      const match = SECTION.exec(line);
      release = match ? { version: match[1], date: match[2], count: 0 } : null;
    } else if (!release) {
      // preamble or the Unreleased section
    } else if (line.startsWith('- ')) {
      flush();
      bullet = [line.slice(2)];
    } else if (bullet && line.trim() !== '') {
      bullet.push(line.trim());
    }
  }
  flush();

  // Stable sort: releases by date, newest first; bullets keep their order.
  return entries
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => (b.entry.date.localeCompare(a.entry.date)) || (a.order - b.order))
    .map(({ entry }) => entry);
}

/** The panel's entries from the shipped CHANGELOG.md; empty when the file cannot be read. */
function loadReleaseNotes(file = CHANGELOG_PATH) {
  let markdown;
  try {
    markdown = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return parseReleaseNotes(markdown).slice(0, MAX_ENTRIES);
}

module.exports = { parseReleaseNotes, loadReleaseNotes, MAX_ENTRIES };

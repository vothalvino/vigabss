// =============================================================================
// VigaBSS 5.0 — Changelog Route (P3.8)
// =============================================================================
// Public endpoint — no authentication required.
// Returns the release notes of the running build, newest first, read once at
// start from the CHANGELOG.md shipped in the image.
// =============================================================================

const { Router } = require('express');
const { loadReleaseNotes } = require('../utils/releaseNotes');
const logger = require('../utils/logger').child({ route: 'changelog' });

const router = Router();
const entries = loadReleaseNotes();
if (entries.length === 0) {
  logger.warn('CHANGELOG.md is missing or has no released section; "What\'s New" will be empty');
}

router.get('/', (_req, res) => {
  res.json({ data: entries });
});

module.exports = router;

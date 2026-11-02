// =============================================================================
// FE2-08 — the AI policy tone choices match the ai_policies.tone ENUM
// =============================================================================
// The page and the validator offered formal|friendly|technical|empathetic, but
// the column is ENUM('formal','neutral','friendly'), so saving 'technical' or
// 'empathetic' failed the whole policy upsert with a 500, and 'neutral' was
// refused by the validator.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { updateAiPolicy } = require('../src/middleware/schemas/ai');

const root = path.join(__dirname, '..');
const schemaSql = fs.readFileSync(path.join(root, 'database/schema.sql'), 'utf8');
const columnEnum = schemaSql
  .slice(schemaSql.indexOf('CREATE TABLE IF NOT EXISTS ai_policies'))
  .match(/\btone\s+ENUM\(([^)]*)\)/)[1]
  .split(',').map((v) => v.trim().replace(/^'|'$/g, ''));

test('the validator accepts exactly the column ENUM', () => {
  expect(columnEnum).toEqual(['formal', 'neutral', 'friendly']);
  expect(updateAiPolicy.tone.enum).toEqual(columnEnum);
});

test('the settings page offers exactly the column ENUM', () => {
  const page = fs.readFileSync(path.join(root, 'frontend/src/pages/AIAssistantSettings.tsx'), 'utf8');
  const tones = page.match(/^const TONES = \[([^\]]*)\];/m)[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
  expect(tones).toEqual(columnEnum);
});

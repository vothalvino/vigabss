// =============================================================================
// OPS-25 — the image keeps code read-only to the runtime user, pins its base,
// ignores nested node_modules and env files, and health-checks /health/live
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split('\n').map((l) => l.trim());

test('every FROM pins an exact node version by digest', () => {
  const froms = dockerfile.match(/^FROM .+$/gm);
  expect(froms.length).toBeGreaterThan(0);
  for (const line of froms) expect(line).toMatch(/^FROM node:\d+\.\d+\.\d+-bookworm-slim@sha256:[0-9a-f]{64}( AS \S+)?$/);
});

test('only /app/storage is chowned to the runtime user', () => {
  const chowns = dockerfile.split('\n').filter((l) => /chown/.test(l) && !l.trim().startsWith('#'));
  expect(chowns).toEqual(['RUN mkdir -p /app/storage && chown -R fireisp:fireisp /app/storage']);
  expect(dockerfile).not.toMatch(/COPY --chown=fireisp/);
});

test('.dockerignore excludes nested node_modules and env files, keeping the example', () => {
  expect(ignore).toEqual(expect.arrayContaining(['**/node_modules', '**/.env', '**/.env.*', '!.env.example']));
});

test('the image health check probes /health/live', () => {
  expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*http:\/\/localhost:3000\/health\/live/);
});

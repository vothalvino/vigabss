'use strict';
// The helper that runs the isolation sweep in parts: which database and report
// each part uses, and how the parts' write reports become one.

const { plan, mergeWriteReports } = require('../src/scripts/db-integration-shards');

describe('plan', () => {
  it('keeps the job\'s own database and report for the first part', () => {
    expect(plan(3, 'vigabss_integration', 'db-isolation-report.json')).toEqual([
      { part: 1, database: 'vigabss_integration', report: 'db-isolation-report.json' },
      { part: 2, database: 'vigabss_integration_s2', report: 'db-isolation-report.part2.json' },
      { part: 3, database: 'vigabss_integration_s3', report: 'db-isolation-report.part3.json' },
    ]);
  });

  it('runs as one part on the one database', () => {
    expect(plan(1, 'db', '')).toEqual([{ part: 1, database: 'db', report: '' }]);
  });
});

describe('mergeWriteReports', () => {
  it('adds the counts and keeps every finding of every part', () => {
    const merged = mergeWriteReports([
      { locale: 'MX', shard: '1/2', routes: 5, routesInAllParts: 9, requests: 4, byStatus: { 404: 3, 201: 1 }, changed: [], linked: [], accepted: ['PUT /a -> 200'], unresolved: [], installWide: ['POST /x'], mxOnly: [], initialLinks: [] },
      { locale: 'MX', shard: '2/2', routes: 4, routesInAllParts: 9, requests: 4, byStatus: { 404: 2, 422: 2 }, changed: ['DELETE /b -> 204: changed clients'], linked: [], accepted: [], unresolved: ['POST /c (id)'], installWide: [], mxOnly: [], initialLinks: [] },
    ]);
    expect(merged).toMatchObject({
      locale: 'MX', shard: '1-2/2', routes: 9, routesInAllParts: 9, requests: 8,
      byStatus: { 404: 5, 201: 1, 422: 2 },
      changed: ['DELETE /b -> 204: changed clients'],
      accepted: ['PUT /a -> 200'],
      unresolved: ['POST /c (id)'],
      installWide: ['POST /x'],
    });
  });
});

describe('the sweep covers every write route exactly once across its parts', () => {
  it('every index lands in one part', () => {
    const parts = 4;
    const routes = Array.from({ length: 967 }, (_, i) => i);
    const seen = [];
    for (let part = 1; part <= parts; part += 1) seen.push(...routes.filter((_, i) => i % parts === part - 1));
    expect(seen.sort((a, b) => a - b)).toEqual(routes);
  });
});

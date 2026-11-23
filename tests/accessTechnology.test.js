'use strict';
// =============================================================================
// Access technology: a plan is WISP, FTTH or both; a contract may say its own
// =============================================================================
// A subscriber can be moved from WISP to FTTH on the same contract (no new
// plan, no new signature). One rule decides which technology serves a
// contract, and it is the same in JavaScript, in SQL and in GraphQL.
// =============================================================================

const fs = require('fs');
const path = require('path');
const tech = require('../src/utils/accessTechnology');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('which technology serves a contract', () => {
  test('the contract\'s own choice wins', () => {
    expect(tech.effectiveTechnology('ftth', 'wisp')).toBe('ftth');
    expect(tech.effectiveTechnology('wisp', 'ftth')).toBe('wisp');
    expect(tech.effectiveTechnology('ftth', 'both')).toBe('ftth');
  });

  test('with no choice it follows the plan; a plan offered over both is WISP until someone says otherwise', () => {
    expect(tech.effectiveTechnology(null, 'ftth')).toBe('ftth');
    expect(tech.effectiveTechnology(null, 'wisp')).toBe('wisp');
    expect(tech.effectiveTechnology(undefined, 'both')).toBe('wisp');
    // Rows from before migration 018, or a value that is not a technology.
    expect(tech.effectiveTechnology(null, undefined)).toBe('wisp');
    expect(tech.effectiveTechnology('satellite', 'ftth')).toBe('ftth');
  });

  test('the SQL form is the same rule', () => {
    expect(tech.effectiveTechnologySql('c', 'p'))
      .toBe("COALESCE(c.access_technology, IF(p.access_technology = 'ftth', 'ftth', 'wisp'))");
    expect(() => tech.effectiveTechnologySql('c; DROP', 'p')).toThrow();
  });

  test('a choice outside what the plan is offered over is flagged, not refused', () => {
    expect(tech.isOutsidePlan('ftth', 'wisp')).toBe(true);
    expect(tech.isOutsidePlan('ftth', 'both')).toBe(false);
    expect(tech.isOutsidePlan('ftth', 'ftth')).toBe(false);
    expect(tech.isOutsidePlan(null, 'wisp')).toBe(false);
  });
});

describe('where it is stored and accepted', () => {
  const Plan = require('../src/models/Plan');
  const Contract = require('../src/models/Contract');
  const planSchemas = require('../src/middleware/schemas/plans');
  const contractSchemas = require('../src/middleware/schemas/contracts');

  test('plans and contracts accept the field with their own allowed values', () => {
    expect(Plan.fillable).toContain('access_technology');
    expect(Contract.fillable).toContain('access_technology');
    for (const schema of Object.values(planSchemas).filter((s) => s && s.access_technology)) {
      expect(schema.access_technology.enum).toEqual(['wisp', 'ftth', 'both']);
    }
    const contractRules = Object.values(contractSchemas).filter((s) => s && s.access_technology);
    expect(contractRules.length).toBeGreaterThanOrEqual(2);
    for (const schema of contractRules) expect(schema.access_technology.enum).toEqual(['wisp', 'ftth']);
  });

  test('changing a contract\'s technology is not blocked by a prepared installation', () => {
    // It is not one of the fields an activation applies, so a migration can be
    // recorded at any time.
    expect(read('src', 'services', 'contractUpdateGuard.js')).not.toMatch(/'access_technology'/);
  });

  test('existing plans and contracts stay WISP after the migration', () => {
    const sql = read('database', 'migrations', '018_access_technology.sql');
    expect(sql).toMatch(/ADD COLUMN access_technology ENUM\('wisp','ftth','both'\) NOT NULL DEFAULT 'wisp'/);
    expect(sql).toMatch(/ADD COLUMN access_technology ENUM\('wisp','ftth'\) NULL DEFAULT NULL/);
  });

  test('GraphQL reports the effective technology and the contract\'s own choice', () => {
    expect(read('src', 'graphql', 'typeDefs.js')).toMatch(/accessTechnology: String\n[^\n]*\n\s+accessTechnologyOverride: String/);
    const resolvers = read('src', 'graphql', 'resolvers.js');
    expect(resolvers).toMatch(/accessTechnologyOverride: \(c\) => c\.access_technology \|\| null/);
    // The plan lookup is scoped to the caller's organization.
    expect(resolvers).toMatch(/SELECT access_technology FROM plans WHERE id = \? AND \(organization_id = \? OR organization_id IS NULL\) LIMIT 1/);
  });
});

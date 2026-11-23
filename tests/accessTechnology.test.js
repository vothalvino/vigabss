'use strict';
// =============================================================================
// Access technology: a plan is WISP, FTTH or both; a contract is one of them
// =============================================================================
// A contract is created for one technology and keeps it. Changing between
// WISP and FTTH is done with a new contract, so nothing may change the
// technology of an existing one, directly or by moving it to another plan.
// =============================================================================

const fs = require('fs');
const path = require('path');
const tech = require('../src/utils/accessTechnology');
const plans = require('../src/services/planAvailability');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/** An executor whose plans table is `rows` (id -> access_technology). */
const withPlans = (rows) => ({
  calls: [],
  async query(sql, params) {
    this.calls.push([sql, params]);
    const value = rows[params[0]];
    return [value === undefined ? [] : [{ id: params[0], access_technology: value }]];
  },
});

describe('which technology a contract is', () => {
  test('the one it was written for', () => {
    expect(tech.effectiveTechnology('ftth', 'both')).toBe('ftth');
    expect(tech.effectiveTechnology('wisp', 'both')).toBe('wisp');
  });

  test('a contract from before the migration follows its plan', () => {
    expect(tech.effectiveTechnology(null, 'ftth')).toBe('ftth');
    expect(tech.effectiveTechnology(null, 'wisp')).toBe('wisp');
    expect(tech.effectiveTechnology(undefined, 'both')).toBe('wisp');
    expect(tech.effectiveTechnology(null, undefined)).toBe('wisp');
    expect(tech.effectiveTechnology('satellite', 'ftth')).toBe('ftth');
  });

  test('the SQL form is the same rule', () => {
    expect(tech.effectiveTechnologySql('c', 'p'))
      .toBe("COALESCE(c.access_technology, IF(p.access_technology = 'ftth', 'ftth', 'wisp'))");
    expect(() => tech.effectiveTechnologySql('c; DROP', 'p')).toThrow();
  });
});

describe('a new contract', () => {
  test('takes the technology of a plan offered over one', () => {
    expect(plans.technologyForNewContract('wisp', undefined)).toBe('wisp');
    expect(plans.technologyForNewContract('ftth', null)).toBe('ftth');
    expect(plans.technologyForNewContract('ftth', 'ftth')).toBe('ftth');
    // A plan row from before the migration.
    expect(plans.technologyForNewContract(undefined, undefined)).toBe('wisp');
  });

  test('cannot ask for a technology its plan is not offered over', () => {
    expect(() => plans.technologyForNewContract('wisp', 'ftth')).toThrow(expect.objectContaining({ statusCode: 422, code: 'TECHNOLOGY_NOT_OFFERED' }));
  });

  test('must say which, when the plan is offered over both', () => {
    expect(() => plans.technologyForNewContract('both', undefined)).toThrow(expect.objectContaining({ statusCode: 422, code: 'TECHNOLOGY_REQUIRED' }));
    expect(plans.technologyForNewContract('both', 'ftth')).toBe('ftth');
    expect(plans.technologyForNewContract('both', 'wisp')).toBe('wisp');
  });

  test('the create route writes the technology resolved from the plan it just checked', () => {
    expect(read('src', 'routes', 'contracts.js'))
      .toMatch(/const plan = await assertPlanSelectable\(conn, filtered\.plan_id, req\.orgId\);\n\n[^\n]*\n\s+filtered\.access_technology = technologyForNewContract\(plan\.access_technology, filtered\.access_technology\);/);
  });
});

describe('an existing contract keeps its technology', () => {
  const { updateContractWithActivationGuard } = require('../src/services/contractUpdateGuard');
  const wispContract = { id: 5, plan_id: 1, access_technology: 'wisp' };

  test('moving it to a plan of the other technology is refused', async () => {
    const db = withPlans({ 1: 'wisp', 2: 'ftth', 3: 'both' });
    await expect(plans.assertPlanKeepsTechnology(db, wispContract, 2, 9))
      .rejects.toMatchObject({ statusCode: 422, code: 'TECHNOLOGY_CHANGE_NEEDS_NEW_CONTRACT' });
    await expect(plans.assertPlanKeepsTechnology(db, wispContract, 3, 9)).resolves.toBe('wisp');
    await expect(plans.assertPlanKeepsTechnology(db, wispContract, 1, 9)).resolves.toBe('wisp');
    await expect(plans.assertPlanKeepsTechnology(db, { id: 6, plan_id: 3, access_technology: 'ftth' }, 1, 9))
      .rejects.toMatchObject({ code: 'TECHNOLOGY_CHANGE_NEEDS_NEW_CONTRACT' });
  });

  test('a contract from before the migration counts as its plan\'s technology', async () => {
    const db = withPlans({ 1: 'wisp', 2: 'ftth' });
    await expect(plans.assertPlanKeepsTechnology(db, { id: 7, plan_id: 1, access_technology: null }, 2, 9))
      .rejects.toMatchObject({ code: 'TECHNOLOGY_CHANGE_NEEDS_NEW_CONTRACT' });
  });

  test('an update cannot set another technology', async () => {
    const db = withPlans({ 1: 'wisp' });
    await expect(updateContractWithActivationGuard(wispContract, { access_technology: 'ftth' }, 9, db))
      .rejects.toMatchObject({ statusCode: 422, code: 'TECHNOLOGY_CHANGE_NEEDS_NEW_CONTRACT' });
    // Nothing was written.
    expect(db.calls.some(([sql]) => /UPDATE/i.test(sql))).toBe(false);
  });

  test('an update that changes the plan is checked before anything is written', async () => {
    const db = withPlans({ 1: 'wisp', 2: 'ftth' });
    await expect(updateContractWithActivationGuard(wispContract, { plan_id: 2 }, 9, db))
      .rejects.toMatchObject({ code: 'TECHNOLOGY_CHANGE_NEEDS_NEW_CONTRACT' });
    expect(db.calls.some(([sql]) => /UPDATE/i.test(sql))).toBe(false);
  });

  test('every way to re-plan a contract goes through one of the two checks', () => {
    const routes = read('src', 'routes', 'contracts.js');
    // PUT and the batch plan change use the guard; renew checks directly.
    expect(read('src', 'services', 'automationService.js')).toMatch(/updateContractWithActivationGuard\(rows\[0\], \{ plan_id: params\.plan_id \}/);
    expect(routes).toMatch(/await assertPlanSelectable\(db, req\.body\.plan_id, req\.orgId\);\n\s+await assertPlanKeepsTechnology\(db, contract, req\.body\.plan_id, req\.orgId\);/);
  });
});

describe('where it is stored and shown', () => {
  test('plans and contracts accept the field with their own allowed values', () => {
    expect(require('../src/models/Plan').fillable).toContain('access_technology');
    expect(require('../src/models/Contract').fillable).toContain('access_technology');
    for (const schema of Object.values(require('../src/middleware/schemas/plans')).filter((s) => s && s.access_technology)) {
      expect(schema.access_technology.enum).toEqual(['wisp', 'ftth', 'both']);
    }
    for (const schema of Object.values(require('../src/middleware/schemas/contracts')).filter((s) => s && s.access_technology)) {
      expect(schema.access_technology.enum).toEqual(['wisp', 'ftth']);
    }
  });

  test('existing plans and contracts stay WISP after the migration', () => {
    const sql = read('database', 'migrations', '018_access_technology.sql');
    expect(sql).toMatch(/ADD COLUMN access_technology ENUM\('wisp','ftth','both'\) NOT NULL DEFAULT 'wisp'/);
    expect(sql).toMatch(/ADD COLUMN access_technology ENUM\('wisp','ftth'\) NULL DEFAULT NULL/);
  });

  test('GraphQL reports the technology, with the plan lookup scoped to the organization', () => {
    expect(read('src', 'graphql', 'typeDefs.js')).toMatch(/accessTechnology: String/);
    expect(read('src', 'graphql', 'resolvers.js'))
      .toMatch(/SELECT access_technology FROM plans WHERE id = \? AND \(organization_id = \? OR organization_id IS NULL\) LIMIT 1/);
  });

  test('the edit-contract form has no technology field; the new-contract form asks only for a plan offered over both', () => {
    expect(read('frontend', 'src', 'pages', 'contracts', 'EditContractModal.tsx').replace(/access_technology\?: string \| null;/, '')).not.toMatch(/access_technology|accessTechnology/);
    const list = read('frontend', 'src', 'pages', 'ContractList.tsx');
    expect(list).toMatch(/const planOfferedOverBoth = plans\.find\(p => String\(p\.id\) === form\.plan_id\)\?\.access_technology === 'both';/);
    expect(list).toMatch(/\{planOfferedOverBoth && \(/);
  });
});

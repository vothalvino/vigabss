'use strict';
// =============================================================================
// VigaBSS 5.0 — a failed TYPE check must stop the range checks
// =============================================================================
// The min/max branches in validate() key off the RUNTIME type of the value, not
// the DECLARED type in the schema. So a string sent for a {type:'number',max:1}
// field failed the number check AND then also fell into the STRING-length
// branch, reporting "must be at most 1 characters".
//
// Found on the IVA rate field, where max:1 is the numeric ceiling (1.0 = 100%).
// An operator setting their tax rate read "at most 1 characters" as a one-digit
// limit — a wrong constraint, on the fiscal config path, stated with authority.
// =============================================================================

const { validate } = require('../src/middleware/validate');

// validate() reports by calling next(new ValidationError(...)) — it never
// touches res — so the harness captures the next() argument.
function run(schema, body) {
  const req = { body };
  let err;
  validate(schema)(req, {}, (e) => { err = e; });
  return { nexted: err === undefined, errors: err ? (err.details ?? err.errors ?? []) : [] };
}

describe('a type failure suppresses the range message', () => {
  it('does not claim "characters" for a numeric max', () => {
    const { nexted, errors } = run({ rate: { type: 'number', min: 0, max: 1 } }, { rate: '0.1600' });
    expect(nexted).toBe(false);
    expect(errors.map(e => e.message)).toEqual(['rate must be a number']);
    expect(JSON.stringify(errors)).not.toMatch(/characters/);
  });

  it('reports the type error once, not once per rule', () => {
    // Two errors for one field is what made the wrong wording so confusing.
    const { errors } = run({ rate: { type: 'number', min: 0, max: 1 } }, { rate: 'abc' });
    expect(errors.filter(e => e.field === 'rate')).toHaveLength(1);
  });

  it('still reports a genuine numeric range violation', () => {
    const { errors } = run({ rate: { type: 'number', min: 0, max: 1 } }, { rate: 5 });
    expect(errors.map(e => e.message)).toEqual(['rate must be at most 1']);
  });

  it('still says "characters" for a real string length', () => {
    const { errors } = run({ name: { type: 'string', max: 3 } }, { name: 'abcdef' });
    expect(errors.map(e => e.message)).toEqual(['name must be at most 3 characters']);
  });

  it('lets a valid value through', () => {
    const { nexted, errors } = run({ rate: { type: 'number', min: 0, max: 1 } }, { rate: 0.16 });
    expect(nexted).toBe(true);
    expect(errors).toEqual([]);
  });
});

// 'integer' was not a type validate() knew, so it checked nothing: the
// password policy took "abc" or 9.5, and min/max measured a string's length.
describe("type: 'integer'", () => {
  const schema = { min_length: { type: 'integer', min: 8, max: 128 } };

  it('accepts a whole number in range', () => {
    expect(run(schema, { min_length: 12 }).nexted).toBe(true);
  });

  it.each([['a string', 'abc'], ['a numeric string', '12'], ['a fraction', 9.5], ['a boolean', true]])('refuses %s', (_label, value) => {
    const { nexted, errors } = run(schema, { min_length: value });
    expect(nexted).toBe(false);
    expect(errors.map(e => e.message)).toEqual(['min_length must be a whole number']);
  });

  it('applies the numeric range, not a string length', () => {
    const { errors } = run(schema, { min_length: 4 });
    expect(errors.map(e => e.message)).toEqual(['min_length must be at least 8']);
  });
});

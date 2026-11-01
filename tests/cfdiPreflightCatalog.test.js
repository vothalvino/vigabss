// =============================================================================
// CFD-12 — CFDI 4.0 text and rate rules are checked before the PAC
// =============================================================================
// '|' and control characters in Descripcion/Nombre, a Nombre over 254
// characters, or a back-derived IVA rate such as 0.161000 reached the PAC,
// which rejected the document and stranded the draft.

const { cfdiText, nombreProblem, catalogIvaRate } = require('../src/utils/satCatalogs');
const { validate } = require('../src/middleware/validate');
const { updateMxProfile } = require('../src/middleware/schemas/clients');

test('Descripcion text loses pipes and control characters', () => {
  expect(cfdiText('Internet 100M | Fibra\u0007\nHogar')).toBe('Internet 100M / Fibra Hogar');
  expect(cfdiText('x'.repeat(1200))).toHaveLength(1000);
});

test.each([
  ['A'.repeat(255), /at most 254/],
  ['ACME | SA DE CV', /'\|'/],
  ['ACME\u0001', /control character/],
])('Nombre %#: refused with a reason', (name, reason) => {
  expect(nombreProblem(name)).toMatch(reason);
});

test('a plain Nombre is fine', () => {
  expect(nombreProblem('ESCUELA KEMPER URGATE')).toBeNull();
});

test.each([
  [0.161, 0.16], [0.1595, 0.16], [0.16, 0.16], [0.0801, 0.08], [0, 0],
])('rate %s files as catalog rate %s', (rate, catalog) => {
  expect(catalogIvaRate(rate)).toBe(catalog);
});

test.each([[0.12], [0.05], [0.17]])('rate %s is not an IVA rate SAT accepts', (rate) => {
  expect(catalogIvaRate(rate)).toBeNull();
});

test('the client MX profile refuses a razón social SAT cannot file', () => {
  const run = (razon) => {
    let err;
    validate(updateMxProfile)({ body: { rfc: 'MISC491214B86', razon_social: razon, regimen_fiscal: '612', codigo_postal_fiscal: '01010' } }, {}, (e) => { err = e; });
    return err;
  };
  expect(run('A'.repeat(255))).toMatchObject({ statusCode: 422 });
  expect(run('ACME | SA')).toMatchObject({ statusCode: 422 });
  expect(run('ACME SA DE CV')).toBeUndefined();
});

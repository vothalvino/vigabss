// =============================================================================
// TNA-33 — page and limit parsing never yields NaN and list limits are capped
// =============================================================================
// Math.max(1, parseInt('abc', 10)) is NaN, so `?page=abc` built
// `LIMIT n OFFSET NaN` and the request failed with a 500; the same held for
// parseInt(x || '1', 10) and (parseInt(page) - 1) * limit. Many list limits
// had no upper bound, so one request could buffer a whole table. Every page
// or limit parse in src/ falls back to a default and every limit is capped.
// =============================================================================
'use strict';

jest.mock('../src/config/database', () => ({ query: jest.fn(), queryReplica: jest.fn() }));

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function sourceLines() {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
          out.push({ where: `${path.relative(SRC, full)}:${i + 1}`, line });
        });
      }
    }
  })(SRC);
  return out.filter(({ line }) => /page|limit/i.test(line) && !line.includes('process.env'));
}

const lines = sourceLines();
const offenders = (test) => lines.filter(({ line }) => test(line)).map(({ where, line }) => `${where}: ${line.trim()}`);

test('no Math.max(1, parseInt(x)) without a fallback for NaN', () => {
  expect(offenders(line => [...line.matchAll(/Math\.max\(1,\s*parseInt\(([^()]*)\)\)/g)]
    .some(m => !m[1].includes('||')))).toEqual([]);
});

test("no parseInt(x || 'N') default, which is still NaN for non-numeric input", () => {
  expect(offenders(line => /parseInt\(\s*[\w.]+\s*\|\|\s*'\d+'/.test(line))).toEqual([]);
});

test('no (parseInt(page) - 1) offset without a fallback', () => {
  expect(offenders(line => /\(\s*parseInt\(\s*(?:page|req\.query\.page)[^()]*\)\s*-\s*1\s*\)/.test(line))).toEqual([]);
});

test('every parsed limit is capped', () => {
  expect(offenders(line => /Math\.max\(1,\s*parseInt\([^()]*limit[^()]*\)/i.test(line) && !/Math\.min/.test(line)))
    .toEqual([]);
});

describe('crudController list', () => {
  const { crudController } = require('../src/controllers/crudController');
  const Model = {
    findAll: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };

  test('a non-numeric page or limit falls back to the defaults, and the cap drives offset and meta', async () => {
    const ctrl = crudController(Model);
    const res = { json: jest.fn() };
    await ctrl.list({ query: { page: 'abc', limit: 'x' }, orgId: 1 }, res, (err) => { throw err; });
    expect(Model.findAll).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 50, offset: 0 }));
    expect(res.json.mock.calls[0][0].meta).toMatchObject({ page: 1, limit: 50 });

    await ctrl.list({ query: { page: '3', limit: '1000' }, orgId: 1 }, res, (err) => { throw err; });
    expect(Model.findAll).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 100, offset: 200 }));
    expect(res.json.mock.calls[1][0].meta).toMatchObject({ page: 3, limit: 100 });
  });
});

// A response and a db.query answer for the streamed /export controllers
// (DAL-13): COUNT, the access-log insert, then the rows in one batch.

function csvRes() {
  const chunks = [];
  const res = {
    destroyed: false,
    set: jest.fn(() => res),
    write: jest.fn((chunk) => { chunks.push(chunk); return true; }),
    end: jest.fn(),
    on: jest.fn(),
    off: jest.fn(),
    destroy: jest.fn(() => { res.destroyed = true; }),
    body: () => chunks.join(''),
  };
  return res;
}

function exportQueries(rows) {
  let served = false;
  return async (sql) => {
    if (/COUNT\(\*\)/.test(sql)) return [[{ total: rows.length }]];
    if (/INSERT INTO report_access_logs/.test(sql)) return [{ insertId: 1 }];
    if (served) return [[]];
    served = true;
    return [rows];
  };
}

module.exports = { csvRes, exportQueries };

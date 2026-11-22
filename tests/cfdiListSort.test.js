// The CFDI list sorts by the columns its page offers. Lifecycle columns
// (sat_status, stamp_date, pac_provider, uuid) are not fillable, since only
// the stamp and cancel flows may set them, but ordering by them must work.
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const db = require('../src/config/database');
const CfdiDocument = require('../src/models/CfdiDocument');

beforeEach(() => { jest.clearAllMocks(); db.query.mockResolvedValue([[]]); });

test.each(['id', 'tipo_comprobante', 'receptor_rfc', 'total', 'created_at', 'sat_status', 'pac_provider'])(
  'orders by %s when asked', async (column) => {
    await CfdiDocument.findAll({ orgId: 1, orderBy: column, order: 'DESC' });
    expect(db.query.mock.calls[0][0]).toContain(`ORDER BY \`${column}\` DESC`);
  },
);

test('an unknown column falls back to id, and lifecycle columns stay unwritable', async () => {
  await CfdiDocument.findAll({ orgId: 1, orderBy: 'signed_xml; DROP TABLE x', order: 'ASC' });
  expect(db.query.mock.calls[0][0]).toContain('ORDER BY `id` ASC');
  for (const column of ['sat_status', 'stamp_date', 'pac_provider', 'uuid']) {
    expect(CfdiDocument.fillable).not.toContain(column);
  }
});

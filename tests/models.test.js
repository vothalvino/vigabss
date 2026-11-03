// =============================================================================
// VigaBSS 5.0 — BaseModel Unit Tests
// =============================================================================

jest.mock('../src/config/database', () => ({
  query: jest.fn(),
  execute: jest.fn(),
  getConnection: jest.fn(),
  close: jest.fn(),
  pool: { end: jest.fn() },
}));

const db = require('../src/config/database');
const BaseModel = require('../src/models/BaseModel');

// Create a concrete subclass for testing
class TestModel extends BaseModel {
  static get tableName() { return 'test_table'; }
  static get fillable() { return ['name', 'email', 'status']; }
  static get hasOrgScope() { return true; }
  // A service-managed column that must be filterable but never writable.
  static get filterableColumns() { return ['lifecycle_state']; }
}

describe('BaseModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('tableName throws if not overridden', () => {
    expect(() => BaseModel.tableName).toThrow('Subclass must define tableName');
  });

  test('findById queries by ID', async () => {
    db.query.mockResolvedValue([[{ id: 1, name: 'Test' }]]);
    const result = await TestModel.findById(1, BaseModel.UNSCOPED);
    expect(result).toEqual({ id: 1, name: 'Test' });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = ?'),
      [1],
    );
  });

  test('findById with orgScope adds organization filter', async () => {
    db.query.mockResolvedValue([[{ id: 1, name: 'Test' }]]);
    await TestModel.findById(1, 42);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('AND organization_id = ?'),
      [1, 42],
    );
  });

  test('findById returns null when not found', async () => {
    db.query.mockResolvedValue([[]]);
    const result = await TestModel.findById(999, 42);
    expect(result).toBeNull();
  });

  test('findAll filters by a filterableColumns value (non-fillable but whitelisted)', async () => {
    db.query.mockResolvedValue([[]]);
    await TestModel.findAll({ where: { lifecycle_state: 'active' }, orgId: 42 });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('`lifecycle_state` = ?');
    expect(params).toContain('active');
  });

  test('findAll IGNORES a where column that is neither fillable nor filterable', async () => {
    db.query.mockResolvedValue([[]]);
    await TestModel.findAll({ where: { not_a_real_filter: 'x' }, orgId: 42 });
    const [sql] = db.query.mock.calls[0];
    expect(sql).not.toContain('not_a_real_filter');
  });

  test('BaseModel.filterableColumns defaults to empty', () => {
    expect(BaseModel.filterableColumns).toEqual([]);
  });

  test('findByIdOrFail throws NotFoundError', async () => {
    db.query.mockResolvedValue([[]]);
    await expect(TestModel.findByIdOrFail(999, 42)).rejects.toThrow('not found');
  });

  test('create filters to fillable columns', async () => {
    db.query
      .mockResolvedValueOnce([{ insertId: 1 }])  // INSERT
      .mockResolvedValueOnce([[{ id: 1, name: 'New' }]]);  // findById

    await TestModel.create({ name: 'New', email: 'a@b.com', secret_field: 'hack' });

    const insertCall = db.query.mock.calls[0];
    expect(insertCall[0]).not.toContain('secret_field');
    expect(insertCall[0]).toContain('name');
    expect(insertCall[0]).toContain('email');
  });

  test('create throws on empty data', async () => {
    await expect(TestModel.create({ secret_field: 'hack' })).rejects.toThrow('No fillable data');
  });

  test('update filters to fillable columns', async () => {
    db.query
      .mockResolvedValueOnce([{ affectedRows: 1 }])  // UPDATE
      .mockResolvedValueOnce([[{ id: 1, name: 'Updated' }]]);  // findById

    await TestModel.update(1, { name: 'Updated', secret_field: 'hack' }, 42);

    const updateCall = db.query.mock.calls[0];
    expect(updateCall[0]).not.toContain('secret_field');
    expect(updateCall[0]).toContain('name');
  });

  test('delete removes record', async () => {
    db.query.mockResolvedValue([{ affectedRows: 1 }]);
    const result = await TestModel.delete(1, 42);
    expect(result).toBe(true);
  });

  test('delete throws when record not found', async () => {
    db.query.mockResolvedValue([{ affectedRows: 0 }]);
    await expect(TestModel.delete(999, 42)).rejects.toThrow('not found');
  });

  test('count returns total', async () => {
    db.query.mockResolvedValue([[{ total: 42 }]]);
    const result = await TestModel.count({ orgId: 1 });
    expect(result).toBe(42);
  });

  test('findAll with pagination', async () => {
    db.query.mockResolvedValue([[{ id: 1 }, { id: 2 }]]);
    const result = await TestModel.findAll({ limit: 10, offset: 0, orgId: 1 });
    expect(result).toHaveLength(2);
  });
});

// TNB-34: the organization argument defaulted to null, and null dropped the
// tenant predicate, so an omitted argument read or wrote every organization.
describe('BaseModel org scoping fails closed', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each([
    ['findById', () => TestModel.findById(1)],
    ['findById with null', () => TestModel.findById(1, null)],
    ['findByIdOrFail', () => TestModel.findByIdOrFail(1)],
    ['findByIdIncludingDeleted', () => TestModel.findByIdIncludingDeleted(1)],
    ['findAll', () => TestModel.findAll({})],
    ['count', () => TestModel.count({})],
    ['update', () => TestModel.update(1, { name: 'x' })],
    ['delete', () => TestModel.delete(1)],
    ['forceDelete', () => TestModel.forceDelete(1)],
  ])('%s without an organization throws before any query', async (_name, call) => {
    await expect(call()).rejects.toThrow(/needs an organization id/);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('UNSCOPED is the explicit install-wide form', async () => {
    db.query.mockResolvedValue([[{ id: 1 }]]);
    await TestModel.findAll({ orgId: BaseModel.UNSCOPED });
    expect(db.query.mock.calls[0][0]).not.toMatch(/organization_id/);
  });

  test('a model without an organization column needs no argument', async () => {
    class Global extends BaseModel {
      static get tableName() { return 'global_table'; }
    }
    db.query.mockResolvedValue([[{ id: 1 }]]);
    await expect(Global.findById(1)).resolves.toEqual({ id: 1 });
  });
});

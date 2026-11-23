'use strict';
// =============================================================================
// Technology transition: a new, signed contract replaces the old one
// =============================================================================
// A subscriber changes between WISP and FTTH with a new contract. It names
// the contract it replaces, goes through the ordinary activation workflow
// (which requires the customer's signature), and when it is activated the old
// contract is terminated. Until then the old contract keeps working.
// =============================================================================

jest.mock('../src/utils/logger', () => ({ child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) }));
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const mockTerminate = jest.fn();
jest.mock('../src/services/contractTerminationService', () => ({ terminateContract: (...a) => mockTerminate(...a) }));

const fs = require('fs');
const path = require('path');
const db = require('../src/config/database');
const transition = require('../src/services/contractTransitionService');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

/** A transaction connection whose old contract and open replacement are scripted. */
function connWith({ old, open = [] }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push([sql.replace(/\s+/g, ' ').trim(), params]);
      if (/FOR UPDATE/.test(sql)) return [old ? [old] : []];
      return [open];
    },
  };
}
const wisp = { id: 10, client_id: 5, status: 'active', access_technology: 'wisp', plan_technology: 'wisp' };
const ask = (conn, over = {}) => transition.assertCanReplace(conn, { orgId: 3, clientId: 5, replacesId: 10, technology: 'ftth', ...over });

beforeEach(() => { db.query.mockReset(); mockTerminate.mockReset(); });

describe('what a new contract may replace', () => {
  test('a contract in service, of the same client, of the other technology', async () => {
    const conn = connWith({ old: wisp });
    await expect(ask(conn)).resolves.toMatchObject({ id: 10 });
    // The old contract is locked, so two replacements cannot be opened at once.
    expect(conn.calls[0][0]).toMatch(/WHERE c\.id = \? AND c\.organization_id = \? AND c\.deleted_at IS NULL FOR UPDATE$/);
    expect(conn.calls[0][1]).toEqual([10, 3]);
    await expect(ask(connWith({ old: { ...wisp, status: 'suspended' } }))).resolves.toBeTruthy();
  });

  test('not a contract of another organization or one that does not exist', async () => {
    await expect(ask(connWith({ old: null }))).rejects.toMatchObject({ statusCode: 422, code: 'REPLACED_CONTRACT_NOT_FOUND' });
  });

  test('not another client\'s contract', async () => {
    await expect(ask(connWith({ old: wisp }), { clientId: 6 })).rejects.toMatchObject({ code: 'REPLACED_CONTRACT_OTHER_CLIENT' });
  });

  test('not a contract that is not in service', async () => {
    for (const status of ['pending', 'cancelled', 'terminated', 'expired']) {
      await expect(ask(connWith({ old: { ...wisp, status } }))).rejects.toMatchObject({ code: 'REPLACED_CONTRACT_NOT_IN_SERVICE' });
    }
  });

  test('not for the same technology: that is a plan change, not a transition', async () => {
    await expect(ask(connWith({ old: wisp }), { technology: 'wisp' })).rejects.toMatchObject({ code: 'REPLACEMENT_SAME_TECHNOLOGY' });
    // A contract from before the technology existed counts as its plan's.
    await expect(ask(connWith({ old: { ...wisp, access_technology: null, plan_technology: 'ftth' } }))).rejects.toMatchObject({ code: 'REPLACEMENT_SAME_TECHNOLOGY' });
  });

  test('not while another replacement is still open', async () => {
    await expect(ask(connWith({ old: wisp, open: [{ id: 44 }] }))).rejects.toMatchObject({ code: 'REPLACEMENT_ALREADY_OPEN', message: expect.stringContaining('#44') });
  });
});

describe('when the new contract is activated', () => {
  test('the contract it replaces is terminated, with the reason recorded', async () => {
    db.query.mockResolvedValueOnce([[{ replaces_contract_id: 10 }]]);
    mockTerminate.mockResolvedValue({ id: 10, status: 'terminated' });
    await expect(transition.completeTransition(77, 3, { userId: 9 })).resolves.toEqual({ replaced_contract_id: 10, terminated: true });
    expect(mockTerminate).toHaveBeenCalledWith(10, 3, { userId: 9, summary: 'Replaced by contract #77' });
    expect(db.query.mock.calls[0]).toEqual(['SELECT replaces_contract_id FROM contracts WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [77, 3]]);
  });

  test('an ordinary contract terminates nothing', async () => {
    db.query.mockResolvedValueOnce([[{ replaces_contract_id: null }]]);
    await expect(transition.completeTransition(77, 3)).resolves.toBeNull();
    expect(mockTerminate).not.toHaveBeenCalled();
  });

  test('a problem ending the old contract never fails the activation', async () => {
    db.query.mockResolvedValueOnce([[{ replaces_contract_id: 10 }]]);
    mockTerminate.mockRejectedValue(new Error('RADIUS down'));
    await expect(transition.completeTransition(77, 3)).resolves.toEqual({ replaced_contract_id: 10, terminated: false, error: 'RADIUS down' });
  });

  test('an old contract someone already ended is not an error', async () => {
    db.query.mockResolvedValueOnce([[{ replaces_contract_id: 10 }]]);
    mockTerminate.mockRejectedValue(Object.assign(new Error('Cannot terminate'), { code: 'NOT_TERMINABLE' }));
    await expect(transition.completeTransition(77, 3)).resolves.toEqual({ replaced_contract_id: 10, terminated: false, error: null });
  });

  test('it runs after the activation has committed, and only for a permanent activation', () => {
    const src = read('src', 'services', 'lifecycleService.js');
    const commit = src.indexOf('permanentlyActivatedContractId = order.contract_id;');
    const hook = src.indexOf('.completeTransition(permanentlyActivatedContractId');
    expect(commit).toBeGreaterThan(0);
    expect(hook).toBeGreaterThan(commit);
    expect(src.slice(hook - 200, hook)).toMatch(/if \(permanentlyActivatedContractId\) \{/);
  });
});

describe('the signature is still required', () => {
  test('a replacement contract is created pending and activates through the same workflow', () => {
    const routes = read('src', 'routes', 'contracts.js');
    // Created like any contract: pending, then the transition check.
    expect(routes.indexOf("filtered.status = 'pending';")).toBeLessThan(routes.indexOf('contractTransitionService.assertCanReplace(conn'));
    // The workflow that activates a pending contract blocks on a missing signature.
    expect(read('src', 'services', 'contractActivationService.js')).toMatch(/blockers\.push\('signature_missing'\)/);
    // Nothing in the transition code touches signatures or activation state.
    const code = read('src', 'services', 'contractTransitionService.js').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(code).not.toMatch(/signature|signed|status = 'active'/i);
  });

  test('which contract is replaced cannot be changed after creation', async () => {
    const { updateContractWithActivationGuard } = require('../src/services/contractUpdateGuard');
    const runner = { query: jest.fn(async () => [[]]) };
    await expect(updateContractWithActivationGuard({ id: 77, plan_id: 1, replaces_contract_id: 10 }, { replaces_contract_id: 11 }, 3, runner))
      .rejects.toMatchObject({ statusCode: 422, code: 'REPLACEMENT_LINK_FIXED' });
    await expect(updateContractWithActivationGuard({ id: 77, plan_id: 1, replaces_contract_id: null }, { replaces_contract_id: 10 }, 3, runner))
      .rejects.toMatchObject({ code: 'REPLACEMENT_LINK_FIXED' });
  });
});

describe('how a contract relates to others', () => {
  test('reports what it replaces and the open or completed replacement, within the organization', async () => {
    db.query
      .mockResolvedValueOnce([[{ id: 77, replaces_contract_id: 10 }]])
      .mockResolvedValueOnce([[{ id: 10, status: 'active' }]])
      .mockResolvedValueOnce([[]]);
    await expect(transition.relations(77, 3)).resolves.toEqual({ replaces: { id: 10, status: 'active' }, replaced_by: null });
    for (const [sql, params] of db.query.mock.calls) {
      expect(sql).toMatch(/organization_id = \?/);
      expect(params).toContain(3);
    }
  });

  test('a cancelled replacement no longer counts', async () => {
    db.query.mockResolvedValueOnce([[{ id: 10, replaces_contract_id: null }]]).mockResolvedValueOnce([[]]);
    await transition.relations(10, 3);
    expect(db.query.mock.calls[1][0]).toMatch(/status IN \('pending', 'active', 'suspended'\)/);
  });
});

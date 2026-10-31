// =============================================================================
// CFD-01 — SAT cancellation answers are booked as what they mean
// =============================================================================
// EstatusUUID 201 was booked as a final 'cancelado' although it only means
// SAT registered the request (a cancellation needing receptor acceptance
// stays en proceso for up to 72 hours, and the receptor can refuse), and
// 202, 206-212 and 3xx all became 'pending' with no way out. Outcomes now
// come from EstatusCancelacion / the SAT consulta; refusals keep the CFDI
// vigente; pending ones are polled by poll_cfdi_cancellations.
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));

const db = require('../src/config/database');
const cfdiService = require('../src/services/cfdiService');
const taskRunner = require('../src/services/taskRunner');

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  db.query.mockReset();
});

describe('classifyCancellation', () => {
  test.each([
    [{ code: '201' }, 'pending', true],
    [{ code: 202 }, 'pending', true],
    [{ code: '201', cancellationStatus: 'Cancelado sin aceptación' }, 'accepted', false],
    [{ cancellationStatus: 'Plazo vencido' }, 'accepted', false],
    [{ estado: 'Cancelado' }, 'accepted', false],
    [{ code: '201', cancellationStatus: 'En proceso' }, 'pending', false],
    [{ cancellationStatus: 'Solicitud rechazada' }, 'rejected', false],
    [{ cancellationStatus: 'No cancelable' }, 'rejected', false],
    [{ code: 206 }, 'rejected', false],
    [{ code: 212 }, 'rejected', false],
    [{ code: 312 }, 'rejected', false],
  ])('%j → %s', (answer, status, registered) => {
    const outcome = cfdiService.classifyCancellation(answer);
    expect(outcome.status).toBe(status);
    expect(outcome.registered).toBe(registered);
    if (status === 'rejected') expect(outcome.error).toBeTruthy();
  });
});

describe('getCancellationStatus', () => {
  const pending = { id: 9, cfdi_document_id: 7, cancellation_status: 'pending', pac_provider_id: 10, uuid: 'U-1' };

  test('a resolved status is written only over a still-pending row and document', async () => {
    db.query
      .mockResolvedValueOnce([[pending]])
      .mockResolvedValueOnce([[{ id: 10, provider_name: 'dev_placeholder', environment: 'sandbox' }]])
      .mockResolvedValue([{ affectedRows: 0 }]); // someone else already settled it

    await cfdiService.getCancellationStatus(9);

    const [cancelSql] = db.query.mock.calls.find(([sql]) => /UPDATE cfdi_cancellations/.test(sql));
    expect(cancelSql).toContain("cancellation_status = 'pending'");
    const [docSql] = db.query.mock.calls.find(([sql]) => /UPDATE cfdi_documents/.test(sql));
    expect(docSql).toContain("sat_status IN ('vigente', 'cancel_pending')");
    // affectedRows 0: the invoice is not synced a second time
    expect(db.query.mock.calls.some(([sql]) => /SELECT invoice_id, organization_id FROM cfdi_documents/.test(sql))).toBe(false);
  });
});

describe('poll_cfdi_cancellations', () => {
  test('is an organization-scoped task that fans out per organization', () => {
    expect(taskRunner.ORGANIZATION_SCOPED_TASK_NAMES.has('poll_cfdi_cancellations')).toBe(true);
  });

  test("checks the org's pending cancellations whose CFDI is still cancel_pending", async () => {
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM cfdi_cancellations c\s+JOIN cfdi_documents d/.test(sql)) return [[{ id: 1 }, { id: 2 }]];
      if (/SELECT \* FROM cfdi_cancellations WHERE id = \?/.test(sql)) {
        // #1 was settled meanwhile; #2 has no PAC to ask and stays pending.
        return [[params[0] === 1
          ? { id: 1, cfdi_document_id: 7, cancellation_status: 'accepted' }
          : { id: 2, cfdi_document_id: 8, cancellation_status: 'pending', pac_provider_id: null }]];
      }
      return [[]];
    });

    const summary = await cfdiService.pollPendingCancellations(3);

    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain("c.cancellation_status = 'pending'");
    expect(sql).toContain("d.sat_status = 'cancel_pending'");
    expect(params).toEqual([3, 200]);
    expect(db.query.mock.calls.filter(([q]) => /SELECT \* FROM cfdi_cancellations WHERE id = \?/.test(q))).toHaveLength(2);
    expect(summary).toEqual({ checked: 2, resolved: 1, errors: 0 });
  });
});

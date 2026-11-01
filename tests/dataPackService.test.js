'use strict';

jest.mock('../src/config/database');
jest.mock('../src/services/rolloverService');
const db = require('../src/config/database');
const { mockTxConnection } = require('./fixtures/mockTxConnection');
const rolloverService = require('../src/services/rolloverService');
const billingService = require('../src/services/billingService');
const businessEvents = require('../src/services/businessEvents');
const dataPackService = require('../src/services/dataPackService');

describe('dataPackService', () => {
  let conn;
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    conn = mockTxConnection(db);
    jest.spyOn(billingService, 'createOneOffInvoice').mockResolvedValue({ id: 700, total: '58.00' });
    jest.spyOn(businessEvents, 'emitInvoiceCreated').mockResolvedValue(undefined);
  });

  describe('listPacks', () => {
    it('returns active packs for org and global', async () => {
      db.query.mockResolvedValueOnce([[{ id: 1, name: 'Basic 10GB', data_gb: '10.000' }]]);
      const packs = await dataPackService.listPacks(1);
      expect(packs).toHaveLength(1);
    });
  });

  describe('purchasePack', () => {
    it('creates a purchase for an active free pack without an invoice', async () => {
      db.query
        .mockResolvedValueOnce([[{ id: 10, client_id: 4 }]]) // contract ownership
        .mockResolvedValueOnce([[{ id: 1, name: '10GB Pack', data_gb: '10.000', validity_days: 30, price: '0.00' }]])
        .mockResolvedValueOnce([{ insertId: 5 }]) // INSERT (tx)
        .mockResolvedValueOnce([[{ id: 5, gb_applied: '10.000', pack_name: '10GB Pack' }]]);

      const purchase = await dataPackService.purchasePack(1, 10, 1, { purchasedBy: 'admin' });
      expect(purchase.id).toBe(5);
      expect(billingService.createOneOffInvoice).not.toHaveBeenCalled();
      expect(conn.commit).toHaveBeenCalledTimes(1);
    });

    // TNA-21: a priced pack was granted with no charge at all.
    it('bills a priced pack in the purchase transaction and stores the invoice', async () => {
      db.query
        .mockResolvedValueOnce([[{ id: 10, client_id: 4 }]])
        .mockResolvedValueOnce([[{ id: 1, name: '10GB Pack', data_gb: '10.000', validity_days: 30, price: '50.00', currency: 'MXN' }]])
        .mockResolvedValueOnce([{ insertId: 6 }])
        .mockResolvedValueOnce([[{ id: 6, invoice_id: 700 }]]);

      await dataPackService.purchasePack(1, 10, 1, { purchasedBy: 'client_portal' });

      expect(billingService.createOneOffInvoice).toHaveBeenCalledWith(expect.objectContaining({
        orgId: 1, clientId: 4, contractId: 10, amount: 50, currency: 'MXN', conn,
      }));
      const insert = conn.execute.mock.calls.find(([sql]) => /INSERT INTO data_pack_purchases/.test(sql));
      expect(insert[1][7]).toBe(700); // invoice_id
      expect(businessEvents.emitInvoiceCreated).toHaveBeenCalledWith(1, expect.objectContaining({ id: 700 }));
    });

    it('a failed invoice leaves no purchase', async () => {
      db.query
        .mockResolvedValueOnce([[{ id: 10, client_id: 4 }]])
        .mockResolvedValueOnce([[{ id: 1, name: '10GB Pack', data_gb: '10.000', validity_days: 30, price: '50.00' }]]);
      billingService.createOneOffInvoice.mockRejectedValue(new Error('numbering locked'));

      await expect(dataPackService.purchasePack(1, 10, 1, {})).rejects.toThrow(/numbering/);
      expect(conn.rollback).toHaveBeenCalled();
      expect(conn.execute.mock.calls.some(([sql]) => /INSERT INTO data_pack_purchases/.test(sql))).toBe(false);
    });

    it('throws 404 when pack not found', async () => {
      db.query
        .mockResolvedValueOnce([[{ id: 10 }]]) // contract ownership
        .mockResolvedValueOnce([[]]); // empty pack result

      await expect(dataPackService.purchasePack(1, 10, 999, {}))
        .rejects.toMatchObject({ status: 404 });
    });
  });

  describe('getEffectiveAllowance', () => {
    it('sums base cap + packs + rollover', async () => {
      db.query
        .mockResolvedValueOnce([[{ id: 10, organization_id: 1, data_cap_gb: '100.000' }]])
        .mockResolvedValueOnce([[{ pack_gb: '20.000' }]]);
      rolloverService.getRolloverBalance.mockResolvedValueOnce({ total_available_gb: 5.5, history: [] });

      const allowance = await dataPackService.getEffectiveAllowance(10, 1);
      expect(db.query.mock.calls[0][0]).toMatch(/c\.organization_id <=> \?/);
      expect(db.query.mock.calls[0][1]).toEqual([10, 1]);
      expect(allowance.total_gb).toBeCloseTo(125.5, 1);
      expect(allowance.base_cap_gb).toBe(100);
      expect(allowance.pack_gb).toBe(20);
    });

    it('returns null for non-existent contract', async () => {
      db.query.mockResolvedValueOnce([[]]); // no contract

      const allowance = await dataPackService.getEffectiveAllowance(999, 1);
      expect(allowance).toBeNull();
    });
  });

  describe('cancelPurchase', () => {
    it('cancels an active purchase', async () => {
      db.query
        .mockResolvedValueOnce([{ affectedRows: 1 }])
        .mockResolvedValueOnce([[{ id: 3, status: 'cancelled' }]]);

      const result = await dataPackService.cancelPurchase(3, 1);
      expect(result.status).toBe('cancelled');
    });
  });
});

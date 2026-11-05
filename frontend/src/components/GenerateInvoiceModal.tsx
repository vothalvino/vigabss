// =============================================================================
// VigaBSS 5.0 — Generate Invoice Modal (shared)
// =============================================================================
// Flexible multi-item invoice builder used by both the global Invoice List page
// and the Client detail page.
//
// Line-item types:
//   • contract — bill a contract's plan for the current period (contract picker;
//     this is the ONLY type that asks for a contract)
//   • product  — bill a catalog product, chosen from the plan add-on catalog
//     (auto-fills the price; editable). No contract needed.
//   • custom   — a free-text one-off charge (description + qty + price)
//
// Pass `lockedClientId` to pre-select + lock the client (e.g. when opened from a
// client's page). Otherwise a client selector is shown. The modal fetches its own
// clients / contracts / product catalog so callers just render it.
// =============================================================================

import { useState, useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import {
  overlay, modalBox, errorBox, labelStyle, inputStyle, submitBtn, cancelBtn,
  extractApiError,
} from '@/components/ClientFormModal';
import { fetchAddonCatalog, fetchSellableInventoryItems, buildProductPickerEntries } from '@/api/addonCatalog';
import { ClientPicker } from '@/components/ClientPicker';
import { useTranslation } from 'react-i18next';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Contract { id: number; client_id: number; }

type ItemType = 'contract' | 'product' | 'custom';

interface InvoiceLineItem {
  localId: string;
  type: ItemType;
  contractId: string;      // contract type
  productAddonId: string;  // product type (catalog selection)
  description: string;     // product (auto-filled from the catalog) / custom (free text)
  quantity: string;
  unitPrice: string;
}

interface FlexItem {
  type: ItemType;
  contract_id?: number;
  description?: string;
  quantity?: number;
  unit_price?: number;
  inventory_item_id?: number;
}

const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  contract: 'Contract charge',
  product:  'Product',
  custom:   'Custom item',
};

let _itemCounter = 0;
function makeItem(type: ItemType): InvoiceLineItem {
  return { localId: `item-${++_itemCounter}`, type, contractId: '', productAddonId: '', description: '', quantity: '1', unitPrice: '' };
}

// ---------------------------------------------------------------------------
// Data helpers
// ---------------------------------------------------------------------------

// The chosen client's contracts. This fetched every contract and filtered by
// client, but the list returns at most 100 (the oldest), so most clients'
// contracts never appeared (FE-04).
async function fetchClientContracts(clientId: string): Promise<Contract[]> {
  const res = await api.GET('/contracts', { params: { query: { client_id: clientId, limit: 100 } } });
  if (res.error) throw new Error('Failed to load contracts');
  return res.data.data;
}

async function generateFlexibleInvoice(clientId: number, items: FlexItem[]): Promise<void> {
  const { error } = await api.POST('/invoices/generate', {
    body: { client_id: clientId, items },
  });
  if (error) throw new Error(extractApiError(error, 'Failed to generate invoice'));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface GenerateInvoiceModalProps {
  /** Pre-select + lock the client (e.g. opened from the client's page). */
  lockedClientId?: number;
  /** Display name for the locked client (the clients list isn't fetched when locked). */
  lockedClientName?: string;
  onClose: () => void;
  onGenerated: () => void;
}

export function GenerateInvoiceModal({ lockedClientId, lockedClientName, onClose, onGenerated }: GenerateInvoiceModalProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [clientId, setClientId] = useState(lockedClientId ? String(lockedClientId) : '');
  // Start with no line — the user picks the type (product / contract charge /
  // custom) via the buttons, so we never force an empty `required` product line
  // (which would block submit, especially when the catalog is empty).
  const [items, setItems] = useState<InvoiceLineItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Self-fetch data. Client list only needed when the client isn't locked.
  const [clientName, setClientName] = useState(lockedClientName ?? '');
  const { data: clientContracts = [] } = useQuery({
    queryKey: ['client-contracts', clientId],
    queryFn: () => fetchClientContracts(clientId),
    enabled: !!clientId,
  });
  const { data: addonCatalog = [], isError: addonsError } = useQuery({ queryKey: ['addon-catalog'], queryFn: fetchAddonCatalog });
  const { data: sellableItems = [] } = useQuery({ queryKey: ['sellable-inventory-items'], queryFn: fetchSellableInventoryItems });
  // Product picker: UNION of the curated addon catalog and active inventory
  // items not already linked by one of those addons (Inventory follow-up —
  // an item is sellable directly, no addon detour required). Picking a
  // stock-backed entry tags the line with inventory_item_id, which
  // POST /invoices/generate now carries through to the created invoice_items
  // row and draws down in the same transaction — same behavior as
  // InvoiceDetail's per-item Add Item form.
  const addons = buildProductPickerEntries(addonCatalog, sellableItems);
  const loadError = addonsError;


  function addItem(type: ItemType) { setItems(prev => [...prev, makeItem(type)]); }
  function removeItem(localId: string) { setItems(prev => prev.filter(i => i.localId !== localId)); }
  function updateItem(localId: string, patch: Partial<InvoiceLineItem>) {
    setItems(prev => prev.map(i => i.localId === localId ? { ...i, ...patch } : i));
  }
  function selectAddon(localId: string, addonId: string) {
    const addon = addons.find(a => a.value === addonId);
    const current = items.find(i => i.localId === localId);
    // Inventory-linked lines must carry a WHOLE-number quantity — the
    // backend 422s otherwise (mirrors InvoiceDetail's AddInvoiceItemForm).
    // Reset a fractional quantity left over from a previous (unlinked)
    // selection so the input doesn't silently fail submit.
    const resetQuantity = addon?.inventory_item_id && current && !Number.isInteger(parseFloat(current.quantity));
    updateItem(localId, {
      productAddonId: addonId,
      description: addon ? addon.label : '',
      unitPrice: addon ? addon.price : '',
      ...(resetQuantity ? { quantity: '1' } : {}),
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId) { setError('Please select a client.'); return; }
    if (items.length === 0) { setError('Please add at least one item.'); return; }

    for (const item of items) {
      if (item.type === 'contract' && !item.contractId) {
        setError('Please select a contract for each contract-charge item.'); return;
      }
      if (item.type === 'product' && !item.productAddonId) {
        setError('Please select a product for each product item.'); return;
      }
      if ((item.type === 'product' || item.type === 'custom') && !item.description.trim()) {
        setError('Please enter a description for each product/custom item.'); return;
      }
      if ((item.type === 'product' || item.type === 'custom') && (!item.unitPrice || parseFloat(item.unitPrice) <= 0)) {
        setError('Please enter a unit price greater than zero for each product/custom item.'); return;
      }
      if (item.type === 'product') {
        const entry = addons.find(a => a.value === item.productAddonId);
        if (entry?.inventory_item_id && !Number.isInteger(parseFloat(item.quantity))) {
          setError('Quantity must be a whole number for a stock-linked product.'); return;
        }
      }
    }

    setSubmitting(true);
    setError('');
    try {
      const flexItems: FlexItem[] = items.map(item => {
        if (item.type === 'contract') {
          return { type: 'contract', contract_id: Number(item.contractId) };
        }
        const entry = item.type === 'product' ? addons.find(a => a.value === item.productAddonId) : undefined;
        return {
          type: item.type,
          description: item.description.trim(),
          quantity: parseFloat(item.quantity) || 1,
          unit_price: parseFloat(item.unitPrice) || 0,
          ...(entry?.inventory_item_id ? { inventory_item_id: entry.inventory_item_id } : {}),
        };
      });
      await generateFlexibleInvoice(Number(clientId), flexItems);
      onGenerated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate invoice');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label={t('ui.generateInvoiceModal.generateInvoice')}>
      <div style={{ ...modalBox, width: 520, maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ margin: '0 0 1rem' }}>{t('ui.generateInvoiceModal.generateInvoice')}</h3>
        {error && <div style={errorBox}>{error}</div>}
        {loadError && (
          <div style={errorBox}>{t('ui.generateInvoiceModal.someDataFailedToLoad')}</div>
        )}
        <form onSubmit={handleSubmit}>
          {/* Client selector — hidden/locked when opened from a client's page */}
          <ClientPicker
            label={t('ui.generateInvoiceModal.client')}
            value={clientId ? Number(clientId) : ''}
            initialName={clientName || (clientId ? `Client #${clientId}` : undefined)}
            disabled={!!lockedClientId}
            onChange={(id, name) => { setClientId(id ? String(id) : ''); setClientName(name); setItems([]); }}
          />

          {/* Line items */}
          <div style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontWeight: 600, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('ui.generateInvoiceModal.invoiceItems')}</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['contract', 'product', 'custom'] as ItemType[]).map(type => (
                  <button key={type} type="button" onClick={() => addItem(type)} style={addItemBtn} title={`Add ${ITEM_TYPE_LABELS[type]}`}>
                    + {ITEM_TYPE_LABELS[type]}
                  </button>
                ))}
              </div>
            </div>

            {items.length === 0 && (
              <p style={{ fontSize: '0.82rem', color: '#9ca3af', textAlign: 'center', padding: '0.75rem 0' }}>
                {t('ui.generateInvoiceModal.useTheButtonsAboveTo')}
              </p>
            )}

            {items.map((item, idx) => {
              // Inventory-linked lines require a whole-number quantity (see
              // selectAddon / handleSubmit) — mirrors InvoiceDetail's
              // AddInvoiceItemForm min/step swap.
              const selectedEntry = item.type === 'product' ? addons.find(a => a.value === item.productAddonId) : undefined;
              const isInventoryLinked = !!selectedEntry?.inventory_item_id;
              return (
              <div
                key={item.localId}
                style={{
                  border: '1px solid var(--border-strong)', borderRadius: 6,
                  padding: '0.6rem 0.75rem', marginBottom: 8, background: 'var(--bg-card)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--accent)' }}>
                    {idx + 1}. {ITEM_TYPE_LABELS[item.type]}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeItem(item.localId)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', fontSize: '1rem', lineHeight: 1 }}
                    aria-label={t('ui.generateInvoiceModal.removeItem')}
                  >×</button>
                </div>

                {item.type === 'contract' && (
                  /* Contract charge: the only type that asks for a contract */
                  <>
                    <label htmlFor={`${fieldId}-1`} style={{ ...labelStyle, marginTop: 0 }}>{t('ui.generateInvoiceModal.contract')}</label>
                    <select id={`${fieldId}-1`}
                      style={inputStyle}
                      value={item.contractId}
                      onChange={e => updateItem(item.localId, { contractId: e.target.value })}
                      disabled={!clientId}
                      required
                    >
                      <option value="">{t('ui.generateInvoiceModal.selectContract')}</option>
                      {clientContracts.map(c => <option key={c.id} value={c.id}>{t('ui.generateInvoiceModal.contract2')}{c.id}</option>)}
                    </select>
                  </>
                )}

                {item.type === 'product' && (
                  /* Product: choose from the add-on catalog; price auto-fills (editable) */
                  <>
                    <label htmlFor={`${fieldId}-2`} style={{ ...labelStyle, marginTop: 0 }}>{t('ui.generateInvoiceModal.product')}</label>
                    <select id={`${fieldId}-2`}
                      style={inputStyle}
                      value={item.productAddonId}
                      onChange={e => selectAddon(item.localId, e.target.value)}
                      required
                    >
                      <option value="">
                        {addons.length
                          ? '— select product —'
                          : addonsError ? '— failed to load products —' : '— no products in catalog —'}
                      </option>
                      {addons.map(a => (
                        <option key={a.value} value={a.value}>{a.label} ({a.price})</option>
                      ))}
                    </select>
                    {addons.length === 0 && !addonsError && (
                      <p style={{ fontSize: '0.74rem', color: '#9ca3af', margin: '4px 0 0' }}>
                        {t('ui.generateInvoiceModal.addProductsUnderPlansAdd')}
                      </p>
                    )}
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      <div style={{ flex: 1 }}>
                        <label htmlFor={`${fieldId}-3`} style={labelStyle}>{t('ui.generateInvoiceModal.quantity')}</label>
                        <input id={`${fieldId}-3`} style={inputStyle} type="number" min={isInventoryLinked ? '1' : '0.01'} step={isInventoryLinked ? '1' : 'any'} value={item.quantity}
                          onChange={e => updateItem(item.localId, { quantity: e.target.value })} />
                      </div>
                      <div style={{ flex: 2 }}>
                        <label htmlFor={`${fieldId}-4`} style={labelStyle}>{t('ui.generateInvoiceModal.unitPrice')}</label>
                        <input id={`${fieldId}-4`} style={inputStyle} type="number" min="0.01" step="0.01" placeholder="0.00" value={item.unitPrice}
                          onChange={e => updateItem(item.localId, { unitPrice: e.target.value })} required />
                      </div>
                    </div>
                  </>
                )}

                {item.type === 'custom' && (
                  /* Custom: free-text one-off charge */
                  <>
                    <label htmlFor={`${fieldId}-5`} style={{ ...labelStyle, marginTop: 0 }}>{t('ui.generateInvoiceModal.description')}</label>
                    <input id={`${fieldId}-5`} style={inputStyle} type="text" placeholder={t('ui.generateInvoiceModal.eGInstallationFee')} value={item.description}
                      onChange={e => updateItem(item.localId, { description: e.target.value })} required />
                    <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                      <div style={{ flex: 1 }}>
                        <label htmlFor={`${fieldId}-6`} style={labelStyle}>{t('ui.generateInvoiceModal.quantity')}</label>
                        <input id={`${fieldId}-6`} style={inputStyle} type="number" min="0.01" step="any" value={item.quantity}
                          onChange={e => updateItem(item.localId, { quantity: e.target.value })} />
                      </div>
                      <div style={{ flex: 2 }}>
                        <label htmlFor={`${fieldId}-7`} style={labelStyle}>{t('ui.generateInvoiceModal.unitPrice')}</label>
                        <input id={`${fieldId}-7`} style={inputStyle} type="number" min="0.01" step="0.01" placeholder="0.00" value={item.unitPrice}
                          onChange={e => updateItem(item.localId, { unitPrice: e.target.value })} required />
                      </div>
                    </div>
                  </>
                )}
              </div>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 8, marginTop: '1rem', justifyContent: 'flex-end' }}>
            <button type="button" onClick={onClose} style={cancelBtn}>{t('ui.generateInvoiceModal.cancel')}</button>
            <button type="submit" style={submitBtn} disabled={submitting}>
              {submitting ? 'Generating…' : 'Generate'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const addItemBtn: React.CSSProperties = {
  background: 'var(--bg-card)', color: 'var(--accent)', border: '1px solid var(--accent)',
  padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
  fontWeight: 600, fontSize: '0.72rem',
};

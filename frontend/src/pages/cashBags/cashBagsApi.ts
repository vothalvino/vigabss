// =============================================================================
// Cash bags and carriers (staff) — requests to /cash-bags, /carriers and
// /resellers/:id/bags
// =============================================================================
// The ISP registers numbered cash bags, hands batches to a carrier, the
// carrier drops them empty at resellers, a reseller seals one with the cash
// it declares, the carrier picks it up (in_transit) and the ISP counts it on
// arrival (received): the declared amount is booked as a deposit on the
// reseller's ledger and a count difference as an adjustment. Shapes are
// declared here (like puntoApi.ts) and read tolerantly, so a renamed field
// shows a dash instead of breaking the page.
// =============================================================================

import { ApiRequestError, apiFetch } from '@/api/apiFetch';

export const BAG_STATUSES = ['in_stock', 'with_carrier', 'at_reseller', 'ready_for_pickup', 'in_transit', 'received', 'void', 'lost'] as const;
export type BagStatus = typeof BAG_STATUSES[number];

export interface CashBag {
  id: number;
  serial: string;
  status: BagStatus | string;
  reseller_id: number | null;
  reseller_name: string | null;
  carrier_user_id: number | null;
  carrier_name: string | null;
  declared_amount: number | string | null;
  counted_amount: number | string | null;
  variance: number | string | null;
  currency: string | null;
  sealed_at: string | null;
  picked_up_at: string | null;
  received_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  notes: string | null;
}

export interface CashBagEvent {
  id: number;
  from_status: string | null;
  to_status: string;
  actor_name: string | null;
  amount: number | string | null;
  reseller_name: string | null;
  carrier_name: string | null;
  note: string | null;
  created_at: string | null;
}

export interface CashBagDetail extends CashBag { events: CashBagEvent[] }

export interface ListMeta { total: number; page: number; limit: number }

export interface ResellerVariance { reseller_id: number; reseller_name: string; variance: number | string; received: number }

export interface CashBagSummary {
  counts: Record<string, number>;
  /** Declared cash of bags ready for pickup or on their way; already off the resellers' ledgers. */
  in_bags: number | string | null;
  resellers: ResellerVariance[];
}

export interface Carrier {
  user_id: number;
  name: string;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  resellers: { id: number; name: string }[];
  with_carrier: number;
  in_transit: number;
}

export interface ReceiveResult {
  bag: CashBag | null;
  ledger: { entry_type: string; amount: number | string; note: string | null }[];
  summary: Record<string, unknown> | null;
}

export interface RegisterResult { created: string[]; skipped: string[] }

export const cashBagKeys = {
  all: ['cash-bags'] as const,
  list: (filters: Record<string, string | number | null>) => ['cash-bags', 'list', filters] as const,
  summary: ['cash-bags', 'summary'] as const,
  detail: (id: number) => ['cash-bags', 'detail', id] as const,
  carriers: ['cash-bags', 'carriers'] as const,
  carrierResellers: (userId: number) => ['cash-bags', 'carrier-resellers', userId] as const,
  assignableResellers: ['cash-bags', 'assignable-resellers'] as const,
  resellerBags: (resellerId: number, page: number) => ['cash-bags', 'reseller', resellerId, page] as const,
};

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : {});
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const idOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : num(v));
const money = (v: unknown): number | string | null => (v === null || v === undefined || v === '' ? null : (typeof v === 'number' ? v : String(v)));

/** A DECIMAL that may arrive as a string. */
export function toAmount(v: number | string | null | undefined): number {
  const n = typeof v === 'number' ? v : parseFloat(v ?? '');
  return Number.isFinite(n) ? n : 0;
}

function personName(v: unknown, fallback: unknown): string | null {
  const o = obj(v);
  const joined = [o.first_name, o.last_name].filter(Boolean).join(' ');
  return str(o.name) ?? (joined || null) ?? str(fallback);
}

export function toCashBag(raw: Raw): CashBag {
  const declared = money(raw.declared_amount);
  const counted = money(raw.counted_amount);
  const variance = raw.variance !== undefined && raw.variance !== null
    ? money(raw.variance)
    : declared !== null && counted !== null ? Math.round((toAmount(counted) - toAmount(declared)) * 100) / 100 : null;
  return {
    id: num(raw.id),
    serial: String(raw.serial ?? ''),
    status: String(raw.status ?? ''),
    reseller_id: idOrNull(raw.reseller_id),
    reseller_name: str(raw.reseller_name) ?? personName(raw.reseller, null),
    carrier_user_id: idOrNull(raw.carrier_user_id),
    carrier_name: str(raw.carrier_name) ?? personName(raw.carrier, null),
    declared_amount: declared,
    counted_amount: counted,
    variance,
    currency: str(raw.currency),
    sealed_at: str(raw.sealed_at),
    picked_up_at: str(raw.picked_up_at),
    received_at: str(raw.received_at),
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
    notes: str(raw.notes),
  };
}

export function toCashBagEvent(raw: Raw): CashBagEvent {
  return {
    id: num(raw.id),
    from_status: str(raw.from_status),
    to_status: String(raw.to_status ?? ''),
    actor_name: str(raw.actor_name) ?? personName(raw.actor, raw.actor_user_id ? `#${raw.actor_user_id}` : null),
    amount: money(raw.amount),
    reseller_name: str(raw.reseller_name),
    carrier_name: str(raw.carrier_name),
    note: str(raw.note),
    created_at: str(raw.created_at),
  };
}

export function toSummary(raw: Raw): CashBagSummary {
  const countsRaw = raw.counts ?? raw.by_status ?? raw.status_counts;
  const counts: Record<string, number> = {};
  if (Array.isArray(countsRaw)) {
    for (const c of countsRaw) counts[String(obj(c).status)] = num(obj(c).count ?? obj(c).total);
  } else {
    for (const [k, v] of Object.entries(obj(countsRaw))) counts[k] = num(v);
  }
  const list = raw.resellers ?? raw.variance_by_reseller ?? raw.by_reseller ?? raw.variances;
  const resellers = (Array.isArray(list) ? list : []).map((r): ResellerVariance => {
    const o = obj(r);
    return {
      reseller_id: num(o.reseller_id ?? o.id),
      reseller_name: String(o.reseller_name ?? o.name ?? ''),
      variance: money(o.variance ?? o.variance_total ?? o.total_variance) ?? 0,
      received: num(o.received_bags ?? o.received ?? o.received_count ?? o.bags_received ?? o.count),
    };
  });
  return { counts, in_bags: money(raw.in_bags), resellers };
}

export function toCarrier(raw: Raw): Carrier {
  const bags = raw.bags_in_hand ?? raw.bags;
  const b = obj(bags);
  const resellers = Array.isArray(raw.resellers) ? raw.resellers.map(r => ({ id: num(obj(r).id ?? obj(r).reseller_id), name: String(obj(r).name ?? obj(r).reseller_name ?? '') })) : [];
  const joined = [raw.first_name, raw.last_name].filter(Boolean).join(' ');
  return {
    user_id: num(raw.user_id ?? raw.id),
    name: str(raw.name) ?? (joined || String(raw.email ?? '')),
    email: str(raw.email),
    phone: str(raw.phone),
    is_active: raw.status !== undefined && raw.status !== null
      ? raw.status === 'active'
      : raw.is_active === undefined ? true : Boolean(Number(raw.is_active) || raw.is_active === true),
    resellers,
    with_carrier: typeof bags === 'number' ? bags : num(b.with_carrier ?? b.stock ?? raw.with_carrier),
    in_transit: num(b.in_transit ?? raw.in_transit),
  };
}

export interface BagFilters { status?: string; reseller_id?: number | null; carrier_user_id?: number | null; serial?: string; page?: number; limit?: number }

export async function fetchCashBags(f: BagFilters): Promise<{ data: CashBag[]; meta: ListMeta | null }> {
  const q = new URLSearchParams();
  if (f.status) q.set('status', f.status);
  if (f.reseller_id) q.set('reseller_id', String(f.reseller_id));
  if (f.carrier_user_id) q.set('carrier_user_id', String(f.carrier_user_id));
  if (f.serial) q.set('serial', f.serial);
  q.set('page', String(f.page ?? 1));
  q.set('limit', String(f.limit ?? 25));
  const res = await apiFetch<{ data?: Raw[]; meta?: ListMeta }>(`/cash-bags?${q.toString()}`);
  return { data: (Array.isArray(res?.data) ? res.data : []).map(toCashBag), meta: res?.meta ?? null };
}

export async function fetchCashBagSummary(): Promise<CashBagSummary> {
  return toSummary(obj((await apiFetch<{ data?: Raw }>('/cash-bags/summary'))?.data));
}

export async function fetchCashBag(id: number): Promise<CashBagDetail> {
  const data = obj((await apiFetch<{ data?: Raw }>(`/cash-bags/${id}`))?.data);
  const bag = toCashBag(obj(data.bag ?? data));
  const events = data.events ?? obj(data.bag).events;
  return { ...bag, events: (Array.isArray(events) ? events : []).map(e => toCashBagEvent(obj(e))) };
}

const serialList = (v: unknown): string[] =>
  (Array.isArray(v) ? v : []).map(item => (typeof item === 'string' ? item : String(obj(item).serial ?? ''))).filter(Boolean);

export async function registerCashBags(body: { serial: string } | { prefix: string; from: number; to: number; pad?: number }): Promise<RegisterResult> {
  const data = obj((await apiFetch<{ data?: Raw }>('/cash-bags', { method: 'POST', body: JSON.stringify(body) }))?.data);
  const created = data.created ?? data.bags ?? (data.serial ? [data] : []);
  return { created: serialList(created), skipped: serialList(data.skipped ?? data.existing) };
}

export async function handoverCashBags(body: { carrier_user_id: number; reseller_id: number; serials: string[] }): Promise<string[]> {
  const res = await apiFetch<{ data?: unknown }>('/cash-bags/handover', { method: 'POST', body: JSON.stringify(body) });
  const data = res?.data;
  const list = Array.isArray(data) ? data : obj(data).bags ?? obj(data).serials;
  const serials = serialList(list);
  return serials.length ? serials : body.serials;
}

export async function receiveCashBag(id: number, body: { counted_amount: number; note?: string }): Promise<ReceiveResult> {
  const data = obj((await apiFetch<{ data?: Raw }>(`/cash-bags/${id}/receive`, { method: 'POST', body: JSON.stringify(body) }))?.data);
  const bagRaw = data.bag ? obj(data.bag) : data.serial ? data : null;
  const lines = [data.ledger_entries, data.ledger, data.entries].find(Array.isArray) ?? [];
  const ledger = lines.map(l => ({
    entry_type: String(obj(l).entry_type ?? ''), amount: money(obj(l).amount) ?? 0, note: str(obj(l).note),
  }));
  return { bag: bagRaw ? toCashBag(bagRaw) : null, ledger, summary: data.summary ? obj(data.summary) : null };
}

export async function closeCashBag(id: number, action: 'void' | 'lost', reason: string): Promise<void> {
  await apiFetch(`/cash-bags/${id}/${action}`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export async function fetchCarriers(): Promise<Carrier[]> {
  const res = await apiFetch<{ data?: Raw[] }>('/carriers');
  return (Array.isArray(res?.data) ? res.data : []).map(toCarrier);
}

export interface CarrierBody { first_name: string; last_name: string; email: string; password: string; phone?: string }

export async function createCarrier(body: CarrierBody): Promise<{ user_id: number | null; email: string }> {
  const data = obj((await apiFetch<{ data?: Raw }>('/carriers', { method: 'POST', body: JSON.stringify(body) }))?.data);
  return { user_id: idOrNull(data.user_id ?? data.id), email: String(data.email ?? body.email) };
}

/** GET /carriers/:userId/resellers: the assigned resellers (rows or ids). */
export async function fetchCarrierResellers(userId: number): Promise<number[]> {
  const res = await apiFetch<{ data?: unknown }>(`/carriers/${userId}/resellers`);
  const data = res?.data;
  const list = Array.isArray(data) ? data : obj(data).reseller_ids ?? obj(data).resellers;
  return (Array.isArray(list) ? list : []).map(r => (typeof r === 'number' || typeof r === 'string' ? num(r) : num(obj(r).id ?? obj(r).reseller_id))).filter(n => n > 0);
}

export async function saveCarrierResellers(userId: number, resellerIds: number[]): Promise<void> {
  await apiFetch(`/carriers/${userId}/resellers`, { method: 'PUT', body: JSON.stringify({ reseller_ids: resellerIds }) });
}

/**
 * GET /carriers/assignable-resellers: every top-level reseller a carrier may
 * be given (carriers.manage alone, without resellers.view or paging GET /resellers).
 */
export async function fetchAssignableResellers(): Promise<{ resellers: { id: number; name: string }[]; truncated: boolean }> {
  const res = await apiFetch<{ data?: Raw[]; meta?: { truncated?: boolean } }>('/carriers/assignable-resellers');
  const resellers = (Array.isArray(res?.data) ? res.data : [])
    .map(r => ({ id: num(r.id), name: String(r.name ?? '') }))
    .filter(r => r.id > 0);
  return { resellers, truncated: Boolean(res?.meta?.truncated) };
}

export async function fetchResellerBags(resellerId: number, page: number, limit: number): Promise<{ data: CashBag[]; meta: ListMeta | null; variance: number | string | null }> {
  const res = await apiFetch<{ data?: Raw[]; meta?: ListMeta & { variance?: number | string }; summary?: Raw }>(`/resellers/${resellerId}/bags?page=${page}&limit=${limit}`);
  const summary = obj(res?.summary);
  const variance = money(summary.variance ?? summary.variance_total ?? res?.meta?.variance);
  return { data: (Array.isArray(res?.data) ? res.data : []).map(toCashBag), meta: res?.meta ?? null, variance };
}

/** The serials a refusal names (error.failed, error.details.failed, error.details), if any. */
export function refusedSerials(err: unknown): string[] {
  if (!(err instanceof ApiRequestError)) return [];
  const e = obj(obj(err.body).error);
  for (const c of [e.failed, obj(e.details).failed, obj(e.details).serials, obj(e.details).skipped, e.details, obj(err.body).failed]) {
    const list = serialList(c);
    if (list.length) return list;
  }
  return [];
}

/** The i18n key for a bag refusal the server names by code, or null. */
export function bagRefusalKey(err: unknown): string | null {
  if (!(err instanceof ApiRequestError)) return null;
  const code = obj(obj(err.body).error).code;
  if (code === 'BAG_INVALID_TRANSITION') return 'cashBags.common.invalidTransition';
  if (code === 'BAG_CHANGED' || code === 'LOCK_CONTENTION') return 'cashBags.common.changed';
  return null;
}

/** The serials of a range, as the server builds them (prefix + zero-padded number). */
export function rangeSerials(prefix: string, from: number, to: number, pad: number): string[] {
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(`${prefix}${String(n).padStart(pad, '0')}`.toUpperCase());
  return out;
}

export const RANGE_MAX = 500;

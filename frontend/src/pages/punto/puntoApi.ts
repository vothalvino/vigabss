// =============================================================================
// Reseller app (/punto) — requests to /api/v1/reseller-app
// =============================================================================
// Every call goes through apiFetch (cookie, CSRF, refresh). The response
// shapes are declared here rather than taken from the generated schema types.
// An account bound to a reseller may call only /auth, /reseller-app and a few
// other prefixes, so nothing under /punto may call a staff endpoint.
// =============================================================================

import { ApiRequestError, apiFetch } from '@/api/apiFetch';

export interface PuntoMe {
  reseller: {
    id: number;
    name: string;
    level: number;
    status: string;
    commission_rate: number | string;
    parent_id: number | null;
  };
  currency: string;
  counts: {
    active_clients: number;
    suspended_clients: number;
    open_leads: number;
    overdue_clients: number;
  };
  /** Phase 2: the cash this reseller holds for the ISP and what it may still collect. */
  money?: PuntoMoney;
}

/**
 * The collecting reseller's cash position (its top-level reseller's ledger).
 * `balance` is what it owes the ISP, including sealed bags not yet received;
 * `in_bags` is what its sealed bags (ready for pickup or on their way) hold;
 * `cash_on_hand` is the cash outside bags (balance − in_bags), which is what
 * counts against `credit_limit` (its own or the organization default).
 * `empty_bags` is how many empty bags it has to fill.
 */
export interface PuntoMoney {
  currency: string;
  balance: number | string;
  in_bags?: number | string;
  cash_on_hand: number | string;
  credit_limit: number | string;
  available_to_collect: number | string;
  collected_today: number | string;
  empty_bags?: number;
  bags_ready_for_pickup?: number;
  bags_in_transit?: number;
}

export interface PuntoListMeta { total: number; page: number; limit: number }

export interface PuntoClientRow {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  status: string;
  reseller_id: number | null;
  balance_due: number | string;
  overdue: boolean;
}

export interface PuntoClientDetail {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  city?: string | null;
  status: string;
  reseller_id: number | null;
  balance_due: number | string;
  contracts: { id: number; status: string; plan_name: string | null; monthly_price: number | string | null }[];
  invoices: {
    id: number;
    invoice_number: string | null;
    status: string;
    total: number | string;
    balance: number | string;
    due_date: string | null;
    issue_date: string | null;
  }[];
}

export interface PuntoPlan {
  id: number;
  name: string;
  price: number | string;
  download_speed: number | null;
  upload_speed: number | null;
}

export interface PuntoLead {
  id: number;
  name: string;
  phone: string | null;
  status: string;
  desired_plan_id: number | null;
  desired_plan_name: string | null;
  created_at: string;
  converted_client_id: number | null;
}

/** Body of POST /reseller-app/leads; blank optional fields are left out. */
export interface PuntoLeadBody {
  name: string;
  phone: string;
  email?: string;
  address?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  desired_plan_id?: number;
  rfc?: string;
  razon_social?: string;
  regimen_fiscal?: string;
  codigo_postal_fiscal?: string;
  notes?: string;
}

export type PuntoDistanceBand = 'under_1km' | 'under_3km' | 'farther' | null;

/**
 * The reseller's coverage summary. Unlike the staff GET /leads/:id/feasibility
 * it carries no network ids, names, coordinates or radio data: only zones in
 * service and coarse wireless and fiber flags ("nearby" means within 3 km).
 */
export interface PuntoFeasibility {
  has_coordinates: boolean;
  covered: boolean;
  coverage_zones: {
    name: string;
    zone_type: string | null;
    status: 'active' | 'degraded';
    max_download_mbps: number | null;
    max_upload_mbps: number | null;
  }[];
  zone_lookup_failed: boolean;
  wireless: { nearby: boolean; distance_band: PuntoDistanceBand };
  ftth: { nearby: boolean; distance_band: PuntoDistanceBand; has_free_ports: boolean | null };
}

export interface PuntoOpenInvoice {
  id: number;
  invoice_number: string | null;
  balance: number | string;
  due_date: string | null;
}

/**
 * A subscriber the reseller may collect from (GET /reseller-app/collect/lookup
 * or /collect/client/:id). `own` is false for a subscriber outside the
 * reseller's subtree: its name is masked and no contact data is sent.
 * `collect_token` is a short-lived signed token that POST /payments needs.
 */
export interface PuntoCollectTarget {
  collect_token: string;
  own: boolean;
  client_number: number | string;
  name: string;
  status: string;
  amount_due: number | string;
  open_invoices: PuntoOpenInvoice[];
}

export interface PuntoCollectBody {
  collect_token: string;
  amount: number;
  invoice_ids?: number[];
  note?: string;
}

export interface PuntoCollectResult {
  payment_id: number;
  amount: number | string;
  allocated: { invoice_id: number; amount: number | string }[];
  client_number: number | string;
  client_name: string;
  reconnected: boolean | null;
  receipt_url: string;
}

/** One collection of this reseller (GET /reseller-app/payments). */
export interface PuntoCollection {
  id: number;
  client_number: number | string;
  client_name: string;
  own: boolean;
  amount: number | string;
  collected_at: string | null;
  status: 'completed' | 'voided' | string;
  invoice_numbers: string[];
  cash_session_id: number | null;
  /** The server's verdict (same business day, open cash box); absent on older responses. */
  voidable?: boolean;
}

export interface PuntoReceipt {
  receipt_number: string;
  issued_at: string;
  /** 'voided' once the collection was voided. */
  status?: 'completed' | 'voided' | string;
  isp: { name: string; rfc?: string | null; address?: string | null; phone?: string | null };
  collected_by: { reseller_name: string; user_name: string | null };
  client: { number: number | string; name: string; own?: boolean };
  amount: number | string;
  currency: string;
  payment_method: string;
  allocations: { invoice_number: string | null; amount: number | string }[];
  remaining_balance: number | string | null;
  legend: string;
  plain_text?: string | null;
}

export interface PuntoOpenSession {
  id: number;
  opened_at: string;
  expected_total: number | string;
  collections_count: number;
}

export interface PuntoClosedSession {
  id: number;
  opened_at: string;
  closed_at: string | null;
  expected_total: number | string;
  counted_total: number | string | null;
  variance: number | string | null;
  status: string;
}

export interface PuntoCashSession {
  current: PuntoOpenSession | null;
  recent: PuntoClosedSession[];
}

export type PuntoLedgerType = 'collection' | 'collection_void' | 'deposit' | 'adjustment';

export interface PuntoLedgerEntry {
  id: number;
  entry_type: PuntoLedgerType | string;
  amount: number | string;
  note: string | null;
  created_at: string;
  payment_id: number | null;
  /** The cash bag a deposit or an adjustment came from (its receipt). */
  cash_bag_id?: number | null;
  cash_bag_serial?: string | null;
}

export interface PuntoLedgerSummary {
  balance: number | string;
  in_bags?: number | string;
  cash_on_hand: number | string;
  credit_limit: number | string;
  available_to_collect: number | string;
}

export interface PuntoLedgerPage {
  data: PuntoLedgerEntry[];
  summary: PuntoLedgerSummary | null;
  meta: PuntoListMeta | null;
}

export const puntoKeys = {
  me: ['punto', 'me'] as const,
  clients: (search: string, status: string, overdue: boolean, page: number) => ['punto', 'clients', search, status, overdue, page] as const,
  client: (id: number) => ['punto', 'client', id] as const,
  plans: ['punto', 'plans'] as const,
  leads: (page: number) => ['punto', 'leads', page] as const,
  feasibility: (id: number) => ['punto', 'feasibility', id] as const,
  collectClient: (id: number) => ['punto', 'collect-client', id] as const,
  receipt: (id: number) => ['punto', 'receipt', id] as const,
  collections: (date: string, page: number) => ['punto', 'collections', date, page] as const,
  cashSession: ['punto', 'cash-session'] as const,
  ledger: (page: number) => ['punto', 'ledger', page] as const,
  bags: ['punto', 'bags'] as const,
};

/** Every query a collection, a void, a cash-box close or a sealed bag changes. */
export const PUNTO_MONEY_QUERIES = [
  puntoKeys.me,
  ['punto', 'collections'],
  puntoKeys.cashSession,
  ['punto', 'ledger'],
  puntoKeys.bags,
] as const;

/**
 * A cash bag at the reseller (GET /reseller-app/bags): empty (at_reseller),
 * sealed with the declared amount (ready_for_pickup) or picked up by the
 * carrier (in_transit). Received, void and lost bags are not listed.
 */
export type PuntoBagStatus = 'at_reseller' | 'ready_for_pickup' | 'in_transit';

export interface PuntoBag {
  id: number;
  serial: string;
  status: PuntoBagStatus | string;
  declared_amount: number | string | null;
  sealed_at: string | null;
  picked_up_at: string | null;
}

export interface PuntoSealResult { bag: PuntoBag | null; money: PuntoMoney | PuntoLedgerSummary | null }

export async function fetchPuntoMe(): Promise<PuntoMe> {
  return (await apiFetch<{ data: PuntoMe }>('/reseller-app/me')).data;
}

export async function fetchPuntoClients(params: { search: string; status: string; overdue?: boolean; page: number; limit: number }) {
  const q = new URLSearchParams({ page: String(params.page), limit: String(params.limit) });
  if (params.search) q.set('search', params.search);
  if (params.status) q.set('status', params.status);
  if (params.overdue) q.set('overdue', '1');
  return apiFetch<{ data: PuntoClientRow[]; meta: PuntoListMeta }>(`/reseller-app/clients?${q.toString()}`);
}

export async function fetchPuntoClient(id: number): Promise<PuntoClientDetail> {
  return (await apiFetch<{ data: PuntoClientDetail }>(`/reseller-app/clients/${id}`)).data;
}

export async function fetchPuntoPlans(): Promise<PuntoPlan[]> {
  return (await apiFetch<{ data: PuntoPlan[] }>('/reseller-app/plans')).data ?? [];
}

export async function fetchPuntoLeads(page: number, limit: number) {
  return apiFetch<{ data: PuntoLead[]; meta: PuntoListMeta }>(`/reseller-app/leads?page=${page}&limit=${limit}`);
}

export async function createPuntoLead(body: PuntoLeadBody): Promise<PuntoLead> {
  return (await apiFetch<{ data: PuntoLead }>('/reseller-app/leads', { method: 'POST', body: JSON.stringify(body) })).data;
}

export async function fetchPuntoFeasibility(id: number): Promise<PuntoFeasibility> {
  return (await apiFetch<{ data: PuntoFeasibility }>(`/reseller-app/leads/${id}/feasibility`)).data;
}

export async function lookupPuntoCollect(q: string): Promise<PuntoCollectTarget[]> {
  const res = await apiFetch<{ data: PuntoCollectTarget[] }>(`/reseller-app/collect/lookup?q=${encodeURIComponent(q)}`);
  return res.data ?? [];
}

export async function fetchPuntoCollectClient(id: number): Promise<PuntoCollectTarget> {
  return (await apiFetch<{ data: PuntoCollectTarget }>(`/reseller-app/collect/client/${id}`)).data;
}

/**
 * Record a cash collection. `idempotencyKey` is the same for every retry of
 * one attempt, so a lost response cannot make the subscriber pay twice.
 */
export async function createPuntoCollection(body: PuntoCollectBody, idempotencyKey: string): Promise<PuntoCollectResult> {
  return (await apiFetch<{ data: PuntoCollectResult }>('/reseller-app/payments', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(body),
  })).data;
}

/** A row of GET /reseller-app/payments, tolerating the name/time aliases. */
function toCollection(raw: Record<string, unknown>): PuntoCollection {
  const invoices = raw.invoice_numbers;
  return {
    id: Number(raw.id ?? raw.payment_id),
    client_number: (raw.client_number ?? '') as number | string,
    client_name: String(raw.client_name ?? raw.name ?? ''),
    own: Boolean(raw.own),
    amount: (raw.amount ?? 0) as number | string,
    collected_at: (raw.collected_at ?? raw.created_at ?? raw.time ?? null) as string | null,
    status: String(raw.status ?? 'completed'),
    invoice_numbers: Array.isArray(invoices)
      ? invoices.map(String)
      : typeof invoices === 'string' && invoices ? invoices.split(',').map(v => v.trim()) : [],
    cash_session_id: raw.cash_session_id == null ? null : Number(raw.cash_session_id),
    ...(typeof raw.voidable === 'boolean' ? { voidable: raw.voidable } : {}),
  };
}

export async function fetchPuntoCollections(params: { date?: string; page: number; limit: number }) {
  const q = new URLSearchParams({ page: String(params.page), limit: String(params.limit) });
  if (params.date) q.set('date', params.date);
  const res = await apiFetch<{ data: Record<string, unknown>[]; meta?: PuntoListMeta }>(`/reseller-app/payments?${q.toString()}`);
  return { data: (res.data ?? []).map(toCollection), meta: res.meta ?? null };
}

export async function voidPuntoCollection(id: number, reason: string): Promise<void> {
  await apiFetch(`/reseller-app/payments/${id}/void`, { method: 'POST', body: JSON.stringify({ reason }) });
}

export async function fetchPuntoReceipt(id: number): Promise<PuntoReceipt> {
  return (await apiFetch<{ data: PuntoReceipt }>(`/reseller-app/payments/${id}/receipt`)).data;
}

/** GET /reseller-app/cash-session: `{ current, recent }` (aliases accepted). */
export async function fetchPuntoCashSession(): Promise<PuntoCashSession> {
  const res = await apiFetch<{ data?: unknown; recent?: unknown; closed?: unknown }>('/reseller-app/cash-session');
  const data = (res.data ?? null) as Record<string, unknown> | null;
  // Either { data: { current, recent } } or { data: <open session|null>, recent }.
  const wrapped = data && ('current' in data || 'open' in data || 'recent' in data || 'closed' in data);
  const current = (wrapped ? data.current ?? data.open ?? null : data) as PuntoOpenSession | null;
  const recent = (wrapped ? data.recent ?? data.closed : res.recent ?? res.closed) as PuntoClosedSession[] | undefined;
  return { current: current && current.id ? current : null, recent: Array.isArray(recent) ? recent : [] };
}

export async function closePuntoCashSession(body: { counted_total: number; notes?: string }): Promise<PuntoClosedSession> {
  return (await apiFetch<{ data: PuntoClosedSession }>('/reseller-app/cash-session/close', { method: 'POST', body: JSON.stringify(body) })).data;
}

/** A ledger page: entries plus the summary (top level or in meta). */
export function toLedgerPage(res: { data?: PuntoLedgerEntry[]; summary?: PuntoLedgerSummary; meta?: PuntoListMeta & { summary?: PuntoLedgerSummary } }): PuntoLedgerPage {
  return { data: res.data ?? [], summary: res.summary ?? res.meta?.summary ?? null, meta: res.meta ?? null };
}

export async function fetchPuntoLedger(page: number, limit: number): Promise<PuntoLedgerPage> {
  return toLedgerPage(await apiFetch(`/reseller-app/ledger?page=${page}&limit=${limit}`));
}

function toBag(raw: Record<string, unknown>): PuntoBag {
  return {
    id: Number(raw.id ?? 0),
    serial: String(raw.serial ?? ''),
    status: String(raw.status ?? ''),
    declared_amount: (raw.declared_amount ?? null) as number | string | null,
    sealed_at: (raw.sealed_at ?? null) as string | null,
    picked_up_at: (raw.picked_up_at ?? null) as string | null,
  };
}

export async function fetchPuntoBags(): Promise<PuntoBag[]> {
  const res = await apiFetch<{ data?: Record<string, unknown>[] }>('/reseller-app/bags');
  return (Array.isArray(res?.data) ? res.data : []).map(toBag);
}

/** Seal an empty bag with the cash put in it: frees that much of the cash limit. */
export async function sealPuntoBag(body: { serial: string; declared_amount: number }): Promise<PuntoSealResult> {
  const res = await apiFetch<{ data?: Record<string, unknown> }>('/reseller-app/bags/seal', { method: 'POST', body: JSON.stringify(body) });
  const data = (res?.data ?? {}) as Record<string, unknown>;
  const bag = data.bag && typeof data.bag === 'object' ? toBag(data.bag as Record<string, unknown>) : (data.serial ? toBag(data) : null);
  const money = (data.money ?? data.summary ?? null) as PuntoMoney | PuntoLedgerSummary | null;
  return { bag, money };
}

/** A field of a refusal: error.<name>, error.details.<name> or <name>. */
function errorField(err: ApiRequestError, name: string): unknown {
  const body = (err.body ?? {}) as Record<string, unknown>;
  const e = (typeof body.error === 'object' && body.error ? body.error : {}) as Record<string, unknown>;
  const details = (e.details && typeof e.details === 'object' && !Array.isArray(e.details) ? e.details : {}) as Record<string, unknown>;
  return e[name] ?? details[name] ?? body[name];
}

/** The CREDIT_LIMIT refusal of POST /payments, with what may still be collected and the empty bags at hand. */
export function creditLimitError(err: unknown): { available: number | null; emptyBags: number | null } | null {
  if (!(err instanceof ApiRequestError) || err.status !== 409) return null;
  const body = (err.body ?? {}) as Record<string, unknown>;
  const e = (typeof body.error === 'object' && body.error ? body.error : {}) as Record<string, unknown>;
  const details = (e.details && typeof e.details === 'object' && !Array.isArray(e.details) ? e.details : {}) as Record<string, unknown>;
  const code = e.code ?? body.code;
  const available = e.available_to_collect ?? details.available_to_collect ?? body.available_to_collect;
  // A 409 without the code is some other conflict (a void rule, say).
  if (code !== 'CREDIT_LIMIT' && available === undefined) return null;
  const emptyBags = errorField(err, 'empty_bags');
  return {
    available: available === undefined || available === null ? null : toNumber(available as number | string),
    emptyBags: emptyBags === undefined || emptyBags === null ? null : toNumber(emptyBags as number | string),
  };
}

/** The `error.code` of a refused request (e.g. 'VOID_WINDOW_CLOSED'), or null. */
export function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiRequestError)) return null;
  const body = (err.body ?? {}) as Record<string, unknown>;
  const e = (typeof body.error === 'object' && body.error ? body.error : {}) as Record<string, unknown>;
  const code = e.code ?? body.code;
  return typeof code === 'string' ? code : null;
}

/** A key for one collection attempt. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** A DECIMAL that may arrive as a string. */
export function toNumber(value: number | string | null | undefined): number {
  const n = typeof value === 'number' ? value : parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

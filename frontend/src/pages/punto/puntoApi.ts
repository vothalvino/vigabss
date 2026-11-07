// =============================================================================
// Reseller app (/punto) — requests to /api/v1/reseller-app
// =============================================================================
// Every call goes through apiFetch (cookie, CSRF, refresh). The response
// shapes are declared here rather than taken from the generated schema types.
// An account bound to a reseller may call only /auth, /reseller-app and a few
// other prefixes, so nothing under /punto may call a staff endpoint.
// =============================================================================

import { apiFetch } from '@/api/apiFetch';

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

export const puntoKeys = {
  me: ['punto', 'me'] as const,
  clients: (search: string, status: string, overdue: boolean, page: number) => ['punto', 'clients', search, status, overdue, page] as const,
  client: (id: number) => ['punto', 'client', id] as const,
  plans: ['punto', 'plans'] as const,
  leads: (page: number) => ['punto', 'leads', page] as const,
  feasibility: (id: number) => ['punto', 'feasibility', id] as const,
};

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

/** A DECIMAL that may arrive as a string. */
export function toNumber(value: number | string | null | undefined): number {
  const n = typeof value === 'number' ? value : parseFloat(value ?? '');
  return Number.isFinite(n) ? n : 0;
}

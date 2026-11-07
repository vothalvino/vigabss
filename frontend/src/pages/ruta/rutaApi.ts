// =============================================================================
// Carrier app (/ruta) — requests to /api/v1/carrier-app
// =============================================================================
// A carrier picks up the sealed cash bags of the resellers assigned to it and
// drops off empty ones. The server fences a carrier to /auth and
// /carrier-app, so nothing under /ruta may call another endpoint. Nothing
// here carries an amount: a carrier never learns what a bag holds. Shapes
// are declared here (like puntoApi.ts) and the readers tolerate small name
// variations, so a renamed field shows a dash instead of breaking the page.
// =============================================================================

import { ApiRequestError, apiFetch } from '@/api/apiFetch';

export interface RutaMe {
  name: string;
  /** Empty bags the carrier holds to drop off (with_carrier). */
  stock: number;
  /** Sealed bags picked up and not yet handed in (in_transit). */
  inTransit: number;
  assignedResellers: number;
}

export interface RutaReseller {
  id: number;
  name: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  readyForPickup: number;
  emptyBags: number;
}

export type RutaBagStatus = 'with_carrier' | 'in_transit' | string;

export interface RutaBag {
  serial: string;
  status: RutaBagStatus;
  resellerName: string | null;
}

export interface RutaPickupResult {
  serial: string;
  status: string;
  resellerName: string | null;
}

export interface RutaDropoffResult { serials: string[] }

export const rutaKeys = {
  me: ['ruta', 'me'] as const,
  resellers: ['ruta', 'resellers'] as const,
  bags: ['ruta', 'bags'] as const,
};

/** Every query a pickup or a drop-off changes. */
export const RUTA_QUERIES = [rutaKeys.me, rutaKeys.resellers, rutaKeys.bags] as const;

type Raw = Record<string, unknown>;

const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : {});
const int = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const coord = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function toRutaMe(raw: Raw): RutaMe {
  const carrier = obj(raw.carrier);
  const counts = obj(raw.counts ?? raw.bags);
  return {
    name: String(carrier.name ?? raw.name ?? ''),
    stock: int(counts.with_carrier ?? counts.stock ?? raw.with_carrier),
    inTransit: int(counts.in_transit ?? raw.in_transit),
    assignedResellers: int(raw.assigned_resellers ?? raw.assigned_resellers_count ?? counts.assigned_resellers ?? raw.resellers_count),
  };
}

export function toRutaReseller(raw: Raw): RutaReseller {
  const counts = obj(raw.counts);
  return {
    id: int(raw.id ?? raw.reseller_id),
    name: String(raw.name ?? ''),
    address: str(raw.address),
    city: str(raw.city),
    phone: str(raw.phone),
    latitude: coord(raw.latitude),
    longitude: coord(raw.longitude),
    readyForPickup: int(counts.ready_for_pickup ?? raw.ready_for_pickup),
    emptyBags: int(counts.empty_bags ?? counts.at_reseller ?? raw.empty_bags),
  };
}

export function toRutaBag(raw: Raw): RutaBag {
  const reseller = obj(raw.reseller);
  return {
    serial: String(raw.serial ?? ''),
    status: String(raw.status ?? ''),
    resellerName: str(raw.reseller_name ?? reseller.name),
  };
}

export async function fetchRutaMe(): Promise<RutaMe> {
  const res = await apiFetch<{ data?: Raw }>('/carrier-app/me');
  return toRutaMe(obj(res?.data));
}

export async function fetchRutaResellers(): Promise<RutaReseller[]> {
  const res = await apiFetch<{ data?: Raw[] }>('/carrier-app/resellers');
  return (Array.isArray(res?.data) ? res.data : []).map(toRutaReseller);
}

export async function fetchRutaBags(): Promise<RutaBag[]> {
  const res = await apiFetch<{ data?: Raw[] }>('/carrier-app/bags');
  return (Array.isArray(res?.data) ? res.data : []).map(toRutaBag);
}

export interface RutaPosition { latitude: number; longitude: number }

/** The phone's position when it shares it within a few seconds, else null. */
export function currentPosition(timeoutMs = 5000): Promise<RutaPosition | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return Promise.resolve(null);
  return new Promise(resolve => {
    let done = false;
    const finish = (p: RutaPosition | null) => { if (!done) { done = true; resolve(p); } };
    const timer = setTimeout(() => finish(null), timeoutMs + 500);
    try {
      navigator.geolocation.getCurrentPosition(
        pos => { clearTimeout(timer); finish({ latitude: Number(pos.coords.latitude.toFixed(7)), longitude: Number(pos.coords.longitude.toFixed(7)) }); },
        () => { clearTimeout(timer); finish(null); },
        { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 60_000 },
      );
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/** POST /carrier-app/pickup: the scanned serial must be a ready bag of that reseller. */
export async function pickupRutaBag(body: { reseller_id: number; serial: string } & Partial<RutaPosition>): Promise<RutaPickupResult> {
  const res = await apiFetch<{ data?: Raw }>('/carrier-app/pickup', { method: 'POST', body: JSON.stringify(body) });
  const data = obj(res?.data);
  const bag = obj(data.bag ?? data);
  return {
    serial: String(bag.serial ?? body.serial),
    status: String(bag.status ?? 'in_transit'),
    resellerName: str(bag.reseller_name ?? data.reseller_name),
  };
}

/** POST /carrier-app/dropoff: all of the serials, or none. */
export async function dropoffRutaBags(body: { reseller_id: number; serials: string[] }): Promise<RutaDropoffResult> {
  const res = await apiFetch<{ data?: unknown }>('/carrier-app/dropoff', { method: 'POST', body: JSON.stringify(body) });
  const data = res?.data;
  const list = Array.isArray(data) ? data : obj(data).bags ?? obj(data).serials;
  const serials = Array.isArray(list)
    ? list.map(item => (typeof item === 'string' ? item : String(obj(item).serial ?? ''))).filter(Boolean)
    : body.serials;
  return { serials };
}

/** The serials a 422 refusal names (error.failed, error.details.failed or error.details), if any. */
export function failedSerials(err: unknown): string[] {
  if (!(err instanceof ApiRequestError)) return [];
  const body = obj(err.body);
  const e = obj(body.error);
  const details = e.details;
  const candidates = [e.failed, obj(details).failed, obj(details).serials, details, body.failed];
  for (const c of candidates) {
    if (!Array.isArray(c)) continue;
    const out = c
      .map(item => (typeof item === 'string' ? item : str(obj(item).serial)))
      .filter((s): s is string => Boolean(s));
    if (out.length) return out;
  }
  return [];
}

/** A tel: link for a phone number as typed. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/** A map link (opens the phone's map app) for a reseller's coordinates. */
export function mapHref(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

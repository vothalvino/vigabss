// Health of each line and each piece of equipment in the network tree, as
// GET /topology/health returns it, and how it is shown: one colour per state
// and one sentence per reason.
import type { TFunction } from 'i18next';
import { apiFetch } from '@/api/apiFetch';

export type HealthState = 'good' | 'degraded' | 'off' | 'unknown';
export interface Reason { code: string; value?: number; limit?: number; normal?: number; drop?: number; mbps?: number; capacity_mbps?: number; plan_mbps?: number; cause?: string | null }
export interface TopClient { device_id: number; name: string; mbps: number }
export interface Verdict { state: HealthState; reasons: Reason[]; top_clients?: TopClient[] }
export interface NodeHealth { equipment: Verdict; uplink: Verdict | null }
export interface HealthReport { checked_at: string; limits: Record<string, number>; nodes: Record<string, NodeHealth> }

export const HEALTH_QUERY_KEY = ['topology-health'];
export const HEALTH_REFRESH_MS = 60_000;

export const HEALTH_COLOR: Record<HealthState, string> = {
  good: '#16a34a',
  degraded: '#eab308',
  off: '#dc2626',
  unknown: '#9ca3af',
};
export const HEALTH_STATES: HealthState[] = ['good', 'degraded', 'off', 'unknown'];

export async function fetchHealth(): Promise<HealthReport> {
  const res = await apiFetch<{ data: HealthReport }>('/topology/health');
  return res.data;
}

/** One reason as a sentence, e.g. "Airtime 87% (limit 80%)". */
export function reasonText(t: TFunction, reason: Reason): string {
  return t(`linkHealth.reasons.${reason.code}`, {
    value: reason.value, limit: reason.limit, normal: reason.normal, drop: reason.drop,
    mbps: reason.mbps, capacity: reason.capacity_mbps, plan_mbps: reason.plan_mbps,
    defaultValue: reason.code,
  });
}

/** A verdict's state and reasons in one line, for a tooltip or a note. */
export function verdictText(t: TFunction, verdict: Verdict): string {
  const state = t(`linkHealth.states.${verdict.state}`);
  return verdict.reasons.length ? `${state}: ${verdict.reasons.map(r => reasonText(t, r)).join('; ')}` : state;
}

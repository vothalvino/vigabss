// What the cashier reminders read: the signed-in person's own open cashier,
// and, for supervisors, the cashiers left open too long and the counts
// waiting for a review.
import { useQuery } from '@tanstack/react-query';
import { authedFetch } from '@/api/client';
import { useAuth } from '@/auth/AuthContext';
import { can } from '@/auth/permissions';

export interface MyCashier {
  id: number;
  opened_at: string;
  hours_open: number;
  /** The cash the drawer should hold right now: opening + taken - handed in. */
  expected_total: number;
  max_open_hours: number;
  overdue: boolean;
  /** 0 = no limit. */
  pickup_threshold?: number;
  pickup_strict?: boolean;
  over_threshold?: boolean;
  /** Pickups a supervisor recorded that wait for this person to confirm. */
  pending_pickups?: number;
  pending_pickups_total?: number;
}

export interface CashierAttention {
  max_open_hours: number;
  awaiting_review: number;
  overdue_open: CashierAttentionRow[];
  /** Open cashiers holding the pickup threshold or more. */
  over_threshold?: CashierAttentionRow[];
  /** Open cashiers opened with a different amount than they were closed with. */
  opening_differences?: CashierAttentionRow[];
}

export interface CashierAttentionRow {
  id: number; agent_user_id: number; agent_name: string | null; opened_at: string; hours_open: number;
  cash_on_hand?: number; opening_difference?: number;
}

export const MY_CASHIER_KEY = ['my-cashier'] as const;
export const CASHIER_ATTENTION_KEY = ['cashier-attention'] as const;
/** The one-line-per-person list and each person's page. */
export const CASHIER_STAFF_KEY = ['cashier-staff'] as const;
const FIVE_MINUTES = 5 * 60 * 1000;

async function read<T>(path: string): Promise<T | null> {
  const res = await authedFetch(`/api/v1/cash-reconciliation/${path}`);
  if (!res.ok) throw new Error('cashier reminder fetch failed');
  return ((await res.json()) as { data: T | null }).data;
}

/** The signed-in person's open cashier, or null. Not asked for people who cannot have one. */
export function useMyCashier() {
  const { user } = useAuth();
  const enabled = Boolean(user) && can(user, 'cash_reconciliation.create');
  return useQuery({
    queryKey: MY_CASHIER_KEY,
    queryFn: () => read<MyCashier>('my-cashier'),
    enabled,
    staleTime: FIVE_MINUTES,
    refetchInterval: FIVE_MINUTES,
    retry: false,
  });
}

/** For supervisors only. */
export function useCashierAttention() {
  const { user } = useAuth();
  const enabled = Boolean(user) && can(user, 'cash_reconciliation.approve');
  return useQuery({
    queryKey: CASHIER_ATTENTION_KEY,
    queryFn: () => read<CashierAttention>('attention'),
    enabled,
    staleTime: FIVE_MINUTES,
    refetchInterval: FIVE_MINUTES,
    retry: false,
  });
}

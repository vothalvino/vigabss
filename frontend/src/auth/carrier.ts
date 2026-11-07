// =============================================================================
// Is this account a cash-bag carrier?
// =============================================================================
// A carrier is a staff user in the seeded system "carrier" group. /auth/me
// says so with `carrier` (true, or an object); an older response without it
// is read from the group. A carrier uses only the route app (/ruta): the
// server refuses it every staff endpoint, so the console would show errors.
// =============================================================================

import type { AuthUser } from './AuthContext';

type CarrierSubject = Pick<AuthUser, 'carrier' | 'group'> | null | undefined;

export function isCarrier(user: CarrierSubject): boolean {
  if (!user) return false;
  const flag = user.carrier;
  if (flag === true) return true;
  if (flag && typeof flag === 'object') return true;
  if (flag === false) return false;
  // Fallback for a response without the flag: the seeded system group.
  const group = user.group;
  return Boolean(group && (group.is_system === true || group.is_system === 1)
    && (group.kind === 'carrier' || group.name === 'carrier'));
}

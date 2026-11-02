// =============================================================================
// Role tiers — the fallback when the session has no resolved permissions
// =============================================================================
// Route guards and the nav decide from the permissions /auth/me returns
// (FE-25). These tiers are used only when that list is missing.
// =============================================================================

// Higher = broader privilege.
const ROLE_RANK: Record<string, number> = {
  readonly: 1,
  support: 2,
  technician: 3,
  billing: 3,
  admin: 10,
};

export function hasRole(userRole: string, required: string): boolean {
  // admin always passes
  if (userRole === 'admin') return true;
  // readonly "must see everything, change nothing" (CLAUDE.md persona
  // contract) — it passes every requiredRole gate so it reaches every page;
  // the backend still rejects every mutation, and each page's own GETs are
  // covered by the readonly permission grants (migration 399 and prior).
  if (userRole === 'readonly') return true;
  // exact match
  if (userRole === required) return true;
  // rank-based fallback
  return (ROLE_RANK[userRole] ?? 0) >= (ROLE_RANK[required] ?? 0);
}

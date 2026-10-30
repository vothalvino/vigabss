// =============================================================================
// VigaBSS 5.0 — requireOrgId
// =============================================================================
// Child-resource model helpers (contacts, line items, allocations, CFDI
// conceptos, certificates, group members, ...) scope their SQL by joining the
// parent's organization_id. A caller that forgets to pass the org would
// otherwise bind `undefined` — mysql2 rejects that, but an accidental `null`
// default would silently widen or narrow the predicate. Fail loudly instead.
//
// `null` stays legal on purpose: the helpers compare with the null-safe `<=>`,
// so null matches ONLY rows whose parent has organization_id IS NULL (legacy
// single-tenant data). It can never match another tenant's rows.
// =============================================================================

function requireOrgId(orgId, where) {
  if (orgId === undefined) {
    throw new Error(`${where} requires an orgId; refusing an unscoped child-resource query`);
  }
  return orgId;
}

module.exports = { requireOrgId };

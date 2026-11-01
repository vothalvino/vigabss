// =============================================================================
// VigaBSS 5.0 — refuse organization_id on an update
// =============================================================================
// Mount BEFORE validate(..., { strip: true }) on PUT/PATCH routes. Strip mode
// would quietly drop organization_id; a caller trying to move a record to
// another organization gets the same explicit 422 ORG_IMMUTABLE that
// BaseModel.update raises on unstripped routes.
// =============================================================================

const { AppError } = require('../utils/errors');

function rejectOrgReassignment(req, _res, next) {
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'organization_id')) {
    return next(new AppError('A record cannot be moved to another organization.', 422, 'ORG_IMMUTABLE'));
  }
  return next();
}

module.exports = { rejectOrgReassignment };

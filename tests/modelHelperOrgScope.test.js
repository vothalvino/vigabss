'use strict';
// =============================================================================
// TNB-34 — helpers on org-scoped models take the organization
// =============================================================================
// BaseModel's own methods now throw without an organization, but a model's
// custom helpers build their own SQL. A helper keyed by a parent id (a
// client's custom fields, a ticket's comments) relied on every caller having
// checked the parent first. Each helper on an org-scoped model must take the
// organization, or be listed here with the reason it does not need one.
// =============================================================================

const fs = require('fs');
const path = require('path');

const MODELS = path.join(__dirname, '..', 'src', 'models');
const BASE = ['findById', 'findByIdOrFail', 'findByIdIncludingDeleted', 'findAll', 'count', 'create', 'update', 'delete', 'forceDelete', 'restore'];

const REVIEWED = {
  'Invoice.addItem': 'writes an item row the caller built for an invoice it already loaded in its organization',
  'Quote.addItem': 'writes an item row the caller built for a quote it already loaded in its organization',
  'Nas.createOrRestore': 'the row carries its own organization_id',
  'SnmpProfile.getOids': 'profiles can be install-wide; routes check visibility with requireVisibleProfile',
  'SnmpProfile.addOid': 'profiles can be install-wide; routes check visibility with requireVisibleProfile',
  'Ticket.addComment': 'writes a comment row the caller built for a ticket it already loaded in its organization',
  'User.resolveGroupMirror': 'users are install-wide identities',
  'User.syncOrgMembership': 'users are install-wide identities',
  'User.findByEmail': 'users are install-wide identities (sign-in)',
  'User.refreshMembershipRoles': 'users are install-wide identities',
  'User.getOrganizations': 'users are install-wide identities',
  'User.setUserOrganizations': 'sets an install-wide identity\'s memberships; routes check the actor\'s authority',
};

function scopedHelpers() {
  const found = [];
  for (const file of fs.readdirSync(MODELS)) {
    if (!file.endsWith('.js') || file === 'BaseModel.js') continue;
    const src = fs.readFileSync(path.join(MODELS, file), 'utf8');
    const cls = /class (\w+) extends BaseModel/.exec(src);
    if (!cls || !/static get hasOrgScope\(\)\s*\{\s*return true;/.test(src)) continue;
    for (const m of src.matchAll(/static async (\w+)\(([^)]*)\)/g)) {
      if (BASE.includes(m[1])) continue;
      found.push({ name: `${cls[1]}.${m[1]}`, params: m[2] });
    }
  }
  return found;
}

test('every helper on an org-scoped model takes the organization or has a reviewed reason', () => {
  const missing = scopedHelpers()
    .filter(h => !/\borg(anization)?Id\b/.test(h.params))
    .map(h => h.name)
    .filter(name => !REVIEWED[name]);
  expect(missing).toEqual([]);
});

test('every reviewed helper still exists', () => {
  const names = new Set(scopedHelpers().map(h => h.name));
  expect(Object.keys(REVIEWED).filter(name => !names.has(name))).toEqual([]);
});

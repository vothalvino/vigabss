// =============================================================================
// In-memory answers to the cash bag SQL of services/cashBagService.js,
// services/carrierService.js and the in_bags figures of
// services/resellerLedgerService.js (reseller app, phase 3).
// =============================================================================
// handleCashBagSql(state, sql, params) returns a mysql2-shaped result, or
// undefined when the statement is not one of these. `state` holds:
//   bags:        [{ id, organization_id, serial, status, reseller_id, carrier_user_id,
//                   declared_amount, counted_amount, currency, ... }]
//   events:      [{ id, organization_id, bag_id, from_status, to_status, ... }]
//   assignments: [{ organization_id, carrier_user_id, reseller_id }]
//   resellers:   { id: { id, organization_id, parent_id, name, ... } }
//   ledger:      [{ id, reseller_id, entry_type, amount, cash_bag_id, ... }]
//   seq:         { bag, event, ledger }
// Amounts are stored as mysql2 does: DECIMAL strings.
// =============================================================================
'use strict';

const cents = (v) => Math.round(Number(v) * 100);
const fromCents = (c) => (c / 100).toFixed(2);
const live = (b) => !b.deleted_at;
const sumDeclared = (bags) => fromCents(bags.reduce((t, b) => t + cents(b.declared_amount || 0), 0));
const IN_BAGS = ['ready_for_pickup', 'in_transit'];

function quotedList(sql, column) {
  const m = new RegExp(`${column} IN \\(([^)]*)\\)`).exec(sql);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : null;
}

function bagRow(b) {
  return { ...b };
}

function handleCashBagSql(state, sql, params = []) {
  const s = String(sql).replace(/\s+/g, ' ');
  const org = Number(params[0]);
  const bags = () => state.bags.filter((b) => b.organization_id === org && live(b));

  // --- in_bags and counts (resellerLedgerService)
  if (/SUM\(declared_amount\), 0\) AS in_bags FROM cash_bags WHERE organization_id = \? AND reseller_id = \? AND/.test(s)) {
    const rid = Number(params[1]);
    return [[{ in_bags: sumDeclared(bags().filter((b) => b.reseller_id === rid && IN_BAGS.includes(b.status))) }]];
  }
  if (/SELECT reseller_id, COALESCE\(SUM\(declared_amount\), 0\) AS in_bags FROM cash_bags/.test(s)) {
    const ids = params.slice(1).map(Number);
    return [ids.map((id) => ({ reseller_id: id, in_bags: sumDeclared(bags().filter((b) => b.reseller_id === id && IN_BAGS.includes(b.status))) }))];
  }
  if (/SUM\(declared_amount\), 0\) AS in_bags FROM cash_bags WHERE organization_id = \? AND deleted_at IS NULL AND status IN/.test(s)) {
    return [[{ in_bags: sumDeclared(bags().filter((b) => IN_BAGS.includes(b.status))) }]];
  }
  if (/AS at_reseller, .*FROM cash_bags/.test(s)) {
    const mine = bags().filter((b) => b.reseller_id === Number(params[1]));
    return [[{
      at_reseller: mine.filter((b) => b.status === 'at_reseller').length,
      ready_for_pickup: mine.filter((b) => b.status === 'ready_for_pickup').length,
      in_transit: mine.filter((b) => b.status === 'in_transit').length,
    }]];
  }
  if (/SELECT reseller_id, COALESCE\(SUM\(status = 'ready_for_pickup'\), 0\) AS ready_for_pickup/.test(s)) {
    const ids = params.slice(1).map(Number);
    return [ids.map((id) => ({
      reseller_id: id,
      ready_for_pickup: bags().filter((b) => b.reseller_id === id && b.status === 'ready_for_pickup').length,
      empty_bags: bags().filter((b) => b.reseller_id === id && b.status === 'at_reseller').length,
    }))];
  }
  if (/SELECT carrier_user_id, COALESCE\(SUM\(status = 'with_carrier'\), 0\) AS with_carrier/.test(s)) {
    const ids = params.slice(1).map(Number);
    return [ids.map((id) => ({
      carrier_user_id: id,
      with_carrier: bags().filter((b) => b.carrier_user_id === id && b.status === 'with_carrier').length,
      in_transit: bags().filter((b) => b.carrier_user_id === id && b.status === 'in_transit').length,
    }))];
  }

  // --- registration
  if (/SELECT serial FROM cash_bags WHERE organization_id = \? AND serial IN/.test(s)) {
    const wanted = params.slice(1);
    return [state.bags.filter((b) => b.organization_id === org && wanted.includes(b.serial)).map((b) => ({ serial: b.serial }))];
  }
  if (/^INSERT INTO cash_bags /.test(s.trim())) {
    const [orgId, serial, currency, notes, createdBy] = params;
    if (state.bags.some((b) => b.organization_id === orgId && b.serial === serial)) {
      const err = new Error(`Duplicate entry '${serial}'`);
      err.code = 'ER_DUP_ENTRY';
      err.errno = 1062;
      throw err;
    }
    const id = ++state.seq.bag;
    state.bags.push({
      id, organization_id: orgId, serial, status: 'in_stock', reseller_id: null, carrier_user_id: null,
      declared_amount: null, counted_amount: null, currency, notes, created_by: createdBy,
      sealed_at: null, sealed_by: null, picked_up_at: null, picked_up_by: null, received_at: null, received_by: null,
      created_at: new Date(), updated_at: new Date(), deleted_at: null,
    });
    return [{ insertId: id, affectedRows: 1 }];
  }
  if (/^INSERT INTO cash_bag_events/.test(s.trim())) {
    for (let i = 0; i < params.length; i += 11) {
      const [orgId, bagId, from, to, actor, amount, resellerId, carrier, lat, lng, note] = params.slice(i, i + 11);
      state.events.push({
        id: ++state.seq.event, organization_id: orgId, bag_id: bagId, from_status: from, to_status: to,
        actor_user_id: actor, amount: amount === null ? null : Number(amount).toFixed(2), reseller_id: resellerId,
        carrier_user_id: carrier, latitude: lat, longitude: lng, note, created_at: new Date(),
      });
    }
    return [{ affectedRows: params.length / 11 }];
  }

  // --- locks and reads of one bag
  if (/FROM cash_bags WHERE organization_id = \? AND deleted_at IS NULL AND (id|serial) IN/.test(s)) {
    const byId = /AND id IN/.test(s);
    const n = (s.match(/IN \(([^)]*)\)/)[1].match(/\?/g) || []).length;
    const keys = params.slice(1, 1 + n).map((k) => (byId ? Number(k) : k));
    let rows = bags().filter((b) => keys.includes(byId ? b.id : b.serial));
    if (/AND carrier_user_id = \? AND status = 'with_carrier'/.test(s)) {
      const carrier = Number(params[1 + n]);
      rows = rows.filter((b) => b.carrier_user_id === carrier && b.status === 'with_carrier');
    }
    return [rows.sort((a, b) => a.id - b.id).map(bagRow)];
  }
  if (/FROM cash_bags WHERE organization_id = \? AND serial = \? AND reseller_id = \? AND status = '(\w+)'/.test(s)) {
    const status = /status = '(\w+)'/.exec(s)[1];
    return [bags().filter((b) => b.serial === params[1] && b.reseller_id === Number(params[2]) && b.status === status).map(bagRow)];
  }
  if (/SELECT reseller_id FROM cash_bags WHERE id = \? AND organization_id = \?/.test(s)) {
    const b = state.bags.find((x) => x.id === Number(params[0]) && x.organization_id === Number(params[1]) && live(x));
    return [b ? [{ reseller_id: b.reseller_id }] : []];
  }
  if (/FROM cash_bags WHERE id = \? AND organization_id = \? AND deleted_at IS NULL/.test(s)) {
    const b = state.bags.find((x) => x.id === Number(params[0]) && x.organization_id === Number(params[1]) && live(x));
    return [b ? [bagRow(b)] : []];
  }

  // --- transitions
  const update = (match, apply) => {
    const rows = state.bags.filter((b) => live(b) && match(b));
    rows.forEach((b) => { apply(b); b.updated_at = new Date(); });
    return [{ affectedRows: rows.length }];
  };
  const idsOf = (from) => params.slice(from).map(Number);
  if (/^UPDATE cash_bags SET status = 'with_carrier', carrier_user_id = \? WHERE organization_id = \? AND status = 'in_stock'/.test(s.trim())) {
    const [carrier, orgId] = params;
    const ids = idsOf(2);
    return update((b) => b.organization_id === orgId && b.status === 'in_stock' && ids.includes(b.id), (b) => { b.status = 'with_carrier'; b.carrier_user_id = carrier; });
  }
  if (/^UPDATE cash_bags SET status = 'at_reseller', reseller_id = \?/.test(s.trim())) {
    const [rid, orgId, carrier] = params;
    const ids = idsOf(3);
    return update((b) => b.organization_id === orgId && b.carrier_user_id === carrier && b.status === 'with_carrier' && ids.includes(b.id), (b) => { b.status = 'at_reseller'; b.reseller_id = rid; });
  }
  if (/^UPDATE cash_bags SET status = 'in_transit'/.test(s.trim())) {
    const [carrier, by, id, orgId] = params;
    return update((b) => b.id === Number(id) && b.organization_id === orgId && b.status === 'ready_for_pickup', (b) => {
      b.status = 'in_transit'; b.carrier_user_id = carrier; b.picked_up_by = by; b.picked_up_at = new Date();
    });
  }
  if (/^UPDATE cash_bags SET status = 'ready_for_pickup'/.test(s.trim())) {
    const [declared, by, id, orgId] = params;
    return update((b) => b.id === Number(id) && b.organization_id === orgId && b.status === 'at_reseller', (b) => {
      b.status = 'ready_for_pickup'; b.declared_amount = Number(declared).toFixed(2); b.sealed_by = by; b.sealed_at = new Date();
    });
  }
  if (/^UPDATE cash_bags SET status = 'received'/.test(s.trim())) {
    const [counted, by, id, orgId, from] = params;
    return update((b) => b.id === Number(id) && b.organization_id === orgId && b.status === from, (b) => {
      b.status = 'received'; b.counted_amount = Number(counted).toFixed(2); b.received_by = by; b.received_at = new Date();
    });
  }
  if (/^UPDATE cash_bags SET status = '(lost|void)' WHERE id = \?/.test(s.trim())) {
    const to = /status = '(lost|void)'/.exec(s)[1];
    const [id, orgId, from] = params;
    return update((b) => b.id === Number(id) && b.organization_id === orgId && b.status === from, (b) => { b.status = to; });
  }
  if (/^UPDATE cash_bags SET status = 'in_stock', carrier_user_id = NULL/.test(s.trim())) {
    const [id, orgId] = params;
    return update((b) => b.id === Number(id) && b.organization_id === orgId && b.status === 'with_carrier', (b) => { b.status = 'in_stock'; b.carrier_user_id = null; });
  }
  if (/^UPDATE cash_bags SET status = 'with_carrier', reseller_id = NULL, carrier_user_id = \?/.test(s.trim())) {
    const [carrier, id, orgId] = params;
    return update((b) => b.id === Number(id) && b.organization_id === orgId && b.status === 'at_reseller', (b) => {
      b.status = 'with_carrier'; b.reseller_id = null; b.carrier_user_id = carrier;
    });
  }

  // --- lists
  if (/FROM cash_bags b WHERE b\.organization_id = \?/.test(s) && !/GROUP BY/.test(s)) {
    let rest = params.slice(1);
    let rows = bags();
    const statuses = /b\.status IN \(([^)]*)\)/.exec(s);
    if (statuses) {
      const n = (statuses[1].match(/\?/g) || []).length;
      const wanted = rest.slice(0, n);
      rest = rest.slice(n);
      rows = rows.filter((b) => wanted.includes(b.status));
    }
    if (/b\.reseller_id = \?/.test(s)) { const id = Number(rest.shift()); rows = rows.filter((b) => b.reseller_id === id); }
    if (/b\.carrier_user_id = \?/.test(s)) { const id = Number(rest.shift()); rows = rows.filter((b) => b.carrier_user_id === id); }
    if (/b\.serial LIKE \?/.test(s)) { const like = String(rest.shift()).replace(/%/g, ''); rows = rows.filter((b) => b.serial.includes(like)); }
    if (/b\.counted_amount <> b\.declared_amount/.test(s)) rows = rows.filter((b) => b.status === 'received' && cents(b.counted_amount) !== cents(b.declared_amount));
    if (/COUNT\(\*\) AS total/.test(s)) return [[{ total: rows.length }]];
    return [rows.slice().reverse().map(bagRow)];
  }
  if (/SELECT status, COUNT\(\*\) AS total FROM cash_bags/.test(s)) {
    let rows = bags();
    if (/AND reseller_id = \?/.test(s)) rows = rows.filter((b) => b.reseller_id === Number(params[1]));
    const counts = {};
    for (const b of rows) counts[b.status] = (counts[b.status] || 0) + 1;
    return [Object.entries(counts).map(([status, total]) => ({ status, total }))];
  }
  if (/SELECT b\.reseller_id, COUNT\(\*\) AS received_bags/.test(s)) {
    let rows = bags().filter((b) => b.status === 'received');
    if (/AND b\.reseller_id = \?/.test(s)) rows = rows.filter((b) => b.reseller_id === Number(params[1]));
    const by = new Map();
    for (const b of rows) {
      const g = by.get(b.reseller_id) || { reseller_id: b.reseller_id, received_bags: 0, declared: 0, counted: 0, diff: 0 };
      g.received_bags += 1; g.declared += cents(b.declared_amount); g.counted += cents(b.counted_amount);
      if (cents(b.declared_amount) !== cents(b.counted_amount)) g.diff += 1;
      by.set(b.reseller_id, g);
    }
    return [[...by.values()].map((g) => ({
      reseller_id: g.reseller_id, received_bags: g.received_bags, declared_total: fromCents(g.declared),
      counted_total: fromCents(g.counted), variance: fromCents(g.counted - g.declared), bags_with_difference: g.diff,
    }))];
  }
  if (/FROM cash_bags WHERE organization_id = \? AND reseller_id = \? AND deleted_at IS NULL ORDER BY updated_at/.test(s)) {
    return [bags().filter((b) => b.reseller_id === Number(params[1])).reverse().map(bagRow)];
  }
  if (/COUNT\(\*\) AS total FROM cash_bags WHERE organization_id = \? AND reseller_id = \?/.test(s)) {
    return [[{ total: bags().filter((b) => b.reseller_id === Number(params[1])).length }]];
  }
  if (/FROM cash_bags WHERE organization_id = \? AND reseller_id = \? AND deleted_at IS NULL AND status IN \('at_reseller'/.test(s)) {
    return [bags().filter((b) => b.reseller_id === Number(params[1]) && ['at_reseller', 'ready_for_pickup', 'in_transit'].includes(b.status)).map(bagRow)];
  }
  if (/FROM cash_bags WHERE organization_id = \? AND carrier_user_id = \? AND deleted_at IS NULL AND status IN \('with_carrier', 'in_transit'\)/.test(s)) {
    return [bags().filter((b) => b.carrier_user_id === Number(params[1]) && ['with_carrier', 'in_transit'].includes(b.status)).map(bagRow)];
  }
  if (/FROM cash_bag_events WHERE organization_id = \? AND bag_id IN/.test(s)) {
    const ids = params.slice(1).map(Number);
    return [state.events.filter((e) => e.organization_id === org && ids.includes(e.bag_id))];
  }
  if (/SELECT id, serial FROM cash_bags WHERE organization_id = \? AND id IN/.test(s)) {
    const ids = params.slice(1).map(Number);
    return [state.bags.filter((b) => b.organization_id === org && ids.includes(b.id)).map((b) => ({ id: b.id, serial: b.serial }))];
  }

  // --- the received bag's ledger lines
  if (/FROM reseller_ledger_entries WHERE organization_id = \? AND id IN/.test(s)) {
    const ids = params.slice(1).map(Number);
    return [state.ledger.filter((e) => ids.includes(e.id))];
  }

  // --- carrier assignments
  if (/FROM carrier_reseller_assignments a JOIN resellers r/.test(s)) {
    const carriers = /a\.carrier_user_id IN/.test(s) ? params.slice(1).map(Number) : [Number(params[1])];
    let rows = state.assignments.filter((a) => a.organization_id === org && carriers.includes(a.carrier_user_id));
    if (/AND a\.reseller_id = \?/.test(s)) rows = rows.filter((a) => a.reseller_id === Number(params[2]));
    return [rows.map((a) => ({ a, r: state.resellers[a.reseller_id] }))
      .filter(({ r }) => r && r.organization_id === org && !r.deleted_at && r.parent_id === null)
      .map(({ a, r }) => ({ ...r, carrier_user_id: a.carrier_user_id }))];
  }
  if (/SELECT reseller_id FROM carrier_reseller_assignments/.test(s)) {
    return [state.assignments.filter((a) => a.organization_id === org && a.carrier_user_id === Number(params[1])).map((a) => ({ reseller_id: a.reseller_id }))];
  }
  if (/^DELETE FROM carrier_reseller_assignments/.test(s.trim())) {
    const before = state.assignments.length;
    state.assignments = state.assignments.filter((a) => !(a.organization_id === org && a.carrier_user_id === Number(params[1])));
    return [{ affectedRows: before - state.assignments.length }];
  }
  if (/^INSERT INTO carrier_reseller_assignments/.test(s.trim())) {
    for (let i = 0; i < params.length; i += 4) {
      const [orgId, carrier, resellerId, by] = params.slice(i, i + 4);
      state.assignments.push({ organization_id: orgId, carrier_user_id: carrier, reseller_id: resellerId, created_by: by });
    }
    return [{ affectedRows: params.length / 4 }];
  }
  if (/SELECT id FROM resellers WHERE organization_id = \? AND deleted_at IS NULL AND parent_id IS NULL AND id IN/.test(s)) {
    const ids = params.slice(1).map(Number);
    return [Object.values(state.resellers).filter((r) => r.organization_id === org && !r.deleted_at && r.parent_id === null && ids.includes(r.id)).map((r) => ({ id: r.id }))];
  }
  if (/SELECT id, name, city FROM resellers WHERE organization_id = \? AND deleted_at IS NULL AND parent_id IS NULL ORDER BY name/.test(s)) {
    const rows = Object.values(state.resellers).filter((r) => r.organization_id === org && !r.deleted_at && r.parent_id === null);
    return [rows.sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id).map((r) => ({ id: r.id, name: r.name, city: r.city ?? null }))];
  }
  if (/SELECT COUNT\(\*\) AS total FROM resellers WHERE organization_id = \? AND deleted_at IS NULL AND parent_id IS NULL/.test(s)) {
    return [[{ total: Object.values(state.resellers).filter((r) => r.organization_id === org && !r.deleted_at && r.parent_id === null).length }]];
  }
  if (/SELECT id, name FROM resellers WHERE organization_id = \? AND id IN/.test(s)) {
    const ids = params.slice(1).map(Number);
    return [Object.values(state.resellers).filter((r) => r.organization_id === org && ids.includes(r.id)).map((r) => ({ id: r.id, name: r.name }))];
  }
  return undefined;
}

module.exports = { handleCashBagSql, quotedList };

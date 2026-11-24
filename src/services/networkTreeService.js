// =============================================================================
// VigaBSS 5.0 — the network as a tree
// =============================================================================
// "What feeds what", as a simple tree: a main NAS at the top and, under it,
// the sub-NAS routers, point-to-point and point-to-multipoint links, OLTs,
// switches, battery monitors and so on. An ISP with more than one network or
// origin marks more than one NAS as main and gets one tree for each.
//
//   - A piece of equipment has at most ONE parent (devices.parent_device_id),
//     which is what makes it a tree and keeps it simple to read.
//   - A main NAS (nas.is_main, migration 027) is a root and has no parent.
//   - Equipment not yet placed under anything is "unplaced": it is listed
//     beside the trees, never hidden.
//   - Subscriber equipment (CPEs and ONUs) is not part of this tree.
//
// A NAS takes part through the device that represents it (nas.device_id,
// created on demand by topologyMapService.deviceForNode), so one mechanism
// serves the tree, the map and links.
// =============================================================================

const db = require('../config/database');
const { ValidationError } = require('../utils/errors');
const { deviceForNode } = require('./topologyMapService');

const SUBSCRIBER_TYPES = ['outdoor_cpe', 'indoor_cpe', 'onu'];
const MAX_DEPTH = 64;

const coordinate = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * The whole picture for one organization.
 * @returns {Promise<{trees: object[], unplaced: object[], sites: object[]}>}
 */
async function getTree(orgId) {
  const [devices] = await db.query(
    `SELECT d.id, d.name, d.type, d.status, d.site_id, d.parent_device_id, d.ip_address, d.latitude, d.longitude, s.name AS site_name
       FROM devices d
       LEFT JOIN sites s ON s.id = d.site_id AND s.deleted_at IS NULL
      WHERE d.organization_id = ? AND d.deleted_at IS NULL
        AND d.type NOT IN (${SUBSCRIBER_TYPES.map(() => '?').join(', ')})
      ORDER BY d.name`,
    [orgId, ...SUBSCRIBER_TYPES],
  );
  const [nasRows] = await db.query(
    `SELECT n.id, n.name, n.type, n.device_id, n.is_main, n.site_id, n.ip_address, s.name AS site_name
       FROM nas n
       LEFT JOIN sites s ON s.id = n.site_id AND s.deleted_at IS NULL
      WHERE n.organization_id = ? AND n.deleted_at IS NULL
      ORDER BY n.name`,
    [orgId],
  );

  const [siteRows] = await db.query(
    'SELECT id, name, latitude, longitude FROM sites WHERE organization_id = ? AND deleted_at IS NULL ORDER BY name',
    [orgId],
  );
  const sites = siteRows.map((x) => ({ id: Number(x.id), name: x.name, latitude: coordinate(x.latitude), longitude: coordinate(x.longitude) }));

  const nodes = new Map();
  for (const d of devices) {
    nodes.set(Number(d.id), {
      id: Number(d.id), name: d.name, type: d.type, status: d.status, ip_address: d.ip_address || null,
      site_id: d.site_id || null, site_name: d.site_name || null,
      latitude: coordinate(d.latitude), longitude: coordinate(d.longitude),
      parent_id: d.parent_device_id ? Number(d.parent_device_id) : null, children: [],
    });
  }
  const unplaced = [];
  for (const n of nasRows) {
    const twin = n.device_id ? nodes.get(Number(n.device_id)) : null;
    if (twin) {
      Object.assign(twin, { kind: 'nas', nas_id: Number(n.id), make: n.type || null, is_main: Number(n.is_main) === 1 });
    } else {
      // A NAS that has not been placed anywhere yet.
      unplaced.push({
        id: `nas-${n.id}`, kind: 'nas', nas_id: Number(n.id), name: n.name, type: 'router', make: n.type || null,
        status: null, ip_address: n.ip_address || null, site_id: n.site_id || null, site_name: n.site_name || null,
        latitude: null, longitude: null,
        parent_id: null, is_main: false, children: [],
      });
    }
  }

  const trees = [];
  for (const node of nodes.values()) {
    if (node.is_main) { trees.push(node); continue; }
    const parent = node.parent_id ? nodes.get(node.parent_id) : null;
    if (parent) parent.children.push(node);
    else unplaced.push(node);
  }
  // A loop in the data (which setParent prevents) must not hang the page:
  // anything not reachable from a root or an unplaced top is cut loose.
  const seen = new Set();
  const mark = (node, depth) => {
    if (seen.has(node.id) || depth > MAX_DEPTH) { node.children = []; return; }
    seen.add(node.id);
    node.children = node.children.filter((c) => !seen.has(c.id));
    node.children.forEach((c) => mark(c, depth + 1));
  };
  trees.forEach((t) => mark(t, 0));
  unplaced.forEach((u) => mark(u, 0));
  for (const node of nodes.values()) {
    if (!seen.has(node.id)) { node.children = []; node.parent_id = null; unplaced.push(node); seen.add(node.id); }
  }
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
  const sortDeep = (list) => { list.sort(byName); list.forEach((n) => sortDeep(n.children)); };
  sortDeep(trees); sortDeep(unplaced);
  return { trees, unplaced, sites };
}

/**
 * Put a piece of equipment under another one, or take it out of the tree
 * (parent null). Refused: itself as parent, anything under itself (a loop),
 * and giving a parent to a main NAS.
 */
async function setParent(orgId, nodeRef, parentRef) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const nodeId = await deviceForNode(conn, orgId, nodeRef);
    const [[self]] = await conn.query(
      `SELECT d.id, COALESCE(n.is_main, 0) AS is_main
         FROM devices d LEFT JOIN nas n ON n.device_id = d.id AND n.deleted_at IS NULL
        WHERE d.id = ? AND d.organization_id = ? AND d.deleted_at IS NULL FOR UPDATE`,
      [nodeId, orgId],
    );
    let parentId = null;
    if (parentRef !== null && parentRef !== undefined && parentRef !== '') {
      if (Number(self.is_main) === 1) throw new ValidationError('A main NAS is the top of its tree. Unmark it as main before placing it under something.');
      parentId = await deviceForNode(conn, orgId, parentRef);
      if (parentId === nodeId) throw new ValidationError('Equipment cannot be placed under itself');
      // Walk up from the new parent: meeting the node means a loop.
      let cursor = parentId;
      for (let depth = 0; cursor && depth <= MAX_DEPTH; depth += 1) {
        const [[row]] = await conn.query(
          'SELECT parent_device_id FROM devices WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [cursor, orgId],
        );
        cursor = row && row.parent_device_id ? Number(row.parent_device_id) : null;
        if (cursor === nodeId) throw new ValidationError('That would make a loop: it is already above the equipment you chose');
        if (depth === MAX_DEPTH) throw new ValidationError('The tree is too deep');
      }
    }
    await conn.query(
      'UPDATE devices SET parent_device_id = ? WHERE id = ? AND organization_id = ?', [parentId, nodeId, orgId],
    );
    await conn.commit();
    return { id: nodeId, parent_id: parentId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Mark a NAS as the top of a tree, or unmark it. A main NAS has no parent. */
async function setMain(orgId, nasId, main) {
  const id = Number(nasId);
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('That NAS does not exist');
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const deviceId = await deviceForNode(conn, orgId, `nas-${id}`);
    await conn.query('UPDATE nas SET is_main = ? WHERE id = ? AND organization_id = ?', [main ? 1 : 0, id, orgId]);
    if (main) {
      await conn.query('UPDATE devices SET parent_device_id = NULL WHERE id = ? AND organization_id = ?', [deviceId, orgId]);
    }
    await conn.commit();
    return { nas_id: id, device_id: deviceId, is_main: Boolean(main) };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Put a piece of equipment at a point of the map. Used by the network map;
 * a NAS that is not a device yet becomes one here.
 */
async function setPosition(orgId, nodeRef, latitude, longitude) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  const valid = (value, limit) => value !== null && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= limit;
  if (!valid(latitude, 90) || !valid(longitude, 180)) throw new ValidationError('That is not a point on the map');
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const nodeId = await deviceForNode(conn, orgId, nodeRef);
    await conn.query(
      'UPDATE devices SET latitude = ?, longitude = ? WHERE id = ? AND organization_id = ?',
      [Number(lat.toFixed(7)), Number(lng.toFixed(7)), nodeId, orgId],
    );
    await conn.commit();
    return { id: nodeId, latitude: Number(lat.toFixed(7)), longitude: Number(lng.toFixed(7)) };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { getTree, setParent, setMain, setPosition, SUBSCRIBER_TYPES };

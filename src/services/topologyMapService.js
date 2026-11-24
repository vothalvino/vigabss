// =============================================================================
// VigaBSS 5.0 — Topology Map Service — §13
// =============================================================================
// Provides data for the three map layers:
//   §13.1  Network Topology Map — device graph with link utilization
//   §13.2  Geographic Mapping   — customer pins, coverage zones, fiber routes, infra
//   §13.3  Dependency Mapping   — parent-child graph, impact analysis, cascade
// =============================================================================

const db = require('../config/database');
const { inPlaceholders } = require('../utils/sqlBuild');
const { ValidationError, NotFoundError } = require('../utils/errors');
const _logger = require('../utils/logger').child({ service: 'topologyMapService' });

// ---------------------------------------------------------------------------
// §13.1 Network Topology Map
// ---------------------------------------------------------------------------

/**
 * Build a node+edge graph for the topology map.
 * Nodes are devices (with lat/lng for geo placement) and edges are network_links
 * enriched with utilization data from the most recent SNMP metric sample.
 *
 * @param {number} orgId
 * @param {string|null} layer  'l2' | 'l3' | 'physical' — null = all
 * @returns {Promise<{ nodes: object[], edges: object[] }>}
 */
async function getNetworkGraph(orgId, layer = null) {
  const [nodes] = await db.query(
    `SELECT d.id, d.name, d.type, d.role, d.status,
            d.latitude, d.longitude, d.ip_address, d.site_id,
            s.name AS site_name
     FROM devices d
     LEFT JOIN sites s ON s.id = d.site_id
     WHERE d.deleted_at IS NULL
       AND (d.organization_id = ?
         OR d.site_id IN (SELECT id FROM sites WHERE organization_id = ?))
     ORDER BY d.name`,
    [orgId, orgId],
  );

  let edgeSql = `
    SELECT nl.id, nl.device_a_id, nl.device_b_id, nl.medium, nl.role,
           nl.status, nl.capacity_mbps AS bandwidth_mbps
     FROM network_links nl
     WHERE nl.deleted_at IS NULL
       AND nl.status != 'decommissioned'
       AND nl.organization_id = ?`;

  const params = [orgId];

  if (layer === 'l2') {
    edgeSql += " AND nl.medium IN ('ethernet','fiber','copper')";
  } else if (layer === 'l3') {
    edgeSql += " AND nl.medium IN ('vpn','mpls','gre','ip_tunnel')";
  } else if (layer === 'physical') {
    edgeSql += " AND nl.medium NOT IN ('vpn','mpls','gre','ip_tunnel')";
  }

  const [edges] = await db.query(edgeSql, params);
  const rates = await latestDeviceRates([...new Set(edges.filter(e => e.bandwidth_mbps).map(e => e.device_a_id))]);

  // Compute utilization percentage per edge (0-100, null if no rate)
  const enrichedEdges = edges.map(e => {
    let utilization = null;
    const rate = rates.get(e.device_a_id);
    if (e.bandwidth_mbps && rate) {
      const capacityBps = e.bandwidth_mbps * 1_000_000;
      utilization = Math.min(100, Math.round((Math.max(rate.inBps, rate.outBps) / capacityBps) * 100));
    }
    return {
      id: e.id,
      source: e.device_a_id,
      target: e.device_b_id,
      medium: e.medium,
      role: e.role,
      status: e.status,
      bandwidth_mbps: e.bandwidth_mbps,
      utilization,
    };
  });

  // NAS routers are kept in their own table, so they were missing from the
  // map. A NAS has no coordinates of its own: it is drawn at its site. One
  // without a located site cannot be placed and is returned separately so the
  // page can say why it is not shown.
  const [nasRows] = await db.query(
    `SELECT n.id, n.name, n.type, n.status, n.ip_address, n.site_id, n.device_id,
            s.name AS site_name, s.latitude, s.longitude
       FROM nas n
       LEFT JOIN sites s ON s.id = n.site_id AND s.deleted_at IS NULL
      WHERE n.deleted_at IS NULL AND n.organization_id = ?
      ORDER BY n.name`,
    [orgId],
  );
  const nasNodes = [];
  const nasWithoutLocation = [];
  const deviceNodes = new Map(nodes.map((d) => [Number(d.id), d]));
  for (const n of nasRows) {
    // A NAS that has been linked is represented by its device (migration 026):
    // one marker, placed and linked like any device, labelled as the NAS.
    const twin = n.device_id ? deviceNodes.get(Number(n.device_id)) : null;
    if (twin) {
      twin.kind = 'nas';
      twin.nas_id = n.id;
      twin.role = n.type || twin.role;
      if (twin.latitude === null && n.latitude !== null && n.latitude !== undefined) {
        twin.latitude = Number(n.latitude);
        twin.longitude = Number(n.longitude);
      }
      continue;
    }
    if (n.latitude === null || n.latitude === undefined || n.longitude === null || n.longitude === undefined) {
      nasWithoutLocation.push({ id: n.id, name: n.name, site_name: n.site_name || null });
      continue;
    }
    nasNodes.push({
      id: `nas-${n.id}`,
      kind: 'nas',
      nas_id: n.id,
      name: n.name,
      type: 'nas',
      role: n.type || 'other',
      status: n.status,
      latitude: Number(n.latitude),
      longitude: Number(n.longitude),
      ip_address: n.ip_address,
      site_id: n.site_id,
      site_name: n.site_name,
    });
  }

  return { nodes: [...nodes, ...nasNodes], edges: enrichedEdges, nas_without_location: nasWithoutLocation };
}

const NODE_REF = /^(?:nas-)?[1-9]\d{0,18}$/;
const LINK_TYPES = ['fiber', 'wireless', 'copper', 'virtual', 'other'];

/**
 * The device behind a map node. A device node is its own id. A NAS node
 * ("nas-<id>") is the device that represents that NAS, created here the
 * first time it is needed: a router at the NAS's site, with the site's
 * coordinates so it stays where it was drawn.
 *
 * @param {object} conn  transaction connection
 * @returns {Promise<number>} devices.id
 */
async function deviceForNode(conn, orgId, ref) {
  const text = String(ref ?? '');
  if (!NODE_REF.test(text)) throw new ValidationError('A link joins two points of the map');
  if (!text.startsWith('nas-')) {
    const [rows] = await conn.query(
      'SELECT id FROM devices WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [Number(text), orgId],
    );
    if (!rows[0]) throw new ValidationError('That device does not exist');
    return Number(rows[0].id);
  }
  const nasId = Number(text.slice(4));
  const [rows] = await conn.query(
    `SELECT n.id, n.name, n.type, n.ip_address, n.site_id, n.device_id, s.latitude, s.longitude
       FROM nas n
       LEFT JOIN sites s ON s.id = n.site_id AND s.deleted_at IS NULL
      WHERE n.id = ? AND n.organization_id = ? AND n.deleted_at IS NULL
      FOR UPDATE`,
    [nasId, orgId],
  );
  const nas = rows[0];
  if (!nas) throw new ValidationError('That NAS does not exist');
  if (nas.device_id) {
    const [live] = await conn.query(
      'SELECT id FROM devices WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', [nas.device_id, orgId],
    );
    if (live[0]) return Number(live[0].id);
  }
  const [ins] = await conn.query(
    `INSERT INTO devices (organization_id, site_id, category, name, type, manufacturer, ip_address, latitude, longitude, role)
     VALUES (?, ?, 'pop', ?, 'router', ?, ?, ?, ?, 'core')`,
    [orgId, nas.site_id || null, nas.name, nas.type && nas.type !== 'other' ? nas.type : null, nas.ip_address || null,
      nas.latitude ?? null, nas.longitude ?? null],
  );
  await conn.query('UPDATE nas SET device_id = ? WHERE id = ? AND organization_id = ?', [ins.insertId, nasId, orgId]);
  return Number(ins.insertId);
}

/**
 * Draw a link between two map nodes (devices or NAS routers).
 * @param {{a: number|string, b: number|string, link_type?: string, capacity_mbps?: number|null}} input
 */
async function createLink(orgId, input) {
  const linkType = input.link_type === undefined || input.link_type === null ? 'fiber' : String(input.link_type);
  if (!LINK_TYPES.includes(linkType)) throw new ValidationError('link_type is not valid');
  let capacity = null;
  if (input.capacity_mbps !== undefined && input.capacity_mbps !== null && input.capacity_mbps !== '') {
    capacity = Number(input.capacity_mbps);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000000) throw new ValidationError('capacity_mbps must be a whole number of Mbps');
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const deviceA = await deviceForNode(conn, orgId, input.a);
    const deviceB = await deviceForNode(conn, orgId, input.b);
    if (deviceA === deviceB) throw new ValidationError('A link joins two different points');
    const [existing] = await conn.query(
      `SELECT id FROM network_links
        WHERE organization_id = ? AND deleted_at IS NULL AND status != 'decommissioned'
          AND ((device_a_id = ? AND device_b_id = ?) OR (device_a_id = ? AND device_b_id = ?))
        LIMIT 1`,
      [orgId, deviceA, deviceB, deviceB, deviceA],
    );
    if (existing[0]) throw new ValidationError('These two points are already linked');
    const [ins] = await conn.query(
      `INSERT INTO network_links (organization_id, device_a_id, device_b_id, link_type, medium, capacity_mbps, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [orgId, deviceA, deviceB, linkType, ['fiber', 'wireless', 'copper'].includes(linkType) ? linkType : null, capacity],
    );
    await conn.commit();
    return { id: ins.insertId, source: deviceA, target: deviceB, link_type: linkType, capacity_mbps: capacity };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Remove a link from the map (soft delete). */
async function removeLink(orgId, linkId) {
  const [result] = await db.query(
    'UPDATE network_links SET deleted_at = NOW() WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [linkId, orgId],
  );
  if (!result.affectedRows) throw new NotFoundError('Network link');
  return { id: Number(linkId), removed: true };
}

/**
 * Current in/out rate of each device, in bits per second, from the counter
 * delta between its two newest poll buckets over their real elapsed time.
 *
 * snmp_metrics stores the raw cumulative ifHC*Octets counters. Treating their
 * 5-minute sum as bytes moved in 300 s gave tens of Gbps for any device with
 * real uptime, so every edge sat at 100% (NPR-04). Same approach as GET
 * /snmp-metrics/devices and rateTransform.currentRate: interface rows are
 * bucketed to the minute and summed per device; a pair whose interface set
 * differs, or whose counters went backwards (reset, wrap), yields no rate
 * rather than an invented one.
 *
 * @param {number[]} deviceIds
 * @returns {Promise<Map<number, {inBps: number, outBps: number}>>}
 */
async function latestDeviceRates(deviceIds) {
  const rates = new Map();
  if (!deviceIds.length) return rates;
  const [rows] = await db.query(
    `SELECT device_id,
            FLOOR(UNIX_TIMESTAMP(polled_at) / 60) AS minute_bucket,
            UNIX_TIMESTAMP(MAX(polled_at)) AS ts,
            SUM(if_in_octets) AS in_octets,
            SUM(if_out_octets) AS out_octets,
            GROUP_CONCAT(DISTINCT interface_id ORDER BY interface_id) AS iface_signature
       FROM snmp_metrics
      WHERE device_id IN (${deviceIds.map(() => '?').join(', ')}) AND interface_id IS NOT NULL
        AND polled_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
      GROUP BY device_id, minute_bucket
      ORDER BY device_id ASC, minute_bucket DESC`,
    deviceIds,
  );
  const latestTwo = new Map();
  for (const row of rows) {
    const list = latestTwo.get(row.device_id) || [];
    if (list.length < 2) list.push(row);
    latestTwo.set(row.device_id, list);
  }
  for (const [deviceId, [newer, older]] of latestTwo) {
    if (!older || newer.iface_signature !== older.iface_signature) continue;
    const seconds = Number(newer.ts) - Number(older.ts);
    const dIn = Number(newer.in_octets) - Number(older.in_octets);
    const dOut = Number(newer.out_octets) - Number(older.out_octets);
    if (!(seconds > 0) || dIn < 0 || dOut < 0) continue;
    rates.set(deviceId, { inBps: (dIn * 8) / seconds, outBps: (dOut * 8) / seconds });
  }
  return rates;
}

/**
 * §13.1 Network Fabric — a schematic, tier-laid-out view of the network for
 * the "Network Fabric" topology tab. Returns the device graph enriched with a
 * layout tier (from device role), latest per-node SNMP metrics, per-PoP client
 * counts, and the org's currently-ongoing outages as incidents.
 *
 * Reuses getNetworkGraph for nodes/edges; everything else is one extra query
 * each. Client count is per-SITE (PoP) via contracts.site_id — a per-device
 * count for aggregation nodes isn't modelled (documented gap).
 *
 * @param {number} orgId
 */
async function getFabric(orgId) {
  const { nodes, edges } = await getNetworkGraph(orgId);

  // Layout tier: prefer the explicit network role; when a device has no role
  // (common — role isn't always set), infer a sensible tier from its type so
  // the fabric still lays out in columns instead of collapsing to one. Unknown
  // → the access edge.
  const TIER_ROLE = { core: 0, backhaul: 1, distribution: 1, access: 2 };
  const TIER_TYPE = {
    router: 0, switch: 1, olt: 1, ptp: 1, ptmp_ap: 1,
    onu: 2, indoor_cpe: 2, outdoor_cpe: 2, other: 2,
  };
  const has = (obj, k) => k !== null && Object.prototype.hasOwnProperty.call(obj, k);
  const tierFor = (role, type) => {
    if (has(TIER_ROLE, role)) return TIER_ROLE[role];
    if (has(TIER_TYPE, type)) return TIER_TYPE[type];
    return 2;
  };

  const deviceIds = nodes.map(n => n.id);
  const metricsById = new Map();
  const firmwareById = new Map();

  if (deviceIds.length > 0) {
    // db.query() is execute()-backed — `IN (?)` does NOT expand an array bind
    // (see sqlBuild.inPlaceholders). Expand placeholders and spread the ids.
    const idsIn = inPlaceholders(deviceIds);

    const [devs] = await db.query(
      `SELECT id, firmware FROM devices WHERE id IN (${idsIn})`,
      [...deviceIds],
    );
    for (const d of devs) firmwareById.set(d.id, d.firmware);

    // Latest device-level (interface_id IS NULL) metric row per device.
    const [metrics] = await db.query(
      `SELECT m.device_id, m.cpu_usage, m.memory_usage, m.uptime_ticks,
              m.temperature_c, m.sfp_rx_power_dbm
       FROM snmp_metrics m
       INNER JOIN (
         SELECT device_id, MAX(polled_at) AS latest
         FROM snmp_metrics
         WHERE interface_id IS NULL AND device_id IN (${idsIn})
         GROUP BY device_id
       ) lr ON m.device_id = lr.device_id AND m.polled_at = lr.latest
       WHERE m.interface_id IS NULL`,
      [...deviceIds],
    );
    for (const m of metrics) metricsById.set(m.device_id, m);
  }

  // Per-PoP (site) active-client counts.
  const siteIds = [...new Set(nodes.map(n => n.site_id).filter(id => id !== null))];
  const clientsBySite = new Map();
  if (siteIds.length > 0) {
    const sitesIn = inPlaceholders(siteIds);
    const [rows] = await db.query(
      `SELECT site_id, COUNT(DISTINCT client_id) AS clients
       FROM contracts
       WHERE site_id IN (${sitesIn}) AND status = 'active' AND deleted_at IS NULL
       GROUP BY site_id`,
      [...siteIds],
    );
    for (const r of rows) clientsBySite.set(r.site_id, Number(r.clients));
  }

  const fabricNodes = nodes.map(n => {
    const m = metricsById.get(n.id);
    return {
      id: n.id,
      name: n.name,
      type: n.type,
      role: n.role,
      status: n.status,
      site_id: n.site_id,
      site_name: n.site_name,
      tier: tierFor(n.role, n.type),
      metrics: {
        cpu_usage: m?.cpu_usage ?? null,
        memory_usage: m?.memory_usage ?? null,
        uptime_ticks: m?.uptime_ticks ?? null,
        temperature_c: m?.temperature_c ?? null,
        rx_power_dbm: m?.sfp_rx_power_dbm ?? null,
        firmware: firmwareById.get(n.id) ?? null,
        clients: n.site_id !== null ? (clientsBySite.get(n.site_id) ?? null) : null,
      },
    };
  });

  // Ongoing outages as incidents — org-scoped via either the site or the
  // device (device-only outages have site_id NULL, so a sites-only join drops
  // them). Ordered most-severe first.
  const [incidents] = await db.query(
    `SELECT o.id, o.device_id, o.site_id, o.title, o.description AS detail,
            o.severity, o.started_at
     FROM outages o
     LEFT JOIN sites s   ON s.id = o.site_id
     LEFT JOIN devices d ON d.id = o.device_id
     WHERE o.status = 'ongoing' AND o.deleted_at IS NULL
       AND (s.organization_id = ? OR d.organization_id = ?)
     ORDER BY FIELD(o.severity, 'critical', 'major', 'minor'), o.started_at DESC`,
    [orgId, orgId],
  );

  return { nodes: fabricNodes, edges, incidents };
}

// ---------------------------------------------------------------------------
// §13.2 Geographic Mapping
// ---------------------------------------------------------------------------

/**
 * Customer location pins — clients with lat/lng coordinates.
 * @param {number} orgId
 */
async function getCustomerLocations(orgId) {
  const [rows] = await db.query(
    `SELECT c.id, c.name, c.email, c.phone,
            c.latitude, c.longitude, c.address,
            c.status,
            ct.name AS contract_plan
     FROM clients c
     LEFT JOIN contracts con ON con.client_id = c.id AND con.status = 'active' AND con.deleted_at IS NULL
     LEFT JOIN plans ct ON ct.id = con.plan_id
     WHERE c.organization_id = ?
       AND c.deleted_at IS NULL
       AND c.latitude IS NOT NULL
       AND c.longitude IS NOT NULL`,
    [orgId],
  );
  return rows;
}

/**
 * Coverage data — service areas + coverage zones as GeoJSON polygons.
 * @param {number} orgId
 */
async function getCoverageData(orgId) {
  // Both tables store the polygon as a native MySQL POLYGON column named
  // `boundary` (no `coordinates`/`geojson`/`coverage_type` columns exist) —
  // ST_AsGeoJSON() converts it to the GeoJSON string the map frontend needs,
  // matching the pattern already used by coverageZoneService.js.
  const [serviceAreas] = await db.query(
    `SELECT id, name, ST_AsGeoJSON(boundary) AS coordinates, status
     FROM service_areas
     WHERE organization_id = ? AND deleted_at IS NULL`,
    [orgId],
  );

  const [coverageZones] = await db.query(
    `SELECT id, name, ST_AsGeoJSON(boundary) AS geojson, zone_type, color
     FROM coverage_zones
     WHERE organization_id = ? AND deleted_at IS NULL`,
    [orgId],
  );

  return { service_areas: serviceAreas, coverage_zones: coverageZones };
}

/**
 * Fiber routes with their route segments for polyline display.
 * @param {number} orgId
 */
async function getFiberRoutes(orgId) {
  const [routes] = await db.query(
    `SELECT fr.id, fr.name, fr.status, fr.cable_length_m AS total_length_m, fr.notes,
            fr.gis_path
     FROM fiber_routes fr
     WHERE fr.organization_id = ? AND fr.deleted_at IS NULL`,
    [orgId],
  );

  const [segments] = await db.query(
    `SELECT id, fiber_route_id, name, sequence_no, coordinates,
            length_m, cable_type, burial_type, fiber_count, status
     FROM fiber_route_segments
     WHERE organization_id = ?
     ORDER BY fiber_route_id, sequence_no`,
    [orgId],
  );

  // Group segments by route
  const segsByRoute = {};
  for (const seg of segments) {
    if (!segsByRoute[seg.fiber_route_id]) segsByRoute[seg.fiber_route_id] = [];
    segsByRoute[seg.fiber_route_id].push(seg);
  }

  return routes.map(r => ({ ...r, segments: segsByRoute[r.id] || [] }));
}

/**
 * Infrastructure pins — map_infrastructure_points + sites with lat/lng.
 * @param {number} orgId
 */
async function getInfrastructurePins(orgId) {
  const [points] = await db.query(
    `SELECT mip.id, mip.name, mip.type, mip.latitude, mip.longitude,
            mip.address, mip.description, mip.properties, mip.is_active,
            mip.site_id, s.name AS site_name
     FROM map_infrastructure_points mip
     LEFT JOIN sites s ON s.id = mip.site_id
     WHERE mip.organization_id = ?
       AND mip.deleted_at IS NULL
     ORDER BY mip.name`,
    [orgId],
  );

  // Also include sites that have lat/lng as additional pins
  const [sitePins] = await db.query(
    `SELECT id, name, 'site' AS type, latitude, longitude, address,
            NULL AS description, NULL AS properties, 1 AS is_active, NULL AS site_id
     FROM sites
     WHERE organization_id = ?
       AND deleted_at IS NULL
       AND latitude IS NOT NULL
       AND longitude IS NOT NULL`,
    [orgId],
  );

  return { infrastructure: points, sites: sitePins };
}

// ---------------------------------------------------------------------------
// §13.3 Dependency Mapping
// ---------------------------------------------------------------------------

/**
 * Impact analysis — all devices that would be impacted if the given device fails.
 * Uses a recursive BFS traversal of device_dependency_edges.
 *
 * @param {number} orgId
 * @param {number} deviceId  The failing device
 * @returns {Promise<{ device: object, impacted: object[], edge_count: number }>}
 */
async function getImpactAnalysis(orgId, deviceId) {
  const [[device]] = await db.query(
    `SELECT id, name, type, role, status, ip_address, latitude, longitude
     FROM devices
     WHERE id = ? AND deleted_at IS NULL
       AND (organization_id = ?
         OR site_id IN (SELECT id FROM sites WHERE organization_id = ?))`,
    [deviceId, orgId, orgId],
  );

  if (!device) return { device: null, impacted: [], edge_count: 0 };

  // Load all dependency edges for the org
  const [edges] = await db.query(
    `SELECT dde.parent_device_id, dde.child_device_id, dde.dependency_type, dde.is_redundant,
            d.name AS child_name, d.type AS child_type, d.status AS child_status,
            d.ip_address AS child_ip, d.latitude AS child_lat, d.longitude AS child_lng
     FROM device_dependency_edges dde
     JOIN devices d ON d.id = dde.child_device_id AND d.deleted_at IS NULL
     WHERE dde.organization_id = ?`,
    [orgId],
  );

  // BFS from deviceId following child edges
  const visited = new Set();
  const queue = [deviceId];
  const impacted = [];

  // Build adjacency map
  const childMap = {};
  for (const e of edges) {
    if (!childMap[e.parent_device_id]) childMap[e.parent_device_id] = [];
    childMap[e.parent_device_id].push(e);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const children = childMap[current] || [];
    for (const edge of children) {
      if (!visited.has(edge.child_device_id)) {
        visited.add(edge.child_device_id);
        impacted.push({
          device_id: edge.child_device_id,
          name: edge.child_name,
          type: edge.child_type,
          status: edge.child_status,
          ip_address: edge.child_ip,
          latitude: edge.child_lat,
          longitude: edge.child_lng,
          dependency_type: edge.dependency_type,
          is_redundant: !!edge.is_redundant,
        });
        queue.push(edge.child_device_id);
      }
    }
  }

  return { device, impacted, edge_count: impacted.length };
}

/**
 * Cascade chain — upstream failure chain from a device back to root.
 * Traverses parent edges to show "who failing would cause this device to fail."
 *
 * @param {number} orgId
 * @param {number} deviceId
 */
async function getCascadeChain(orgId, deviceId) {
  const [[device]] = await db.query(
    `SELECT id, name, type, role, status, ip_address
     FROM devices
     WHERE id = ? AND deleted_at IS NULL
       AND (organization_id = ?
         OR site_id IN (SELECT id FROM sites WHERE organization_id = ?))`,
    [deviceId, orgId, orgId],
  );

  if (!device) return { device: null, chain: [] };

  const [edges] = await db.query(
    `SELECT dde.parent_device_id, dde.child_device_id, dde.dependency_type, dde.is_redundant,
            d.name AS parent_name, d.type AS parent_type, d.status AS parent_status,
            d.ip_address AS parent_ip
     FROM device_dependency_edges dde
     JOIN devices d ON d.id = dde.parent_device_id AND d.deleted_at IS NULL
     WHERE dde.organization_id = ?`,
    [orgId],
  );

  // Build reverse adjacency: child → parents
  const parentMap = {};
  for (const e of edges) {
    if (!parentMap[e.child_device_id]) parentMap[e.child_device_id] = [];
    parentMap[e.child_device_id].push(e);
  }

  // BFS upward
  const visited = new Set();
  const queue = [deviceId];
  const chain = [];

  while (queue.length > 0) {
    const current = queue.shift();
    const parents = parentMap[current] || [];
    for (const edge of parents) {
      if (!visited.has(edge.parent_device_id)) {
        visited.add(edge.parent_device_id);
        chain.push({
          device_id: edge.parent_device_id,
          name: edge.parent_name,
          type: edge.parent_type,
          status: edge.parent_status,
          ip_address: edge.parent_ip,
          dependency_type: edge.dependency_type,
          is_redundant: !!edge.is_redundant,
        });
        queue.push(edge.parent_device_id);
      }
    }
  }

  return { device, chain };
}

/**
 * Dual-homed devices — devices with 2+ upstream links or a failover_link_id.
 * @param {number} orgId
 */
async function getDualHomedDevices(orgId) {
  const [rows] = await db.query(
    `SELECT d.id, d.name, d.type, d.role, d.status, d.ip_address,
            d.latitude, d.longitude,
            COUNT(nl.id) AS upstream_link_count
     FROM devices d
     JOIN network_links nl ON (nl.device_a_id = d.id OR nl.device_b_id = d.id)
       AND nl.role IN ('uplink','backbone','transit')
       AND nl.status = 'active'
       AND nl.deleted_at IS NULL
     WHERE d.deleted_at IS NULL
       AND (d.organization_id = ?
         OR d.site_id IN (SELECT id FROM sites WHERE organization_id = ?))
     GROUP BY d.id
     HAVING upstream_link_count >= 2
     ORDER BY upstream_link_count DESC, d.name`,
    [orgId, orgId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// CRUD helpers for dependency edges
// ---------------------------------------------------------------------------

/**
 * Get dependency edges for a specific device (both parent and child edges).
 * @param {number} orgId
 * @param {number} deviceId
 */
async function getDependencyEdges(orgId, deviceId) {
  const [rows] = await db.query(
    `SELECT dde.*,
            pd.name AS parent_name, pd.type AS parent_type, pd.status AS parent_status,
            cd.name AS child_name, cd.type AS child_type, cd.status AS child_status
     FROM device_dependency_edges dde
     JOIN devices pd ON pd.id = dde.parent_device_id AND pd.organization_id <=> dde.organization_id
     JOIN devices cd ON cd.id = dde.child_device_id AND cd.organization_id <=> dde.organization_id
     WHERE dde.organization_id = ?
       AND (dde.parent_device_id = ? OR dde.child_device_id = ?)`,
    [orgId, deviceId, deviceId],
  );
  return rows;
}

/**
 * Create a dependency edge.
 */
async function createDependencyEdge(orgId, data) {
  const { parent_device_id, child_device_id, dependency_type = 'network', is_redundant = false, notes } = data;
  if (Number(parent_device_id) === Number(child_device_id)) {
    throw new ValidationError('A device cannot depend on itself');
  }
  const [result] = await db.query(
    `INSERT INTO device_dependency_edges
       (organization_id, parent_device_id, child_device_id, dependency_type, is_redundant, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [orgId, parent_device_id, child_device_id, dependency_type, is_redundant ? 1 : 0, notes || null],
  );
  const [[row]] = await db.query('SELECT * FROM device_dependency_edges WHERE id = ?', [result.insertId]);
  return row;
}

/**
 * Delete a dependency edge.
 */
async function deleteDependencyEdge(orgId, edgeId) {
  const [result] = await db.query(
    'DELETE FROM device_dependency_edges WHERE id = ? AND organization_id = ?',
    [edgeId, orgId],
  );
  return result.affectedRows > 0;
}

// ---------------------------------------------------------------------------
// CRUD helpers for geofences
// ---------------------------------------------------------------------------

async function listGeofences(orgId) {
  const [rows] = await db.query(
    `SELECT * FROM map_geofences
     WHERE organization_id = ? AND deleted_at IS NULL
     ORDER BY name`,
    [orgId],
  );
  return rows;
}

async function getGeofence(orgId, id) {
  const [[row]] = await db.query(
    `SELECT * FROM map_geofences
     WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    [id, orgId],
  );
  return row;
}

async function createGeofence(orgId, data, userId) {
  const { name, type, boundary, center_lat, center_lng, radius_meters, device_id, description } = data;
  const [result] = await db.query(
    `INSERT INTO map_geofences
       (organization_id, name, type, boundary, center_lat, center_lng, radius_meters,
        device_id, description, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orgId, name, type,
      boundary ? JSON.stringify(boundary) : null,
      center_lat || null, center_lng || null, radius_meters || null,
      device_id || null, description || null, userId || null,
    ],
  );
  return getGeofence(orgId, result.insertId);
}

async function updateGeofence(orgId, id, data) {
  const fields = [];
  const params = [];
  const allowed = ['name', 'type', 'boundary', 'center_lat', 'center_lng', 'radius_meters', 'device_id', 'description', 'is_active'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(key === 'boundary' && data[key] !== null ? JSON.stringify(data[key]) : data[key]);
    }
  }
  if (!fields.length) return getGeofence(orgId, id);
  params.push(id, orgId);
  await db.query(
    `UPDATE map_geofences SET ${fields.join(', ')} WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    params,
  );
  return getGeofence(orgId, id);
}

async function deleteGeofence(orgId, id) {
  const [result] = await db.query(
    'UPDATE map_geofences SET deleted_at = NOW() WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [id, orgId],
  );
  return result.affectedRows > 0;
}

// ---------------------------------------------------------------------------
// CRUD helpers for infrastructure points
// ---------------------------------------------------------------------------

async function listInfrastructure(orgId) {
  const [rows] = await db.query(
    `SELECT mip.*, s.name AS site_name
     FROM map_infrastructure_points mip
     LEFT JOIN sites s ON s.id = mip.site_id
     WHERE mip.organization_id = ? AND mip.deleted_at IS NULL
     ORDER BY mip.name`,
    [orgId],
  );
  return rows;
}

async function getInfrastructurePoint(orgId, id) {
  const [[row]] = await db.query(
    `SELECT mip.*, s.name AS site_name
     FROM map_infrastructure_points mip
     LEFT JOIN sites s ON s.id = mip.site_id
     WHERE mip.id = ? AND mip.organization_id = ? AND mip.deleted_at IS NULL`,
    [id, orgId],
  );
  return row;
}

async function createInfrastructurePoint(orgId, data) {
  const { name, type, latitude, longitude, site_id, address, description, properties } = data;
  const [result] = await db.query(
    `INSERT INTO map_infrastructure_points
       (organization_id, site_id, name, type, latitude, longitude, address, description, properties)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orgId, site_id || null, name, type || 'other',
      latitude, longitude,
      address || null, description || null,
      properties ? JSON.stringify(properties) : null,
    ],
  );
  return getInfrastructurePoint(orgId, result.insertId);
}

async function updateInfrastructurePoint(orgId, id, data) {
  const fields = [];
  const params = [];
  const allowed = ['name', 'type', 'latitude', 'longitude', 'site_id', 'address', 'description', 'properties', 'is_active'];
  for (const key of allowed) {
    if (data[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(key === 'properties' && data[key] !== null ? JSON.stringify(data[key]) : data[key]);
    }
  }
  if (!fields.length) return getInfrastructurePoint(orgId, id);
  params.push(id, orgId);
  await db.query(
    `UPDATE map_infrastructure_points SET ${fields.join(', ')} WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`,
    params,
  );
  return getInfrastructurePoint(orgId, id);
}

async function deleteInfrastructurePoint(orgId, id) {
  const [result] = await db.query(
    'UPDATE map_infrastructure_points SET deleted_at = NOW() WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',
    [id, orgId],
  );
  return result.affectedRows > 0;
}

module.exports = {
  createLink,
  removeLink,
  deviceForNode,
  getNetworkGraph,
  getFabric,
  getCustomerLocations,
  getCoverageData,
  getFiberRoutes,
  getInfrastructurePins,
  getImpactAnalysis,
  getCascadeChain,
  getDualHomedDevices,
  getDependencyEdges,
  createDependencyEdge,
  deleteDependencyEdge,
  listGeofences,
  getGeofence,
  createGeofence,
  updateGeofence,
  deleteGeofence,
  listInfrastructure,
  getInfrastructurePoint,
  createInfrastructurePoint,
  updateInfrastructurePoint,
  deleteInfrastructurePoint,
};

// =============================================================================
// VigaBSS 5.0 — FireRelay Validation Schemas
// =============================================================================

const firerelayNode = {
  id: { type: 'string', required: true, min: 1, max: 64 },
  name: { type: 'string', max: 255 },
  api_url: { type: 'string', required: true, min: 1, max: 512 },
};

const firerelayNodeUpdate = {
  name: { type: 'string', max: 255 },
  api_url: { type: 'string', max: 512 },
  status: { type: 'string', enum: ['active', 'draining', 'maintenance', 'offline'] },
  client_count: { type: 'number', min: 0 },
  device_count: { type: 'number', min: 0 },
  cpu_percent: { type: 'number', min: 0, max: 100 },
  memory_percent: { type: 'number', min: 0, max: 100 },
  disk_percent: { type: 'number', min: 0, max: 100 },
  db_size_mb: { type: 'number', min: 0 },
  uptime_seconds: { type: 'number', min: 0 },
  last_seen_at: { type: 'string', max: 30, pattern: /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/ },
};

// Exactly the command handlers a FireRelay agent implements
// (src/services/routerosService.js `handlers`). Anything else is refused at the
// edge instead of being relayed to a router-adjacent agent.
const FIRERELAY_TUNNEL_METHODS = Object.freeze([
  'pppoe.create',
  'pppoe.delete',
  'queue.set',
  'addressList.add',
  'addressList.remove',
  'config.backup',
  'wireguard.interfaceUpsert',
  'wireguard.addressUpsert',
  'wireguard.peerUpsert',
  'wireguard.readTopology',
  'wireguard.peerRemove',
  'wireguard.routeUpsert',
]);

const firerelayTunnelCommand = {
  node_id: { type: 'string', required: true, min: 1, max: 64 },
  method: { type: 'string', required: true, enum: FIRERELAY_TUNNEL_METHODS },
  params: { type: 'object' },
  timeout_ms: { type: 'number', min: 1000, max: 60000 },
};

module.exports = { firerelayNode, firerelayNodeUpdate, firerelayTunnelCommand };

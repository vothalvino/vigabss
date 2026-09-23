# Installing a modular VigaBSS

> Status: Proposed, 2026-09-07. Companion to
> [modular-regional-architecture-plan.md](modular-regional-architecture-plan.md).
> Full version: [modular-installation-plan-complete.md](modular-installation-plan-complete.md).
> Describes the target installer, not current behavior.

## The idea

Keep the one-line installer. Add one question at the start: **what is this host?**

The regional tier is not a new system. It is FireRelay, which already ships in every install with a node registry (`firerelay_nodes`, `poller_nodes`), an outbound-dialing agent (`src/scripts/firerelay-agent.js`), a WebSocket tunnel, and a per-device node assignment (`devices.firerelay_node_id`). Today the agent only runs RouterOS commands and enrolls with a single shared secret. The plan grows it into the node system it was meant to be.

| Profile | Runs | For |
|---|---|---|
| Standalone | Everything, like today | Small ISPs, evaluations, existing installs |
| Central | Web/API, business modules, scheduler, regional control, telemetry | One host per installation |
| FireRelay node | The existing FireRelay agent, extended to run polling, traps, RADIUS, provisioning, backups; local DB and buffers | One host per region or site |

Rules:

- One release, one image set. Profiles choose what starts, not what is built.
- Every prompt has an env variable, so unattended installs still work.
- Modules are written explicitly into the env file. Nothing runs by accident.
- Enabling a module grants no user permission.
- Missing dependencies stop the install. No silent fallbacks.

## Standalone

Unchanged. Two new lines in `.env.prod`:

```
VIGABSS_PROFILE=standalone
VIGABSS_MODULES=all
```

## Central

1. Domain, email, TLS, database, secrets. Same as today.
2. Redis. Now required.
3. Generate the region CA key. It never leaves this host.
4. Pick business modules:

   ```
   [x] customers  [x] billing  [x] support  [x] inventory
   [x] communications  [x] reporting (ChromaDB)  [x] telemetry (ClickHouse)
   [x] network-control (cannot be disabled)
   ```

5. Choose how nodes enroll: one-time token (default) or CSR approved in the UI.
6. Start, migrate, health-check every enabled module.

```
docker compose -f docker-compose.prod.yml --profile central --env-file .env.prod up -d
```

## FireRelay node

1. Enter the central URL. Installer checks protocol compatibility.
2. Paste the node enrollment token created in the FireRelay admin UI (or wait for CSR approval). Installer receives a per-node certificate and the node identity. This replaces today's shared `FIRERELAY_TUNNEL_SECRET`.
3. Confirm the node name, region, and organization shown. Nothing to type.
4. Pick capabilities, limited to what central allows for this node:

   ```
   [x] polling  [x] traps  [x] radius  [x] provisioning  [x] backups  [ ] connectivity
   ```

5. Set the local DB password and buffer size. Installer suggests 72 hours of peak volume.
6. Set listener ports only for the selected services.
7. Start, connect the tunnel, health-check. Includes a short simulated central outage to prove local continuity.

```
docker compose -f docker-compose.node.yml --env-file .env.node up -d
```

Summary printed at the end:

```
[✓] FireRelay node north-1 enrolled with https://isp.example.com
[✓] Certificate valid until 2027-09-07
[✓] Assignment generation 14: 1,832 devices, 3 NAS
[✓] Capabilities: polling traps radius provisioning backups
[i] Buffer reserved: 40 GB of 120 GB free
```

## What the repo needs

- `docker-compose.node.yml` (agent, local MySQL, FreeRADIUS) and Compose profiles in `docker-compose.prod.yml`.
- FireRelay registry additions: `organization_id`, capabilities, per-node credentials, assignment generation on `firerelay_nodes`; merge `poller_nodes` into it.
- FireRelay agent additions: polling, traps, RADIUS policy sync, and provisioning handlers beside the existing RouterOS handlers.
- A real enrollment API replacing the static `FIRERELAY_NODES` env list.
- A release manifest listing modules per release, read by `install.sh`.
- New installer variables: `PROFILE`, `VIGABSS_MODULES`, `FIRERELAY_MASTER_URL` (already exists), `FIRERELAY_ENROLL_TOKEN`.
- Wrapper commands: `vigabss node status|drain`, `vigabss modules list|enable|disable`, `vigabss profile convert central`.
- Matching Helm values.

## Upgrades

- Existing standalone: normal upgrade, plus the two env lines. No-Redis fallback stays.
- Split into central plus nodes: convert the host to central (FireRelay master), install nodes, reassign devices in the FireRelay UI, then disable network modules on central.
- Rollback: reassign devices back, re-enable the modules, drain and revoke the node.
- Upgrade order: master first, then nodes. Central accepts the current and one prior protocol version.

## Done when

- An unattended run with no variables still produces today's standalone install.
- A bad token fails before any file is written or container started.
- A FireRelay node runs no business worker, web portal, or unselected listener.
- A FireRelay node never holds central DB credentials, the encryption key, or a shared installation-wide tunnel secret.
- Compose and Helm checks pass for every profile in CI.
- README and `docs/deployment.md` cover all three profiles.

No installer changes have been implemented for this document.

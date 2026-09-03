# Claude Repository Entry Point

This file contains Claude-specific loading instructions only. Shared agent
behavior belongs in `AGENTS.md`; shared technical truth belongs in
`ARCHITECTURE.md`.

## Required reading

Before planning, editing, testing, or reviewing repository work:

1. Read `AGENTS.md` in full.
2. Read `ARCHITECTURE.md` in full.
3. Read `.claude/agent-memory/fullstack-autonomous-engineer/MEMORY.md`, then the
   linked notes relevant to the task.

Memory entries and older jobdesk audits are historical evidence, not authority.
Re-verify them against the current branch before citing or implementing them.
When a discovery changes a durable system contract, update `ARCHITECTURE.md`;
do not copy the new fact back into this file.

## Claude-specific workflow

- When orchestrating multi-agent section work, also read
  `.claude/agent-orchestration-guidelines.md`.
- The project jobdesk is at `~/Documents/Claude/jobdesk`. Use it only for a
  finding that meets the deferral rules in `AGENTS.md` and when writing to that
  external tracker is within the user's authorized task.
- Older point-in-time audits under the jobdesk's `roadmap/` directory are June
  2026 snapshots; several findings have since changed or been fixed.
- If a multi-part job is deferred, record which parts are complete and which
  remain. In the final report, distinguish findings fixed in the current run
  from findings filed for later work.

// =============================================================================
// Audit log hash chain verification (ASY-38)
// =============================================================================
// Migration 505 chains each organization's audit rows (and the install-wide
// rows) by hash. This walks one chain in order and reports every row whose
// content no longer matches its hash, whose prev_hash does not match the row
// before it, or whose position leaves a gap, plus a head that does not match
// the newest row (rows removed from the end).
// =============================================================================

const db = require('../config/database');
const { runInPrimaryContext } = require('../utils/primaryContext');

const BATCH = 5000;
const MAX_PROBLEMS = 100;
const GENESIS = '0'.repeat(64);

/**
 * @param {number|null} organizationId - null verifies the install-wide chain
 * @returns {Promise<{intact: boolean, checked: number, last_seq: number,
 *   unchained: number, problems: Array<{id: number|null, chain_seq: number, problem: string}>}>}
 */
async function verifyAuditChain(organizationId) {
  return runInPrimaryContext(async () => {
    const org = organizationId === null || organizationId === undefined ? null : Number(organizationId);
    const problems = [];
    const report = (row, problem) => {
      if (problems.length < MAX_PROBLEMS) problems.push({ id: row.id ?? null, chain_seq: Number(row.chain_seq), problem });
    };

    let checked = 0;
    let previousSeq = 0;
    let previousHash = GENESIS;
    for (;;) {
      const [rows] = await db.query(
        `SELECT id, chain_seq, prev_hash, row_hash,
                audit_log_row_hash(prev_hash, chain_seq, organization_id, user_id, action, entity_type,
                  entity_id, summary, old_values, new_values, ip_address, user_agent, created_at) AS expected_hash
           FROM audit_logs
          WHERE organization_id <=> ? AND chain_seq > ?
          ORDER BY chain_seq
          LIMIT ${BATCH}`,
        [org, previousSeq],
      );
      for (const row of rows) {
        const seq = Number(row.chain_seq);
        if (seq !== previousSeq + 1) report(row, `missing rows ${previousSeq + 1}–${seq - 1}`);
        if (row.prev_hash !== previousHash) report(row, 'prev_hash does not match the previous row');
        if (row.row_hash !== row.expected_hash) report(row, 'row content does not match its hash');
        previousSeq = seq;
        previousHash = row.row_hash;
        checked += 1;
      }
      if (rows.length < BATCH) break;
    }

    const [[head]] = await db.query(
      'SELECT last_seq, last_hash FROM audit_log_chain WHERE chain_key = ?',
      [org ?? 0],
    );
    if (head && (Number(head.last_seq) !== previousSeq || head.last_hash !== previousHash)) {
      report({ id: null, chain_seq: head.last_seq },
        `chain head is at ${head.last_seq} but the newest row is at ${previousSeq}`);
    } else if (!head && checked > 0) {
      report({ id: null, chain_seq: previousSeq }, 'chain head is missing');
    }

    const [[unchained]] = await db.query(
      'SELECT COUNT(*) AS total FROM audit_logs WHERE organization_id <=> ? AND chain_seq IS NULL',
      [org],
    );

    return {
      intact: problems.length === 0,
      checked,
      last_seq: previousSeq,
      unchained: Number(unchained?.total || 0),
      problems,
    };
  });
}

module.exports = { verifyAuditChain, GENESIS };

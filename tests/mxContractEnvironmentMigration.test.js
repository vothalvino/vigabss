'use strict';
// =============================================================================
// MX contract environments (introduced by development migration 452)
// =============================================================================
// The database itself classifies MX contracts as sandbox or production,
// freezes their source snapshot and keeps signed-document provenance
// immutable. Checked in the baseline's triggers; 452's rerun guards and
// rollback went with the development history.
// =============================================================================

const { baselineColumns, baselineProgram } = require('./helpers/baseline');

const trigger = name => baselineProgram('trigger', name);

describe('MX contract environments', () => {
  test('a contract source defaults to sandbox', () => {
    expect(baselineColumns('contract_templates_mx').get('environment')).toMatch(/NOT NULL DEFAULT 'sandbox'/);
  });

  test('status FSM blocks sandbox revival in production', () => {
    const fsm = trigger('trg_contracts_status_fsm_bu');
    expect(fsm).toMatch(/OLD\.mx_contract_environment = 'sandbox'/);
    expect(fsm).toMatch(/current_org_locale = 'MX'/);
    expect(fsm).toMatch(/OLD\.contract_template_mx_id IS NULL OR OLD\.mx_contract_environment IS NULL/);
    expect(fsm).toMatch(/create a new classified MX contract/);
    expect(fsm).toMatch(/NEW\.status IN \('pending', 'active'\)/);
    expect(fsm).toMatch(/legacy_source\.environment = 'production'/);
    expect(fsm).toMatch(/OLD\.deleted_at IS NOT NULL AND NEW\.deleted_at IS NULL/);
    expect(fsm).toMatch(
      /SELECT organization_row\.locale,[\s\S]*CASE[\s\S]*INTO current_org_locale, current_mx_contract_environment[\s\S]*FOR UPDATE/,
    );
  });

  test('database classifies new MX contracts and freezes their source snapshot', () => {
    const insertTrigger = trigger('trg_contracts_mx_template_bi');
    const updateTrigger = trigger('trg_contracts_mx_template_bu');

    expect(insertTrigger).toMatch(/MX contracts require a classified contract source and environment/);
    expect(insertTrigger).toMatch(/source\.organization_id INTO source_org_id/);
    expect(insertTrigger).toMatch(
      /source\.environment = 'sandbox'[\s\S]*source\.status = 'sandbox_ready'[\s\S]*source\.ift_registration_number IS NULL[\s\S]*source\.registered_at IS NULL/,
    );
    expect(insertTrigger).toMatch(
      /source\.environment = 'production'[\s\S]*source\.status = 'registered'[\s\S]*source\.ift_registration_number IS NOT NULL[\s\S]*source\.registered_at IS NOT NULL/,
    );
    expect(insertTrigger).toMatch(
      /FROM document_templates activation_template[\s\S]*activation_template\.organization_id = contract_org_id[\s\S]*activation_template\.contract_template_mx_id = source\.id[\s\S]*activation_template\.template_type = 'activation_contract'[\s\S]*activation_template\.is_active = 1[\s\S]*activation_template\.deleted_at IS NULL[\s\S]*BINARY activation_template\.body_md = BINARY source\.template_body/,
    );
    expect(insertTrigger).toMatch(/NOT EXISTS \([\s\S]*FROM document_templates competing_template[\s\S]*competing_template\.is_active = 1/);

    expect(`${insertTrigger}\n${updateTrigger}`).toMatch(/NEW\.mx_contract_environment <> current_contract_environment/);
    expect(updateTrigger).toMatch(/NOT \(NEW\.mx_contract_environment <=> OLD\.mx_contract_environment\)/);
    expect(updateTrigger).toMatch(
      /NOT \(NEW\.contract_template_mx_id <=> OLD\.contract_template_mx_id\)[\s\S]*OLD\.status <> 'pending'[\s\S]*FROM signed_documents document_history/,
    );
    expect(updateTrigger).toMatch(
      /Revalidate current readiness only when deliberately repairing the source[\s\S]*IF NOT \(NEW\.contract_template_mx_id <=> OLD\.contract_template_mx_id\) THEN[\s\S]*SELECT source\.organization_id INTO source_org_id/,
    );
    expect(updateTrigger).not.toMatch(/IF NEW\.contract_template_mx_id IS NOT NULL THEN/);
  });

  test('signed-document MX provenance is immutable without blocking v2 to v3 signing', () => {
    const snapshot = trigger('trg_signed_documents_mx_snapshot_bu');
    for (const field of [
      'contract_template_mx_id', 'mx_contract_environment', 'mx_registration_number',
      'mx_registered_at', 'mx_template_version', 'mx_source_sha256',
    ]) {
      expect(snapshot).toMatch(new RegExp(`NEW\\.${field} <=> OLD\\.${field}`));
    }
    expect(snapshot).not.toMatch(/evidence_format_version <=>/);
  });
});

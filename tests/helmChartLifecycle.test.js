// =============================================================================
// OPS-16 — the chart installs with --create-namespace and keeps its PVC
// =============================================================================
// templates/namespace.yaml always rendered the release Namespace, so the
// documented `helm install --namespace fireisp --create-namespace` failed, and
// an uninstall would delete the namespace; the storage PVC had no keep policy
// although the docs said Helm preserves it.
// =============================================================================

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('the chart renders a Namespace only when namespace.create is set, and defaults it off', () => {
  const ns = read('charts/fireisp/templates/namespace.yaml');
  const kind = ns.indexOf('kind: Namespace');
  const gate = ns.indexOf('{{- if .Values.namespace.create }}');
  expect(gate).toBeGreaterThan(-1);
  expect(kind).toBeGreaterThan(gate);
  expect(read('charts/fireisp/values.yaml')).toMatch(/^namespace:\n {2}create: false$/m);
});

test('the storage PVC survives helm uninstall', () => {
  expect(read('charts/fireisp/templates/pvc.yaml')).toMatch(/annotations:\n\s+(#[^\n]*\n\s+)*helm\.sh\/resource-policy: keep/);
});

test('CI installs, upgrades and uninstalls the chart the way the docs do', () => {
  const ci = read('.github/workflows/ci.yml');
  const job = ci.slice(ci.indexOf('\n  helm-install:\n'), ci.indexOf('\n  helm-release:\n'));
  expect(job).toMatch(/helm install fireisp charts\/fireisp --create-namespace/);
  expect(job).toMatch(/helm upgrade fireisp charts\/fireisp/);
  expect(job).toMatch(/helm uninstall fireisp --namespace fireisp\n\s+# [^\n]*\n\s+kubectl get pvc -n fireisp fireisp-storage/);
  expect(read('docs/deployment.md')).toMatch(/--namespace fireisp --create-namespace/);
});

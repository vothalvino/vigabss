// =============================================================================
// OPS-17 — Kubernetes/Helm secure defaults
// =============================================================================
// The cosign policies trusted only main, so the released chart's tag image was
// rejected; ingress TLS was off while the auth cookies are Secure; there was
// no NetworkPolicy or Pod Security label; the default SA token was mounted.
// =============================================================================

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('both cosign policies accept images signed on main or a v* tag', () => {
  for (const f of ['k8s/cosign-policy.yaml', 'charts/fireisp/templates/cosign-policy.yaml']) {
    expect(read(f)).toContain('subjectRegExp: "^https://github.com/vothalvino/vigabss/.github/workflows/ci.yml@refs/(heads/main|tags/v.*)$"');
  }
});

test('ingress TLS is on by default and the chart refuses to render without a secret or issuer', () => {
  expect(read('charts/fireisp/values.yaml')).toMatch(/ {2}tls:\n {4}enabled: true\n/);
  const ingress = read('charts/fireisp/templates/ingress.yaml');
  expect(ingress).toMatch(/if and \.Values\.ingress\.tls\.enabled \(not \.Values\.ingress\.tls\.secretName\) \(not \.Values\.ingress\.tls\.clusterIssuer\)[\s\S]*?fail /);
  expect(read('k8s/ingress.yaml')).toMatch(/^ {2}tls:\n {4}- hosts:/m);
});

test('a NetworkPolicy limits HTTP to the ingress and metrics namespaces', () => {
  const np = read('charts/fireisp/templates/networkpolicy.yaml');
  expect(np).toMatch(/kind: NetworkPolicy/);
  expect(np).toMatch(/policyTypes: \[Ingress\]/);
  expect(np).toMatch(/- port: http\n\s+protocol: TCP/);
  expect(read('charts/fireisp/values.yaml')).toMatch(/networkPolicy:\n {2}enabled: true/);
  expect(read('k8s/networkpolicy.yaml')).toMatch(/kubernetes\.io\/metadata\.name: ingress-nginx/);
});

test('the pod mounts no service-account token, and namespaces enforce the restricted profile', () => {
  expect(read('charts/fireisp/templates/deployment.yaml')).toMatch(/\n {6}automountServiceAccountToken: false\n/);
  expect(read('k8s/deployment.yaml')).toMatch(/\n {6}automountServiceAccountToken: false\n/);
  for (const f of ['k8s/namespace.yaml', 'charts/fireisp/templates/namespace.yaml']) {
    expect(read(f)).toContain('pod-security.kubernetes.io/enforce: restricted');
  }
});

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
  expect(np).toMatch(/policyTypes: \[Ingress/);
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

// The image created fireisp with `useradd --system`, so its uid was whatever
// the base image left free (999 on bookworm), while both manifests ran the pod
// as 1000: the base image's `node` user, which does not own /app/storage. The
// uid is now fixed in the image and the manifests run as exactly that, above
// 10000 so it matches no base-image user and no human account on the host.
test('the pod runs as the image user, a fixed uid above 10000', () => {
  const dockerfile = read('Dockerfile');
  const uid = Number((dockerfile.match(/useradd [^\n]*--uid (\d+)/) || [])[1]);
  const gid = Number((dockerfile.match(/groupadd [^\n]*--gid (\d+)/) || [])[1]);
  expect(uid).toBeGreaterThanOrEqual(10000);
  expect(gid).toBe(uid);
  expect(dockerfile).toMatch(new RegExp(`\\nUSER ${uid}:${gid}\\n`));
  for (const [file, indent] of [['k8s/deployment.yaml', 8], ['charts/fireisp/values.yaml', 2]]) {
    const pad = ' '.repeat(indent);
    const text = read(file);
    expect([file, text.match(new RegExp(`\\n${pad}runAsUser: (\\d+)`))?.[1]]).toEqual([file, String(uid)]);
    expect([file, text.match(new RegExp(`\\n${pad}runAsGroup: (\\d+)`))?.[1]]).toEqual([file, String(gid)]);
    expect([file, text.match(new RegExp(`\\n${pad}fsGroup: (\\d+)`))?.[1]]).toEqual([file, String(gid)]);
  }
});

// Egress stays open by default (providers and devices live anywhere), but an
// operator who knows where the app must reach can now drop everything else.
test('the chart can restrict egress, off by default, with DNS and the release namespace allowed', () => {
  const values = read('charts/fireisp/values.yaml');
  expect(values).toMatch(/\n {2}egress:\n(?: {4}#[^\n]*\n)* {4}enabled: false\n/);
  expect(values).toMatch(/\n {4}allowDns: true\n/);
  expect(values).toMatch(/\n {4}allowReleaseNamespace: true\n/);
  const np = read('charts/fireisp/templates/networkpolicy.yaml');
  expect(np).toMatch(/policyTypes: \[Ingress\{\{ if \$egress\.enabled \}\}, Egress\{\{ end \}\}\]/);
  expect(np).toMatch(/k8s-app: kube-dns/);
  expect(np).toMatch(/ipBlock:\n\s+cidr: \{\{ \.cidr \| quote \}\}/);
  expect(read('.github/workflows/ci.yml')).toMatch(/--set networkPolicy\.egress\.enabled=true/);
});

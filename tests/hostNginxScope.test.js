// =============================================================================
// SUP-11 — host-nginx mode serves only the VigaBSS domain and leaves the
// host's own sites alone
// =============================================================================
// The installer switched to host-nginx mode on its own whenever port 80 was
// taken, unlinked /etc/nginx/sites-enabled/default without saying so, and
// served VigaBSS with `server_name _`, so it became the catch-all virtual host
// for every unmatched Host on the machine.
// =============================================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const install = read('install.sh');

test('the host config is rendered for the install domain, never as the catch-all', () => {
  const conf = read('nginx/host-nginx.conf');
  expect(conf).not.toMatch(/server_name\s+_;/);
  expect(conf.match(/server_name __DOMAIN__;/g)).toHaveLength(2);
  expect(install).toContain('HOST_NGINX_CONF_CONTENT="${HOST_NGINX_CONF_CONTENT//__DOMAIN__/$DOMAIN}"');
});

test("the installer never removes the host's default site", () => {
  expect(install).not.toMatch(/rm\s+-f\s+\/etc\/nginx\/sites-enabled\/default/);
});

test('a busy port 80 stops the install instead of switching to host-nginx mode', () => {
  const branch = install.slice(install.indexOf('if [[ -n "$_port80_owner" ]]; then'));
  const body = branch.slice(0, branch.indexOf('\n    fi'));
  expect(body).toMatch(/die "Port 80 is already in use/);
  expect(body).toMatch(/USE_HOST_NGINX=1/);
  expect(body).not.toMatch(/^\s*USE_HOST_NGINX=1\s*$/m);
});

test('DOMAIN must be a plain hostname before it reaches server_name', () => {
  const line = install.split('\n').find((l) => l.includes('[[ "$DOMAIN" =~'));
  const pattern = line.match(/=~ (\S+) \]\]/)[1];
  const accepts = (domain) => {
    try {
      execFileSync('bash', ['-c', `[[ "$1" =~ ${pattern} ]]`, '_', domain]);
      return true;
    } catch { return false; }
  };
  expect(accepts('isp.example.com')).toBe(true);
  expect(accepts('a-b.isp.mx')).toBe(true);
  expect(accepts('_')).toBe(false);
  expect(accepts('isp.example.com; return 200')).toBe(false);
  expect(accepts('localhost')).toBe(false);
});

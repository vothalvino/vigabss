// FE2-11 — pages read the fields the backend returns: the 2FA uri, the NAS
// session mac, an alert's current_value, the WireGuard peer owner's
// first_name/last_name/email, the IPv6 conflict pool_a_name/pool_b_name, and
// no provider status or log channel (neither column exists).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = (name: string) => readFileSync(join(__dirname, '..', name), 'utf8');

describe('pages read the fields the API returns', () => {
  it.each([
    ['UserList.tsx', /otpauth_url/],
    ['NasDetail.tsx', /mac_address/],
    ['TechnicianDashboard.tsx', /\ba\.value\b/],
    ['AdminWgTunnels.tsx', /user_name|user_email/],
    ['Ipv6ManagementPage.tsx', /c\.pool_a\}|overlapping_networks/],
    ['AIAssistantSettings.tsx', /\bp\.status\b|\bl\.channel\b|cost_usd\.toFixed/],
  ])('%s no longer reads %s', (file, stale) => {
    expect(page(file)).not.toMatch(stale);
  });

  it.each([
    ['UserList.tsx', /setupData\.uri/],
    ['NasDetail.tsx', /s\.mac \?\?/],
    ['TechnicianDashboard.tsx', /a\.current_value/],
    ['AdminWgTunnels.tsx', /peer\.first_name, peer\.last_name/],
    ['Ipv6ManagementPage.tsx', /c\.pool_a_name/],
    ['AIAssistantSettings.tsx', /Number\(l\.confidence\) \* 100/],
  ])('%s reads %s', (file, field) => {
    expect(page(file)).toMatch(field);
  });
});

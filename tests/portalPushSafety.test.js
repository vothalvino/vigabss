// =============================================================================
// ASY-12 — Web Push endpoints are real push services, and sends are bounded
// =============================================================================

jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn(async () => ({})) }));

process.env.VAPID_PUBLIC_KEY = 'pub';
process.env.VAPID_PRIVATE_KEY = 'priv';
process.env.VAPID_SUBJECT = 'mailto:noc@isp.test';

const db = require('../src/config/database');
const webPush = require('web-push');
const { isAllowedPushEndpoint, dispatch } = require('../src/services/portalPushService');

test.each([
  ['https://fcm.googleapis.com/fcm/send/abc', true],
  ['https://updates.push.services.mozilla.com/wpush/v2/abc', true],
  ['https://web.push.apple.com/QGuQ', true],
  ['https://wns2-par02p.notify.windows.com/w/?token=x', true],
  ['http://fcm.googleapis.com/fcm/send/abc', false],
  ['https://169.254.169.254/latest/meta-data', false],
  ['https://fcm.googleapis.com.evil.test/x', false],
  ['https://fcm.googleapis.com:8443/x', false],
  ['https://user:pw@fcm.googleapis.com/x', false],
])('%s allowed=%s', (endpoint, allowed) => {
  expect(isAllowedPushEndpoint(endpoint)).toBe(allowed);
});

test('dispatch skips a stored endpoint on an unknown host and passes a timeout', async () => {
  db.query.mockImplementation(async (sql) => (/FROM portal_push_subscriptions/.test(sql)
    ? [[
      { id: 1, endpoint: 'https://internal.lan/hook', p256dh: 'k', auth: 'a' },
      { id: 2, endpoint: 'https://fcm.googleapis.com/fcm/send/ok', p256dh: 'k', auth: 'a' },
    ]]
    : [{ affectedRows: 1 }]));
  const result = await dispatch({ clientId: 5, eventType: 'outage', payload: { title: 't' } });

  expect(result).toEqual({ sent: 1, failed: 1 });
  expect(webPush.sendNotification).toHaveBeenCalledTimes(1);
  const [subscription, , options] = webPush.sendNotification.mock.calls[0];
  expect(subscription.endpoint).toBe('https://fcm.googleapis.com/fcm/send/ok');
  expect(options).toEqual({ timeout: 10000 });
});

test('the outage hook alerts staff before it starts on subscriber pushes', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/services/notificationHooks.js'), 'utf8');
  const hook = src.slice(src.indexOf("eventBus.on('outage.reported'"));
  expect(hook.indexOf('resolveStaffRecipients(organizationId')).toBeLessThan(hook.indexOf('portalPushService.dispatch('));
});

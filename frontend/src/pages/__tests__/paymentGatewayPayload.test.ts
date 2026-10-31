// BIL-09: the gateway form could not create a gateway (no `name`), dropped the
// webhook secret, and sent an empty secret key on every edit.
import { describe, it, expect } from 'vitest';
import { gatewayPayload } from '../paymentGatewayPayload';

const base = {
  provider: 'stripe', name: ' Stripe MX ', environment: 'sandbox',
  public_key: 'pk_test_1', secret_key: '', webhook_secret: '', status: 'active',
};

describe('gatewayPayload', () => {
  it('create: sends name and both secrets under their write-only fields', () => {
    const body = gatewayPayload({ ...base, secret_key: 'sk_test_1', webhook_secret: 'whsec_1' });
    expect(body).toEqual({
      provider: 'stripe', name: 'Stripe MX', environment: 'sandbox',
      public_key: 'pk_test_1', secret_key: 'sk_test_1', webhook_secret: 'whsec_1', status: 'active',
    });
    expect(body).not.toHaveProperty('label');
    expect(body).not.toHaveProperty('secret_key_encrypted');
    expect(body).not.toHaveProperty('webhook_secret_encrypted');
  });

  it('edit: blank secrets are omitted so the stored ones are kept', () => {
    const body = gatewayPayload({ ...base, secret_key: '   ', webhook_secret: '' });
    expect(body).not.toHaveProperty('secret_key');
    expect(body).not.toHaveProperty('webhook_secret');
    expect(body.name).toBe('Stripe MX');
  });
});

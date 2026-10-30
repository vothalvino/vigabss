// Payment-gateway settings form → API body.

export interface GatewayForm {
  provider: string;
  name: string;
  environment: string;
  public_key: string;
  secret_key: string;
  webhook_secret: string;
  status: string;
}

// Secret fields are write-only: the server encrypts them and never returns
// them. A blank one is left out so the stored secret is kept (the form used to
// send an empty secret key on every edit, wiping it).
export function gatewayPayload(form: GatewayForm): Record<string, string> {
  const { secret_key, webhook_secret, ...rest } = form;
  const body: Record<string, string> = { ...rest, name: form.name.trim() };
  if (secret_key.trim()) body.secret_key = secret_key.trim();
  if (webhook_secret.trim()) body.webhook_secret = webhook_secret.trim();
  return body;
}

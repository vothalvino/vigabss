// =============================================================================
// VigaBSS 5.0 — Write-only secret columns in API responses
// =============================================================================
// Network credentials (RADIUS shared secret, SNMP community, ONU LOID and
// Wi-Fi passwords, iperf tokens) were returned by SELECT * to every holder of
// the matching *.view permission, which the read-only role has (NET-10). A
// response carries `has_<name>` instead of the value; forms treat the field
// as write-only (blank keeps what is stored).
// =============================================================================

const flagName = column => `has_${column.replace(/_encrypted$/, '')}`;

/**
 * Copy of `row` without `columns`, each replaced by a `has_<name>` boolean
 * (`_encrypted` is dropped from the flag name).
 * @param {object|null|undefined} row
 * @param {string[]} columns
 */
function redactSecretColumns(row, columns) {
  if (!row || typeof row !== 'object') return row;
  const rest = { ...row };
  for (const column of columns) {
    if (!Object.prototype.hasOwnProperty.call(rest, column)) continue;
    const value = rest[column];
    delete rest[column];
    rest[flagName(column)] = value !== null && value !== undefined && value !== '';
  }
  return rest;
}

/**
 * Router middleware: redact `columns` from `data` (one row or a list) in every
 * JSON response sent after it, so no handler can forget to.
 * @param {string[]} columns
 */
function redactSecretsInResponses(columns) {
  return (_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && body.data !== undefined) {
        const { data } = body;
        const redacted = Array.isArray(data)
          ? data.map(row => redactSecretColumns(row, columns))
          : redactSecretColumns(data, columns);
        return json({ ...body, data: redacted });
      }
      return json(body);
    };
    next();
  };
}

/**
 * Drop blank values of write-only fields so an edit that leaves a secret
 * empty keeps the stored one instead of clearing it.
 * @param {string[]} fields
 */
function keepBlankSecrets(fields) {
  return (req, _res, next) => {
    for (const field of fields) {
      const value = req.body ? req.body[field] : undefined;
      if (value === '' || value === null) delete req.body[field];
    }
    next();
  };
}

// Router command parameters are kept in device_command_executions and listed
// to every device_command_executions.view holder. pppoe_create's
// secretPassword was stored exactly as sent, so the command history exposed
// every PPPoE password dispatched through it (rest of NET-10).
const SECRET_PARAM = /password|passwd|passphrase|secret|token|private_?key|preshared|psk|api_?key/i;
const REDACTED = '[REDACTED]';

/**
 * Copy of a command's params with every credential-named key replaced, at
 * any depth. A JSON string (MariaDB returns JSON columns as text) comes back
 * as a JSON string.
 * @param {*} params
 */
function redactSecretParams(params) {
  if (typeof params === 'string') {
    let parsed;
    try { parsed = JSON.parse(params); } catch { return params; }
    return JSON.stringify(redactSecretParams(parsed));
  }
  if (Array.isArray(params)) return params.map(redactSecretParams);
  if (!params || typeof params !== 'object') return params;
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [
    key,
    SECRET_PARAM.test(key) && value !== null && value !== undefined && value !== '' && typeof value !== 'object'
      ? REDACTED
      : redactSecretParams(value),
  ]));
}

module.exports = { redactSecretColumns, redactSecretsInResponses, keepBlankSecrets, redactSecretParams };

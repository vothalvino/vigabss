// =============================================================================
// VigaBSS 5.0 — Write-only credential fields
// =============================================================================
// Settings forms send a credential in plaintext under a write-only field
// (`secret_key`), and only this middleware writes the matching `*_encrypted`
// column. Clients may never write the column directly: whatever they put there
// was stored verbatim, so a "secret_key_encrypted" sent from the UI was kept
// as plaintext even with ENCRYPTION_KEY set.
//
// A blank write-only field means "keep what is stored" on update, so editing
// another field never wipes a credential. In production the value must really
// be encrypted (encryptStrict refuses without ENCRYPTION_KEY); elsewhere
// encrypt() is the usual pass-through when no key is configured.
// =============================================================================

const config = require('../config');
const { encrypt, encryptStrict } = require('./encryption');
const { ValidationError } = require('./errors');

function sealSecret(plaintext) {
  return config.env === 'production' ? encryptStrict(plaintext) : encrypt(plaintext);
}

/**
 * @param {Object<string,string>} fields  write-only field → encrypted column,
 *   e.g. { secret_key: 'secret_key_encrypted' }
 * @param {object} [options]
 * @param {Object<string,string>} [options.defaults]  column value to store on
 *   create when the field is absent (for NOT NULL columns, e.g. '')
 */
function sealSecretFields(fields, { defaults = {} } = {}) {
  return (req, _res, next) => {
    try {
      const body = req.body || {};
      const direct = Object.values(fields).filter(col => body[col] !== undefined);
      if (direct.length) {
        throw new ValidationError('Encrypted credential columns cannot be written directly', direct.map(col => ({
          field: col,
          message: `Send ${Object.keys(fields).find(f => fields[f] === col)} instead`,
        })));
      }
      const isCreate = req.method === 'POST';
      for (const [field, column] of Object.entries(fields)) {
        const value = body[field];
        delete body[field];
        if (typeof value === 'string' && value.length > 0) {
          body[column] = sealSecret(value);
        } else if (isCreate && Object.prototype.hasOwnProperty.call(defaults, column)) {
          body[column] = defaults[column];
        }
      }
      req.body = body;
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { sealSecret, sealSecretFields };

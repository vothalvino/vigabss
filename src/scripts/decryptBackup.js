// =============================================================================
// Decrypt an off-site backup encrypted with BACKUP_ENCRYPTION_KEY (ASY-30)
// =============================================================================
// Usage:
//   BACKUP_ENCRYPTION_KEY=<base64 key> node src/scripts/decryptBackup.js \
//     fireisp_2026-11-02T02-00-00.sql.gz.enc fireisp_2026-11-02T02-00-00.sql.gz
// The output is the plain gzip dump; restore it as docs/backup-restore.md says.
// =============================================================================

const { backupEncryptionKey, decryptFile } = require('../utils/backupEncryption');

async function main(argv) {
  const [source, destination] = argv;
  if (!source || !destination) {
    throw new Error('Usage: node src/scripts/decryptBackup.js <backup.sql.gz.enc> <backup.sql.gz>');
  }
  const key = backupEncryptionKey();
  if (!key) throw new Error('Set BACKUP_ENCRYPTION_KEY to the key the backup was encrypted with');
  await decryptFile(source, destination, key);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(() => {
    process.stdout.write('Backup decrypted.\n');
  }).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { main };

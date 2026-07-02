'use strict';

// Stores the SHA-256 hash of the shared teacher password in the database –
// the server-side equivalent of running setupPassword() in the GAS editor.
//
// Usage: node setup-password.js <passord>

const crypto = require('crypto');
const { db, DB_PATH } = require('./db');

const pw = process.argv[2];
if (!pw) {
  console.error('Bruk: node setup-password.js <passord>');
  process.exit(1);
}

const hash = crypto.createHash('sha256').update(pw, 'utf8').digest('hex');
db.prepare(`
  INSERT INTO settings (key, value) VALUES ('password_hash', ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`).run(hash);

console.log('Passord-hash lagret i ' + DB_PATH);

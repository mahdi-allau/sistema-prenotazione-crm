// Reimposta la password di un utente (di default "admin"): node reset-password.js [utente]
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'ristorante.db'));
const username = (process.argv[2] || 'admin').toLowerCase();
const user = db.prepare('SELECT id FROM users WHERE username=?').get(username);
if (!user) { console.log(`\nUtente "${username}" non trovato.\n`); process.exit(1); }

const pw = Array.from(crypto.randomBytes(8), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');
const salt = crypto.randomBytes(16).toString('hex');
db.prepare('UPDATE users SET pass_hash=?, active=1 WHERE id=?').run(`${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`, user.id);
db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
console.log(`\nNuova password per "${username}":  ${pw}\n`);

// Sistema di prenotazione ristorante - nessuna dipendenza esterna (serve Node 22+)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); } catch {
  console.error('\nServe Node.js versione 22 o più recente. Scaricalo da https://nodejs.org e riprova.\n');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(path.join(DATA_DIR, 'backup'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'ristorante.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN('admin','staff')), pass_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS areas(id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tables(id INTEGER PRIMARY KEY, name TEXT NOT NULL, seats INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  area_id INTEGER REFERENCES areas(id), sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, email TEXT, notes TEXT DEFAULT '',
  marketing_ok INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_cust_phone ON customers(phone);
CREATE TABLE IF NOT EXISTS reservations(id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
  date TEXT NOT NULL, time TEXT NOT NULL, people INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'confermata', notes TEXT DEFAULT '', created_by INTEGER, feedback_token TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_res_date ON reservations(date);
CREATE TABLE IF NOT EXISTS reservation_tables(reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  table_id INTEGER NOT NULL REFERENCES tables(id), PRIMARY KEY(reservation_id, table_id));
CREATE TABLE IF NOT EXISTS feedback(id INTEGER PRIMARY KEY, reservation_id INTEGER, customer_id INTEGER, rating INTEGER NOT NULL,
  comment TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS campaigns(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, message TEXT NOT NULL,
  event_date TEXT, recipients INTEGER DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, channel TEXT NOT NULL, to_addr TEXT NOT NULL, subject TEXT DEFAULT '',
  body TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'in_coda', error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

const DEFAULTS = {
  restaurant_name: 'Il Mio Ristorante', duration_min: '90', slots: '12:00-14:00,19:00-22:00', step_min: '30',
  notify_phone: '', notify_email: '', confirm_customer: '1', base_url: `http://localhost:${PORT}`,
  service_split: '16:00', turn2_pranzo: '13:30', turn2_cena: '21:00', late_min: '15',
};
for (const [k, v] of Object.entries(DEFAULTS)) db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);
const getSettings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));
// pranzo/cena e primo/secondo turno si ricavano dall'orario della prenotazione
const config = () => { const s = getSettings(); return { split: s.service_split, turn2: { pranzo: s.turn2_pranzo, cena: s.turn2_cena }, late: Number(s.late_min) || 15 }; };

// database delle versioni precedenti: aggiunge aree, ordine dei tavoli e tavoli uniti (una volta sola)
const columns = t => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
if (db.prepare('PRAGMA user_version').get().user_version < 1) {
  if (!columns('tables').includes('area_id')) {
    db.exec('ALTER TABLE tables ADD COLUMN area_id INTEGER REFERENCES areas(id)');
    db.exec('ALTER TABLE tables ADD COLUMN sort INTEGER NOT NULL DEFAULT 0');
  }
  if (!db.prepare('SELECT 1 FROM areas').get()) db.prepare("INSERT INTO areas(name) VALUES('Sala')").run();
  db.exec('UPDATE tables SET area_id=(SELECT id FROM areas ORDER BY sort,id LIMIT 1) WHERE area_id IS NULL');
  db.exec('UPDATE tables SET sort=id WHERE sort=0');
  if (columns('reservations').includes('table_id')) db.exec('INSERT OR IGNORE INTO reservation_tables SELECT id, table_id FROM reservations WHERE table_id IS NOT NULL');
  db.exec('PRAGMA user_version = 1');
}

// ---------- utilità ----------
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) =>
  `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
const checkPw = (pw, stored) => {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const normPhone = p => (p || '').replace(/[^\d+]/g, '');
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s));
const isTime = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const tx = fn => { db.exec('BEGIN'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } };

// primo avvio: crea amministratore e tavoli di esempio
if (!db.prepare('SELECT 1 FROM users').get()) {
  const pw = Array.from(crypto.randomBytes(8), b => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join(''); // senza 0/o/1/l per non confondersi
  db.prepare('INSERT INTO users(username,name,role,pass_hash) VALUES(?,?,?,?)').run('admin', 'Titolare', 'admin', hashPw(pw));
  fs.writeFileSync(path.join(DATA_DIR, 'PRIMO-ACCESSO.txt'),
    `Utente: admin\nPassword: ${pw}\n\nCambia la password dopo il primo accesso (menu Impostazioni) e cancella questo file.\n`);
  console.log(`\n>>> Primo avvio. Accesso: utente "admin", password "${pw}" (salvata in data/PRIMO-ACCESSO.txt)\n`);
  const area = db.prepare('SELECT id FROM areas ORDER BY sort,id').get().id;
  for (let i = 1; i <= 8; i++) db.prepare('INSERT INTO tables(name,seats,area_id,sort) VALUES(?,?,?,?)').run(`Tavolo ${i}`, i <= 3 ? 2 : i <= 6 ? 4 : 6, area, i);
}

// ---------- disponibilità ----------
const ACTIVE = "('confermata','arrivato','completata')";
function slotsFor() {
  const s = getSettings(), step = Number(s.step_min) || 30, out = [];
  for (const range of s.slots.split(',')) {
    const [a, b] = range.trim().split('-');
    if (!isTime(a) || !isTime(b)) continue;
    for (let m = toMin(a); m <= toMin(b); m += step) out.push(fromMin(m));
  }
  return out;
}
// tavoli occupati in un certo orario: una prenotazione tiene il tavolo per "durata" minuti
function busyTables(date, time, excludeId = 0) {
  const dur = Number(getSettings().duration_min) || 90, start = toMin(time), busy = new Map();
  const rows = db.prepare(`SELECT rt.table_id,r.id,r.time,r.people,c.name FROM reservation_tables rt JOIN reservations r ON r.id=rt.reservation_id
    JOIN customers c ON c.id=r.customer_id WHERE r.date=? AND r.status IN ${ACTIVE} AND r.id!=?`).all(date, excludeId);
  for (const r of rows) if (start < toMin(r.time) + dur && toMin(r.time) < start + dur) busy.set(r.table_id, { id: r.id, name: r.name, time: r.time, people: r.people });
  return busy;
}
const activeTables = () => db.prepare('SELECT t.*,a.name area_name FROM tables t LEFT JOIN areas a ON a.id=t.area_id WHERE t.active=1 ORDER BY a.sort,a.id,t.sort,t.id').all();
const tablesOf = id => db.prepare('SELECT t.id,t.name,t.seats,t.area_id FROM reservation_tables rt JOIN tables t ON t.id=rt.table_id WHERE rt.reservation_id=? ORDER BY t.sort,t.id').all(id);
const seatsOf = tables => tables.reduce((a, t) => a + t.seats, 0);
const setTables = (id, ids) => { db.prepare('DELETE FROM reservation_tables WHERE reservation_id=?').run(id); for (const t of ids) db.prepare('INSERT INTO reservation_tables VALUES(?,?)').run(id, t); };
const MAX_JOIN = 4; // al massimo 4 tavoli uniti per una prenotazione
const less = (a, b) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] < b[k]; return false; };

// sceglie i tavoli: uno solo se basta, altrimenti tavoli vicini uniti (numerazione consecutiva nella stessa area)
function pickTables(date, time, people, { exclude = 0, areaId = 0 } = {}) {
  const busy = busyTables(date, time, exclude), all = activeTables();
  const free = t => !busy.has(t.id), other = t => (areaId && t.area_id !== areaId ? 1 : 0);
  const single = all.filter(t => free(t) && t.seats >= people).sort((a, b) => other(a) - other(b) || a.seats - b.seats || a.id - b.id)[0];
  if (single) return [single];
  const byArea = new Map();
  for (const t of all) byArea.set(t.area_id, [...(byArea.get(t.area_id) || []), t]);
  let best = null;
  for (const list of byArea.values()) {
    for (let i = 0; i < list.length; i++) {
      let seats = 0;
      for (let j = i; j < Math.min(list.length, i + MAX_JOIN) && free(list[j]); j++) {
        seats += list[j].seats;
        if (seats < people) continue;
        const score = [other(list[i]), j - i, seats - people]; // area preferita, meno tavoli, meno posti in più
        if (!best || less(score, best.score)) best = { group: list.slice(i, j + 1), score };
        break;
      }
    }
  }
  return best && best.group;
}

// tavoli scelti a mano: devono esistere ed essere liberi; se i posti non bastano serve una conferma (force)
function manualTables(ids, { date, time, people, exclude = 0, force }) {
  const rows = [...new Set(ids.map(Number))].map(id => db.prepare('SELECT * FROM tables WHERE id=? AND active=1').get(id));
  if (rows.some(t => !t)) throw new HttpError(400, 'Tavolo non valido');
  const busy = busyTables(date, time, exclude), taken = rows.filter(t => busy.has(t.id));
  if (taken.length) throw new HttpError(409, `${taken.map(t => `${t.name} (${busy.get(t.id).name})`).join(', ')}: già occupato a quest'ora`);
  if (rows.length && seatsOf(rows) < people && !force) throw Object.assign(new HttpError(409, `I tavoli scelti hanno ${seatsOf(rows)} posti e le persone sono ${people}`), { canForce: true });
  return rows;
}

// ---------- notifiche ----------
function queue(channel, to, body, kind, subject = '') {
  if (!to) return;
  db.prepare('INSERT INTO outbox(channel,to_addr,subject,body,kind) VALUES(?,?,?,?,?)').run(channel, to, subject, body, kind);
}
const fmtDate = d => d.split('-').reverse().join('/');
function notifyNewReservation(id) {
  const r = db.prepare('SELECT r.*,c.name cname,c.phone cphone,c.email cemail FROM reservations r JOIN customers c ON c.id=r.customer_id WHERE r.id=?').get(id);
  const s = getSettings(), tn = tablesOf(id).map(t => t.name).join(' + ');
  const txt = `Nuova prenotazione: ${r.cname}, ${r.people} pers., ${fmtDate(r.date)} ore ${r.time}${tn ? ', ' + tn : ''}${r.notes ? '. Note: ' + r.notes : ''}`;
  queue('sms', s.notify_phone, txt, 'staff'); queue('email', s.notify_email, txt, 'staff', 'Nuova prenotazione');
  if (s.confirm_customer === '1') {
    const c = `${s.restaurant_name}: prenotazione confermata per ${r.people} persone il ${fmtDate(r.date)} alle ${r.time}. A presto!`;
    queue('sms', r.cphone, c, 'conferma'); queue('email', r.cemail, c, 'conferma', 'Prenotazione confermata');
  }
}
async function flushOutbox() {
  const rows = db.prepare("SELECT * FROM outbox WHERE status='in_coda' ORDER BY id LIMIT 20").all();
  for (const m of rows) {
    try {
      if (m.channel === 'sms' && process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM) {
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Messages.json`, {
          method: 'POST',
          headers: { Authorization: 'Basic ' + Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: m.to_addr, From: process.env.TWILIO_FROM, Body: m.body }),
        });
        if (!res.ok) throw new Error(`Twilio ${res.status}`);
      } else if (m.channel === 'email' && process.env.RESEND_KEY && process.env.MAIL_FROM) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: process.env.MAIL_FROM, to: m.to_addr, subject: m.subject || getSettings().restaurant_name, text: m.body }),
        });
        if (!res.ok) throw new Error(`Email ${res.status}`);
      } else continue; // invio non configurato: resta in coda e visibile nella pagina Messaggi
      db.prepare("UPDATE outbox SET status='inviato' WHERE id=?").run(m.id);
    } catch (e) { db.prepare("UPDATE outbox SET status='errore',error=? WHERE id=?").run(String(e.message), m.id); }
  }
}
setInterval(() => flushOutbox().catch(() => {}), 15000);

// ---------- backup giornaliero ----------
function backup() {
  const file = path.join(DATA_DIR, 'backup', `ristorante-${todayStr()}.db`);
  if (!fs.existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(path.join(DATA_DIR, 'backup')).sort().slice(0, -30);
  old.forEach(f => fs.unlinkSync(path.join(DATA_DIR, 'backup', f)));
}
backup(); setInterval(backup, 6 * 3600 * 1000);

// ---------- API ----------
const routes = [];
const route = (method, pattern, role, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), role, fn });
const need = (v, msg) => { if (!v) throw new HttpError(400, msg); };

const loginAttempts = new Map(); // solo i tentativi falliti contano
route('GET', '/api/info', null, () => ({ restaurant: getSettings().restaurant_name }));
route('POST', '/api/login', null, ({ body, ip }, res) => {
  const a = loginAttempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 600000) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) throw new HttpError(429, 'Troppi tentativi, riprova tra qualche minuto');
  const uname = String(body.username || '').trim().toLowerCase(), pw = String(body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(uname);
  // tollera gli spazi copiati per errore prima o dopo la password
  if (!u || !(checkPw(pw, u.pass_hash) || (pw !== pw.trim() && checkPw(pw.trim(), u.pass_hash)))) {
    a.n++; loginAttempts.set(ip, a);
    console.log(`Accesso rifiutato (${u ? 'utente esistente, password errata' : 'utente sconosciuto'}), tentativo ${a.n}`);
    throw new HttpError(401, 'Utente o password errati. Controlla di non aver lasciato spazi.');
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token, u.id, Date.now());
  res.setCookie = `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 30}`;
  return { name: u.name, role: u.role };
});
route('POST', '/api/logout', null, ({ cookies }, res) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(cookies.sid || '');
  res.setCookie = 'sid=; Max-Age=0; Path=/'; return { ok: true };
});
route('GET', '/api/me', 'staff', ({ user }) => ({ name: user.name, role: user.role, restaurant: getSettings().restaurant_name, today: todayStr(), cfg: config() }));

route('GET', '/api/slots', 'staff', ({ query }) => {
  const people = Number(query.people) || 2;
  need(isDate(query.date), 'Data non valida');
  const now = new Date(), nowMin = now.getHours() * 60 + now.getMinutes(), isToday = query.date === todayStr(), exclude = Number(query.exclude) || 0;
  return slotsFor().map(time => ({ time, free: !(isToday && toMin(time) < nowMin) && !!pickTables(query.date, time, people, { exclude }) }));
});
// proposta di assegnazione automatica (anche con tavoli uniti)
route('GET', '/api/suggest', 'staff', ({ query }) => {
  need(isDate(query.date) && isTime(query.time), 'Data o orario non validi');
  const t = pickTables(query.date, query.time, Number(query.people) || 1, { areaId: Number(query.area) || 0, exclude: Number(query.exclude) || 0 });
  return { tables: t ? t.map(x => ({ id: x.id, name: x.name, seats: x.seats, area_id: x.area_id })) : null };
});
// tutti i tavoli attivi con chi li occupa in quell'orario (serve per scegliere o unire i tavoli)
route('GET', '/api/tables/status', 'staff', ({ query }) => {
  need(isDate(query.date) && isTime(query.time), 'Data o orario non validi');
  const busy = busyTables(query.date, query.time, Number(query.exclude) || 0);
  return activeTables().map(t => ({ ...t, busy: busy.get(t.id) || null }));
});

route('GET', '/api/reservations', 'staff', ({ query }) => {
  need(isDate(query.date), 'Data non valida');
  const rows = db.prepare(`SELECT r.*,c.name cname,c.phone cphone,c.notes cnotes FROM reservations r JOIN customers c ON c.id=r.customer_id
    WHERE r.date=? ORDER BY r.time,r.id`).all(query.date);
  const links = db.prepare(`SELECT rt.reservation_id rid,t.id,t.name,t.seats,t.area_id FROM reservation_tables rt JOIN tables t ON t.id=rt.table_id
    JOIN reservations r ON r.id=rt.reservation_id WHERE r.date=? ORDER BY t.sort,t.id`).all(query.date);
  for (const r of rows) r.tables = links.filter(l => l.rid === r.id).map(({ rid, ...t }) => t);
  return rows;
});
route('POST', '/api/reservations', 'staff', ({ body, user }) => {
  const { name, date, time, notes = '', force } = body, people = Number(body.people), phone = normPhone(body.phone);
  need(String(name || '').trim(), 'Scrivi il nome del cliente'); need(phone, 'Scrivi il numero di telefono');
  need(isDate(date), 'Data non valida'); need(isTime(time), 'Orario non valido'); need(people >= 1 && people <= 100, 'Numero persone non valido');
  if (date < todayStr()) throw new HttpError(400, 'La data è nel passato');
  let tables;
  if (Array.isArray(body.table_ids)) tables = manualTables(body.table_ids, { date, time, people, force }); // scelti a mano (anche nessuno)
  else {
    tables = pickTables(date, time, people, { areaId: Number(body.area_id) || 0 });
    if (!tables && !force) {
      const free = slotsFor().filter(t => pickTables(date, t, people)).slice(0, 6);
      throw Object.assign(new HttpError(409, `Nessun tavolo libero per ${people} persone alle ${time}.` + (free.length ? ` Orari liberi: ${free.join(', ')}` : ' Nessun orario libero in questa data.')), { canForce: true });
    }
    tables = tables || [];
  }
  const id = tx(() => {
    let cust = db.prepare('SELECT * FROM customers WHERE phone=?').get(phone);
    const mk = body.marketing_ok ? 1 : 0;
    if (cust) db.prepare('UPDATE customers SET name=?, email=COALESCE(NULLIF(?,\'\'),email), marketing_ok=MAX(marketing_ok,?) WHERE id=?').run(name.trim(), body.email || '', mk, cust.id);
    else cust = { id: Number(db.prepare('INSERT INTO customers(name,phone,email,marketing_ok) VALUES(?,?,?,?)').run(name.trim(), phone, body.email || '', mk).lastInsertRowid) };
    const rid = Number(db.prepare('INSERT INTO reservations(customer_id,date,time,people,notes,created_by,feedback_token) VALUES(?,?,?,?,?,?,?)')
      .run(cust.id, date, time, people, notes, user.id, crypto.randomBytes(8).toString('hex')).lastInsertRowid);
    setTables(rid, tables.map(t => t.id));
    return rid;
  });
  notifyNewReservation(id); flushOutbox().catch(() => {});
  return { id, tables: tables.map(t => ({ id: t.id, name: t.name, area_id: t.area_id })) };
});
route('PATCH', '/api/reservations/:id', 'staff', ({ params, body }) => {
  const r = db.prepare('SELECT * FROM reservations WHERE id=?').get(params.id);
  if (!r) throw new HttpError(404, 'Prenotazione non trovata');
  const n = { ...r, ...Object.fromEntries(['status', 'date', 'time', 'people', 'notes'].filter(k => body[k] !== undefined).map(k => [k, body[k]])) };
  need(['confermata', 'arrivato', 'completata', 'annullata', 'no_show'].includes(n.status), 'Stato non valido');
  need(isDate(n.date) && isTime(n.time), 'Data/ora non valide'); n.people = Number(n.people); need(n.people >= 1, 'Persone non valide');
  const live = s => ['confermata', 'arrivato'].includes(s), cur = tablesOf(r.id);
  let tables = null; // null = lascia i tavoli come sono
  if (Array.isArray(body.table_ids)) tables = manualTables(body.table_ids, { date: n.date, time: n.time, people: n.people, exclude: r.id, force: body.force });
  else if (live(n.status) && (n.date !== r.date || n.time !== r.time || n.people !== r.people || !live(r.status) && r.status !== 'completata')) {
    // data, ora o persone cambiate (o prenotazione riattivata): si tengono i tavoli se sono ancora liberi e bastano, altrimenti se ne cercano altri
    const busy = busyTables(n.date, n.time, r.id);
    if (!(cur.length && cur.every(t => !busy.has(t.id)) && seatsOf(cur) >= n.people)) {
      const pick = pickTables(n.date, n.time, n.people, { exclude: r.id, areaId: cur.length ? cur[0].area_id : 0 });
      if (!pick && !body.force) throw Object.assign(new HttpError(409, 'Nessun tavolo libero con questi dati'), { canForce: true });
      tables = pick || [];
    }
  }
  tx(() => {
    db.prepare('UPDATE reservations SET status=?,date=?,time=?,people=?,notes=? WHERE id=?').run(n.status, n.date, n.time, n.people, n.notes, r.id);
    if (tables) setTables(r.id, tables.map(t => t.id));
  });
  if (n.status === 'completata' && r.status !== 'completata') {
    const c = db.prepare('SELECT * FROM customers WHERE id=?').get(r.customer_id), s = getSettings();
    const msg = `${s.restaurant_name}: grazie della visita! Com'è andata? Lascia un voto: ${s.base_url}/f/${r.feedback_token}`;
    queue('sms', c.phone, msg, 'feedback'); queue('email', c.email, msg, 'feedback', 'Com\'è andata?');
  }
  return { ok: true, tables: tablesOf(r.id) };
});
route('GET', '/api/poll', 'staff', ({ query }) => {
  const after = Number(query.after) || 0;
  const max = db.prepare('SELECT COALESCE(MAX(id),0) m FROM reservations').get().m;
  const fresh = after ? db.prepare('SELECT r.id,r.date,r.time,r.people,c.name cname FROM reservations r JOIN customers c ON c.id=r.customer_id WHERE r.id>? ORDER BY r.id').all(after) : [];
  return { max, fresh };
});

route('GET', '/api/customers', 'staff', ({ query }) => {
  const q = `%${(query.q || '').trim()}%`;
  return db.prepare(`SELECT c.*,(SELECT COUNT(*) FROM reservations r WHERE r.customer_id=c.id AND r.status IN ('arrivato','completata')) visits,
    (SELECT MAX(date) FROM reservations r WHERE r.customer_id=c.id) last_date FROM customers c WHERE c.name LIKE ? OR c.phone LIKE ? ORDER BY c.name LIMIT 200`).all(q, q);
});
route('GET', '/api/customers/by-phone', 'staff', ({ query }) => db.prepare('SELECT * FROM customers WHERE phone=?').get(normPhone(query.phone)) || null);
route('GET', '/api/customers/:id', 'staff', ({ params }) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(params.id);
  if (!c) throw new HttpError(404, 'Cliente non trovato');
  c.reservations = db.prepare('SELECT date,time,people,status,notes FROM reservations WHERE customer_id=? ORDER BY date DESC,time DESC LIMIT 50').all(c.id);
  c.feedback = db.prepare('SELECT rating,comment,created_at FROM feedback WHERE customer_id=? ORDER BY id DESC').all(c.id);
  return c;
});
route('PUT', '/api/customers/:id', 'staff', ({ params, body }) => {
  need(String(body.name || '').trim(), 'Nome mancante');
  db.prepare('UPDATE customers SET name=?,phone=?,email=?,notes=?,marketing_ok=? WHERE id=?').run(body.name.trim(), normPhone(body.phone), body.email || '', body.notes || '', body.marketing_ok ? 1 : 0, params.id);
  return { ok: true };
});

route('GET', '/api/feedback', 'staff', () => ({
  avg: db.prepare('SELECT ROUND(AVG(rating),1) a, COUNT(*) n FROM feedback').get(),
  list: db.prepare('SELECT f.*,c.name cname FROM feedback f LEFT JOIN customers c ON c.id=f.customer_id ORDER BY f.id DESC LIMIT 200').all(),
}));
route('POST', '/api/feedback', 'staff', ({ body }) => { // voto raccolto a voce al telefono o al tavolo
  const r = db.prepare('SELECT * FROM reservations WHERE id=?').get(body.reservation_id);
  need(r, 'Prenotazione non trovata'); need(body.rating >= 1 && body.rating <= 5, 'Voto da 1 a 5');
  db.prepare('INSERT INTO feedback(reservation_id,customer_id,rating,comment) VALUES(?,?,?,?)').run(r.id, r.customer_id, body.rating, body.comment || '');
  return { ok: true };
});
route('POST', '/api/public/feedback/:token', null, ({ params, body }) => {
  const r = db.prepare('SELECT * FROM reservations WHERE feedback_token=?').get(params.token);
  if (!r) throw new HttpError(404, 'Link non valido');
  if (db.prepare('SELECT 1 FROM feedback WHERE reservation_id=?').get(r.id)) throw new HttpError(409, 'Hai già lasciato il tuo voto, grazie!');
  const rating = Number(body.rating); need(rating >= 1 && rating <= 5, 'Scegli un voto da 1 a 5');
  db.prepare('INSERT INTO feedback(reservation_id,customer_id,rating,comment) VALUES(?,?,?,?)').run(r.id, r.customer_id, rating, String(body.comment || '').slice(0, 1000));
  return { ok: true };
});

route('GET', '/api/campaigns', 'staff', () => db.prepare('SELECT * FROM campaigns ORDER BY id DESC LIMIT 100').all());
route('GET', '/api/campaigns/audience', 'staff', () => db.prepare("SELECT COUNT(*) n FROM customers WHERE marketing_ok=1 AND (phone!='' OR email!='')").get());
route('POST', '/api/campaigns', 'admin', ({ body, user }) => {
  need(['offerta', 'evento'].includes(body.kind), 'Tipo non valido'); need(String(body.title || '').trim() && String(body.message || '').trim(), 'Scrivi titolo e messaggio');
  const aud = db.prepare("SELECT * FROM customers WHERE marketing_ok=1").all();
  const s = getSettings();
  const text = `${s.restaurant_name} - ${body.title}${body.event_date ? ' (' + fmtDate(body.event_date) + ')' : ''}\n${body.message}`;
  let n = 0;
  for (const c of aud) { if (c.phone) { queue('sms', c.phone, text, body.kind); n++; } if (c.email) { queue('email', c.email, text, body.kind, body.title); n++; } }
  db.prepare('INSERT INTO campaigns(kind,title,message,event_date,recipients,created_by) VALUES(?,?,?,?,?,?)').run(body.kind, body.title, body.message, body.event_date || null, n, user.id);
  flushOutbox().catch(() => {});
  return { messages: n };
});
route('GET', '/api/outbox', 'staff', () => db.prepare('SELECT * FROM outbox ORDER BY id DESC LIMIT 200').all());

route('GET', '/api/areas', 'staff', () => db.prepare('SELECT a.*,(SELECT COUNT(*) FROM tables t WHERE t.area_id=a.id AND t.active=1) tables FROM areas a ORDER BY a.sort,a.id').all());
route('POST', '/api/areas', 'admin', ({ body }) => {
  need(String(body.name || '').trim(), 'Scrivi il nome dell\'area');
  db.prepare('INSERT INTO areas(name,sort) VALUES(?,(SELECT COALESCE(MAX(sort),0)+1 FROM areas))').run(body.name.trim());
  return { ok: true };
});
route('PUT', '/api/areas/:id', 'admin', ({ params, body }) => {
  need(String(body.name || '').trim(), 'Scrivi il nome dell\'area');
  db.prepare('UPDATE areas SET name=? WHERE id=?').run(body.name.trim(), params.id);
  return { ok: true };
});
route('DELETE', '/api/areas/:id', 'admin', ({ params }) => {
  if (db.prepare('SELECT COUNT(*) n FROM areas').get().n <= 1) throw new HttpError(400, 'Deve restare almeno un\'area');
  if (db.prepare('SELECT 1 FROM tables WHERE area_id=?').get(params.id)) throw new HttpError(400, 'In quest\'area ci sono dei tavoli: spostali in un\'altra area prima di eliminarla');
  db.prepare('DELETE FROM areas WHERE id=?').run(params.id);
  return { ok: true };
});

route('GET', '/api/tables', 'staff', () => db.prepare('SELECT t.*,a.name area_name FROM tables t LEFT JOIN areas a ON a.id=t.area_id ORDER BY a.sort,a.id,t.sort,t.id').all());
route('POST', '/api/tables/bulk', 'admin', ({ body }) => { // aggiunge uno o più tavoli di seguito: "Tavolo 9", "Tavolo 10"…
  const count = Number(body.count), seats = Number(body.seats), prefix = String(body.prefix || '').trim() || 'Tavolo';
  need(count >= 1 && count <= 100, 'Quanti tavoli? Da 1 a 100'); need(seats >= 1, 'Quanti posti ha ogni tavolo?');
  const area = db.prepare('SELECT id FROM areas WHERE id=?').get(Number(body.area_id)); need(area, 'Scegli l\'area');
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(\\d+)$', 'i');
  let n = Math.max(0, ...db.prepare('SELECT name FROM tables').all().map(t => Number((re.exec(t.name) || [])[1]) || 0));
  let sort = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM tables WHERE area_id=?').get(area.id).m;
  tx(() => { for (let i = 0; i < count; i++) db.prepare('INSERT INTO tables(name,seats,area_id,sort) VALUES(?,?,?,?)').run(`${prefix} ${++n}`, seats, area.id, ++sort); });
  return { added: count };
});
route('PUT', '/api/tables/:id', 'admin', ({ params, body }) => {
  need(String(body.name || '').trim() && Number(body.seats) >= 1, 'Servono il nome e il numero di posti');
  need(db.prepare('SELECT 1 FROM areas WHERE id=?').get(Number(body.area_id)), 'Scegli l\'area');
  const t = db.prepare('SELECT area_id FROM tables WHERE id=?').get(params.id);
  if (!t) throw new HttpError(404, 'Tavolo non trovato');
  // un tavolo spostato in un'altra area va in fondo alla numerazione di quell'area
  const sort = t.area_id === Number(body.area_id) ? null : db.prepare('SELECT COALESCE(MAX(sort),0)+1 n FROM tables WHERE area_id=?').get(Number(body.area_id)).n;
  db.prepare('UPDATE tables SET name=?,seats=?,active=?,area_id=?,sort=COALESCE(?,sort) WHERE id=?').run(body.name.trim(), Number(body.seats), body.active ? 1 : 0, Number(body.area_id), sort, params.id);
  return { ok: true };
});

route('GET', '/api/settings', 'admin', () => getSettings());
route('PUT', '/api/settings', 'admin', ({ body }) => {
  if (body.service_split !== undefined) need(isTime(body.service_split), 'Orario di inizio cena non valido (esempio 16:00)');
  for (const k of ['turn2_pranzo', 'turn2_cena']) if (body[k] !== undefined) need(body[k] === '' || isTime(body[k]), 'Orario del secondo turno non valido (esempio 21:00, oppure vuoto)');
  for (const k of ['step_min', 'duration_min', 'late_min']) if (body[k] !== undefined) need(Number(body[k]) >= 1, 'Controlla i minuti: servono numeri maggiori di zero');
  if (body.slots !== undefined) need(String(body.slots).split(',').every(s => /^\d\d:\d\d-\d\d:\d\d$/.test(s.trim()) && isTime(s.trim().slice(0, 5)) && isTime(s.trim().slice(6))), 'Orari di servizio non validi (esempio 12:00-14:00,19:00-22:00)');
  for (const k of Object.keys(DEFAULTS)) if (body[k] !== undefined) db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(body[k]).trim(), k);
  return { ok: true };
});
route('GET', '/api/users', 'admin', () => db.prepare('SELECT id,username,name,role,active FROM users').all());
route('POST', '/api/users', 'admin', ({ body }) => {
  need(body.username && body.name && String(body.password || '').length >= 6, 'Utente, nome e password (almeno 6 caratteri)');
  try { db.prepare('INSERT INTO users(username,name,role,pass_hash) VALUES(?,?,?,?)').run(body.username.trim().toLowerCase(), body.name, body.role === 'admin' ? 'admin' : 'staff', hashPw(body.password)); }
  catch { throw new HttpError(409, 'Nome utente già esistente'); }
  return { ok: true };
});
route('PUT', '/api/users/:id', 'admin', ({ params, body, user }) => {
  if (body.password) { need(body.password.length >= 6, 'Password di almeno 6 caratteri'); db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPw(body.password), params.id); }
  if (body.active !== undefined) { if (Number(params.id) === user.id) throw new HttpError(400, 'Non puoi disattivare te stesso'); db.prepare('UPDATE users SET active=? WHERE id=?').run(body.active ? 1 : 0, params.id); }
  return { ok: true };
});
route('POST', '/api/password', 'staff', ({ body, user }) => {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  if (!checkPw(String(body.old || ''), u.pass_hash)) throw new HttpError(400, 'Password attuale errata');
  need(String(body.new || '').length >= 6, 'Nuova password di almeno 6 caratteri');
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPw(body.new), user.id); return { ok: true };
});

// ---------- server HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// pagina pubblica per il voto, stessa linea elegante del gestionale
function feedbackPage() {
  const name = escHtml(getSettings().restaurant_name);
  return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} - La tua opinione</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f4eddc;color:#2b2220;font:20px/1.55 Georgia,"Palatino Linotype",serif}
main{max-width:520px;margin:0 auto;padding:40px 20px;text-align:center}
.rule{display:flex;align-items:center;gap:14px;max-width:300px;margin:0 auto 14px}.rule:before,.rule:after{content:"";flex:1;height:1px;background:#a8873a}
.rule i{width:9px;height:9px;transform:rotate(45deg);border:1px solid #a8873a;background:#f4eddc}
h1{font:600 clamp(28px,8vw,40px)/1.15 "Palatino Linotype",Palatino,Georgia,serif;letter-spacing:.08em;text-transform:uppercase;color:#6d1f2b;margin:0 0 6px}
.card{background:#fffcf4;border:1px solid #e0d3b3;padding:30px 22px;margin-top:22px;position:relative}
.card:before{content:"";position:absolute;inset:6px;border:1px solid #dccb9b;pointer-events:none}
p.lead{font-size:23px;font-style:italic;margin:0}
#st{display:flex;justify-content:center;gap:4px;margin:18px 0}
#st button{font-size:46px;line-height:1;background:none;border:0;color:#d4c7a3;cursor:pointer;padding:2px 4px}#st button.on{color:#c79a1b}
textarea{width:100%;font:inherit;padding:12px;border:1px solid #bfae7f;border-radius:3px;min-height:100px;background:#fffefb}
#go{margin-top:18px;font:600 19px Georgia,serif;letter-spacing:.05em;padding:14px 30px;background:#6d1f2b;color:#f7ebc8;border:1px solid #4f1620;border-radius:3px;box-shadow:inset 0 0 0 2px #6d1f2b,inset 0 0 0 3px rgba(220,203,155,.7);cursor:pointer}
#m{min-height:1.5em;font-weight:700;margin:14px 0 0}.bad{color:#8a1c1c}
</style></head><body><main><div class="rule"><i></i></div><h1>${name}</h1>
<div class="card"><div id="box"><p class="lead">Com'è andata la tua serata da noi?</p><div id="st" role="group" aria-label="Voto da 1 a 5 stelle"></div>
<textarea id="c" placeholder="Vuoi lasciarci un commento? (facoltativo)"></textarea><br><button id="go">Invia il tuo parere</button></div><p id="m"></p></div></main>
<script>
var r=0,st=document.getElementById("st"),m=document.getElementById("m");
for(var i=1;i<=5;i++){(function(i){var b=document.createElement("button");b.type="button";b.textContent="\\u2605";b.setAttribute("aria-label",i+" su 5");b.onclick=function(){r=i;for(var j=0;j<5;j++)st.children[j].className=j<i?"on":""};st.appendChild(b)})(i)}
document.getElementById("go").onclick=function(){
 if(!r){m.className="bad";m.textContent="Tocca le stelle per scegliere un voto";return}
 fetch("/api/public/feedback/"+location.pathname.split("/").pop(),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({rating:r,comment:document.getElementById("c").value})})
 .then(function(x){return x.json().then(function(j){return[x.ok,j]})})
 .then(function(a){if(a[0]){document.getElementById("box").innerHTML='<p class="lead">Grazie di cuore! La tua opinione ci aiuta a migliorare.</p>';m.textContent=""}else{m.className="bad";m.textContent=a[1].error||"Errore"}})
 .catch(function(){m.className="bad";m.textContent="Connessione assente, riprova"})};
</script></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, obj, type = 'application/json') => {
    const h = { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    if (res.setCookie) h['Set-Cookie'] = res.setCookie;
    res.writeHead(code, h); res.end(type === 'application/json' ? JSON.stringify(obj) : obj);
  };
  try {
    if (url.pathname.startsWith('/f/')) return send(200, feedbackPage(), 'text/html; charset=utf-8');
    if (!url.pathname.startsWith('/api/')) {
      let p = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!p.startsWith(PUBLIC_DIR) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end('Non trovato'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); return res.end(fs.readFileSync(p));
    }
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(c => c[0]));
    let body = {};
    if (req.method !== 'GET') {
      const chunks = []; let size = 0;
      for await (const ch of req) { size += ch.length; if (size > 200000) throw new HttpError(413, 'Richiesta troppo grande'); chunks.push(ch); }
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; } catch { throw new HttpError(400, 'Dati non validi'); }
    }
    const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
    if (!r) throw new HttpError(404, 'Non trovato');
    let user = null;
    if (r.role) {
      user = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1').get(cookies.sid || '');
      if (!user) throw new HttpError(401, 'Accedi di nuovo');
      if (r.role === 'admin' && user.role !== 'admin') throw new HttpError(403, 'Solo il titolare può farlo');
    }
    const query = Object.fromEntries(url.searchParams);
    const out = r.fn({ body, query, params: url.pathname.match(r.re).groups || {}, cookies, user, ip: req.socket.remoteAddress }, res);
    send(200, out);
  } catch (e) {
    if (e instanceof HttpError) send(e.code, { error: e.message, canForce: e.canForce || false });
    else { console.error(e); send(500, { error: 'Errore interno' }); }
  }
});
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log(`\nIl sistema è GIÀ ACCESO su http://localhost:${PORT}. Puoi usare quello.\n`); process.exit(0); }
  throw e;
});
server.listen(PORT, () => console.log(`Sistema avviato: http://localhost:${PORT}\nLascia aperta questa finestra mentre lavori.`));

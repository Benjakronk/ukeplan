'use strict';

// =============================================================
// UKEPLAN – API server (drop-in replacement for ukeplan_GAS.js)
//
// Mirrors the Apps Script backend exactly: the same actions, the
// same params (query string + form-urlencoded body, merged like
// GAS e.parameter), the same JSON responses, and the same
// convention that EVERY error is HTTP 200 with { error } – so the
// frontends only need SCRIPT_URL repointed here (any path works,
// e.g. https://host/api/plan).
//
// Phase 2 improvements (range queries, ETags, per-teacher
// accounts) come after the cutover is stable – see
// ../server-plan.md.
//
// Env: PORT (default 3000), HOST (default 127.0.0.1 – behind
// Caddy), UKEPLAN_DB (default ./data/ukeplan.db).
// =============================================================

const crypto = require('crypto');
const express = require('express');
const { db } = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

// Allowed element types. Mirrors TYPES / GENERAL_TYPES in ukeplan_GAS.js
// and teacher.js – keep all three in sync.
const TYPES = ['lekse', 'læringsmål', 'ressurs', 'beskjed', 'timeendring', 'utstyr', 'aktivitet', 'annet'];
const GENERAL_TYPES = ['beskjed', 'timeendring', 'utstyr', 'aktivitet', 'annet'];

// =============================================================
// AUTHENTICATION (same model as the GAS backend)
// Tokens live exactly 4 h from login and are NOT renewed on use –
// the frontend's TOKEN_TTL mirrors this. Tokens are in-memory, so
// a server restart logs teachers out; the frontend handles that
// (re-login + pending-write replay).
// =============================================================

const TOKEN_TTL_MS = 4 * 60 * 60 * 1000;
const tokens = new Map();               // token → expiry (ms since epoch)

// Shared-password login gets basic rate limiting (the GAS never had it).
const loginAttempts = new Map();        // ip → { count, resetAt }
const LOGIN_MAX = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;

function loginLimited(ip) {
  const now = Date.now();
  const a = loginAttempts.get(ip);
  if (!a || now > a.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return false;
  }
  a.count++;
  return a.count > LOGIN_MAX;
}

function hashString(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function handleLogin(password, ip) {
  if (loginLimited(ip)) return { error: 'For mange innloggingsforsøk. Vent 10 minutter og prøv igjen.' };
  if (!password) return { error: 'Passord mangler' };
  const row = db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get();
  if (!row) return { error: 'Server ikke konfigurert – kjør setup-password.js først' };
  if (hashString(password) !== row.value) return { error: 'Feil passord' };

  const token = crypto.randomUUID();
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  loginAttempts.delete(ip);
  return { token };
}

function validateToken(token) {
  if (!token) return false;
  const exp = tokens.get(token);
  if (!exp) return false;
  if (Date.now() >= exp) { tokens.delete(token); return false; }
  return true;
}

// Periodic sweep so dead tokens and stale rate-limit entries don't pile up.
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of tokens) if (now >= exp) tokens.delete(t);
  for (const [ip, a] of loginAttempts) if (now > a.resetAt) loginAttempts.delete(ip);
}, 10 * 60 * 1000).unref();

// =============================================================
// DATA ACCESS
// =============================================================

const selectAll = db.prepare('SELECT * FROM plan_elements ORDER BY rowid');
const selectById = db.prepare('SELECT * FROM plan_elements WHERE id = ?');
const insertRow = db.prepare(`
  INSERT INTO plan_elements (id, timestamp, type, classes, week, day, subject, description, teacher, week_to)
  VALUES (@id, @timestamp, @type, @classes, @week, @day, @subject, @description, @teacher, @week_to)
`);
const updateRow = db.prepare(`
  UPDATE plan_elements SET timestamp = @timestamp, type = @type, classes = @classes, week = @week,
    day = @day, subject = @subject, description = @description, teacher = @teacher, week_to = @week_to
  WHERE id = @id
`);
const deleteRow = db.prepare('DELETE FROM plan_elements WHERE id = ?');

// Row → API object with the exact field names the frontends expect.
function rowToEntry(r) {
  return {
    id:          String(r.id),
    timestamp:   r.timestamp || '',
    type:        r.type || 'annet',
    classes:     r.classes || '',
    week:        r.week || '',
    day:         r.day || '',
    subject:     r.subject || '',
    description: r.description || '',
    teacher:     r.teacher || '',
    weekTo:      r.week_to || r.week || '',   // end of range; defaults to week (single)
  };
}

function readAll() { return selectAll.all().map(rowToEntry); }

// All plan elements (no auth) – fallback / elev-cache.
function getPublicData() { return readAll(); }

// Plan elements matching any of `classesStr` (space-separated) for one ISO
// week. Same filter semantics as the GAS (ISO strings sort lexically).
function getWeekData(classesStr, week) {
  if (!week) return [];
  const selected = parseClasses(classesStr);
  return readAll().filter(entry => {
    const to = entry.weekTo || entry.week;
    if (!(entry.week <= week && to >= week)) return false;
    if (!selected.length) return true;      // no class filter → all classes that week
    return matchesClasses(entry, selected);
  });
}

// =============================================================
// CRUD (ports of createEntry / updateEntry / deleteEntry / cloneWeek)
// =============================================================

function createEntry(p) {
  const type = normalizeType(p.type);
  if (!type) return { error: 'Ukjent type: ' + p.type };
  const week = p.week || (p.date ? isoWeekString(new Date(p.date)) : '');
  if (!week) return { error: 'Mangler uke' };
  let weekTo = p.weekTo || week;
  if (weekTo < week) weekTo = week;

  const entry = {
    id: crypto.randomUUID(),
    timestamp: nowStamp(),
    type,
    classes: p.classes || '',
    week,
    day: p.day || '',
    subject: p.subject || '',
    description: p.description || '',
    teacher: p.teacher || '',
    week_to: weekTo,
  };
  insertRow.run(entry);
  return rowToEntry(entry);
}

function updateEntry(p) {
  const type = normalizeType(p.type);
  if (!type) return { error: 'Ukjent type: ' + p.type };
  const existing = selectById.get(String(p.id || ''));
  if (!existing) return { error: 'Oppføring ikke funnet' };

  const week = p.week || (p.date ? isoWeekString(new Date(p.date)) : '') || existing.week || '';
  let weekTo = p.weekTo || week;
  if (weekTo < week) weekTo = week;

  updateRow.run({
    id: existing.id,
    timestamp: nowStamp(),
    type,
    classes: p.classes || '',
    week,
    day: p.day || '',
    subject: p.subject || '',
    description: p.description || '',
    teacher: p.teacher || '',
    week_to: weekTo,
  });
  return { success: true };
}

function deleteEntry(id) {
  const info = deleteRow.run(String(id || ''));
  if (info.changes === 0) return { error: 'Oppføring ikke funnet' };
  return { success: true };
}

// Copies every element matching `classes` in `fromWeek` into `toWeek` (new
// ids, fresh timestamps). Optional `toClasses` re-targets the copies (used to
// seed an adapted plan from its base class, fromWeek === toWeek). Optional
// scoping from the teacher UI: `subjects` (comma-separated; missing = no
// filter, empty = none) and `general` ('0' skips the banner types).
function cloneWeek(p) {
  if (!p.fromWeek || !p.toWeek) return { error: 'Mangler fromWeek/toWeek' };
  const retarget = p.toClasses ? String(p.toClasses).trim() : '';
  if (p.fromWeek === p.toWeek && !retarget) return { error: 'Kilde- og måluke er like' };

  const selected = parseClasses(p.classes);
  const subjFilter = (p.subjects === undefined) ? null
                   : String(p.subjects).split(',').filter(s => s !== '');
  const skipGeneral = p.general === '0';

  const source = readAll().filter(entry => {
    const to = entry.weekTo || entry.week;
    if (!(entry.week <= p.fromWeek && to >= p.fromWeek)) return false;
    // A multi-week element that already covers toWeek would show its content
    // twice if cloned – skip it (unless re-targeting to another class/code).
    if (!retarget && entry.week <= p.toWeek && to >= p.toWeek) return false;
    if (GENERAL_TYPES.includes(entry.type)) {
      if (skipGeneral) return false;
    } else if (subjFilter && !subjFilter.includes(entry.subject)) {
      return false;
    }
    if (!selected.length) return true;
    return matchesClasses(entry, selected);
  });

  const stamp = nowStamp();
  const created = db.transaction(() => source.map(entry => {
    const row = {
      id: crypto.randomUUID(),
      timestamp: stamp,
      type: entry.type,
      classes: retarget || entry.classes,
      week: p.toWeek,
      day: entry.day,
      subject: entry.subject,
      description: entry.description,
      teacher: entry.teacher,
      week_to: p.toWeek,
    };
    insertRow.run(row);
    return rowToEntry(row);
  }))();

  return { success: true, count: created.length, entries: created };
}

// =============================================================
// UTILITIES (ports of the GAS helpers)
// =============================================================

// "8A 8b, 9C" → ['8A','8B','9C']
function parseClasses(s) {
  if (!s) return [];
  return String(s).toUpperCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
}

function matchesClasses(entry, selected) {
  const entryClasses = parseClasses(entry.classes);
  return selected.some(c => entryClasses.includes(c));
}

function normalizeType(t) {
  if (!t) return 'annet';
  const lower = String(t).toLowerCase();
  return TYPES.includes(lower) ? lower : null;
}

// ISO-8601 week string, e.g. "2026-W24". Must match the frontend's
// dateToWeek() – identical algorithm to isoWeekString in the GAS.
function isoWeekString(date) {
  if (!(date instanceof Date) || isNaN(date)) return '';
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + (week < 10 ? '0' + week : '' + week);
}

// "yyyy-MM-dd HH:mm" in Europe/Oslo – same format the GAS wrote, so imported
// and new rows look alike. (sv-SE locale formats exactly this way.)
function nowStamp() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Oslo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date());
}

// =============================================================
// HTTP wiring
// =============================================================

const app = express();
app.disable('x-powered-by');

// CORS: needed while the frontend is still on GitHub Pages (different
// origin). Form-urlencoded POSTs are "simple" requests, so no preflight in
// practice – the OPTIONS handler is belt-and-braces. Harmless same-origin.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Any other path acts like the GAS exec URL: dispatch on method + action.
app.all('*', (req, res) => {
  const p = Object.assign({}, req.query, req.body);   // like GAS e.parameter
  try {
    let out;
    if (req.method === 'GET') {
      const action = String(p.action || 'public').toLowerCase();
      if (action === 'public')      out = getPublicData();
      else if (action === 'week')   out = getWeekData(p.classes, p.week);
      else if (!validateToken(p.token)) out = { error: 'Unauthorized' };
      else if (action === 'all')    out = readAll();
      else                          out = { error: 'Unknown action' };
    } else if (req.method === 'POST') {
      const action = String(p.action || '').toLowerCase();
      if (action === 'login')       out = handleLogin(p.password, req.ip);
      else if (!validateToken(p.token)) out = { error: 'Unauthorized' };
      else if (action === 'create') out = createEntry(p);
      else if (action === 'update') out = updateEntry(p);
      else if (action === 'delete') out = deleteEntry(p.id);
      else if (action === 'clone')  out = cloneWeek(p);
      else                          out = { error: 'Unknown action' };
    } else {
      out = { error: 'Unknown action' };
    }
    res.json(out);
  } catch (err) {
    // Mirror the GAS convention: every error is HTTP 200 with { error }.
    res.json({ error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`ukeplan-server lytter på http://${HOST}:${PORT}`);
});

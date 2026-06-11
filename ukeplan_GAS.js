// =============================================================
// UKEPLAN — Apps Script backend
//
// Backend for the NEW "Planelementer" sheet (homework, learning
// goals, messages, etc.). Assessments ("vurderinger") are NOT
// stored here — the frontend reads those read-only from the
// existing vurderingskalender backend and merges them in.
//
// Auth, token and response conventions mirror the
// vurderingskalender Apps Script so the two feel identical.
//
// Sheet column order (row 1 is a header):
//   A id | B timestamp | C type | D classes | E week
//   F day | G subject | H description | I teacher
// =============================================================

var SHEET_NAME = 'Planelementer';

// Allowed element types. Kept here so the backend can reject
// garbage, but the frontend owns the canonical list/labels.
var TYPES = ['lekse', 'læringsmål', 'ressurs', 'beskjed', 'timeendring', 'utstyr', 'aktivitet', 'annet'];

// =============================================================
// ONE-TIME SETUP
// Run ONCE from the Script Editor to store the hashed teacher
// password. Never reachable via HTTP.
//
// Usage: open the Script Editor, pick setupPassword from the
// function dropdown, pass your chosen password as the argument,
// then Run.
// =============================================================
function setupPassword(plaintext) {
  PropertiesService.getScriptProperties()
    .setProperty('PASSWORD_HASH', hashString(plaintext));
  Logger.log('Password hash stored successfully.');
}

// =============================================================
// HTTP ENTRY POINTS
// Deploy as: Execute as → Me | Who has access → Anyone
// =============================================================

function doGet(e) {
  var p      = (e && e.parameter) || {};
  var action = (p.action || 'public').toLowerCase();
  try {
    if (action === 'public') return respond(getPublicData());
    if (action === 'week')   return respond(getWeekData(p.classes, p.week));

    if (!validateToken(p.token)) return respond({ error: 'Unauthorized' });

    if (action === 'all') return respond(getAllData());

    return respond({ error: 'Unknown action' });
  } catch (err) {
    return respond({ error: err.message });
  }
}

function doPost(e) {
  var p      = (e && e.parameter) || {};
  var action = (p.action || '').toLowerCase();
  try {
    if (action === 'login') return respond(handleLogin(p.password));

    if (!validateToken(p.token)) return respond({ error: 'Unauthorized' });

    if (action === 'create') return respond(createEntry(p));
    if (action === 'update') return respond(updateEntry(p));
    if (action === 'delete') return respond(deleteEntry(p.id));
    if (action === 'clone')  return respond(cloneWeek(p));

    return respond({ error: 'Unknown action' });
  } catch (err) {
    return respond({ error: err.message });
  }
}

// =============================================================
// AUTHENTICATION  (identical model to vurderingskalender)
// =============================================================

function handleLogin(password) {
  if (!password) return { error: 'Passord mangler' };
  var storedHash = PropertiesService.getScriptProperties().getProperty('PASSWORD_HASH');
  if (!storedHash) return { error: 'Server ikke konfigurert — kjør setupPassword() først' };
  if (hashString(password) !== storedHash) return { error: 'Feil passord' };

  var token = Utilities.getUuid();
  CacheService.getScriptCache().put('tok_' + token, '1', 14400); // 4 hours
  return { token: token };
}

function validateToken(token) {
  if (!token) return false;
  return CacheService.getScriptCache().get('tok_' + token) !== null;
}

function hashString(s) {
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    s,
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(b) {
    return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0');
  }).join('');
}

// =============================================================
// DATA ACCESS
// =============================================================

function getSheet() {
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    // First run: create the sheet with its header so the script
    // works against a blank spreadsheet without manual setup.
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['id', 'timestamp', 'type', 'classes', 'week', 'day', 'subject', 'description', 'teacher', 'weekTo']);
  }
  return sheet;
}

// Reads the whole sheet into an array of objects.
function readSheet() {
  var sheet = getSheet();
  var data  = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  var tz = Session.getScriptTimeZone();
  return data.slice(1)
    .filter(function(row) { return row[0] !== ''; })
    .map(function(row) {
      return {
        id:          String(row[0]),
        timestamp:   row[1] ? Utilities.formatDate(new Date(row[1]), tz, 'yyyy-MM-dd HH:mm') : '',
        type:        String(row[2] || 'annet'),
        classes:     String(row[3] || ''),
        week:        String(row[4] || ''),
        day:         String(row[5] || ''),
        subject:     String(row[6] || ''),
        description: String(row[7] || ''),
        teacher:     String(row[8] || ''),
        weekTo:      String(row[9] || row[4] || '')  // end of range; defaults to week (single)
      };
    });
}

// All plan elements (no auth) — fallback / elev-cache.
function getPublicData() {
  return readSheet();
}

// Plan elements matching any of `classesStr` (space-separated)
// for a single ISO week. Filtered server-side so the student
// page never has to load the whole year.
function getWeekData(classesStr, week) {
  if (!week) return [];
  var selected = parseClasses(classesStr);
  return readSheet().filter(function(entry) {
    var to = entry.weekTo || entry.week;
    // Element applies if the requested week is within [week, weekTo] (ISO strings sort lexically).
    if (!(entry.week <= week && to >= week)) return false;
    if (!selected.length) return true; // no class filter → all classes that week
    return matchesClasses(entry, selected);
  });
}

// Everything, for the teacher dashboard.
function getAllData() {
  return readSheet();
}

// =============================================================
// CRUD
// =============================================================

function createEntry(p) {
  var type = normalizeType(p.type);
  if (!type) return { error: 'Ukjent type: ' + p.type };
  var week = p.week || (p.date ? isoWeekString(new Date(p.date)) : '');
  if (!week) return { error: 'Mangler uke' };
  var weekTo = p.weekTo || week;
  if (weekTo < week) weekTo = week;

  var sheet = getSheet();
  var id    = Utilities.getUuid();
  var now   = new Date();
  var tz    = Session.getScriptTimeZone();
  sheet.appendRow([
    id, now, type,
    p.classes || '', week, p.day || '',
    p.subject || '', p.description || '', p.teacher || '', weekTo
  ]);
  return {
    id:          id,
    timestamp:   Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm'),
    type:        type,
    classes:     p.classes     || '',
    week:        week,
    day:         p.day         || '',
    subject:     p.subject     || '',
    description: p.description  || '',
    teacher:     p.teacher      || '',
    weekTo:      weekTo
  };
}

function updateEntry(p) {
  var type = normalizeType(p.type);
  if (!type) return { error: 'Ukjent type: ' + p.type };
  var sheet = getSheet();
  var data  = sheet.getDataRange().getValues();
  var now   = new Date();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(p.id)) {
      var week   = p.week || (p.date ? isoWeekString(new Date(p.date)) : '') || String(data[i][4] || '');
      var weekTo = p.weekTo || week;
      if (weekTo < week) weekTo = week;
      // Columns B–J (1-indexed cols 2–10), row i+1
      sheet.getRange(i + 1, 2, 1, 9).setValues([[
        now,
        type,
        p.classes     || '',
        week,
        p.day         || '',
        p.subject     || '',
        p.description || '',
        p.teacher     || '',
        weekTo
      ]]);
      return { success: true };
    }
  }
  return { error: 'Oppføring ikke funnet' };
}

function deleteEntry(id) {
  var sheet = getSheet();
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      sheet.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { error: 'Oppføring ikke funnet' };
}

// Copies every element matching `classes` in `fromWeek` into
// `toWeek` (new ids, fresh timestamps). Powers the
// "Kopier fra forrige uke" button. Vurderinger are not touched
// (they live in the other backend).
function cloneWeek(p) {
  if (!p.fromWeek || !p.toWeek) return { error: 'Mangler fromWeek/toWeek' };
  if (p.fromWeek === p.toWeek)  return { error: 'Kilde- og måluke er like' };

  var selected = parseClasses(p.classes);
  var source = readSheet().filter(function(entry) {
    var to = entry.weekTo || entry.week;
    if (!(entry.week <= p.fromWeek && to >= p.fromWeek)) return false;
    if (!selected.length) return true;
    return matchesClasses(entry, selected);
  });

  var sheet = getSheet();
  var now   = new Date();
  var tz    = Session.getScriptTimeZone();
  var created = source.map(function(entry) {
    var id = Utilities.getUuid();
    sheet.appendRow([
      id, now, entry.type,
      entry.classes, p.toWeek, entry.day,
      entry.subject, entry.description, entry.teacher, p.toWeek
    ]);
    return Object.assign({}, entry, {
      id: id,
      week: p.toWeek,
      weekTo: p.toWeek,
      timestamp: Utilities.formatDate(now, tz, 'yyyy-MM-dd HH:mm')
    });
  });

  return { success: true, count: created.length, entries: created };
}

// =============================================================
// UTILITIES
// =============================================================

// "8A 8b, 9C" → ['8A','8B','9C']
function parseClasses(s) {
  if (!s) return [];
  return String(s).toUpperCase().replace(/,/g, ' ').split(/\s+/).filter(Boolean);
}

// True if the entry is tagged with any of the selected classes.
function matchesClasses(entry, selected) {
  var entryClasses = parseClasses(entry.classes);
  return selected.some(function(c) { return entryClasses.indexOf(c) !== -1; });
}

function normalizeType(t) {
  if (!t) return 'annet';
  var lower = String(t).toLowerCase();
  return TYPES.indexOf(lower) !== -1 ? lower : null;
}

// ISO-8601 week string, e.g. "2026-W24". Matches the frontend's
// dateToWeek() so weeks derived on either side agree.
function isoWeekString(date) {
  if (!(date instanceof Date) || isNaN(date)) return '';
  // Copy, shift to Thursday of the current ISO week (Mon=1…Sun=7).
  var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  var dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  var week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return d.getUTCFullYear() + '-W' + (week < 10 ? '0' + week : '' + week);
}

function respond(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

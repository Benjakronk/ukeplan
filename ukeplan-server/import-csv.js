'use strict';

// One-off import of the "Planelementer" sheet into SQLite.
//
// In Google Sheets: Fil → Last ned → Kommadelte verdier (.csv) for the
// Planelementer tab, then:
//
//   node import-csv.js sti/til/Planelementer.csv
//
// Existing UUIDs are kept as primary keys (INSERT OR REPLACE), so the
// frontends notice nothing and the import can be re-run safely.

const fs = require('fs');
const { db, DB_PATH } = require('./db');

// Minimal CSV parser that handles quoted fields, escaped quotes ("") and
// embedded commas/newlines (descriptions can contain both).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const file = process.argv[2];
if (!file) {
  console.error('Bruk: node import-csv.js <Planelementer.csv>');
  process.exit(1);
}

const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');   // strip BOM
const rows = parseCSV(text);
if (!rows.length) { console.error('Tom fil.'); process.exit(1); }

const header = rows.shift().map(h => h.trim());
const COLS = ['id', 'timestamp', 'type', 'classes', 'week', 'day', 'subject', 'description', 'teacher', 'weekTo'];
const idx = {};
COLS.forEach(name => { idx[name] = header.indexOf(name); });
if (idx.id === -1 || idx.type === -1 || idx.week === -1) {
  console.error('Uventet header (forventet kolonnene ' + COLS.join(', ') + '): ' + header.join(', '));
  process.exit(1);
}

// description keeps its whitespace; everything else is trimmed.
const get = (row, name, keepWs) => {
  if (idx[name] === -1) return '';
  const v = String(row[idx[name]] ?? '');
  return keepWs ? v : v.trim();
};

const insert = db.prepare(`
  INSERT OR REPLACE INTO plan_elements (id, timestamp, type, classes, week, day, subject, description, teacher, week_to)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let n = 0;
db.transaction(() => {
  for (const row of rows) {
    const id = get(row, 'id');
    if (!id) continue;                       // skip blank/padding rows
    insert.run(
      id,
      get(row, 'timestamp'),
      get(row, 'type') || 'annet',
      get(row, 'classes'),
      get(row, 'week'),
      get(row, 'day'),
      get(row, 'subject'),
      get(row, 'description', true),
      get(row, 'teacher'),
      get(row, 'weekTo'),
    );
    n++;
  }
})();

console.log('Importerte ' + n + ' rader til ' + DB_PATH);

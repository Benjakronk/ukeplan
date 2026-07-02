'use strict';

// Opens (and on first run creates) the SQLite database. Shared by server.js,
// setup-password.js and import-csv.js.
//
// The schema mirrors the "Planelementer" sheet 1:1 (weekTo → week_to). The
// settings table replaces GAS Script Properties (password hash).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.UKEPLAN_DB || path.join(__dirname, 'data', 'ukeplan.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS plan_elements (
    id          TEXT PRIMARY KEY,
    timestamp   TEXT NOT NULL DEFAULT '',
    type        TEXT NOT NULL,
    classes     TEXT NOT NULL DEFAULT '',
    week        TEXT NOT NULL,
    day         TEXT NOT NULL DEFAULT '',
    subject     TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    teacher     TEXT NOT NULL DEFAULT '',
    week_to     TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_plan_week ON plan_elements(week, week_to);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

module.exports = { db, DB_PATH };

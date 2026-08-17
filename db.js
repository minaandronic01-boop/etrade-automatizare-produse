// Baza de date locala (SQLite, modul nativ Node — nicio dependenta externa).
'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'etrade.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    companie TEXT,
    contact TEXT,
    telefon TEXT,
    email TEXT,
    urgenta TEXT,
    categorie TEXT,
    campuri_json TEXT,
    cod TEXT,
    descriere TEXT,
    foto_path TEXT,
    status TEXT NOT NULL DEFAULT 'nou',
    email_trimis INTEGER NOT NULL DEFAULT 0,
    email_eroare TEXT,
    webhook_trimis INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS xref (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    categorie TEXT,
    cod_intern TEXT,
    eq1 TEXT,
    eq2 TEXT,
    eq3 TEXT,
    observatii TEXT,
    updated_at TEXT NOT NULL
  );
`);

// Seed cu doua randuri demonstrative daca tabelul e gol, ca sa se vada structura.
const xrefCount = db.prepare('SELECT COUNT(*) AS c FROM xref').get().c;
if (xrefCount === 0) {
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO xref (categorie, cod_intern, eq1, eq2, eq3, observatii, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?)`);
  ins.run('Rulmenti (exemplu)', '-', '', '', '', 'Exemplu de structura - completati cu echivalente verificate de echipa tehnica', now);
  ins.run('Garnituri (exemplu)', '-', '', '', '', 'Exemplu de structura - completati cu echivalente verificate de echipa tehnica', now);
}

module.exports = db;

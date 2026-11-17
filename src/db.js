'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'pokladna.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'cashier',
  pin_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  fails INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY, barcode TEXT, name TEXT NOT NULL,
  price INTEGER NOT NULL DEFAULT 0,          -- prodejní cena s DPH v haléřích
  vat_rate INTEGER NOT NULL DEFAULT 21,
  unit TEXT NOT NULL DEFAULT 'ks',
  stock REAL NOT NULL DEFAULT 0,
  purchase_price INTEGER NOT NULL DEFAULT 0, -- poslední nákupní cena bez DPH v haléřích
  favorite INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  created TEXT NOT NULL, updated TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode) WHERE barcode IS NOT NULL AND active = 1;
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL, type TEXT NOT NULL, qty REAL NOT NULL,
  purchase_price INTEGER, note TEXT, user_name TEXT, receipt_id INTEGER, created TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moves_product ON stock_moves(product_id);
CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY, number TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'sale',
  ref_id INTEGER, storno_by INTEGER,
  created TEXT NOT NULL, sale_time TEXT NOT NULL, day TEXT NOT NULL,
  user_id INTEGER, user_name TEXT,
  payment TEXT NOT NULL, total INTEGER NOT NULL, rounding INTEGER NOT NULL DEFAULT 0,
  paid_total INTEGER NOT NULL, received INTEGER,
  customer TEXT, vat TEXT NOT NULL, seller TEXT NOT NULL, note TEXT,
  eet_status TEXT NOT NULL DEFAULT 'none',   -- none | pending | ok | error
  eet_pok TEXT, eet_test INTEGER NOT NULL DEFAULT 0, eet_error TEXT, eet_warnings TEXT,
  eet_attempts INTEGER NOT NULL DEFAULT 0, eet_last_try TEXT, eet_received TEXT,
  eet_eic TEXT, eet_unit TEXT, eet_pos TEXT, eet_env TEXT, eet_trace TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipts_day ON receipts(day);
CREATE INDEX IF NOT EXISTS idx_receipts_eet ON receipts(eet_status);
CREATE TABLE IF NOT EXISTS receipt_items (
  id INTEGER PRIMARY KEY, receipt_id INTEGER NOT NULL, product_id INTEGER,
  name TEXT NOT NULL, barcode TEXT, qty REAL NOT NULL, unit TEXT NOT NULL,
  unit_price INTEGER NOT NULL, vat_rate INTEGER NOT NULL, total INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_receipt ON receipt_items(receipt_id);
`);

const DEFAULT_SETTINGS = {
  company: { name: '', ico: '', dic: '', street: '', city: '', zip: '', registry: '', phone: '', email: '', shopAddress: '' },
  vatPayer: true,
  vatRates: [21, 12, 0],
  defaultVat: 21,
  roundCash: true,
  paper: '80',           // 80 | 58 | A4
  autoPrint: true,
  footer: 'Děkujeme za Váš nákup.',
  eet: { enabled: false, env: 'playground', unitId: '', posId: 'POKLADNA-1', eic: '', certPem: '', keyPem: '', validTo: '' },
};

function getSettings() {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const r of db.prepare('SELECT key, value FROM settings').all()) {
    const v = JSON.parse(r.value);
    out[r.key] = v && typeof v === 'object' && !Array.isArray(v) ? { ...out[r.key], ...v } : v;
  }
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function nextCounter(name) {
  db.prepare('INSERT INTO counters(name, value) VALUES(?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1').run(name);
  return db.prepare('SELECT value FROM counters WHERE name = ?').get(name).value;
}

module.exports = { db, getSettings, setSetting, tx, nextCounter, DEFAULT_SETTINGS, DATA_DIR };

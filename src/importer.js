'use strict';
// Hromadný import zboží z textu / CSV / Excelu (vložený text).
// Podporuje hlavičku (CZ/VN/EN názvy sloupců) nebo bez hlavičky:
//   kód; název; cena; DPH; množství; nákupní cena; jednotka
//   název; cena; DPH; množství            (bez kódu)
const { db, getSettings, tx } = require('./db');

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').trim();

const HEADERS = {
  barcode: ['ma vach', 'mavach', 'ma', 'barcode', 'ean', 'kod', 'carovy kod', 'code', 'plu'],
  name: ['ten', 'ten hang', 'nazev', 'name', 'zbozi', 'hang', 'san pham', 'mat hang'],
  price: ['gia', 'gia ban', 'cena', 'prodejni cena', 'price', 'cena s dph'],
  vat: ['dph', 'thue', 'vat', 'sazba', 'muc thue', 'thue dph'],
  qty: ['so luong', 'sl', 'mnozstvi', 'qty', 'ks', 'pocet', 'nhap', 'ton', 'ton kho', 'sklad', 'stock'],
  purchase: ['gia nhap', 'nakupni cena', 'nakup', 'purchase', 'gia von', 'nc'],
  unit: ['don vi', 'dv', 'jednotka', 'mj', 'unit'],
};

function splitLine(line) {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(';')) return line.split(';');
  if (line.includes('|')) return line.split('|');
  // Čárky: rozdělit jen pokud nejde o desetinnou čárku mezi číslicemi.
  return line.split(/,(?!\d{1,2}(?:\D|$))|,\s+/);
}

/** "3,90", "3.90 Kč", "1 234,50" -> haléře */
function money(s) {
  const t = String(s ?? '').replace(/k[cč]|czk|,-|\s/gi, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(parseFloat(t) * 100);
}
function num(s) {
  const t = String(s ?? '').replace(/ks|kg|pcs|cai|chiec|\s/gi, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null;
}
const isBarcode = (s) => /^\d{4,14}$/.test(String(s).trim());

function detectHeader(cells) {
  const map = {};
  cells.forEach((c, i) => {
    const n = norm(c).replace(/[^a-z ]/g, '').trim();
    for (const [k, names] of Object.entries(HEADERS)) if (!(k in map) && names.includes(n)) map[k] = i;
  });
  return 'name' in map || 'barcode' in map ? map : null;
}

/** Rozpozná řádek bez hlavičky podle obsahu buněk. */
function guessRow(cells, rates) {
  const c = cells.map((x) => x.trim()).filter((x) => x !== '');
  const r = {};
  let i = 0;
  if (c[i] && isBarcode(c[i])) r.barcode = c[i++];
  // název = první nečíselná buňka
  while (i < c.length && money(c[i]) !== null && !r.name) i++;
  if (c[i] !== undefined) r.name = c[i++];
  if (!r.barcode && c[i] && isBarcode(c[i]) && c[i].length >= 8) r.barcode = c[i++];
  const rest = c.slice(i);
  if (rest.length) r.price = rest.shift();
  // DPH: číslo s % nebo hodnota z povolených sazeb
  if (rest.length && (/%$/.test(rest[0]) || (rates.includes(num(rest[0])) && rest.length >= 1 && /^\d{1,2}%?$/.test(rest[0])))) r.vat = rest.shift();
  if (rest.length) r.qty = rest.shift();
  if (rest.length) r.purchase = rest.shift();
  if (rest.length && !/^\d/.test(rest[0])) r.unit = rest.shift();
  return r;
}

/**
 * Rozebere text a připraví plán změn (bez zápisu).
 * mode: 'add' = množství se přičte ke skladu, 'set' = sklad se nastaví (inventura)
 */
function plan(text, mode = 'add') {
  const s = getSettings();
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/^﻿/, '')).filter((l) => l.trim());
  let header = null;
  const rows = [];
  lines.forEach((line, idx) => {
    const cells = splitLine(line);
    if (idx === 0) { header = detectHeader(cells); if (header) return; }
    const raw = header ? Object.fromEntries(Object.entries(header).map(([k, i]) => [k, (cells[i] ?? '').trim()])) : guessRow(cells, s.vatRates);
    rows.push({ line: idx + 1, text: line.trim().slice(0, 200), raw });
  });

  const byBarcode = db.prepare('SELECT * FROM products WHERE barcode = ? AND active = 1');
  const all = db.prepare('SELECT * FROM products WHERE active = 1').all();
  const byName = new Map(all.map((p) => [norm(p.name), p]));
  const seenBarcodes = new Set();

  for (const row of rows) {
    const r = row.raw;
    const errors = [];
    const barcode = r.barcode ? String(r.barcode).trim() : null;
    if (barcode && !/^[0-9A-Za-z\-_.]{1,40}$/.test(barcode)) errors.push('BAD_BARCODE');
    if (barcode && seenBarcodes.has(barcode)) errors.push('DUPLICATE_IN_LIST');
    if (barcode) seenBarcodes.add(barcode);
    const name = r.name ? String(r.name).trim().slice(0, 80) : '';
    const price = r.price !== undefined && r.price !== '' ? money(r.price) : undefined;
    if (price === null) errors.push('BAD_PRICE');
    let vat;
    if (r.vat !== undefined && r.vat !== '') {
      vat = num(String(r.vat).replace('%', ''));
      if (!s.vatRates.includes(vat)) errors.push('BAD_VAT');
    }
    const qty = r.qty !== undefined && r.qty !== '' ? num(r.qty) : undefined;
    if (qty === null) errors.push('BAD_QTY');
    const purchase = r.purchase !== undefined && r.purchase !== '' ? money(r.purchase) : undefined;
    if (purchase === null) errors.push('BAD_PURCHASE');
    const unit = r.unit ? String(r.unit).trim().slice(0, 10) : undefined;

    const existing = (barcode && byBarcode.get(barcode)) || (name && byName.get(norm(name))) || null;
    if (!existing) {
      if (!name) errors.push('NO_NAME');
      if (price === undefined) errors.push('NO_PRICE');
    }
    row.data = { barcode, name, price, vat, qty, purchase, unit };
    row.errors = errors;
    if (errors.length) { row.action = 'error'; continue; }
    if (!existing) {
      row.action = 'create';
      row.product = { name, barcode, price, vat: vat ?? s.defaultVat, unit: unit || 'ks', stock: qty ?? 0, purchase: purchase ?? 0 };
      continue;
    }
    const ch = {};
    if (name && name !== existing.name && barcode && existing.barcode === barcode) ch.name = [existing.name, name];
    if (barcode && !existing.barcode) ch.barcode = [null, barcode];
    if (price !== undefined && price !== existing.price) ch.price = [existing.price, price];
    if (vat !== undefined && vat !== existing.vat_rate) ch.vat = [existing.vat_rate, vat];
    if (purchase !== undefined && purchase !== existing.purchase_price) ch.purchase = [existing.purchase_price, purchase];
    if (unit && unit !== existing.unit) ch.unit = [existing.unit, unit];
    if (qty !== undefined && qty !== null) {
      const newStock = mode === 'set' ? qty : Math.round((existing.stock + qty) * 1000) / 1000;
      if (newStock !== existing.stock) ch.stock = [existing.stock, newStock];
    }
    row.productId = existing.id;
    row.productName = existing.name;
    row.changes = ch;
    row.action = Object.keys(ch).length ? 'update' : 'same';
  }
  const count = (a) => rows.filter((r) => r.action === a).length;
  return { mode, header: !!header, rows, summary: { create: count('create'), update: count('update'), same: count('same'), error: count('error') } };
}

/** Provede import. Řádky s chybou přeskočí. */
function apply(text, mode, userName) {
  const p = plan(text, mode);
  const t = new Date().toISOString();
  const note = mode === 'set' ? 'Hromadná inventura' : 'Hromadný import';
  tx(() => {
    const move = db.prepare('INSERT INTO stock_moves (product_id, type, qty, purchase_price, note, user_name, created) VALUES (?,?,?,?,?,?,?)');
    for (const r of p.rows) {
      if (r.action === 'create') {
        const x = r.product;
        // Duplicitní čárový kód mohl vzniknout dříve v tomto importu.
        const id = Number(db.prepare(`INSERT INTO products (barcode, name, price, vat_rate, unit, stock, purchase_price, favorite, created, updated)
          VALUES (?,?,?,?,?,?,?,0,?,?)`).run(x.barcode, x.name, x.price, x.vat, x.unit, x.stock, x.purchase, t, t).lastInsertRowid);
        if (x.stock) move.run(id, 'in', x.stock, x.purchase || null, note, userName, t);
      } else if (r.action === 'update') {
        const c = r.changes;
        const sets = [], args = [];
        const col = { name: 'name', barcode: 'barcode', price: 'price', vat: 'vat_rate', purchase: 'purchase_price', unit: 'unit', stock: 'stock' };
        for (const [k, v] of Object.entries(c)) { sets.push(`${col[k]} = ?`); args.push(v[1]); }
        db.prepare(`UPDATE products SET ${sets.join(', ')}, updated = ? WHERE id = ?`).run(...args, t, r.productId);
        if (c.stock) move.run(r.productId, mode === 'set' ? 'correction' : 'in', Math.round((c.stock[1] - c.stock[0]) * 1000) / 1000, c.purchase ? c.purchase[1] : null, note, userName, t);
      }
    }
  });
  return p;
}

module.exports = { plan, apply, money, splitLine };

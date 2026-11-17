'use strict';
// Doklady: výpočet, uložení, storno a evidence v EET 2.0.
const { db, getSettings, tx, nextCounter } = require('./db');
const eet = require('./eet');

class ApiError extends Error {
  constructor(code, status = 400, detail) { super(code); this.code = code; this.status = status; this.detail = detail; }
}

const roundHalfAway = (x) => (x < 0 ? -Math.round(-x) : Math.round(x));

/** Rekapitulace DPH: z ceny s daní ("shora"), po sazbách. */
function vatSummary(items, vatPayer) {
  const groups = new Map();
  for (const it of items) groups.set(it.vat_rate, (groups.get(it.vat_rate) || 0) + it.total);
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([rate, gross]) => {
    const vat = vatPayer ? roundHalfAway((gross * rate) / (100 + rate)) : 0;
    return { rate, base: gross - vat, vat, gross };
  });
}

function sellerSnapshot(s) {
  return { ...s.company, vatPayer: !!s.vatPayer, footer: s.footer || '' };
}

function eetFields(s, paidTotal) {
  const e = s.eet;
  if (!e.enabled) return { eet_status: 'none' };
  if (!e.keyPem || !e.certPem || !e.eic || !e.unitId || !e.posId) throw new ApiError('EET_NOT_CONFIGURED');
  if (Math.abs(paidTotal) >= 100000000 * 100) throw new ApiError('AMOUNT_TOO_BIG');
  return { eet_status: 'pending', eet_eic: e.eic, eet_unit: String(e.unitId), eet_pos: e.posId, eet_env: e.env };
}

function insertReceipt(r, items) {
  const year = r.day.slice(0, 4);
  const number = year + String(nextCounter('receipt-' + year)).padStart(6, '0');
  const res = db.prepare(`INSERT INTO receipts
    (number, type, ref_id, created, sale_time, day, user_id, user_name, payment, total, rounding, paid_total, received,
     customer, vat, seller, note, eet_status, eet_eic, eet_unit, eet_pos, eet_env)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    number, r.type, r.ref_id ?? null, r.created, r.sale_time, r.day, r.user_id, r.user_name, r.payment, r.total, r.rounding,
    r.paid_total, r.received ?? null, r.customer ? JSON.stringify(r.customer) : null, JSON.stringify(r.vat),
    JSON.stringify(r.seller), r.note || null, r.eet_status, r.eet_eic ?? null, r.eet_unit ?? null, r.eet_pos ?? null, r.eet_env ?? null);
  const id = Number(res.lastInsertRowid);
  const insItem = db.prepare(`INSERT INTO receipt_items (receipt_id, product_id, name, barcode, qty, unit, unit_price, vat_rate, total)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const move = db.prepare(`INSERT INTO stock_moves (product_id, type, qty, note, user_name, receipt_id, created) VALUES (?,?,?,?,?,?,?)`);
  const upd = db.prepare('UPDATE products SET stock = stock - ? WHERE id = ?');
  for (const it of items) {
    insItem.run(id, it.product_id ?? null, it.name, it.barcode ?? null, it.qty, it.unit, it.unit_price, it.vat_rate, it.total);
    if (it.product_id) {
      upd.run(it.qty, it.product_id);
      move.run(it.product_id, r.type === 'storno' ? 'storno' : 'sale', -it.qty, number, r.user_name, id, r.created);
    }
  }
  return id;
}

function getReceipt(id) {
  const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
  if (!r) return null;
  for (const k of ['customer', 'vat', 'seller', 'eet_warnings']) r[k] = r[k] ? JSON.parse(r[k]) : null;
  r.items = db.prepare('SELECT * FROM receipt_items WHERE receipt_id = ? ORDER BY id').all(id);
  if (r.ref_id) r.ref_number = db.prepare('SELECT number FROM receipts WHERE id = ?').get(r.ref_id)?.number;
  if (r.storno_by) r.storno_number = db.prepare('SELECT number FROM receipts WHERE id = ?').get(r.storno_by)?.number;
  return r;
}

/** Vytvoří prodejní doklad. body: { items:[{productId?, name?, qty, unitPrice?, vatRate?}], payment, received, customer, note } */
function createSale(body, user) {
  const s = getSettings();
  if (!Array.isArray(body.items) || !body.items.length) throw new ApiError('EMPTY_CART');
  if (!['cash', 'card'].includes(body.payment)) throw new ApiError('BAD_PAYMENT');
  const getP = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
  const items = body.items.map((x) => {
    const qty = Number(x.qty);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 100000) throw new ApiError('BAD_QTY');
    let it;
    if (x.productId) {
      const p = getP.get(Number(x.productId));
      if (!p) throw new ApiError('PRODUCT_NOT_FOUND');
      it = { product_id: p.id, name: p.name, barcode: p.barcode, unit: p.unit, unit_price: p.price, vat_rate: p.vat_rate };
      // Pokladní smí cenu změnit jen u položky, kde ji prodavač zadal ručně (sleva / vážené zboží).
      if (user.role === 'admin' && Number.isInteger(x.unitPrice) && x.unitPrice >= 0) it.unit_price = x.unitPrice;
    } else {
      const name = String(x.name || '').trim().slice(0, 80);
      if (!name || !Number.isInteger(x.unitPrice) || x.unitPrice < 0) throw new ApiError('BAD_ITEM');
      const rate = Number(x.vatRate);
      if (!s.vatRates.includes(rate)) throw new ApiError('BAD_VAT');
      it = { product_id: null, name, barcode: null, unit: 'ks', unit_price: x.unitPrice, vat_rate: rate };
    }
    it.qty = qty;
    it.total = Math.round(qty * it.unit_price);
    return it;
  });
  const total = items.reduce((a, b) => a + b.total, 0);
  const paid = body.payment === 'cash' && s.roundCash ? Math.round(total / 100) * 100 : total;
  let customer = null;
  if (body.customer && (body.customer.name || body.customer.ico)) {
    const c = body.customer;
    customer = Object.fromEntries(['name', 'ico', 'dic', 'street', 'city', 'zip'].map((k) => [k, String(c[k] || '').trim().slice(0, 120)]));
  }
  const now = new Date();
  const saleTime = eet.pragueDateTime(now);
  const id = tx(() => insertReceipt({
    type: 'sale', created: now.toISOString(), sale_time: saleTime, day: saleTime.slice(0, 10),
    user_id: user.id, user_name: user.name, payment: body.payment, total, rounding: paid - total, paid_total: paid,
    received: Number.isInteger(body.received) ? body.received : null, customer, vat: vatSummary(items, s.vatPayer),
    seller: sellerSnapshot(s), note: String(body.note || '').slice(0, 200), ...eetFields(s, paid),
  }, items));
  return id;
}

/** Storno celého dokladu = nový doklad se zápornými částkami (do EET jde záporná tržba). */
function createStorno(origId, user) {
  const s = getSettings();
  const o = getReceipt(origId);
  if (!o) throw new ApiError('NOT_FOUND', 404);
  if (o.type !== 'sale') throw new ApiError('CANNOT_STORNO');
  if (o.storno_by) throw new ApiError('ALREADY_STORNO');
  const items = o.items.map((it) => ({ ...it, qty: -it.qty, total: -it.total }));
  const now = new Date();
  const saleTime = eet.pragueDateTime(now);
  // Storno se eviduje, pokud byla evidována původní tržba nebo je EET zapnuté.
  const eetF = o.eet_status === 'none' && !s.eet.enabled ? { eet_status: 'none' } : eetFields({ ...s, eet: { ...s.eet, enabled: true } }, -o.paid_total);
  return tx(() => {
    const id = insertReceipt({
      type: 'storno', ref_id: o.id, created: now.toISOString(), sale_time: saleTime, day: saleTime.slice(0, 10),
      user_id: user.id, user_name: user.name, payment: o.payment, total: -o.total, rounding: -o.rounding, paid_total: -o.paid_total,
      received: null, customer: o.customer, vat: o.vat.map((v) => ({ rate: v.rate, base: -v.base, vat: -v.vat, gross: -v.gross })),
      seller: o.seller, note: '', ...eetF,
    }, items);
    db.prepare('UPDATE receipts SET storno_by = ? WHERE id = ?').run(id, o.id);
    return id;
  });
}

const sending = new Set();
/** Odešle doklad do EET (první pokus i opakování). */
async function sendToEet(id, { timeoutMs } = {}) {
  if (sending.has(id)) return;
  sending.add(id);
  try {
    const r = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
    if (!r || !['pending', 'error'].includes(r.eet_status)) return;
    const e = getSettings().eet;
    const nowIso = new Date().toISOString();
    let res;
    try {
      res = await eet.send(
        { seq: r.number, saleTime: r.sale_time, amount: r.paid_total, first: r.eet_attempts === 0 },
        { eic: r.eet_eic, unitId: r.eet_unit, posId: r.eet_pos, env: r.eet_env, keyPem: e.keyPem, certPem: e.certPem, timeoutMs });
    } catch (err) {
      res = { ok: false, retryable: false, errorText: err.message, warnings: [] };
    }
    if (res.ok) {
      db.prepare(`UPDATE receipts SET eet_status='ok', eet_pok=?, eet_test=?, eet_error=NULL, eet_warnings=?, eet_attempts=eet_attempts+1,
        eet_last_try=?, eet_received=?, eet_trace=? WHERE id=?`).run(
        res.pok, res.test ? 1 : 0, res.warnings.length ? JSON.stringify(res.warnings) : null, nowIso, res.receivedAt || null, res.traceId || null, id);
    } else {
      const msg = (res.errorCode != null ? `[${res.errorCode}] ` : '') + (res.errorText || 'Chyba');
      db.prepare(`UPDATE receipts SET eet_status=?, eet_error=?, eet_attempts=eet_attempts+1, eet_last_try=?, eet_trace=? WHERE id=?`)
        .run(res.retryable ? 'pending' : 'error', msg, nowIso, res.traceId || null, id);
    }
  } finally {
    sending.delete(id);
  }
}

/** Na pozadí: znovu odesílá neodeslané tržby (zákon: bezodkladně, nejpozději do 48 h). */
let retryRunning = false;
async function retryPending() {
  if (retryRunning) return;
  retryRunning = true;
  try {
    const rows = db.prepare("SELECT id FROM receipts WHERE eet_status = 'pending' ORDER BY id LIMIT 50").all();
    for (const r of rows) await sendToEet(r.id, { timeoutMs: 15000 });
  } finally { retryRunning = false; }
}

module.exports = { createSale, createStorno, getReceipt, sendToEet, retryPending, vatSummary, ApiError };

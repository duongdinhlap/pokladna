'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, getSettings, setSetting, tx } = require('./db');
const R = require('./receipts');
const eet = require('./eet');
const importer = require('./importer');
const { ApiError } = R;

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_DAYS = 30;

// ---------- pomocné ----------
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
function checkPin(pin, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}
const validPin = (p) => /^\d{4,8}$/.test(String(p || ''));
const nowIso = () => new Date().toISOString();
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const money = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : NaN; };

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2 * 1024 * 1024) throw new ApiError('TOO_LARGE', 413);
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ApiError('BAD_JSON'); }
}
function auth(req) {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(m[1]);
  if (!s || s.created < Date.now() - SESSION_DAYS * 864e5) return null;
  const u = db.prepare('SELECT id, name, role FROM users WHERE id = ? AND active = 1').get(s.user_id);
  return u || null;
}
const needAdmin = (u) => { if (u.role !== 'admin') throw new ApiError('FORBIDDEN', 403); };

function publicSettings(s, user) {
  const e = { ...s.eet };
  e.hasCert = !!(e.keyPem && e.certPem);
  delete e.keyPem; delete e.certPem;
  const out = { ...s, eet: e };
  if (user.role !== 'admin') delete out.eet.certPem;
  return out;
}

function productRow(p) { return p && { ...p, favorite: !!p.favorite }; }

// ---------- ARES ----------
const aresCache = new Map();
async function ares(ico) {
  if (!/^\d{8}$/.test(ico)) throw new ApiError('BAD_ICO');
  if (aresCache.has(ico) && aresCache.get(ico).t > Date.now() - 3600e3) return aresCache.get(ico).v;
  let r;
  try {
    r = await fetch(`https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${ico}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000),
    });
  } catch { throw new ApiError('ARES_UNAVAILABLE', 502); }
  if (r.status === 404) throw new ApiError('ARES_NOT_FOUND', 404);
  if (!r.ok) throw new ApiError('ARES_UNAVAILABLE', 502);
  const j = await r.json();
  const s = j.sidlo || {};
  const cislo = [s.cisloDomovni, s.cisloOrientacni ? s.cisloOrientacni + (s.cisloOrientacniPismeno || '') : null].filter(Boolean).join('/');
  const street = s.nazevUlice ? `${s.nazevUlice} ${cislo}` : (s.nazevCastiObce ? `${s.nazevCastiObce} ${cislo}` : cislo);
  const v = {
    ico: j.ico, name: j.obchodniJmeno || '', dic: j.dic || '',
    street: street.trim(),
    city: s.nazevMestskehoObvodu && s.nazevMestskehoObvodu.startsWith(s.nazevObce || '\0') ? s.nazevMestskehoObvodu : (s.nazevObce || ''),
    zip: s.psc ? String(s.psc).replace(/^(\d{3})(\d{2})$/, '$1 $2') : '',
    address: s.textovaAdresa || '',
    vatPayer: j.seznamRegistraci?.stavZdrojeDph === 'AKTIVNI',
  };
  aresCache.set(ico, { t: Date.now(), v });
  return v;
}

// ---------- routy ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, public: !!opts.public });
};

route('GET', '/api/state', () => {
  const s = getSettings();
  return {
    setupNeeded: db.prepare('SELECT COUNT(*) c FROM users').get().c === 0,
    shopName: s.company.name,
    users: db.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all(),
  };
}, { public: true });

route('POST', '/api/setup', ({ body }) => {
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c > 0) throw new ApiError('ALREADY_SETUP', 403);
  const name = str(body.name, 40);
  if (!name || !validPin(body.pin)) throw new ApiError('BAD_INPUT');
  db.prepare("INSERT INTO users (name, role, pin_hash) VALUES (?, 'admin', ?)").run(name, hashPin(body.pin));
  return { ok: true };
}, { public: true });

route('POST', '/api/login', ({ body }) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(Number(body.userId));
  if (!u) throw new ApiError('BAD_LOGIN', 401);
  if (u.locked_until > Date.now()) throw new ApiError('LOCKED', 429);
  if (!validPin(body.pin) || !checkPin(body.pin, u.pin_hash)) {
    const fails = u.fails + 1;
    db.prepare('UPDATE users SET fails = ?, locked_until = ? WHERE id = ?').run(fails >= 5 ? 0 : fails, fails >= 5 ? Date.now() + 5 * 60e3 : 0, u.id);
    throw new ApiError('BAD_LOGIN', 401);
  }
  db.prepare('UPDATE users SET fails = 0 WHERE id = ?').run(u.id);
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').run(token, u.id, Date.now());
  return { token, user: { id: u.id, name: u.name, role: u.role } };
}, { public: true });

route('POST', '/api/logout', ({ req }) => {
  const m = /^Bearer (\w+)$/.exec(req.headers.authorization || '');
  if (m) db.prepare('DELETE FROM sessions WHERE token = ?').run(m[1]);
  return { ok: true };
});

route('GET', '/api/me', ({ user }) => ({ user, settings: publicSettings(getSettings(), user) }));

// --- uživatelé ---
route('GET', '/api/users', ({ user }) => { needAdmin(user); return db.prepare('SELECT id, name, role, active FROM users ORDER BY name').all(); });
route('POST', '/api/users', ({ user, body }) => {
  needAdmin(user);
  const name = str(body.name, 40);
  if (!name || !validPin(body.pin) || !['admin', 'cashier'].includes(body.role)) throw new ApiError('BAD_INPUT');
  db.prepare('INSERT INTO users (name, role, pin_hash) VALUES (?, ?, ?)').run(name, body.role, hashPin(body.pin));
  return { ok: true };
});
route('PUT', '/api/users/:id', ({ user, body, params }) => {
  needAdmin(user);
  const id = Number(params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) throw new ApiError('NOT_FOUND', 404);
  const role = ['admin', 'cashier'].includes(body.role) ? body.role : u.role;
  const active = body.active === undefined ? u.active : (body.active ? 1 : 0);
  if (u.role === 'admin' && (role !== 'admin' || !active)) {
    const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1").get().c;
    if (admins <= 1) throw new ApiError('LAST_ADMIN');
  }
  db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(str(body.name, 40) || u.name, role, active, id);
  if (body.pin) {
    if (!validPin(body.pin)) throw new ApiError('BAD_INPUT');
    db.prepare('UPDATE users SET pin_hash = ?, fails = 0, locked_until = 0 WHERE id = ?').run(hashPin(body.pin), id);
  }
  if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  return { ok: true };
});

// --- nastavení ---
route('PUT', '/api/settings', ({ user, body }) => {
  needAdmin(user);
  const s = getSettings();
  if (body.company) {
    const c = {};
    for (const k of Object.keys(s.company)) c[k] = str(body.company[k] ?? s.company[k], 200);
    setSetting('company', c);
  }
  if (body.vatPayer !== undefined) setSetting('vatPayer', !!body.vatPayer);
  if (Array.isArray(body.vatRates)) {
    const rates = [...new Set(body.vatRates.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 50))].sort((a, b) => b - a);
    if (!rates.length) throw new ApiError('BAD_INPUT');
    setSetting('vatRates', rates);
  }
  if (body.defaultVat !== undefined) setSetting('defaultVat', Number(body.defaultVat));
  if (body.roundCash !== undefined) setSetting('roundCash', !!body.roundCash);
  if (body.autoPrint !== undefined) setSetting('autoPrint', !!body.autoPrint);
  if (['80', '58', 'A4'].includes(body.paper)) setSetting('paper', body.paper);
  if (body.footer !== undefined) setSetting('footer', str(body.footer, 300));
  if (body.eet) {
    const e = { ...s.eet };
    if (body.eet.enabled !== undefined) e.enabled = !!body.eet.enabled;
    if (['playground', 'production'].includes(body.eet.env)) e.env = body.eet.env;
    if (body.eet.unitId !== undefined) {
      const u = str(body.eet.unitId, 9);
      if (u && !eet.RE.unit.test(u)) throw new ApiError('EET_BAD_UNIT');
      e.unitId = u;
    }
    if (body.eet.posId !== undefined) {
      const p = str(body.eet.posId, 20);
      if (!eet.RE.pos.test(p)) throw new ApiError('EET_BAD_POS');
      e.posId = p;
    }
    if (e.enabled && !(e.keyPem && e.certPem && e.unitId)) throw new ApiError('EET_NOT_CONFIGURED');
    setSetting('eet', e);
  }
  return publicSettings(getSettings(), user);
});

route('POST', '/api/settings/cert', ({ user, body }) => {
  needAdmin(user);
  const buf = Buffer.from(String(body.p12 || ''), 'base64');
  if (!buf.length) throw new ApiError('P12_INVALID');
  const c = eet.loadP12(buf, String(body.password || ''));
  if (!eet.RE.eic.test(c.eic)) throw new ApiError('P12_NO_EIC');
  const e = { ...getSettings().eet, keyPem: c.keyPem, certPem: c.certPem, eic: c.eic, validTo: c.validTo };
  setSetting('eet', e);
  return { eic: c.eic, validTo: c.validTo };
});

route('POST', '/api/eet/test', async ({ user }) => {
  needAdmin(user);
  const e = getSettings().eet;
  if (!e.keyPem || !e.unitId || !e.posId) throw new ApiError('EET_NOT_CONFIGURED');
  const r = await eet.send({ seq: 'TEST-' + Date.now(), saleTime: eet.pragueDateTime(), amount: 100, first: true, verify: true }, { ...e, timeoutMs: 15000 });
  return r;
});

// --- ARES ---
route('GET', '/api/ares/:ico', ({ params }) => ares(params.ico));

// --- zboží ---
route('GET', '/api/products', ({ query }) => {
  const q = str(query.get('q'), 60);
  const all = query.get('all') === '1';
  let sql = 'SELECT * FROM products WHERE active = 1';
  const args = [];
  if (q) { sql += ' AND (name LIKE ? OR barcode LIKE ?)'; args.push(`%${q}%`, `${q}%`); }
  if (query.get('fav') === '1') sql += ' AND favorite = 1';
  sql += ' ORDER BY favorite DESC, name COLLATE NOCASE LIMIT ' + (all ? 5000 : 200);
  return db.prepare(sql).all(...args).map(productRow);
});
route('GET', '/api/products/barcode/:code', ({ params }) => {
  const p = db.prepare('SELECT * FROM products WHERE barcode = ? AND active = 1').get(decodeURIComponent(params.code));
  if (!p) throw new ApiError('PRODUCT_NOT_FOUND', 404);
  return productRow(p);
});

function productInput(body, s, existing) {
  const name = str(body.name ?? existing?.name, 80);
  const price = body.price === undefined ? existing?.price : money(body.price);
  const vat = body.vatRate === undefined ? existing?.vat_rate ?? s.defaultVat : Number(body.vatRate);
  const barcode = body.barcode === undefined ? existing?.barcode : (str(body.barcode, 40) || null);
  if (!name || !Number.isInteger(price) || price < 0 || price > 9999999900) throw new ApiError('BAD_INPUT');
  if (!s.vatRates.includes(vat)) throw new ApiError('BAD_VAT');
  if (barcode) {
    const dup = db.prepare('SELECT id FROM products WHERE barcode = ? AND active = 1 AND id != ?').get(barcode, existing?.id ?? 0);
    if (dup) throw new ApiError('BARCODE_EXISTS');
  }
  return {
    name, price, vat, barcode,
    unit: str(body.unit ?? existing?.unit ?? 'ks', 10) || 'ks',
    purchase: body.purchasePrice === undefined ? existing?.purchase_price ?? 0 : Math.max(0, money(body.purchasePrice) || 0),
    favorite: body.favorite === undefined ? existing?.favorite ?? 0 : (body.favorite ? 1 : 0),
  };
}

route('POST', '/api/products', ({ user, body }) => {
  needAdmin(user);
  const p = productInput(body, getSettings());
  const t = nowIso();
  const stock = Number(body.stock) || 0;
  const id = tx(() => {
    const id = Number(db.prepare(`INSERT INTO products (barcode, name, price, vat_rate, unit, stock, purchase_price, favorite, created, updated)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(p.barcode, p.name, p.price, p.vat, p.unit, stock, p.purchase, p.favorite, t, t).lastInsertRowid);
    if (stock) db.prepare("INSERT INTO stock_moves (product_id, type, qty, purchase_price, note, user_name, created) VALUES (?, 'in', ?, ?, ?, ?, ?)")
      .run(id, stock, p.purchase, 'Počáteční stav', user.name, t);
    return id;
  });
  return productRow(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});
route('PUT', '/api/products/:id', ({ user, body, params }) => {
  needAdmin(user);
  const ex = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(Number(params.id));
  if (!ex) throw new ApiError('NOT_FOUND', 404);
  const p = productInput(body, getSettings(), ex);
  db.prepare('UPDATE products SET barcode=?, name=?, price=?, vat_rate=?, unit=?, purchase_price=?, favorite=?, updated=? WHERE id=?')
    .run(p.barcode, p.name, p.price, p.vat, p.unit, p.purchase, p.favorite, nowIso(), ex.id);
  return productRow(db.prepare('SELECT * FROM products WHERE id = ?').get(ex.id));
});
route('DELETE', '/api/products/:id', ({ user, params }) => {
  needAdmin(user);
  db.prepare('UPDATE products SET active = 0, updated = ? WHERE id = ?').run(nowIso(), Number(params.id));
  return { ok: true };
});

// --- příjem zboží / inventura ---
route('POST', '/api/stock', ({ user, body }) => {
  needAdmin(user);
  if (!Array.isArray(body.items) || !body.items.length) throw new ApiError('BAD_INPUT');
  const type = body.type === 'correction' ? 'correction' : 'in';
  const t = nowIso();
  const note = str(body.note, 120);
  tx(() => {
    for (const it of body.items) {
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(Number(it.productId));
      const qty = Number(it.qty);
      if (!p || !Number.isFinite(qty) || qty === 0) throw new ApiError('BAD_INPUT');
      const pp = it.purchasePrice === undefined || it.purchasePrice === null ? null : Math.max(0, money(it.purchasePrice) || 0);
      db.prepare('INSERT INTO stock_moves (product_id, type, qty, purchase_price, note, user_name, created) VALUES (?,?,?,?,?,?,?)')
        .run(p.id, type, qty, pp, note, user.name, t);
      db.prepare('UPDATE products SET stock = stock + ?, purchase_price = COALESCE(?, purchase_price), updated = ? WHERE id = ?').run(qty, pp, t, p.id);
      if (Number.isInteger(it.price) && it.price >= 0) db.prepare('UPDATE products SET price = ? WHERE id = ?').run(it.price, p.id);
    }
  });
  return { ok: true };
});
route('GET', '/api/stock/moves', ({ user, query }) => {
  needAdmin(user);
  return db.prepare(`SELECT m.*, p.name, p.unit FROM stock_moves m JOIN products p ON p.id = m.product_id
    WHERE m.type != 'sale' ${query.get('product') ? 'AND m.product_id = ' + Number(query.get('product')) : ''} ORDER BY m.id DESC LIMIT 200`).all();
});

// --- hromadný import ---
route('POST', '/api/import', ({ user, body }) => {
  needAdmin(user);
  const text = String(body.text || '');
  if (text.length > 1024 * 1024) throw new ApiError('TOO_LARGE', 413);
  const mode = body.mode === 'set' ? 'set' : 'add';
  return body.apply ? importer.apply(text, mode, user.name) : importer.plan(text, mode);
});

// --- doklady ---
route('POST', '/api/receipts', async ({ user, body }) => {
  const id = R.createSale(body, user);
  await R.sendToEet(id, { timeoutMs: 5000 });
  return R.getReceipt(id);
});
route('GET', '/api/receipts', ({ query }) => {
  const from = query.get('from') || eet.pragueDateTime().slice(0, 10);
  const to = query.get('to') || from;
  const q = str(query.get('q'), 40);
  let sql = 'SELECT id, number, type, ref_id, storno_by, sale_time, user_name, payment, paid_total, eet_status, eet_pok, eet_test, eet_error FROM receipts WHERE day BETWEEN ? AND ?';
  const args = [from, to];
  if (q) { sql += ' AND number LIKE ?'; args.push(`%${q}%`); }
  if (query.get('eet') === 'problem') { sql = sql.replace('day BETWEEN ? AND ?', "eet_status IN ('pending','error')"); args.splice(0, 2); }
  return db.prepare(sql + ' ORDER BY id DESC LIMIT 1000').all(...args);
});
route('GET', '/api/receipts/:id', ({ params }) => {
  const r = R.getReceipt(Number(params.id));
  if (!r) throw new ApiError('NOT_FOUND', 404);
  return r;
});
route('POST', '/api/receipts/:id/storno', async ({ user, params }) => {
  needAdmin(user);
  const id = R.createStorno(Number(params.id), user);
  await R.sendToEet(id, { timeoutMs: 5000 });
  return R.getReceipt(id);
});
route('POST', '/api/receipts/:id/eet', async ({ params }) => {
  const id = Number(params.id);
  const r = db.prepare('SELECT eet_status FROM receipts WHERE id = ?').get(id);
  if (!r) throw new ApiError('NOT_FOUND', 404);
  if (r.eet_status === 'none') {
    // Doklad vystavený s vypnutým EET -> dodatečně zaevidovat.
    const e = getSettings().eet;
    if (!e.keyPem || !e.unitId) throw new ApiError('EET_NOT_CONFIGURED');
    db.prepare("UPDATE receipts SET eet_status='pending', eet_eic=?, eet_unit=?, eet_pos=?, eet_env=? WHERE id=?").run(e.eic, String(e.unitId), e.posId, e.env, id);
  }
  await R.sendToEet(id, { timeoutMs: 15000 });
  return R.getReceipt(id);
});

// --- přehled / uzávěrka ---
route('GET', '/api/report', ({ query }) => {
  const from = query.get('from') || eet.pragueDateTime().slice(0, 10);
  const to = query.get('to') || from;
  const rows = db.prepare('SELECT * FROM receipts WHERE day BETWEEN ? AND ?').all(from, to);
  const sum = { count: 0, storno: 0, total: 0, cash: 0, card: 0, rounding: 0, vat: {}, eetOk: 0, eetPending: 0, eetError: 0, eetNone: 0 };
  for (const r of rows) {
    if (r.type === 'sale') sum.count++; else sum.storno++;
    sum.total += r.paid_total; sum[r.payment] += r.paid_total; sum.rounding += r.rounding;
    for (const v of JSON.parse(r.vat)) {
      const g = (sum.vat[v.rate] ||= { rate: v.rate, base: 0, vat: 0, gross: 0 });
      g.base += v.base; g.vat += v.vat; g.gross += v.gross;
    }
    sum[{ ok: 'eetOk', pending: 'eetPending', error: 'eetError', none: 'eetNone' }[r.eet_status]]++;
  }
  sum.vat = Object.values(sum.vat).sort((a, b) => b.rate - a.rate);
  sum.top = db.prepare(`SELECT i.name, SUM(i.qty) qty, SUM(i.total) total FROM receipt_items i JOIN receipts r ON r.id = i.receipt_id
    WHERE r.day BETWEEN ? AND ? GROUP BY COALESCE(i.product_id, i.name) ORDER BY total DESC LIMIT 15`).all(from, to);
  sum.byUser = db.prepare('SELECT user_name, COUNT(*) n, SUM(paid_total) total FROM receipts WHERE day BETWEEN ? AND ? GROUP BY user_name').all(from, to);
  return { from, to, ...sum };
});

route('GET', '/api/export', ({ user, query }) => {
  needAdmin(user);
  const from = query.get('from'), to = query.get('to') || from;
  const rows = db.prepare('SELECT * FROM receipts WHERE day BETWEEN ? AND ? ORDER BY id').all(from, to);
  const head = 'cislo;typ;datum_cas;pokladni;platba;celkem;zaokrouhleni;eet_stav;pok\n';
  const csv = head + rows.map((r) => [r.number, r.type, r.sale_time, r.user_name, r.payment, (r.paid_total / 100).toFixed(2).replace('.', ','),
    (r.rounding / 100).toFixed(2).replace('.', ','), r.eet_status, r.eet_pok || ''].join(';')).join('\n');
  return { __raw: '﻿' + csv, type: 'text/csv; charset=utf-8', file: `doklady_${from}_${to}.csv` };
});

// ---------- statické soubory ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      const user = auth(req);
      if (!r.public && !user) throw new ApiError('UNAUTHORIZED', 401);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const out = await r.handler({ req, user, body, params, query: url.searchParams });
      if (out && out.__raw) return send(res, 200, out.__raw, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.file}"` });
      return send(res, 200, out ?? { ok: true });
    }
    throw new ApiError('NOT_FOUND', 404);
  } catch (e) {
    if (e instanceof ApiError) return send(res, e.status, { error: e.code, detail: e.detail });
    if (/^(EET_|P12_)/.test(e.message)) return send(res, 400, { error: e.message, detail: e.detail });
    if (String(e.message).includes('UNIQUE')) return send(res, 400, { error: 'DUPLICATE' });
    console.error(e);
    return send(res, 500, { error: 'SERVER_ERROR' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Pokladna běží na http://localhost:${PORT}`));
  // Opakované odesílání neodeslaných tržeb do EET (každou minutu).
  setInterval(() => R.retryPending().catch((e) => console.error('EET retry', e)), 60e3).unref();
  setInterval(() => db.prepare('DELETE FROM sessions WHERE created < ?').run(Date.now() - SESSION_DAYS * 864e5), 3600e3).unref();
}
module.exports = { server, ares };

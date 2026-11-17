/* Pokladna – frontend (vanilla JS, bez závislostí) */
(() => {
  'use strict';
  const { kc, esc } = window.Receipt;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ---------- stav ----------
  const S = {
    token: localStorage.getItem('pk_token'),
    lang: localStorage.getItem('pk_lang') || 'vi',
    user: null, settings: null, view: 'sale',
    cart: JSON.parse(localStorage.getItem('pk_cart') || '[]'),
    customer: JSON.parse(localStorage.getItem('pk_customer') || 'null'),
    products: [], byBarcode: new Map(),
    tab: 'fav', tileQuery: '', nextQty: null,
    stockLines: [], eetProblems: 0, offline: false,
  };
  const saveCart = () => { localStorage.setItem('pk_cart', JSON.stringify(S.cart)); localStorage.setItem('pk_customer', JSON.stringify(S.customer)); };

  // ---------- i18n ----------
  const t = (k) => (I18N[S.lang] && I18N[S.lang][k]) ?? I18N.cs[k] ?? k;
  const terr = (code) => (I18N[S.lang].err[code] || I18N.cs.err[code] || code);
  const setLang = (l) => { S.lang = l; localStorage.setItem('pk_lang', l); document.documentElement.lang = l === 'vi' ? 'vi' : 'cs'; render(); };

  // ---------- peníze ----------
  const fmt = (h) => kc(h) + ' Kč';
  /** "25", "25,90", "25.9" -> haléře */
  const parseMoney = (v) => {
    const s = String(v ?? '').replace(/\s/g, '').replace(',', '.');
    if (!/^-?\d+(\.\d{0,2})?$/.test(s)) return NaN;
    return Math.round(parseFloat(s) * 100);
  };
  const parseQty = (v) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : NaN; };
  const moneyIn = (h) => (h == null || isNaN(h) ? '' : (h / 100).toFixed(2).replace('.', ',').replace(/,00$/, ''));
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(new Date());
  const shiftDay = (d, n) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

  // ---------- API ----------
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch(path, {
        method, headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      setOffline(true);
      throw Object.assign(new Error('NETWORK'), { code: 'NETWORK' });
    }
    setOffline(false);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/login') { logoutLocal(); throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }); }
    if (!res.ok) throw Object.assign(new Error(data.error || 'SERVER_ERROR'), { code: data.error || 'SERVER_ERROR', detail: data.detail });
    return data;
  }
  function setOffline(v) { if (S.offline !== v) { S.offline = v; const el = $('#offline'); if (el) el.hidden = !v; } }

  // ---------- UI pomocníci ----------
  function toast(msg, type = '') {
    const d = document.createElement('div');
    d.className = type; d.textContent = msg;
    $('#toast').appendChild(d);
    setTimeout(() => d.remove(), type === 'err' ? 4500 : 2500);
  }
  const showErr = (e) => toast(terr(e.code || e.message), 'err');
  function beep(ok = true) {
    try {
      const ctx = beep.ctx || (beep.ctx = new (window.AudioContext || window.webkitAudioContext)());
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = ok ? 1250 : 300; o.type = ok ? 'sine' : 'square';
      g.gain.value = 0.08; o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + (ok ? 0.08 : 0.3));
    } catch { /* bez zvuku */ }
  }

  let modalStack = [];
  function modal(html, { wide = false, onClose } = {}) {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    $('#modal-root').appendChild(bg);
    const close = () => {
      bg.remove();
      modalStack = modalStack.filter((m) => m.close !== close);
      onClose && onClose();
      if (!modalStack.length) focusScan();
    };
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
    $$('[data-close]', bg).forEach((b) => b.addEventListener('click', close));
    modalStack.push({ close, el: bg });
    setTimeout(() => { const f = $('[autofocus]', bg); f && f.focus(); f && f.select && f.select(); }, 30);
    return { el: bg, close };
  }
  const head = (title) => `<h2><span>${title}</span><button class="close" data-close aria-label="close">×</button></h2>`;
  function confirmBox(text, okLabel = t('yes'), danger = false) {
    return new Promise((resolve) => {
      let answered = false;
      const m = modal(`${head(t('confirm'))}<p style="font-size:1.1rem">${esc(text)}</p>
        <div class="row end"><button class="btn big" data-close>${t('no')}</button><button class="btn big ${danger ? 'danger solid' : 'primary'}" id="ok">${esc(okLabel)}</button></div>`,
        { onClose: () => !answered && resolve(false) });
      $('#ok', m.el).onclick = () => { answered = true; m.close(); resolve(true); };
      $('#ok', m.el).focus();
    });
  }
  const isAdmin = () => S.user && S.user.role === 'admin';

  // ---------- přihlášení ----------
  function logoutLocal() {
    S.token = null; S.user = null; localStorage.removeItem('pk_token');
    modalStack.forEach((m) => m.el.remove()); modalStack = [];
    renderLogin();
  }
  async function boot() {
    document.documentElement.lang = S.lang === 'vi' ? 'vi' : 'cs';
    if (S.token) {
      try {
        const me = await api('GET', '/api/me');
        S.user = me.user; S.settings = me.settings;
        await loadProducts();
        return render();
      } catch { /* odhlášen */ }
    }
    renderLogin();
  }

  async function renderLogin() {
    let st;
    try { st = await api('GET', '/api/state'); } catch (e) {
      $('#app').innerHTML = `<div class="login"><div class="box"><h1>Pokladna</h1><div class="alert err">${t('offline')}</div><button class="btn block" onclick="location.reload()">↻</button></div></div>`;
      return;
    }
    const langSw = `<div class="lang-switch"><button data-lang="vi" class="${S.lang === 'vi' ? 'on' : ''}">🇻🇳 Tiếng Việt</button><button data-lang="cs" class="${S.lang === 'cs' ? 'on' : ''}">🇨🇿 Čeština</button></div>`;
    const bindLang = () => $$('[data-lang]').forEach((b) => (b.onclick = () => { S.lang = b.dataset.lang; localStorage.setItem('pk_lang', S.lang); renderLogin(); }));
    if (st.setupNeeded) {
      $('#app').innerHTML = `<div class="login"><div class="box"><h1>🧾 ${t('setupTitle')}</h1><p class="muted">${t('setupText')}</p>
        <form id="setup"><label class="f"><span>${t('name')}</span><input class="inp" name="name" required maxlength="40" autofocus></label>
        <label class="f"><span>${t('pin')}</span><input class="inp" name="pin" type="password" inputmode="numeric" pattern="\\d{4,8}" required></label>
        <button class="btn primary big block">${t('create')}</button></form>${langSw}</div></div>`;
      bindLang();
      $('#setup').onsubmit = async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        try { await api('POST', '/api/setup', { name: f.get('name'), pin: f.get('pin') }); renderLogin(); } catch (err) { showErr(err); }
      };
      return;
    }
    $('#app').innerHTML = `<div class="login"><div class="box"><h1>🧾 ${esc(st.shopName || 'Pokladna')}</h1>
      <p class="muted" style="text-align:center">${t('chooseUser')}</p>
      <div class="users">${st.users.map((u) => `<button data-u="${u.id}"><span class="av">${esc(u.name[0].toUpperCase())}</span>${esc(u.name)}</button>`).join('')}</div>
      ${langSw}</div></div>`;
    bindLang();
    $$('[data-u]').forEach((b) => (b.onclick = () => pinScreen(st.users.find((u) => u.id === +b.dataset.u))));
  }

  function pinScreen(u) {
    let pin = '';
    const box = $('.login .box');
    box.innerHTML = `<h1>${esc(u.name)}</h1><p class="muted" style="text-align:center">${t('enterPin')}</p>
      <div class="pin-dots">${'<i></i>'.repeat(4)}</div>
      <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-n="${n}">${n}</button>`).join('')}
      <button data-n="back">⌫</button><button data-n="0">0</button><button data-n="ok" style="background:var(--brand);color:#fff">OK</button></div>
      <button class="btn block" style="margin-top:.8rem" id="backu">← ${t('chooseUser')}</button>`;
    const dots = () => { const n = Math.max(4, pin.length); $('.pin-dots').innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join(''); };
    const submit = async () => {
      if (pin.length < 4) return;
      try {
        const r = await api('POST', '/api/login', { userId: u.id, pin });
        S.token = r.token; localStorage.setItem('pk_token', r.token);
        document.removeEventListener('keydown', onKey);
        boot();
      } catch (e) { showErr(e); pin = ''; dots(); beep(false); }
    };
    const press = (n) => {
      if (n === 'back') pin = pin.slice(0, -1);
      else if (n === 'ok') return submit();
      else if (pin.length < 8) pin += n;
      dots();
    };
    const onKey = (e) => {
      if (!$('.pinpad')) return document.removeEventListener('keydown', onKey);
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Enter') press('ok');
    };
    document.addEventListener('keydown', onKey);
    $$('[data-n]').forEach((b) => (b.onclick = () => press(b.dataset.n)));
    $('#backu').onclick = () => { document.removeEventListener('keydown', onKey); renderLogin(); };
  }

  // ---------- data ----------
  async function loadProducts() {
    S.products = await api('GET', '/api/products?all=1');
    S.byBarcode = new Map(S.products.filter((p) => p.barcode).map((p) => [p.barcode, p]));
  }
  async function refreshEetProblems() {
    try {
      const rows = await api('GET', '/api/receipts?eet=problem');
      S.eetProblems = rows.length;
      const b = $('#eetbadge');
      if (b) { b.hidden = !rows.length; b.textContent = `⚠ ${t('eetProblems')}: ${rows.length}`; }
    } catch { /* ignore */ }
  }

  // ---------- kostra ----------
  const VIEWS = [
    ['sale', '🛒', () => true], ['receipts', '🧾', () => true], ['products', '📦', isAdmin],
    ['stockIn', '📥', isAdmin], ['report', '📊', () => true], ['settings', '⚙️', isAdmin],
  ];
  function render() {
    if (!S.user) return renderLogin();
    if (!VIEWS.find((v) => v[0] === S.view && v[2]())) S.view = 'sale';
    $('#app').innerHTML = `<div class="shell">
      <div class="topbar">
        <div class="logo">🧾 <span>${esc(S.settings.company.name || 'Pokladna')}</span></div>
        <nav>${VIEWS.filter((v) => v[2]()).map(([k, ic]) => `<button data-view="${k}" class="${S.view === k ? 'on' : ''}">${ic} ${t(k)}</button>`).join('')}</nav>
        <div class="right">
          <button class="badge-alert" id="eetbadge" hidden></button>
          ${S.settings.eet.enabled && S.settings.eet.env !== 'production' ? '<span class="tag test" title="EET playground">EET TEST</span>' : ''}
          <button class="pill-btn" id="lang">${S.lang === 'vi' ? '🇻🇳 VI' : '🇨🇿 CZ'}</button>
          <span class="user">👤 ${esc(S.user.name)}</span>
          <button class="pill-btn" id="logout">${t('logout')}</button>
        </div>
      </div>
      <div class="offline" id="offline" ${S.offline ? '' : 'hidden'}>${t('offline')}</div>
      <main id="main"></main>
    </div>`;
    $$('[data-view]').forEach((b) => (b.onclick = () => { S.view = b.dataset.view; render(); }));
    $('#lang').onclick = () => setLang(S.lang === 'vi' ? 'cs' : 'vi');
    $('#logout').onclick = async () => { try { await api('POST', '/api/logout'); } catch { /* */ } logoutLocal(); };
    $('#eetbadge').onclick = () => { S.view = 'receipts'; S.receiptFilter = 'problem'; render(); };
    ({ sale: viewSale, receipts: viewReceipts, products: viewProducts, stockIn: viewStockIn, report: viewReport, settings: viewSettings })[S.view]();
    refreshEetProblems();
  }

  // ======================================================================
  // PRODEJ
  // ======================================================================
  function cartTotal() { return S.cart.reduce((a, l) => a + Math.round(l.qty * l.unitPrice), 0); }
  function toPay(method) {
    const tot = cartTotal();
    return method === 'cash' && S.settings.roundCash ? Math.round(tot / 100) * 100 : tot;
  }

  function addToCart(p, qty = 1) {
    if (S.nextQty) { qty = S.nextQty; S.nextQty = null; }
    const ex = S.cart.find((l) => l.productId === p.id && l.unitPrice === p.price);
    if (ex) { ex.qty = Math.round((ex.qty + qty) * 1000) / 1000; S.lastLine = S.cart.indexOf(ex); }
    else { S.cart.push({ productId: p.id, name: p.name, unitPrice: p.price, vatRate: p.vat_rate, unit: p.unit, qty, barcode: p.barcode }); S.lastLine = S.cart.length - 1; }
    saveCart(); beep(true); drawCart();
  }

  async function handleScan(raw) {
    let code = raw.trim();
    if (!code) return;
    const m = /^(\d+(?:[.,]\d+)?)\s*[*xX×]\s*(.*)$/.exec(code);
    if (m) {
      S.nextQty = parseQty(m[1]);
      code = m[2].trim();
      if (!code) { drawScanHint(); return; }
    }
    let p = S.byBarcode.get(code);
    if (!p && /^\d{3,}$/.test(code)) {
      try { p = await api('GET', '/api/products/barcode/' + encodeURIComponent(code)); } catch { p = null; }
    }
    if (p) return addToCart(p);
    // Textové hledání: přesně 1 výsledek -> přidat
    const found = searchLocal(code);
    if (found.length === 1 && !/^\d+$/.test(code)) return addToCart(found[0]);
    beep(false);
    unknownCode(code);
  }
  function searchLocal(q) {
    const n = norm(q);
    if (!n) return [];
    return S.products.filter((p) => norm(p.name).includes(n) || (p.barcode && p.barcode.startsWith(q))).slice(0, 30);
  }
  const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

  function unknownCode(code) {
    const m = modal(`${head('⚠ ' + t('notFound'))}<p>${t('notFoundText')}</p><p class="mono" style="font-size:1.4rem;text-align:center">${esc(code)}</p>
      <div class="row" style="flex-direction:column;align-items:stretch">
        ${isAdmin() ? `<button class="btn primary big" id="asnew">➕ ${t('addAsNew')}</button>` : ''}
        <button class="btn big" id="manual">✏️ ${t('sellManual')}</button>
        <button class="btn" data-close>${t('cancel')}</button></div>`);
    if ($('#asnew', m.el)) $('#asnew', m.el).onclick = () => { m.close(); productForm(/^\d+$/.test(code) ? { barcode: code } : { name: code }, (p) => addToCart(p)); };
    $('#manual', m.el).onclick = () => { m.close(); manualItem(/^\d+$/.test(code) ? '' : code); };
  }

  function manualItem(name = '') {
    const rates = S.settings.vatRates;
    const m = modal(`${head(t('manualTitle'))}<form id="mf">
      <label class="f"><span>${t('productName')}</span><input class="inp" name="name" required maxlength="80" value="${esc(name)}" ${name ? '' : 'autofocus'}></label>
      <div class="grid2"><label class="f"><span>${t('priceVat')} (Kč)</span><input class="inp" name="price" inputmode="decimal" required ${name ? 'autofocus' : ''}></label>
      <label class="f"><span>${t('qty')}</span><input class="inp" name="qty" inputmode="decimal" value="1" required></label></div>
      ${S.settings.vatPayer ? `<label class="f"><span>${t('vat')}</span><select class="inp" name="vat">${rates.map((r) => `<option value="${r}" ${r === S.settings.defaultVat ? 'selected' : ''}>${r} %</option>`).join('')}</select></label>` : ''}
      <div class="row end"><button type="button" class="btn" data-close>${t('cancel')}</button><button class="btn primary big">${t('add')}</button></div></form>`);
    $('#mf', m.el).onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const price = parseMoney(f.get('price')), qty = parseQty(f.get('qty'));
      if (isNaN(price) || price < 0 || isNaN(qty)) return toast(terr('BAD_INPUT'), 'err');
      S.cart.push({ productId: null, name: f.get('name').trim(), unitPrice: price, vatRate: S.settings.vatPayer ? +f.get('vat') : (S.settings.vatRates.includes(0) ? 0 : S.settings.defaultVat), unit: 'ks', qty });
      S.lastLine = S.cart.length - 1;
      saveCart(); m.close(); drawCart();
    };
  }

  function viewSale() {
    $('#main').innerHTML = `<div class="pos">
      <section class="pos-left">
        <div class="scanbar"><span class="ico">▦</span>
          <input id="scan" class="inp" placeholder="${t('scanHere')}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go">
          <div id="suggest"></div><div class="small muted" id="scanhint" style="margin-top:.3rem">${t('scanHint')}</div></div>
        <div id="custbadge"></div>
        <div class="cart" id="cart"></div>
        <div class="totalbar">
          <div class="amount"><span class="muted" id="cnt"></span><b id="total"></b></div>
          <div class="paybtns"><button class="btn cash" id="paycash">💵 ${t('cash')} <small>F2</small></button><button class="btn card" id="paycard">💳 ${t('card')} <small>F4</small></button></div>
          <div class="subbtns">
            <button class="btn" id="cust">🏢 ${t('customer')}</button>
            <button class="btn" id="manual">✏️ ${t('manualItem')}</button>
            <button class="btn danger" id="clear">🗑 ${t('clearCart')}</button>
          </div>
        </div>
      </section>
      <section class="pos-right">
        <div class="tabs"><button data-tab="fav" class="${S.tab === 'fav' ? 'on' : ''}">⭐ ${t('favorites')}</button><button data-tab="all" class="${S.tab === 'all' ? 'on' : ''}">📦 ${t('allProducts')}</button></div>
        <div class="tilesearch"><input class="inp" id="tq" placeholder="🔍 ${t('search')} (F8)" value="${esc(S.tileQuery)}"></div>
        <div class="tiles" id="tiles"></div>
      </section></div>`;
    const scan = $('#scan');
    let sel = -1;
    scan.addEventListener('keydown', (e) => {
      const items = $$('#suggest button');
      if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); items.forEach((b, i) => b.classList.toggle('sel', i === sel)); }
      else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); sel = Math.max(sel - 1, 0); items.forEach((b, i) => b.classList.toggle('sel', i === sel)); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (sel >= 0 && items[sel]) { items[sel].click(); return; }
        const v = scan.value; scan.value = ''; $('#suggest').innerHTML = ''; sel = -1;
        handleScan(v);
      } else if (e.key === 'Escape') { scan.value = ''; $('#suggest').innerHTML = ''; sel = -1; }
    });
    scan.addEventListener('input', () => {
      sel = -1;
      const v = scan.value.trim().replace(/^\d+(?:[.,]\d+)?\s*[*xX×]\s*/, '');
      if (v.length < 2 || /^\d+$/.test(v)) { $('#suggest').innerHTML = ''; return; }
      const res = searchLocal(v).slice(0, 8);
      $('#suggest').innerHTML = res.length ? `<div class="suggest">${res.map((p) => `<button data-p="${p.id}"><span>${esc(p.name)}</span><b>${fmt(p.price)}</b></button>`).join('')}</div>` : '';
      $$('#suggest button').forEach((b) => (b.onclick = () => {
        const m = /^(\d+(?:[.,]\d+)?)\s*[*xX×]/.exec(scan.value);
        if (m) S.nextQty = parseQty(m[1]);
        scan.value = ''; $('#suggest').innerHTML = '';
        addToCart(S.products.find((p) => p.id === +b.dataset.p)); focusScan();
      }));
    });
    $('#paycash').onclick = () => payDialog('cash');
    $('#paycard').onclick = () => payDialog('card');
    $('#manual').onclick = () => manualItem();
    $('#cust').onclick = customerDialog;
    $('#clear').onclick = async () => { if (S.cart.length && await confirmBox(t('confirmClear'), t('clearCart'), true)) { S.cart = []; S.customer = null; saveCart(); drawCart(); } };
    $$('[data-tab]').forEach((b) => (b.onclick = () => { S.tab = b.dataset.tab; $$('[data-tab]').forEach((x) => x.classList.toggle('on', x === b)); drawTiles(); }));
    $('#tq').oninput = (e) => { S.tileQuery = e.target.value; drawTiles(); };
    drawCart(); drawTiles(); focusScan();
  }
  function drawScanHint() {
    const h = $('#scanhint');
    if (h) h.innerHTML = S.nextQty ? `<b style="color:var(--brand-d)">× ${S.nextQty} — ${t('scanHere')}</b>` : t('scanHint');
  }
  function focusScan() { const s = $('#scan'); if (s && !modalStack.length) s.focus({ preventScroll: true }); }

  function drawTiles() {
    const el = $('#tiles');
    if (!el) return;
    let list = S.tileQuery ? searchLocal(S.tileQuery) : S.products;
    if (S.tab === 'fav' && !S.tileQuery) list = list.filter((p) => p.favorite);
    list = list.slice(0, 120);
    el.innerHTML = list.length ? list.map((p) => `<button class="tile" data-p="${p.id}"><span class="tn">${esc(p.name)}</span><span class="tp">${fmt(p.price)}${p.unit !== 'ks' ? ' / ' + esc(p.unit) : ''}</span></button>`).join('')
      : `<div class="muted" style="grid-column:1/-1;padding:1rem;text-align:center">${t('noResults')}</div>`;
    $$('.tile', el).forEach((b) => (b.onclick = () => { addToCart(S.products.find((p) => p.id === +b.dataset.p)); focusScan(); }));
  }

  function drawCart() {
    const el = $('#cart');
    if (!el) return;
    drawScanHint();
    $('#custbadge').innerHTML = S.customer ? `<div class="custbadge"><span>🏢 ${esc(S.customer.name)} · IČO ${esc(S.customer.ico)}</span><button class="x" id="rmcust" title="${t('removeCustomer')}">×</button></div>` : '';
    if ($('#rmcust')) $('#rmcust').onclick = () => { S.customer = null; saveCart(); drawCart(); };
    if (!S.cart.length) {
      el.innerHTML = `<div class="cart-empty"><span class="big-ico">▦</span>${t('cartEmpty')}</div>`;
    } else {
      el.innerHTML = S.cart.map((l, i) => `<div class="line ${i === S.lastLine ? 'flash' : ''}" data-i="${i}">
        <div><div class="nm">${esc(l.name)}</div><div class="sub">${fmt(l.unitPrice)} / ${esc(l.unit)}${S.settings.vatPayer ? ` · DPH ${l.vatRate} %` : ''}${l.productId == null ? ' · ✏️' : ''}</div></div>
        <div class="qty"><button data-act="minus">−</button><span data-act="qty">${String(l.qty).replace('.', ',')}</span><button data-act="plus">+</button></div>
        <div class="sum">${fmt(Math.round(l.qty * l.unitPrice))}</div>
        <button class="x" data-act="del" aria-label="${t('delete')}">✕</button></div>`).join('');
      if (S.lastLine != null) { const ln = $(`.line[data-i="${S.lastLine}"]`, el); ln && ln.scrollIntoView({ block: 'nearest' }); }
      S.lastLine = null;
      $$('.line', el).forEach((row) => {
        const i = +row.dataset.i;
        row.onclick = (e) => {
          const act = e.target.dataset.act;
          const l = S.cart[i];
          if (act === 'plus') l.qty = Math.round((l.qty + 1) * 1000) / 1000;
          else if (act === 'minus') { l.qty = Math.round((l.qty - 1) * 1000) / 1000; if (l.qty <= 0) S.cart.splice(i, 1); }
          else if (act === 'del') S.cart.splice(i, 1);
          else if (act === 'qty' || (e.target.closest('.nm') && isAdmin())) return lineEdit(i);
          else return;
          saveCart(); drawCart(); focusScan();
        };
      });
    }
    const n = S.cart.length;
    $('#cnt').textContent = `${n} ${t('items')}`;
    $('#total').textContent = fmt(cartTotal());
    $('#paycash').disabled = $('#paycard').disabled = !n;
  }

  function lineEdit(i) {
    const l = S.cart[i];
    const canPrice = isAdmin() || l.productId == null;
    const m = modal(`${head(esc(l.name))}<form id="lf">
      <label class="f"><span>${t('qty')} (${esc(l.unit)})</span><input class="inp" name="qty" inputmode="decimal" value="${String(l.qty).replace('.', ',')}" autofocus style="font-size:1.4rem"></label>
      ${canPrice ? `<label class="f"><span>${t('changePrice')} (Kč)</span><input class="inp" name="price" inputmode="decimal" value="${moneyIn(l.unitPrice)}"></label>` : ''}
      <div class="row end"><button type="button" class="btn danger" id="del">${t('delete')}</button><span class="spacer"></span><button type="button" class="btn" data-close>${t('cancel')}</button><button class="btn primary big">${t('save')}</button></div></form>`);
    $('#del', m.el).onclick = () => { S.cart.splice(i, 1); saveCart(); m.close(); drawCart(); };
    $('#lf', m.el).onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const q = parseQty(f.get('qty'));
      if (isNaN(q)) return toast(terr('BAD_QTY'), 'err');
      l.qty = q;
      if (canPrice) { const p = parseMoney(f.get('price')); if (isNaN(p) || p < 0) return toast(terr('BAD_INPUT'), 'err'); l.unitPrice = p; }
      saveCart(); m.close(); drawCart();
    };
  }

  // --- odběratel přes ARES ---
  function customerDialog() {
    const c = S.customer || {};
    const m = modal(`${head('🏢 ' + t('customerTitle'))}<form id="cf">
      <div class="row" style="align-items:flex-end"><label class="f" style="flex:1"><span>${t('ico')}</span><input class="inp" name="ico" inputmode="numeric" maxlength="8" value="${esc(c.ico || '')}" autofocus></label>
      <button type="button" class="btn primary" id="ares" style="margin-bottom:.75rem">🔎 ${t('loadAres')}</button></div>
      <p class="small muted">${t('icoHint')}</p>
      <label class="f"><span>${t('name')}</span><input class="inp" name="name" value="${esc(c.name || '')}" required></label>
      <div class="grid2"><label class="f"><span>${t('dic')}</span><input class="inp" name="dic" value="${esc(c.dic || '')}"></label>
      <label class="f"><span>${t('street')}</span><input class="inp" name="street" value="${esc(c.street || '')}"></label>
      <label class="f"><span>${t('city')}</span><input class="inp" name="city" value="${esc(c.city || '')}"></label>
      <label class="f"><span>${t('zip')}</span><input class="inp" name="zip" value="${esc(c.zip || '')}"></label></div>
      <div class="row end">${S.customer ? `<button type="button" class="btn danger" id="rm">${t('removeCustomer')}</button><span class="spacer"></span>` : ''}
      <button type="button" class="btn" data-close>${t('cancel')}</button><button class="btn primary big">${t('save')}</button></div></form>`);
    const form = $('#cf', m.el);
    const doAres = async () => {
      try {
        const a = await api('GET', '/api/ares/' + form.ico.value.trim());
        for (const k of ['name', 'dic', 'street', 'city', 'zip']) form[k].value = a[k] || '';
        toast(t('aresOk'), 'ok');
      } catch (e) { showErr(e); }
    };
    $('#ares', m.el).onclick = doAres;
    form.ico.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAres(); } });
    if ($('#rm', m.el)) $('#rm', m.el).onclick = () => { S.customer = null; saveCart(); m.close(); drawCart(); };
    form.onsubmit = (e) => {
      e.preventDefault();
      S.customer = Object.fromEntries(['ico', 'name', 'dic', 'street', 'city', 'zip'].map((k) => [k, form[k].value.trim()]));
      saveCart(); m.close(); drawCart();
    };
  }

  // --- platba ---
  function payDialog(method) {
    if (!S.cart.length || modalStack.length) return;
    const due = toPay(method);
    const quick = [...new Set([due, ...[100, 200, 500, 1000, 2000, 5000].map((b) => b * 100).filter((v) => v > due).slice(0, 3)])];
    const m = modal(method === 'cash'
      ? `${head('💵 ' + t('cash'))}<div class="muted" style="text-align:center">${t('toPay')}</div><div class="paybig">${fmt(due)}</div>
        ${due !== cartTotal() ? `<div class="small muted" style="text-align:center;margin-top:-.6rem">${t('rounding')}: ${fmt(due - cartTotal())}</div>` : ''}
        <label class="f"><span>${t('received')} (Kč)</span><input class="inp" id="recv" inputmode="decimal" autofocus style="font-size:1.6rem;text-align:center" placeholder="${moneyIn(due)}"></label>
        <div class="quick">${quick.map((v, i) => `<button class="btn" data-q="${v}">${i === 0 ? t('exact') : kc(v).replace(',00', '')}</button>`).join('')}</div>
        <div class="change" id="chg">${t('change')}<b>0,00 Kč</b></div>
        <div class="row end"><button class="btn big" data-close>${t('cancel')}</button><button class="btn primary big" id="dopay" style="flex:1">✔ ${t('pay')} (Enter)</button></div>`
      : `${head('💳 ' + t('card'))}<div class="muted" style="text-align:center">${t('toPay')}</div><div class="paybig">${fmt(due)}</div>
        <div class="alert info">${S.lang === 'vi' ? 'Cho khách quẹt thẻ trên máy thanh toán, khi máy báo thành công thì bấm Xác nhận.' : 'Proveďte platbu na platebním terminálu a po úspěšné platbě potvrďte.'}</div>
        <div class="row end"><button class="btn big" data-close>${t('cancel')}</button><button class="btn primary big" id="dopay" style="flex:1" autofocus>✔ ${t('confirm')} (Enter)</button></div>`);
    const recv = $('#recv', m.el);
    const upd = () => {
      if (!recv) return;
      const r = recv.value.trim() === '' ? due : parseMoney(recv.value);
      const ch = $('#chg', m.el);
      const diff = isNaN(r) ? NaN : r - due;
      ch.className = 'change' + (diff < 0 || isNaN(diff) ? ' neg' : '');
      ch.innerHTML = `${t('change')}<b>${isNaN(diff) ? '—' : fmt(diff)}</b>`;
      $('#dopay', m.el).disabled = isNaN(diff) || diff < 0;
    };
    if (recv) {
      recv.oninput = upd;
      recv.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#dopay', m.el).click(); } });
      $$('[data-q]', m.el).forEach((b) => (b.onclick = () => { recv.value = moneyIn(+b.dataset.q); upd(); recv.focus(); }));
      upd();
    }
    let busy = false;
    $('#dopay', m.el).onclick = async () => {
      if (busy) return;
      busy = true; $('#dopay', m.el).disabled = true; $('#dopay', m.el).textContent = '⏳ ' + t('loading');
      try {
        const received = recv ? (recv.value.trim() === '' ? due : parseMoney(recv.value)) : null;
        const r = await api('POST', '/api/receipts', {
          payment: method, received,
          items: S.cart.map((l) => (l.productId ? { productId: l.productId, qty: l.qty, unitPrice: l.unitPrice } : { name: l.name, qty: l.qty, unitPrice: l.unitPrice, vatRate: l.vatRate })),
          customer: S.customer,
        });
        S.cart = []; S.customer = null; saveCart();
        m.close();
        drawCart();
        saleDone(r);
        loadProducts().then(drawTiles).catch(() => {});
      } catch (e) { showErr(e); busy = false; $('#dopay', m.el).disabled = false; $('#dopay', m.el).textContent = '✔ ' + t('pay'); }
    };
  }

  function saleDone(r) {
    const change = r.payment === 'cash' && r.received != null ? r.received - r.paid_total : null;
    const paper = S.settings.paper;
    const m = modal(`<div class="success"><div class="ok-ico">✔</div><h2 style="justify-content:center">${t('printed')} · ${esc(r.number)}</h2>
      ${change ? `<div class="change">${t('change')}<b>${fmt(change)}</b></div>` : ''}
      ${eetInfo(r)}
      <div class="row" style="justify-content:center;margin-top:1rem">
        <button class="btn big" id="pr">🖨 ${t('print')}</button>
        ${paper !== 'A4' ? `<button class="btn big" id="pra4">📄 A4</button>` : ''}
        <button class="btn primary big" data-close id="next" autofocus>${t('newSale')} (Enter)</button></div></div>`);
    $('#pr', m.el).onclick = () => Receipt.print(r, paper);
    if ($('#pra4', m.el)) $('#pra4', m.el).onclick = () => Receipt.print(r, 'A4');
    if (S.settings.autoPrint) Receipt.print(r, Receipt.isFull(r) && paper !== 'A4' ? paper : paper);
    $('#next', m.el).focus();
  }
  function eetInfo(r) {
    if (r.eet_status === 'ok') return `<div class="alert ok">EET ✓ POK: <span class="mono">${esc(r.eet_pok)}</span>${r.eet_test ? ` <span class="tag test">${t('testTag')}</span>` : ''}</div>`;
    if (r.eet_status === 'pending') return `<div class="alert warn">⏳ ${t('eetPendingText')}<div class="small">${esc(r.eet_error || '')}</div></div>`;
    if (r.eet_status === 'error') return `<div class="alert err">✖ ${t('eet_error')}: ${esc(r.eet_error || '')}</div>`;
    return '';
  }

  // ======================================================================
  // DOKLADY
  // ======================================================================
  function viewReceipts() {
    const f = S.rf || (S.rf = { from: today(), to: today(), q: '' });
    const problem = S.receiptFilter === 'problem';
    $('#main').innerHTML = `<div class="page"><div class="panel">
      <div class="row">
        <button class="btn ${!problem && f.from === today() && f.to === today() ? 'primary' : ''}" id="d0">${t('today')}</button>
        <button class="btn ${!problem && f.from === shiftDay(today(), -1) && f.to === f.from ? 'primary' : ''}" id="d1">${t('yesterday')}</button>
        <label class="row small">${t('from')} <input type="date" class="inp" id="from" value="${f.from}" style="width:auto"></label>
        <label class="row small">${t('to')} <input type="date" class="inp" id="to" value="${f.to}" style="width:auto"></label>
        <input class="inp" id="q" placeholder="🔍 ${t('receiptNo')}" value="${esc(f.q)}" style="max-width:180px">
        <span class="spacer"></span>
        <button class="btn ${problem ? 'danger solid' : 'danger'}" id="prob">⚠ ${t('eetProblems')}</button>
      </div></div>
      <div class="panel" style="padding:.4rem" id="list">${t('loading')}</div></div>`;
    const load = async () => {
      try {
        const qs = problem ? 'eet=problem' : new URLSearchParams({ from: f.from, to: f.to, q: f.q }).toString();
        const rows = await api('GET', '/api/receipts?' + qs);
        const sum = rows.reduce((a, r) => a + r.paid_total, 0);
        $('#list').innerHTML = rows.length ? `<table class="tbl"><thead><tr><th>${t('receiptNo')}</th><th>${t('time')}</th><th>${t('cashier')}</th><th>${t('payment')}</th><th class="r">${t('amount')}</th><th>EET</th></tr></thead><tbody>
          ${rows.map((r) => `<tr class="click ${r.type === 'storno' ? 'neg' : ''}" data-id="${r.id}"><td><b>${esc(r.number)}</b> ${r.type === 'storno' ? '<span class="tag storno">STORNO</span>' : ''}${r.storno_by ? '<span class="tag none">↩︎</span>' : ''}</td>
            <td class="nowrap">${esc(Receipt.dt(r.sale_time))}</td><td>${esc(r.user_name)}</td><td>${r.payment === 'cash' ? '💵 ' + t('cash') : '💳 ' + t('card')}</td>
            <td class="r nowrap"><b>${fmt(r.paid_total)}</b></td><td>${eetTag(r)}</td></tr>`).join('')}</tbody>
          <tfoot><tr><td colspan="4" class="r"><b>${t('total')}</b> (${rows.length})</td><td class="r nowrap"><b>${fmt(sum)}</b></td><td></td></tr></tfoot></table>`
          : `<div class="muted" style="padding:2rem;text-align:center">${t('noResults')}</div>`;
        $$('tr[data-id]').forEach((tr) => (tr.onclick = () => receiptDetail(+tr.dataset.id, load)));
      } catch (e) { showErr(e); }
    };
    const set = (from, to) => { f.from = from; f.to = to; S.receiptFilter = null; viewReceipts(); };
    $('#d0').onclick = () => set(today(), today());
    $('#d1').onclick = () => set(shiftDay(today(), -1), shiftDay(today(), -1));
    $('#from').onchange = (e) => set(e.target.value, f.to < e.target.value ? e.target.value : f.to);
    $('#to').onchange = (e) => set(f.from, e.target.value);
    let qt; $('#q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { f.q = e.target.value; S.receiptFilter = null; load(); }, 300); };
    $('#prob').onclick = () => { S.receiptFilter = problem ? null : 'problem'; viewReceipts(); };
    load();
  }
  const eetTag = (r) => `<span class="tag ${r.eet_status}">${t('eet_' + r.eet_status)}</span>${r.eet_test ? ` <span class="tag test">${t('testTag')}</span>` : ''}`;

  async function receiptDetail(id, reload) {
    let r;
    try { r = await api('GET', '/api/receipts/' + id); } catch (e) { return showErr(e); }
    const paper = S.settings.paper;
    const m = modal(`${head(`🧾 ${esc(r.number)} ${r.type === 'storno' ? '<span class="tag storno">STORNO</span>' : ''}`)}
      <div class="receipt-layout"><div>
        <dl class="kv">
          <dt>${t('time')}</dt><dd>${esc(Receipt.dt(r.sale_time))}</dd>
          <dt>${t('cashier')}</dt><dd>${esc(r.user_name)}</dd>
          <dt>${t('payment')}</dt><dd>${r.payment === 'cash' ? t('cash') : t('card')}</dd>
          <dt>${t('amount')}</dt><dd>${fmt(r.paid_total)}</dd>
          <dt>EET</dt><dd>${eetTag(r)}</dd>
          ${r.eet_pok ? `<dt>POK</dt><dd class="mono small">${esc(r.eet_pok)}</dd>` : ''}
          ${r.eet_received ? `<dt>EET ✓</dt><dd class="small">${esc(r.eet_received)}</dd>` : ''}
          ${r.eet_attempts ? `<dt>#</dt><dd class="small">${r.eet_attempts}×${r.eet_trace ? ' · ' + esc(r.eet_trace) : ''}</dd>` : ''}
          ${r.storno_number ? `<dt>${t('stornoed')}</dt><dd>${esc(r.storno_number)}</dd>` : ''}
          ${r.ref_number ? `<dt>${t('stornoOf')}</dt><dd>${esc(r.ref_number)}</dd>` : ''}
        </dl>
        ${r.eet_error && r.eet_status !== 'ok' ? `<div class="alert err small">${esc(r.eet_error)}</div>` : ''}
        ${(r.eet_warnings || []).map((w) => `<div class="alert warn small">⚠ [${w.code}] ${esc(w.text)}</div>`).join('')}
        <div style="display:grid;gap:.5rem;margin-top:1rem">
          <button class="btn primary" id="pr">🖨 ${t('print')}</button>
          <button class="btn" id="pra4">📄 ${t('printA4')}</button>
          ${r.eet_status !== 'ok' ? `<button class="btn" id="eet">📡 ${r.eet_status === 'none' ? t('sendEet') : t('resendEet')}</button>` : ''}
          ${isAdmin() && r.type === 'sale' && !r.storno_by ? `<button class="btn danger" id="sto">↩︎ ${t('storno')}</button>` : ''}
        </div></div>
        <iframe class="preview-frame" id="pv" title="preview"></iframe></div>`, { wide: true });
    $('#pv', m.el).srcdoc = Receipt.doc(r, paper === 'A4' ? 'A4' : paper);
    $('#pr', m.el).onclick = () => Receipt.print(r, paper);
    $('#pra4', m.el).onclick = () => Receipt.print(r, 'A4');
    if ($('#eet', m.el)) $('#eet', m.el).onclick = async (e) => {
      e.target.disabled = true; e.target.textContent = '⏳ ' + t('loading');
      try {
        const nr = await api('POST', `/api/receipts/${id}/eet`);
        toast(nr.eet_status === 'ok' ? 'EET ✓' : (nr.eet_error || t('eet_error')), nr.eet_status === 'ok' ? 'ok' : 'err');
        m.close(); reload && reload(); receiptDetail(id, reload); refreshEetProblems();
      } catch (err) { showErr(err); e.target.disabled = false; }
    };
    if ($('#sto', m.el)) $('#sto', m.el).onclick = async () => {
      if (!(await confirmBox(t('stornoConfirm'), t('storno'), true))) return;
      try {
        const s = await api('POST', `/api/receipts/${id}/storno`);
        m.close(); reload && reload();
        toast(`STORNO ${s.number}`, 'ok');
        receiptDetail(s.id, reload);
        if (S.settings.autoPrint) Receipt.print(s, paper);
      } catch (err) { showErr(err); }
    };
  }

  // ======================================================================
  // ZBOŽÍ
  // ======================================================================
  function viewProducts() {
    $('#main').innerHTML = `<div class="page"><div class="panel"><div class="row">
      <input class="inp" id="pq" placeholder="🔍 ${t('search')} / ${t('barcode')}" style="max-width:360px" autofocus>
      <span class="spacer"></span><button class="btn big" id="bulkp">📋 ${t('bulkImport')}</button><button class="btn primary big" id="addp">➕ ${t('newProduct')}</button></div></div>
      <div class="panel" style="padding:.4rem" id="plist"></div></div>`;
    const draw = () => {
      const q = $('#pq').value.trim();
      const list = q ? searchLocal(q).concat(S.byBarcode.get(q) && !searchLocal(q).includes(S.byBarcode.get(q)) ? [S.byBarcode.get(q)] : []) : S.products;
      $('#plist').innerHTML = list.length ? `<table class="tbl"><thead><tr><th>${t('productName')}</th><th>${t('barcode')}</th><th class="r">${t('price')}</th><th>${t('vat')}</th><th class="r">${t('stock')}</th><th></th></tr></thead><tbody>
        ${list.map((p) => `<tr class="click" data-id="${p.id}"><td><b>${esc(p.name)}</b> ${p.favorite ? '⭐' : ''}</td><td class="mono small">${esc(p.barcode || '')}</td>
          <td class="r nowrap"><b>${fmt(p.price)}</b></td><td>${p.vat_rate} %</td>
          <td class="r nowrap ${p.stock <= 0 ? '' : ''}">${String(p.stock).replace('.', ',')} ${esc(p.unit)} ${p.stock <= 0 ? `<span class="tag error">${t('lowStock')}</span>` : ''}</td>
          <td class="r"><button class="btn sm" data-edit="${p.id}">${t('edit')}</button></td></tr>`).join('')}</tbody></table>`
        : `<div class="muted" style="padding:2rem;text-align:center">${t('noResults')}</div>`;
      $$('#plist tr[data-id]').forEach((tr) => (tr.onclick = () => productForm(S.products.find((p) => p.id === +tr.dataset.id), draw)));
    };
    $('#pq').oninput = draw;
    $('#pq').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const v = e.target.value.trim(), p = S.byBarcode.get(v);
      if (p) productForm(p, draw);
      else if (/^\d{4,}$/.test(v)) productForm({ barcode: v }, draw);
    });
    $('#addp').onclick = () => productForm({}, draw);
    $('#bulkp').onclick = () => bulkImport(draw);
    draw();
  }

  function productForm(p = {}, after) {
    const isNew = !p.id;
    const rates = S.settings.vatRates;
    const vat = p.vat_rate ?? S.settings.defaultVat;
    const m = modal(`${head(isNew ? '➕ ' + t('newProduct') : '✏️ ' + t('editProduct'))}<form id="pf">
      <label class="f"><span>${t('barcode')} — ${t('scanToFill')}</span><input class="inp mono" name="barcode" value="${esc(p.barcode || '')}" autocomplete="off" ${!p.barcode ? 'autofocus' : ''}></label>
      <label class="f"><span>${t('productName')}</span><input class="inp" name="name" required maxlength="80" value="${esc(p.name || '')}" ${p.barcode && !p.name ? 'autofocus' : ''}></label>
      <div class="grid2">
        <label class="f"><span>${t('priceVat')} (Kč)</span><input class="inp" name="price" inputmode="decimal" required value="${moneyIn(p.price)}" style="font-size:1.2rem;font-weight:700"></label>
        <label class="f"><span>${t('vat')} ${!S.settings.vatPayer ? '(neplátce)' : ''}</span><select class="inp" name="vat">${rates.map((r) => `<option value="${r}" ${r === vat ? 'selected' : ''}>${r} %</option>`).join('')}</select></label>
        <label class="f"><span>${t('purchasePrice')} (Kč)</span><input class="inp" name="purchase" inputmode="decimal" value="${moneyIn(p.purchase_price)}"></label>
        <label class="f"><span>${t('unit')}</span><input class="inp" name="unit" list="units" value="${esc(p.unit || 'ks')}" maxlength="10"></label>
        ${isNew ? `<label class="f"><span>${t('stock')}</span><input class="inp" name="stock" inputmode="decimal" value="0"></label>` : ''}
      </div>
      <datalist id="units"><option>ks</option><option>kg</option><option>g</option><option>l</option><option>bal</option><option>m</option></datalist>
      <label class="chk"><input type="checkbox" name="favorite" ${p.favorite ? 'checked' : ''}> ⭐ ${t('favorite')}</label>
      <div id="margin" class="small muted"></div>
      <div class="row end">${!isNew ? `<button type="button" class="btn danger" id="delp">${t('delete')}</button><span class="spacer"></span>` : ''}
        <button type="button" class="btn" data-close>${t('cancel')}</button><button class="btn primary big">${t('save')}</button></div></form>`);
    const form = $('#pf', m.el);
    // Skener posílá Enter – v poli kódu jen přeskočit na další pole.
    form.barcode.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); form.name.focus(); } });
    const marg = () => {
      const price = parseMoney(form.price.value), pur = parseMoney(form.purchase.value), r = +form.vat.value;
      if (isNaN(price) || isNaN(pur) || !pur) { $('#margin', m.el).textContent = ''; return; }
      const net = price / (1 + (S.settings.vatPayer ? r : 0) / 100);
      $('#margin', m.el).textContent = `Marže: ${fmt(Math.round(net - pur))} (${Math.round(((net - pur) / net) * 100)} %)`;
    };
    form.price.oninput = form.purchase.oninput = form.vat.onchange = marg; marg();
    if ($('#delp', m.el)) $('#delp', m.el).onclick = async () => {
      if (!(await confirmBox(`${t('delete')}: ${p.name}?`, t('delete'), true))) return;
      try { await api('DELETE', '/api/products/' + p.id); await loadProducts(); m.close(); after && after(); } catch (e) { showErr(e); }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const price = parseMoney(form.price.value), purchase = form.purchase.value.trim() ? parseMoney(form.purchase.value) : 0;
      if (isNaN(price) || isNaN(purchase)) return toast(terr('BAD_INPUT'), 'err');
      const body = { barcode: form.barcode.value.trim(), name: form.name.value.trim(), price, vatRate: +form.vat.value, purchasePrice: purchase, unit: form.unit.value.trim() || 'ks', favorite: form.favorite.checked };
      if (isNew) body.stock = parseFloat(String(form.stock.value).replace(',', '.')) || 0;
      try {
        const saved = await api(isNew ? 'POST' : 'PUT', isNew ? '/api/products' : '/api/products/' + p.id, body);
        await loadProducts();
        toast(t('saved'), 'ok');
        m.close();
        after && after(saved);
      } catch (err) { showErr(err); }
    };
  }

  // ======================================================================
  // PŘÍJEM ZBOŽÍ
  // ======================================================================
  function viewStockIn() {
    $('#main').innerHTML = `<div class="page">
      <div class="panel"><h2>📥 ${t('stockInTitle')}</h2><p class="muted">${t('stockInHint')}</p>
        <div class="scanbar" style="padding:0;border:0"><span class="ico" style="left:.7rem">▦</span><input id="sscan" class="inp" style="padding-left:2.4rem;font-size:1.15rem" placeholder="${t('scanHere')}" autocomplete="off" autofocus><div id="ssug"></div></div></div>
      <div class="panel" style="padding:.4rem" id="slines"></div>
      <div class="panel"><label class="f"><span>${t('note')}</span><input class="inp" id="snote" maxlength="120"></label>
        <div class="row end"><button class="btn" id="hist">🕑 ${t('history')}</button><button class="btn" id="bulk">📋 ${t('bulkImport')}</button><span class="spacer"></span><button class="btn primary big" id="ssave">💾 ${t('saveStockIn')}</button></div></div></div>`;
    const sc = $('#sscan');
    const addLine = (p) => {
      const ex = S.stockLines.find((l) => l.productId === p.id);
      if (ex) ex.qty += 1;
      else S.stockLines.push({ productId: p.id, name: p.name, unit: p.unit, qty: 1, purchasePrice: p.purchase_price, price: p.price, oldPrice: p.price });
      beep(true); draw();
      setTimeout(() => { const q = $$('#slines input[data-f="qty"]'); const i = S.stockLines.findIndex((l) => l.productId === p.id); q[i] && q[i].select(); }, 20);
    };
    sc.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = sc.value.trim(); sc.value = ''; $('#ssug').innerHTML = '';
      if (!v) return;
      const p = S.byBarcode.get(v) || (searchLocal(v).length === 1 ? searchLocal(v)[0] : null);
      if (p) return addLine(p);
      beep(false);
      if (await confirmBox(`${t('notFound')}: ${v}. ${t('addAsNew')}?`, t('addAsNew'))) productForm(/^\d+$/.test(v) ? { barcode: v } : { name: v }, (np) => np && addLine(np));
    });
    sc.oninput = () => {
      const v = sc.value.trim();
      if (v.length < 2 || /^\d+$/.test(v)) { $('#ssug').innerHTML = ''; return; }
      const res = searchLocal(v).slice(0, 8);
      $('#ssug').innerHTML = res.length ? `<div class="suggest" style="left:0;right:0">${res.map((p) => `<button data-p="${p.id}"><span>${esc(p.name)}</span><span class="muted">${esc(p.barcode || '')}</span></button>`).join('')}</div>` : '';
      $$('#ssug button').forEach((b) => (b.onclick = () => { sc.value = ''; $('#ssug').innerHTML = ''; addLine(S.products.find((p) => p.id === +b.dataset.p)); }));
    };
    const draw = () => {
      $('#slines').innerHTML = S.stockLines.length ? `<table class="tbl"><thead><tr><th>${t('productName')}</th><th>${t('qty')}</th><th>${t('purchasePrice')}</th><th>${t('newPrice')}</th><th></th></tr></thead><tbody>
        ${S.stockLines.map((l, i) => `<tr data-i="${i}"><td><b>${esc(l.name)}</b></td>
          <td><input class="inp" data-f="qty" inputmode="decimal" value="${String(l.qty).replace('.', ',')}" style="width:90px"> ${esc(l.unit)}</td>
          <td><input class="inp" data-f="purchasePrice" inputmode="decimal" value="${moneyIn(l.purchasePrice)}" style="width:120px"></td>
          <td><input class="inp" data-f="price" inputmode="decimal" value="${moneyIn(l.price)}" style="width:120px"></td>
          <td><button class="x" data-del="${i}">✕</button></td></tr>`).join('')}</tbody></table>`
        : `<div class="muted" style="padding:2rem;text-align:center">▦ ${t('stockInHint')}</div>`;
      $$('#slines input').forEach((inp) => (inp.onchange = () => {
        const l = S.stockLines[+inp.closest('tr').dataset.i];
        const f = inp.dataset.f;
        l[f] = f === 'qty' ? parseFloat(inp.value.replace(',', '.')) : parseMoney(inp.value);
      }));
      $$('#slines input').forEach((inp) => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sc.focus(); } }));
      $$('[data-del]').forEach((b) => (b.onclick = () => { S.stockLines.splice(+b.dataset.del, 1); draw(); }));
    };
    $('#ssave').onclick = async () => {
      if (!S.stockLines.length) return;
      if (S.stockLines.some((l) => !Number.isFinite(l.qty) || l.qty === 0 || (l.purchasePrice != null && isNaN(l.purchasePrice)) || isNaN(l.price))) return toast(terr('BAD_INPUT'), 'err');
      try {
        await api('POST', '/api/stock', { note: $('#snote').value, items: S.stockLines.map((l) => ({ productId: l.productId, qty: l.qty, purchasePrice: l.purchasePrice, price: l.price !== l.oldPrice ? l.price : undefined })) });
        S.stockLines = []; await loadProducts(); toast(t('saved'), 'ok'); viewStockIn();
      } catch (e) { showErr(e); }
    };
    $('#bulk').onclick = () => bulkImport(() => viewStockIn());
    $('#hist').onclick = async () => {
      try {
        const rows = await api('GET', '/api/stock/moves');
        modal(`${head('🕑 ' + t('history'))}<table class="tbl"><thead><tr><th>${t('time')}</th><th>${t('productName')}</th><th class="r">${t('qty')}</th><th class="r">${t('purchasePrice')}</th><th>${t('note')}</th></tr></thead><tbody>
          ${rows.map((r) => `<tr><td class="small nowrap">${new Date(r.created).toLocaleString('cs-CZ')}</td><td>${esc(r.name)} <span class="tag none">${esc(r.type)}</span></td><td class="r">${String(r.qty).replace('.', ',')} ${esc(r.unit)}</td><td class="r">${r.purchase_price != null ? fmt(r.purchase_price) : ''}</td><td class="small">${esc(r.note || '')} · ${esc(r.user_name || '')}</td></tr>`).join('')}</tbody></table>`, { wide: true });
      } catch (e) { showErr(e); }
    };
    draw();
  }

  // --- hromadný import ---
  function bulkImport(after) {
    const m = modal(`${head('📋 ' + t('bulkImport'))}
      <p class="small muted">${t('bulkHint')}</p>
      <textarea class="inp mono" id="btext" rows="9" style="font-size:.9rem" placeholder="8594001234567; Rohlík; 4,20; 12; 50&#10;Nước mắm Phú Quốc 500ml; 89,90; 12; 20&#10;Gạo ST25 5kg; 249; 12%; 10" autofocus></textarea>
      <div class="row" style="margin:.5rem 0"><label class="btn sm">📂 ${t('openFile')}<input type="file" id="bfile" accept=".txt,.csv,.tsv,text/*" hidden></label></div>
      <label class="chk"><input type="radio" name="bmode" value="add" checked> ${t('bulkModeAdd')}</label>
      <label class="chk"><input type="radio" name="bmode" value="set"> ${t('bulkModeSet')}</label>
      <div id="bprev"></div>
      <div class="row end"><button class="btn" data-close>${t('cancel')}</button><button class="btn" id="bpv">👁 ${t('preview')}</button><button class="btn primary big" id="bap" disabled>💾 ${t('applyImport')}</button></div>`, { wide: true });
    const mode = () => $('input[name=bmode]:checked', m.el).value;
    const txt = $('#btext', m.el);
    let last = null;
    const label = { vat: 'vat', stock: 'stock', name: 'productName', unit: 'unit', barcode: 'barcode', price: 'price', purchase: 'purchasePrice' };
    const ch = (k, [a, b]) => `${t(label[k])}: ${k === 'price' || k === 'purchase' ? `${fmt(a)} → <b>${fmt(b)}</b>` : `${esc(a ?? '')} → <b>${esc(b)}</b>`}`;
    const TAG = { create: 'ok', update: 'pending', same: 'none', error: 'error' };
    const ACT = { create: 'actCreate', update: 'actUpdate', same: 'actSame', error: 'actError' };
    const prev = async () => {
      try {
        const p = await api('POST', '/api/import', { text: txt.value, mode: mode() });
        last = txt.value + '|' + mode();
        $('#bprev', m.el).innerHTML = `<div class="row" style="margin:.5rem 0">${Object.keys(TAG).map((a) => `<span class="tag ${TAG[a]}">${t(ACT[a])}: ${p.summary[a]}</span>`).join('')}</div>
          <div style="max-height:40vh;overflow:auto"><table class="tbl"><tbody>${p.rows.map((r) => `<tr>
            <td class="nowrap"><span class="tag ${TAG[r.action]}">${t(ACT[r.action])}</span></td>
            <td>${r.action === 'create' ? `<b>${esc(r.product.name)}</b> · ${fmt(r.product.price)} · ${r.product.vat} % · ${t('stock')} ${r.product.stock}${r.product.barcode ? ' · <span class="mono">' + esc(r.product.barcode) + '</span>' : ''}`
              : r.action === 'error' ? `<span class="muted">#${r.line}</span> ${esc(r.text)}<br><b style="color:var(--danger)">${r.errors.map(terr).join(', ')}</b>`
              : `<b>${esc(r.productName)}</b>${r.action === 'update' ? '<br><span class="small">' + Object.entries(r.changes).map(([k, v]) => ch(k, v)).join(' · ') + '</span>' : ''}`}</td></tr>`).join('')}</tbody></table></div>`;
        $('#bap', m.el).disabled = !(p.summary.create + p.summary.update);
      } catch (e) { showErr(e); }
    };
    $('#bpv', m.el).onclick = prev;
    txt.oninput = () => { $('#bap', m.el).disabled = true; };
    $$('input[name=bmode]', m.el).forEach((r) => (r.onchange = () => { $('#bap', m.el).disabled = true; if (txt.value.trim()) prev(); }));
    $('#bfile', m.el).onchange = async (e) => { const f = e.target.files[0]; if (f) { txt.value = await f.text(); prev(); } };
    $('#bap', m.el).onclick = async () => {
      if (last !== txt.value + '|' + mode()) return prev();
      try {
        const p = await api('POST', '/api/import', { text: txt.value, mode: mode(), apply: true });
        await loadProducts();
        toast(`${t('importDone')}: +${p.summary.create} / ~${p.summary.update}`, 'ok');
        m.close(); after && after();
      } catch (e) { showErr(e); }
    };
  }

  // ======================================================================
  // PŘEHLED
  // ======================================================================
  function viewReport() {
    const f = S.repf || (S.repf = { from: today(), to: today() });
    $('#main').innerHTML = `<div class="page"><div class="panel"><div class="row">
      <h2 style="margin:0">📊 ${t('reportTitle')}</h2><span class="spacer"></span>
      <button class="btn" id="r0">${t('today')}</button><button class="btn" id="r1">${t('yesterday')}</button>
      <input type="date" class="inp" id="rf" value="${f.from}" style="width:auto"> – <input type="date" class="inp" id="rt" value="${f.to}" style="width:auto"></div></div>
      <div id="rep">${t('loading')}</div></div>`;
    const set = (a, b) => { f.from = a; f.to = b; viewReport(); };
    $('#r0').onclick = () => set(today(), today());
    $('#r1').onclick = () => set(shiftDay(today(), -1), shiftDay(today(), -1));
    $('#rf').onchange = (e) => set(e.target.value, f.to < e.target.value ? e.target.value : f.to);
    $('#rt').onchange = (e) => set(f.from, e.target.value);
    api('GET', `/api/report?from=${f.from}&to=${f.to}`).then((r) => {
      $('#rep').innerHTML = `<div class="stats">
        <div class="stat"><div class="l">${t('total')}</div><div class="v">${fmt(r.total)}</div></div>
        <div class="stat"><div class="l">💵 ${t('cashTotal')}</div><div class="v">${fmt(r.cash)}</div></div>
        <div class="stat"><div class="l">💳 ${t('cardTotal')}</div><div class="v">${fmt(r.card)}</div></div>
        <div class="stat"><div class="l">${t('receiptsCount')}</div><div class="v">${r.count}</div></div>
        <div class="stat"><div class="l">${t('stornoCount')}</div><div class="v">${r.storno}</div></div>
        <div class="stat"><div class="l">EET</div><div class="v" style="font-size:1rem">✓ ${r.eetOk} · ⏳ ${r.eetPending} · ✖ ${r.eetError}</div></div></div>
        <div class="grid2"><div class="panel"><h3>${t('vatRecap')}</h3><table class="tbl"><thead><tr><th>${t('vat')}</th><th class="r">${t('base')}</th><th class="r">DPH</th><th class="r">${t('total')}</th></tr></thead><tbody>
          ${r.vat.map((v) => `<tr><td>${v.rate} %</td><td class="r">${fmt(v.base)}</td><td class="r">${fmt(v.vat)}</td><td class="r"><b>${fmt(v.gross)}</b></td></tr>`).join('')}
          ${r.rounding ? `<tr><td>${t('rounding')}</td><td></td><td></td><td class="r">${fmt(r.rounding)}</td></tr>` : ''}</tbody></table>
          <h3 style="margin-top:1rem">${t('byUser')}</h3><table class="tbl">${r.byUser.map((u) => `<tr><td>${esc(u.user_name)}</td><td class="r">${u.n}×</td><td class="r"><b>${fmt(u.total)}</b></td></tr>`).join('')}</table></div>
        <div class="panel"><h3>${t('topProducts')}</h3><table class="tbl">${r.top.map((p) => `<tr><td>${esc(p.name)}</td><td class="r">${String(Math.round(p.qty * 1000) / 1000).replace('.', ',')}</td><td class="r"><b>${fmt(p.total)}</b></td></tr>`).join('')}</table></div></div>
        <div class="row end"><button class="btn big" id="exp">⬇ ${t('exportCsv')}</button><button class="btn primary big" id="prz">🖨 ${t('printReport')}</button></div>`;
      $('#prz').onclick = () => printReport(r);
      $('#exp').hidden = !isAdmin();
      $('#exp').onclick = async () => {
        const res = await fetch(`/api/export?from=${f.from}&to=${f.to}`, { headers: { Authorization: 'Bearer ' + S.token } });
        const blob = await res.blob();
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `doklady_${f.from}_${f.to}.csv`; a.click();
      };
    }).catch(showErr);
  }
  function printReport(r) {
    const c = S.settings.company;
    const row = (a, b) => `<div class="row"><span>${a}</span><span>${b}</span></div>`;
    const html = `<div class="rcpt th"><div class="seller"><b class="big">${esc(c.name)}</b><div>IČO: ${esc(c.ico)}</div></div>
      <div class="title">UZÁVĚRKA ${r.from === r.to ? esc(r.from) : esc(r.from) + ' – ' + esc(r.to)}</div>
      ${row('Počet dokladů', r.count)}${row('Počet storen', r.storno)}<div class="sep"></div>
      ${row('Hotově', kc(r.cash))}${row('Kartou', kc(r.card))}${r.rounding ? row('Zaokrouhlení', kc(r.rounding)) : ''}
      <div class="row total"><span>CELKEM</span><span>${kc(r.total)} Kč</span></div>
      ${S.settings.vatPayer ? `<table class="vat"><tr><th>Sazba</th><th class="r">Základ</th><th class="r">DPH</th><th class="r">Celkem</th></tr>${r.vat.map((v) => `<tr><td>${v.rate} %</td><td class="r">${kc(v.base)}</td><td class="r">${kc(v.vat)}</td><td class="r">${kc(v.gross)}</td></tr>`).join('')}</table>` : ''}
      <div class="sep"></div>${r.byUser.map((u) => row(esc(u.user_name), kc(u.total))).join('')}
      <div class="sep"></div>${row('EET odesláno', r.eetOk)}${row('EET čeká', r.eetPending)}${row('EET chyba', r.eetError)}
      <div class="small">Vytištěno: ${new Date().toLocaleString('cs-CZ')} · ${esc(S.user.name)}</div></div>`;
    Receipt.printRaw(html, S.settings.paper === 'A4' ? '80' : S.settings.paper);
  }

  // ======================================================================
  // NASTAVENÍ
  // ======================================================================
  function viewSettings() {
    const s = S.settings, c = s.company, e = s.eet;
    const inp = (name, label, val, extra = '') => `<label class="f"><span>${label}</span><input class="inp" name="${name}" value="${esc(val ?? '')}" ${extra}></label>`;
    $('#main').innerHTML = `<div class="page">
      <form class="panel" id="sc"><h2>🏪 ${t('company')}</h2>
        <div class="row" style="align-items:flex-end"><div style="flex:1">${inp('ico', t('ico'), c.ico, 'inputmode="numeric" maxlength="8"')}</div><button type="button" class="btn primary" id="sares" style="margin-bottom:.75rem">🔎 ${t('loadAres')}</button></div>
        ${inp('name', t('name'), c.name, 'required')}
        <div class="grid2">${inp('dic', t('dic'), c.dic)}${inp('street', t('street'), c.street)}${inp('city', t('city'), c.city)}${inp('zip', t('zip'), c.zip)}${inp('phone', t('phone'), c.phone)}${inp('email', t('email'), c.email)}</div>
        ${inp('shopAddress', t('shopAddress'), c.shopAddress)}${inp('registry', t('registry'), c.registry)}
        <label class="chk"><input type="checkbox" name="vatPayer" ${s.vatPayer ? 'checked' : ''}> ${t('vatPayer')}</label>
        <div class="grid3">${inp('vatRates', t('vatRates'), s.vatRates.join(', '))}
          <label class="f"><span>${t('defaultVat')}</span><select class="inp" name="defaultVat">${s.vatRates.map((r) => `<option ${r === s.defaultVat ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
          <label class="f"><span>${t('paper')}</span><select class="inp" name="paper">${['80', '58', 'A4'].map((p) => `<option value="${p}" ${p === s.paper ? 'selected' : ''}>${p === 'A4' ? 'A4' : p + ' mm'}</option>`).join('')}</select></label></div>
        ${inp('footer', t('footer'), s.footer)}
        <label class="chk"><input type="checkbox" name="roundCash" ${s.roundCash ? 'checked' : ''}> ${t('roundCash')}</label>
        <label class="chk"><input type="checkbox" name="autoPrint" ${s.autoPrint ? 'checked' : ''}> ${t('autoPrint')}</label>
        <div class="row end"><button class="btn primary big">💾 ${t('save')}</button></div></form>

      <div class="panel"><h2>📡 ${t('eetSettings')}</h2>
        <div class="alert info small">${S.lang === 'vi'
          ? 'Các bước: 1) Đăng nhập DIS+ (MOJE daně), đăng ký cơ sở (evidenční jednotka) → ghi lại mã ID. 2) Tạo chứng chỉ máy tính tiền (.p12) miễn phí trong DIS+. 3) Tải chứng chỉ lên đây, điền mã cơ sở. 4) Bấm "Kiểm tra kết nối". 5) Chọn môi trường THẬT và bật EET.'
          : 'Postup: 1) V DIS+ (MOJE daně) založte evidenční jednotku → zapište si ID. 2) V DIS+ vygenerujte pokladní certifikát (.p12). 3) Nahrajte certifikát a vyplňte ID jednotky. 4) Ověřte spojení. 5) Přepněte na ostré prostředí a zapněte EET.'}</div>
        <form id="certf" class="row" style="align-items:flex-end">
          <label class="f" style="flex:2;min-width:220px"><span>${t('cert')}</span><input class="inp" type="file" name="p12" accept=".p12,.pfx" required></label>
          <label class="f" style="flex:1;min-width:160px"><span>${t('certPassword')}</span><input class="inp" type="password" name="pw"></label>
          <button class="btn" style="margin-bottom:.75rem">⬆ ${t('upload')}</button></form>
        ${e.hasCert ? `<div class="alert ok">✔ ${t('certOk')} · EIČ <b>${esc(e.eic)}</b> · ${t('validTo')} ${new Date(e.validTo).toLocaleDateString('cs-CZ')}</div>` : ''}
        <form id="eetf"><div class="grid3">
          ${inp('unitId', t('unitId'), e.unitId, 'inputmode="numeric" maxlength="9"')}${inp('posId', t('posId'), e.posId, 'maxlength="20"')}
          <label class="f"><span>${t('eetEnv')}</span><select class="inp" name="env"><option value="playground" ${e.env === 'playground' ? 'selected' : ''}>${t('envPlayground')}</option><option value="production" ${e.env === 'production' ? 'selected' : ''}>${t('envProduction')}</option></select></label></div>
          <label class="chk"><input type="checkbox" name="enabled" ${e.enabled ? 'checked' : ''}> <b>${t('eetEnabled')}</b></label>
          <div class="row end"><button type="button" class="btn" id="eett">🔌 ${t('eetTest')}</button><button class="btn primary big">💾 ${t('save')}</button></div></form></div>

      <div class="panel"><div class="row"><h2 style="margin:0">👥 ${t('users')}</h2><span class="spacer"></span><button class="btn primary" id="addu">➕ ${t('newUser')}</button></div><div id="ulist"></div></div>
      <p class="small muted">${t('shortcuts')}</p></div>`;

    const sc = $('#sc');
    $('#sares').onclick = async () => {
      try {
        const a = await api('GET', '/api/ares/' + sc.ico.value.trim());
        sc.name.value = a.name; sc.dic.value = a.dic; sc.street.value = a.street; sc.city.value = a.city; sc.zip.value = a.zip;
        sc.vatPayer.checked = a.vatPayer;
        toast(t('aresOk'), 'ok');
      } catch (err) { showErr(err); }
    };
    sc.onsubmit = async (ev) => {
      ev.preventDefault();
      const company = Object.fromEntries(['ico', 'name', 'dic', 'street', 'city', 'zip', 'phone', 'email', 'shopAddress', 'registry'].map((k) => [k, sc[k].value]));
      try {
        S.settings = await api('PUT', '/api/settings', {
          company, vatPayer: sc.vatPayer.checked, vatRates: sc.vatRates.value.split(/[,;\s]+/).filter(Boolean).map(Number),
          defaultVat: +sc.defaultVat.value, paper: sc.paper.value, footer: sc.footer.value, roundCash: sc.roundCash.checked, autoPrint: sc.autoPrint.checked,
        });
        toast(t('saved'), 'ok'); render();
      } catch (err) { showErr(err); }
    };
    $('#certf').onsubmit = async (ev) => {
      ev.preventDefault();
      const file = ev.target.p12.files[0];
      if (!file) return;
      const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(file); });
      try {
        await api('POST', '/api/settings/cert', { p12: b64, password: ev.target.pw.value });
        S.settings = (await api('GET', '/api/me')).settings;
        toast(t('certOk'), 'ok'); viewSettings();
      } catch (err) { showErr(err); }
    };
    const ef = $('#eetf');
    ef.onsubmit = async (ev) => {
      ev.preventDefault();
      if (ef.env.value === 'production' && ef.enabled.checked && !(S.settings.eet.env === 'production' && S.settings.eet.enabled)) {
        if (!(await confirmBox(S.lang === 'vi' ? 'Bật EET THẬT? Từ giờ mọi hóa đơn sẽ được gửi lên Finanční správa.' : 'Zapnout OSTRÉ EET? Všechny tržby se budou odesílat Finanční správě.', t('yes')))) return;
      }
      try {
        S.settings = await api('PUT', '/api/settings', { eet: { unitId: ef.unitId.value, posId: ef.posId.value, env: ef.env.value, enabled: ef.enabled.checked } });
        toast(t('saved'), 'ok'); render();
      } catch (err) { showErr(err); }
    };
    $('#eett').onclick = async (ev) => {
      ev.target.disabled = true;
      try {
        await api('PUT', '/api/settings', { eet: { unitId: ef.unitId.value, posId: ef.posId.value, env: ef.env.value } });
        const r = await api('POST', '/api/eet/test');
        if (r.ok) modal(`${head('🔌 EET')}<div class="alert ok">✔ ${t('eetTestOk')}</div><p class="small">${esc(r.errorText || '')}</p>${r.warnings.map((w) => `<div class="alert warn small">⚠ [${w.code}] ${esc(w.text)}</div>`).join('')}<p class="small muted">${r.test ? 'Playground' : 'Produkce'} · ${esc(r.traceId || '')}</p>`);
        else modal(`${head('🔌 EET')}<div class="alert err">✖ ${esc((r.errorCode != null ? '[' + r.errorCode + '] ' : '') + (r.errorText || ''))}</div>`);
      } catch (err) { showErr(err); }
      ev.target.disabled = false;
    };
    // uživatelé
    const loadUsers = async () => {
      const us = await api('GET', '/api/users');
      $('#ulist').innerHTML = `<table class="tbl"><tbody>${us.map((u) => `<tr class="click" data-u="${u.id}"><td><b>${esc(u.name)}</b></td><td>${t('role_' + u.role)}</td><td>${u.active ? '✔' : '<span class="muted">✖</span>'}</td><td class="r"><button class="btn sm">${t('edit')}</button></td></tr>`).join('')}</tbody></table>`;
      $$('[data-u]').forEach((tr) => (tr.onclick = () => userForm(us.find((u) => u.id === +tr.dataset.u), loadUsers)));
    };
    $('#addu').onclick = () => userForm(null, loadUsers);
    loadUsers().catch(showErr);
  }
  function userForm(u, after) {
    const m = modal(`${head(u ? esc(u.name) : t('newUser'))}<form id="uf">
      <label class="f"><span>${t('name')}</span><input class="inp" name="name" value="${esc(u?.name || '')}" required maxlength="40" autofocus></label>
      <label class="f"><span>${u ? t('newPin') : t('pin')}</span><input class="inp" name="pin" type="password" inputmode="numeric" pattern="\\d{4,8}" ${u ? '' : 'required'}></label>
      <label class="f"><span>${t('role')}</span><select class="inp" name="role"><option value="cashier" ${u?.role === 'cashier' ? 'selected' : ''}>${t('role_cashier')}</option><option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>${t('role_admin')}</option></select></label>
      ${u ? `<label class="chk"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> ${t('active')}</label>` : ''}
      <div class="row end"><button type="button" class="btn" data-close>${t('cancel')}</button><button class="btn primary big">${t('save')}</button></div></form>`);
    $('#uf', m.el).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const body = { name: f.name.value, role: f.role.value, ...(f.pin.value ? { pin: f.pin.value } : {}), ...(u ? { active: f.active.checked } : {}) };
      try { await api(u ? 'PUT' : 'POST', u ? '/api/users/' + u.id : '/api/users', body); m.close(); after(); toast(t('saved'), 'ok'); } catch (err) { showErr(err); }
    };
  }

  // ---------- globální klávesy (čtečka čárových kódů = klávesnice) ----------
  document.addEventListener('keydown', (e) => {
    if (!S.user) return;
    if (e.key === 'Escape' && modalStack.length) { e.preventDefault(); modalStack[modalStack.length - 1].close(); return; }
    if (S.view !== 'sale') return;
    if (e.key === 'F2') { e.preventDefault(); payDialog('cash'); return; }
    if (e.key === 'F4') { e.preventDefault(); payDialog('card'); return; }
    if (e.key === 'F8') { e.preventDefault(); const q = $('#tq'); q && q.focus(); return; }
    // Když fokus není v žádném poli, přesměrovat znaky ze čtečky do pole skenování.
    const a = document.activeElement;
    const inField = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT');
    if (!modalStack.length && !inField && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const s = $('#scan');
      if (s) { e.preventDefault(); s.focus(); s.value += e.key; s.dispatchEvent(new Event('input')); }
    }
  });
  // Po kliknutí mimo pole vrátit fokus do skenovacího pole (aby čtečka vždy fungovala).
  document.addEventListener('click', (e) => {
    if (S.view === 'sale' && !modalStack.length && !e.target.closest('input,select,textarea')) setTimeout(focusScan, 0);
  });
  setInterval(() => { if (S.user) refreshEetProblems(); }, 60000);

  boot();
})();

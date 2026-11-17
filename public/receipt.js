// Tisk dokladů (vždy česky – zákonné náležitosti podle § 29/§ 30 ZDPH a § 16 zák. o ochraně spotřebitele).
(function () {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kc = (h) => (h / 100).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const qtyFmt = (q) => Number(q).toLocaleString('cs-CZ', { maximumFractionDigits: 3 });
  const dt = (s) => { const [d, t] = s.split('T'); const [y, m, dd] = d.split('-'); return `${+dd}. ${+m}. ${y} ${t.slice(0, 8)}`; };
  const dOnly = (s) => dt(s).split(' ').slice(0, 3).join(' ');
  const LIMIT_SIMPLE = 1000000; // 10 000 Kč v haléřích

  function docTitle(r) {
    const vp = r.seller.vatPayer;
    if (r.type === 'storno') return vp ? 'OPRAVNÝ DAŇOVÝ DOKLAD' : 'STORNO DOKLADU';
    if (!vp) return 'PRODEJKA / ÚČTENKA';
    return isFull(r) ? 'DAŇOVÝ DOKLAD' : 'ZJEDNODUŠENÝ DAŇOVÝ DOKLAD';
  }
  const isFull = (r) => r.seller.vatPayer && (Math.abs(r.paid_total) > LIMIT_SIMPLE || !!(r.customer && (r.customer.name || r.customer.ico)));
  const vatLetter = (rates) => { const m = {}; rates.forEach((r, i) => (m[r] = 'ABCDEFG'[i])); return m; };

  function sellerBlock(s) {
    const addr = [s.street, [s.zip, s.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return `<div class="seller"><b class="big">${esc(s.name || '— vyplňte název firmy v Nastavení —')}</b>
      ${addr ? `<div>Sídlo: ${esc(addr)}</div>` : ''}
      ${s.shopAddress ? `<div>Provozovna: ${esc(s.shopAddress)}</div>` : ''}
      <div>${s.ico ? 'IČO: ' + esc(s.ico) : ''}${s.vatPayer && s.dic ? ' &nbsp; DIČ: ' + esc(s.dic) : ''}</div>
      ${!s.vatPayer ? '<div>Nejsem plátce DPH</div>' : ''}
      ${s.registry ? `<div class="small">${esc(s.registry)}</div>` : ''}
      ${s.phone || s.email ? `<div class="small">${esc([s.phone, s.email].filter(Boolean).join(' · '))}</div>` : ''}</div>`;
  }
  function customerBlock(c) {
    if (!c || !(c.name || c.ico)) return '';
    const addr = [c.street, [c.zip, c.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    return `<div class="cust"><div class="lbl">Odběratel:</div><b>${esc(c.name)}</b>${addr ? `<div>${esc(addr)}</div>` : ''}
      <div>${c.ico ? 'IČO: ' + esc(c.ico) : ''}${c.dic ? ' &nbsp; DIČ: ' + esc(c.dic) : ''}</div></div>`;
  }
  function eetBlock(r) {
    if (r.eet_status === 'none') return '';
    let s = `<div class="eet"><div>Provozovna (ID): ${esc(r.eet_unit)} &nbsp; Pokladna: ${esc(r.eet_pos)}</div>
      <div>Pořadové č. tržby: ${esc(r.number)}</div><div>Datum a čas tržby: ${esc(dt(r.sale_time))}</div>`;
    if (r.eet_status === 'ok') s += `<div>POK: <span class="mono">${esc(r.eet_pok)}</span>${r.eet_test ? ' <b>(TESTOVACÍ – NEPLATNÝ)</b>' : ''}</div>`;
    else s += `<div>Tržba evidována v režimu dodatečného odeslání.</div>`;
    return s + '</div>';
  }

  function itemsThermal(r, letters, full) {
    return r.items.map((it) => {
      const unitNet = full ? ` <span class="small">(bez DPH ${kc(Math.round((it.unit_price * 100) / (100 + it.vat_rate)))})</span>` : '';
      return `<div class="it"><div class="nm">${esc(it.name)}</div>
        <div class="row"><span>${qtyFmt(it.qty)} ${esc(it.unit)} × ${kc(it.unit_price)}${unitNet}</span><span>${kc(it.total)} ${r.seller.vatPayer ? letters[it.vat_rate] || '' : ''}</span></div></div>`;
    }).join('');
  }
  function itemsA4(r, letters, full) {
    const vp = r.seller.vatPayer;
    return `<table class="items"><thead><tr><th>Položka</th><th class="r">Množství</th>${full ? '<th class="r">Cena/j bez DPH</th>' : ''}<th class="r">Cena/j${vp ? ' s DPH' : ''}</th>${vp ? '<th class="r">DPH</th>' : ''}<th class="r">Celkem</th></tr></thead><tbody>
      ${r.items.map((it) => `<tr><td>${esc(it.name)}</td><td class="r">${qtyFmt(it.qty)} ${esc(it.unit)}</td>
        ${full ? `<td class="r">${kc(Math.round((it.unit_price * 100) / (100 + it.vat_rate)))}</td>` : ''}<td class="r">${kc(it.unit_price)}</td>
        ${vp ? `<td class="r">${it.vat_rate} %</td>` : ''}<td class="r">${kc(it.total)}</td></tr>`).join('')}</tbody></table>`;
  }

  function render(r, opts = {}) {
    const a4 = opts.paper === 'A4';
    const s = r.seller;
    const letters = vatLetter(r.vat.map((v) => v.rate));
    const full = isFull(r);
    const vatTable = s.vatPayer ? `<table class="vat"><tr><th>Sazba</th><th class="r">Základ</th><th class="r">DPH</th><th class="r">Celkem</th></tr>
      ${r.vat.map((v) => `<tr><td>${a4 ? '' : (letters[v.rate] || '') + ' '}${v.rate} %</td><td class="r">${kc(v.base)}</td><td class="r">${kc(v.vat)}</td><td class="r">${kc(v.gross)}</td></tr>`).join('')}</table>` : '';
    const pay = r.payment === 'cash' ? 'Hotově' : 'Platební kartou';
    const change = r.payment === 'cash' && r.received != null && r.received >= r.paid_total ? r.received - r.paid_total : null;
    return `<div class="rcpt ${a4 ? 'a4' : 'th'}">
      ${sellerBlock(s)}
      <div class="title">${docTitle(r)}</div>
      <div class="meta"><div class="row"><span>Číslo dokladu:</span><b>${esc(r.number)}</b></div>
        <div class="row"><span>Datum vystavení:</span><span>${esc(dt(r.sale_time))}</span></div>
        ${s.vatPayer ? `<div class="row"><span>Datum uskut. plnění:</span><span>${esc(dOnly(r.sale_time))}</span></div>` : ''}
        ${r.type === 'storno' ? `<div class="row"><span>Opravovaný doklad:</span><b>${esc(r.ref_number || '')}</b></div><div>Důvod opravy: storno / vrácení zboží</div>` : ''}
      </div>
      ${customerBlock(r.customer)}
      <div class="sep"></div>
      ${a4 ? itemsA4(r, letters, full) : itemsThermal(r, letters, full)}
      <div class="sep"></div>
      ${r.rounding ? `<div class="row"><span>Mezisoučet</span><span>${kc(r.total)}</span></div><div class="row"><span>Zaokrouhlení</span><span>${kc(r.rounding)}</span></div>` : ''}
      <div class="row total"><span>CELKEM K ÚHRADĚ</span><span>${kc(r.paid_total)} Kč</span></div>
      <div class="row"><span>Způsob úhrady:</span><span>${pay}</span></div>
      ${r.received != null && r.payment === 'cash' && r.type === 'sale' ? `<div class="row"><span>Přijato:</span><span>${kc(r.received)}</span></div>` : ''}
      ${change != null && r.type === 'sale' ? `<div class="row"><span>Vráceno:</span><span>${kc(change)}</span></div>` : ''}
      ${vatTable}
      ${eetBlock(r)}
      <div class="small">Pokladní: ${esc(r.user_name)}</div>
      ${s.footer ? `<div class="foot">${esc(s.footer)}</div>` : ''}
    </div>`;
  }

  const CSS = `
    *{box-sizing:border-box} body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff}
    .rcpt.th{font-size:12px;line-height:1.3;padding:0 1mm}
    .rcpt.a4{font-size:12px;line-height:1.4;max-width:180mm;margin:0 auto}
    .seller{text-align:center} .a4 .seller{text-align:left}
    .big{font-size:1.25em} .small{font-size:.85em} .mono{font-family:monospace;word-break:break-all}
    .title{font-weight:bold;text-align:center;margin:2mm 0;border-top:1px dashed #000;border-bottom:1px dashed #000;padding:1mm 0;font-size:1.1em}
    .a4 .title{font-size:1.6em;text-align:left;border:0;margin:6mm 0 3mm}
    .row{display:flex;justify-content:space-between;gap:2mm} .row span:last-child{text-align:right;white-space:nowrap}
    .it{margin:1mm 0} .nm{font-weight:bold}
    .sep{border-top:1px dashed #000;margin:2mm 0}
    .total{font-size:1.35em;font-weight:bold;margin:1.5mm 0}
    table{width:100%;border-collapse:collapse;margin:2mm 0} th{text-align:left;font-weight:bold;border-bottom:1px solid #000}
    td,th{padding:.5mm 1mm} .r{text-align:right}
    .a4 table.items td{border-bottom:1px solid #ccc;padding:1.5mm 1mm}
    .cust{margin:2mm 0;padding:1mm;border:1px solid #000} .lbl{font-size:.85em}
    .eet{margin-top:2mm;font-size:.9em;border-top:1px dashed #000;padding-top:1mm}
    .foot{text-align:center;margin-top:3mm;font-style:italic}
  `;
  const PAGE = { 80: '@page{size:80mm auto;margin:2mm}body{width:76mm}', 58: '@page{size:58mm auto;margin:1mm}body{width:56mm;font-size:11px}', A4: '@page{size:A4;margin:15mm}' };

  const wrap = (inner, paper) =>
    `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}${PAGE[paper] || PAGE[80]}</style></head><body>${inner}</body></html>`;

  function printHtml(inner, paper) {
    const f = document.getElementById('print-frame');
    const doc = f.contentDocument;
    doc.open();
    doc.write(wrap(inner, paper));
    doc.close();
    const prev = document.activeElement;
    setTimeout(() => {
      f.contentWindow.focus();
      f.contentWindow.print();
      // Vrátit fokus do aplikace, aby fungovala klávesnice / čtečka kódů.
      window.focus();
      if (prev && document.contains(prev)) prev.focus();
    }, 150);
  }

  window.Receipt = {
    render, CSS, isFull,
    print(r, paper) { printHtml(render(r, { paper }), paper); },
    printRaw: printHtml,
    /** Celý HTML dokument pro náhled v <iframe srcdoc>. */
    doc(r, paper) { return wrap(`<div style="padding:8px">${render(r, { paper })}</div>`, paper === 'A4' ? 'A4' : paper).replace(/@page[^}]*\}body\{[^}]*\}/, ''); },
    kc, dt, esc,
  };
})();

#!/usr/bin/env node
'use strict';
// Hromadný import z příkazové řádky:
//   node scripts/import.js seznam.txt            -> jen náhled
//   node scripts/import.js seznam.txt --apply    -> provést (množství se přičte)
//   node scripts/import.js seznam.txt --set --apply  -> inventura (sklad = množství)
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('Použití: node scripts/import.js <soubor> [--set] [--apply]'); process.exit(1); }
const importer = require('../src/importer');
const text = fs.readFileSync(file, 'utf8');
const mode = args.includes('--set') ? 'set' : 'add';
const kc = (h) => (h / 100).toFixed(2).replace('.', ',');
const p = args.includes('--apply') ? importer.apply(text, mode, 'import') : importer.plan(text, mode);
for (const r of p.rows) {
  if (r.action === 'create') console.log(`+ NOVÉ   ${r.product.name} | ${r.product.barcode || '-'} | ${kc(r.product.price)} Kč | ${r.product.vat} % | sklad ${r.product.stock}`);
  else if (r.action === 'update') console.log(`~ ZMĚNA  ${r.productName}: ` + Object.entries(r.changes).map(([k, [a, b]]) => `${k} ${['price', 'purchase'].includes(k) ? kc(a) + '→' + kc(b) : a + '→' + b}`).join(', '));
  else if (r.action === 'same') console.log(`= BEZ ZMĚNY ${r.productName}`);
  else console.log(`! CHYBA ř.${r.line}: ${r.errors.join(', ')}  «${r.text}»`);
}
console.log(`\nNové: ${p.summary.create}, změny: ${p.summary.update}, beze změny: ${p.summary.same}, chyby: ${p.summary.error}` + (args.includes('--apply') ? '  ✔ ULOŽENO' : '  (náhled – pro uložení přidejte --apply)'));

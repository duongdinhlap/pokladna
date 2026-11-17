'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-imp-'));
const importer = require('../src/importer');

test('import: bez hlavičky, různé oddělovače, nové + chyby', () => {
  const p = importer.plan('8594001234567; Rohlík; 3,90; 12; 50\nNước mắm 500ml\t89,90\t12\t20\nGạo ST25 5kg, 249, 12%, 10\nCoca-Cola 0,5l, 39,90, 21\nSai; abc; 21');
  assert.deepStrictEqual(p.summary, { create: 4, update: 0, same: 0, error: 1 });
  assert.strictEqual(p.rows[0].product.barcode, '8594001234567');
  assert.strictEqual(p.rows[2].product.price, 24900);
  assert.strictEqual(p.rows[3].product.name, 'Coca-Cola 0,5l');
  assert.strictEqual(p.rows[3].product.price, 3990);
});

test('import: hlavička, uložení, přičtení a inventura', () => {
  importer.apply('Mã vạch;Tên hàng;Giá bán;Thuế;Số lượng\n111222333;Chuối;39,90;12;10', 'add', 't');
  let p = importer.apply('111222333;Chuối;42;12;5', 'add', 't');
  assert.deepStrictEqual(p.rows[0].changes, { price: [3990, 4200], stock: [10, 15] });
  p = importer.apply('111222333;;;;3', 'set', 't');
  assert.deepStrictEqual(p.rows[0].changes, { stock: [15, 3] });
  p = importer.plan('111222333;Chuối;42');
  assert.strictEqual(p.rows[0].action, 'same');
});

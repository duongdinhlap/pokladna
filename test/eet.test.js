'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const forge = require('node-forge');
const eet = require('../src/eet');
const { vatSummary } = require('../src/receipts');

test('formatAmount odpovídá masce CastkaType', () => {
  for (const [h, s] of [[0, '0.00'], [5, '0.05'], [-5, '-0.05'], [12350, '123.50'], [-12350, '-123.50'], [9999999999, '99999999.99']]) {
    assert.strictEqual(eet.formatAmount(h), s);
    assert.match(s, eet.RE.amount);
  }
});

test('pragueDateTime má časovou zónu', () => {
  assert.strictEqual(eet.pragueDateTime(new Date('2027-01-09T03:25:28Z')), '2027-01-09T04:25:28+01:00');
  assert.strictEqual(eet.pragueDateTime(new Date('2027-06-09T03:25:28Z')), '2027-06-09T05:25:28+02:00');
});

test('podepsaná zpráva: digest těla a podpis sedí', () => {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey; cert.serialNumber = '01';
  cert.validity.notBefore = new Date(); cert.validity.notAfter = new Date(Date.now() + 864e5);
  cert.setSubject([{ name: 'commonName', value: 'CZ00000019' }]); cert.setIssuer([{ name: 'commonName', value: 'CZ00000019' }]);
  cert.sign(keys.privateKey);
  const cfg = { eic: 'CZ00000019', unitId: 11, posId: 'P-1', keyPem: forge.pki.privateKeyToPem(keys.privateKey), certPem: forge.pki.certificateToPem(cert) };
  const { xml } = eet.buildMessage({ seq: '2027000001', saleTime: '2027-01-09T04:25:28+01:00', amount: 12350, first: true }, cfg);
  const body = /<soapenv:Body[\s\S]*<\/soapenv:Body>/.exec(xml)[0];
  const digest = /<ds:DigestValue>([^<]+)/.exec(xml)[1];
  assert.strictEqual(crypto.createHash('sha256').update(body).digest('base64'), digest);
  const signedInfo = /<ds:SignedInfo[^>]*>[\s\S]*<\/ds:SignedInfo>/.exec(xml)[0];
  const sig = /<ds:SignatureValue>([^<]+)/.exec(xml)[1];
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(signedInfo), cfg.certPem, Buffer.from(sig, 'base64')));
  assert.match(xml, /celk_trzba="123.50"/);
  assert.match(xml, /prvni_zaslani="true"/);
});

test('parseResponse: potvrzení, chyba, varování', () => {
  const ok = eet.parseResponse('<eet:Odpoved><eet:Hlavicka uuid_zpravy="x" dat_prij="2027-01-01T10:00:00+01:00"/><eet:Potvrzeni pok="987a6be5-6af5-44f3-b4fc-987654321000-ff" test="true"/><eet:Varovani kod_varov="6">Spatne ID</eet:Varovani></eet:Odpoved>');
  assert.strictEqual(ok.ok, true); assert.strictEqual(ok.test, true); assert.strictEqual(ok.warnings[0].code, 6);
  const err = eet.parseResponse('<eet:Odpoved><eet:Hlavicka dat_odmit="x"/><eet:Chyba kod="-1">Docasna technicka chyba</eet:Chyba></eet:Odpoved>');
  assert.strictEqual(err.ok, false); assert.strictEqual(err.errorCode, -1);
});

test('rekapitulace DPH z ceny s daní', () => {
  const v = vatSummary([{ vat_rate: 21, total: 12100 }, { vat_rate: 12, total: 1120 }], true);
  assert.deepStrictEqual(v, [{ rate: 21, base: 10000, vat: 2100, gross: 12100 }, { rate: 12, base: 1000, vat: 120, gross: 1120 }]);
  assert.strictEqual(vatSummary([{ vat_rate: 21, total: 100 }], false)[0].vat, 0);
});

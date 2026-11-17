'use strict';
// EET 2.0 client — rozhraní verze 4.1 (SOAP + WS-Security, RSA-SHA256, Exclusive C14N).
// Podle dokumentu Finanční správy "Popis datového rozhraní" v1.2a a EETXMLSchema.xsd.
const crypto = require('node:crypto');
const forge = require('node-forge');

const ENDPOINTS = {
  playground: 'https://pg.trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4',
  production: 'https://trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4',
};
const SOAP_ACTION = 'http://fs.gov.cz/eet/OdeslaniTrzby';
const NS = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  eet: 'http://fs.gov.cz/eet/schema/v4',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
};
const C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';

const RE = {
  eic: /^CZ[0-9]{8,10}$/,
  unit: /^[1-9][0-9]{0,8}$/,
  pos: /^[0-9a-zA-Z.,:;/#\-_ ]{1,20}$/,
  seq: /^[0-9a-zA-Z.,:;/#\-_ ]{1,25}$/,
  amount: /^((0|-?[1-9]\d{0,7})\.\d\d|-0\.(0[1-9]|[1-9]\d))$/,
};

/** Částka v haléřích -> "123.45" podle masky CastkaType. */
function formatAmount(hal) {
  const neg = hal < 0;
  const a = Math.abs(Math.round(hal));
  const s = Math.floor(a / 100) + '.' + String(a % 100).padStart(2, '0');
  return neg && a !== 0 ? '-' + s : s;
}

/** Místní čas v ČR s časovou zónou: 2027-01-09T04:25:28+01:00 */
function pragueDateTime(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Prague', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  const offMin = Math.round((Date.parse(local + 'Z') - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  const sign = offMin < 0 ? '-' : '+';
  const o = Math.abs(offMin);
  return `${local}${sign}${String(Math.floor(o / 60)).padStart(2, '0')}:${String(o % 60).padStart(2, '0')}`;
}

/** Načte pokladní certifikát (.p12) -> { keyPem, certPem, certB64, eic, validTo } */
function loadP12(buffer, password) {
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(buffer.toString('binary')), password || '');
  } catch (e) {
    const err = new Error('P12_INVALID');
    err.detail = e.message;
    throw err;
  }
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || []),
  ];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
  if (!keyBags.length || !certBags.length) throw new Error('P12_INVALID');
  const key = keyBags[0].key;
  // Certifikát patřící ke klíči (ne certifikáty CA).
  const own = certBags.map((b) => b.cert).find(
    (c) => c && c.publicKey && c.publicKey.n && c.publicKey.n.compareTo(key.n) === 0
  ) || certBags[0].cert;
  const certPem = forge.pki.certificateToPem(own);
  const cn = own.subject.getField('CN');
  return {
    keyPem: forge.pki.privateKeyToPem(key),
    certPem,
    eic: cn ? String(cn.value) : '',
    validFrom: own.validity.notBefore.toISOString(),
    validTo: own.validity.notAfter.toISOString(),
  };
}

function certB64(certPem) {
  return certPem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
}

/**
 * Sestaví podepsanou SOAP zprávu. Tělo i SignedInfo se generují rovnou
 * v kanonickém tvaru (Exclusive XML C14N), takže není potřeba XML knihovna.
 */
function buildMessage(sale, cfg) {
  const d = {
    eic_popl: cfg.eic,
    id_jednotky: String(cfg.unitId),
    id_pokl: cfg.posId,
    porad_cis: sale.seq,
    dat_trzby: sale.saleTime,
    celk_trzba: formatAmount(sale.amount),
  };
  if (!RE.eic.test(d.eic_popl)) throw new Error('EET_BAD_EIC');
  if (!RE.unit.test(d.id_jednotky)) throw new Error('EET_BAD_UNIT');
  if (!RE.pos.test(d.id_pokl)) throw new Error('EET_BAD_POS');
  if (!RE.seq.test(d.porad_cis)) throw new Error('EET_BAD_SEQ');
  if (!RE.amount.test(d.celk_trzba)) throw new Error('EET_BAD_AMOUNT');

  const uuid = crypto.randomUUID();
  const sentAt = pragueDateTime(new Date());
  // Atributy v abecedním pořadí = kanonický tvar.
  const head =
    `dat_odesl="${sentAt}"` + (sale.verify ? ' overeni="true"' : '') +
    ` prvni_zaslani="${sale.first ? 'true' : 'false'}" uuid_zpravy="${uuid}"`;
  const data = Object.keys(d).sort().map((k) => `${k}="${d[k]}"`).join(' ');
  const bodyId = 'Body-' + uuid;
  const body =
    `<soapenv:Body xmlns:soapenv="${NS.soap}" xmlns:wsu="${NS.wsu}" wsu:Id="${bodyId}">` +
    `<v4:Trzba xmlns:v4="${NS.eet}"><v4:Hlavicka ${head}></v4:Hlavicka><v4:Data ${data}></v4:Data></v4:Trzba>` +
    `</soapenv:Body>`;
  const digest = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
  const signedInfoInner =
    `<ds:CanonicalizationMethod Algorithm="${C14N}"></ds:CanonicalizationMethod>` +
    `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod>` +
    `<ds:Reference URI="#${bodyId}"><ds:Transforms><ds:Transform Algorithm="${C14N}"></ds:Transform></ds:Transforms>` +
    `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>` +
    `<ds:DigestValue>${digest}</ds:DigestValue></ds:Reference>`;
  const signedInfo = `<ds:SignedInfo xmlns:ds="${NS.ds}">${signedInfoInner}</ds:SignedInfo>`;
  const signature = crypto.createSign('RSA-SHA256').update(signedInfo, 'utf8').sign(cfg.keyPem, 'base64');
  const tokenId = 'X509-' + uuid;
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="${NS.soap}"><soapenv:Header>` +
    `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}">` +
    `<wsse:BinarySecurityToken EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary" ` +
    `ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3" wsu:Id="${tokenId}">${certB64(cfg.certPem)}</wsse:BinarySecurityToken>` +
    `<ds:Signature xmlns:ds="${NS.ds}">${signedInfo}<ds:SignatureValue>${signature}</ds:SignatureValue>` +
    `<ds:KeyInfo><wsse:SecurityTokenReference><wsse:Reference URI="#${tokenId}" ` +
    `ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"/></wsse:SecurityTokenReference></ds:KeyInfo>` +
    `</ds:Signature></wsse:Security></soapenv:Header>${body}</soapenv:Envelope>`;
  return { xml, uuid, sentAt };
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag || '');
  return m ? m[1] : null;
}

/** Rozbor odpovědi (Potvrzeni / Chyba / Varovani). */
function parseResponse(xml) {
  const out = { ok: false, pok: null, test: false, errorCode: null, errorText: null, warnings: [], receivedAt: null };
  const head = /<(?:\w+:)?Hlavicka\b[^>]*>/.exec(xml);
  if (head) out.receivedAt = attr(head[0], 'dat_prij') || attr(head[0], 'dat_odmit');
  const conf = /<(?:\w+:)?Potvrzeni\b[^>]*>/.exec(xml);
  if (conf) {
    out.ok = true;
    out.pok = attr(conf[0], 'pok');
    out.test = /^(true|1)$/.test(attr(conf[0], 'test') || '');
  }
  const err = /<(?:\w+:)?Chyba\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Chyba>/.exec(xml);
  if (err) {
    out.errorCode = Number(attr(err[1], 'kod'));
    out.errorText = err[2].replace(/\s+/g, ' ').trim();
    out.test = /^(true|1)$/.test(attr(err[1], 'test') || '');
  }
  const wre = /<(?:\w+:)?Varovani\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Varovani>/g;
  let w;
  while ((w = wre.exec(xml))) out.warnings.push({ code: Number(attr(w[1], 'kod_varov')), text: w[2].replace(/\s+/g, ' ').trim() });
  if (!conf && !err) {
    const fault = /<faultstring[^>]*>([\s\S]*?)<\/faultstring>/.exec(xml);
    out.errorCode = -1000;
    out.errorText = fault ? fault[1].trim() : 'Neznama odpoved serveru';
  }
  return out;
}

/**
 * Odešle tržbu. Výsledek:
 *  { ok, pok, test, errorCode, errorText, warnings, uuid, sentAt, traceId, retryable }
 * retryable = true -> síť/dočasná chyba, zkusit znovu později (prvni_zaslani=false).
 */
async function send(sale, cfg) {
  const { xml, uuid, sentAt } = buildMessage(sale, cfg);
  const url = cfg.endpoint || ENDPOINTS[cfg.env] || ENDPOINTS.playground;
  const timeoutMs = Math.max(2000, cfg.timeoutMs || 8000); // mezní doba odezvy min. 2 s
  let res, text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: SOAP_ACTION },
      body: xml,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (e) {
    return { ok: false, retryable: true, errorCode: null, errorText: 'NETWORK: ' + (e.cause?.code || e.name || e.message), warnings: [], uuid, sentAt };
  }
  const r = parseResponse(text);
  r.uuid = uuid;
  r.sentAt = sentAt;
  r.traceId = res.headers.get('x-global-transaction-id');
  // Ověřovací režim: kód 0 = zpráva je v pořádku.
  if (sale.verify && r.errorCode === 0) r.ok = true;
  // Dočasné technické chyby (záporné kódy) a HTTP 5xx => opakovat.
  r.retryable = !r.ok && (r.errorCode === null || r.errorCode < 0 || res.status >= 500);
  return r;
}

module.exports = { send, buildMessage, parseResponse, loadP12, formatAmount, pragueDateTime, ENDPOINTS, RE };

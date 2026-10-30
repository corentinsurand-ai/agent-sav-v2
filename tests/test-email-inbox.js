// ============================================================================
// Tests C5.2 — api/emails.js (polling IMAP + lecture) + lib/mail.js + lib/imap.js
// Exécution : node --test tests/test-email-inbox.js
// ============================================================================

var test = require('node:test');
var assert = require('node:assert');

var mail = require('../lib/mail');
var imapLib = require('../lib/imap');

// ---- Mock fetch global -------------------------------------------------------
var APPELS = [];
var REGLES = [];   // [{ test: fn(url), status, corps }]

function reponseJson(status, corps) {
  return { ok: status >= 200 && status < 300, status: status, json: async function () { return corps; } };
}

var fetchReel = global.fetch;
global.fetch = async function (url, opts) {
  APPELS.push({ url: String(url), opts: opts || {} });
  for (var i = 0; i < REGLES.length; i++) {
    if (REGLES[i].test(String(url))) return reponseJson(REGLES[i].status, REGLES[i].corps);
  }
  return reponseJson(200, []);
};

// ---- Mock boîte IMAP (on patche imapLib.ouvrirBoite) --------------------------
var ouvrirReel = imapLib.ouvrirBoite;
var ETAT_BOITE = { uids: [], messages: {}, erreurLogin: false };
var FERME = false;

imapLib.ouvrirBoite = async function (opts) {
  if (ETAT_BOITE.erreurLogin) throw new Error('IMAP LOGIN refuse : A1 NO Authentication error');
  return {
    chercherNouveaux: async function (dernierUid, max) {
      var u = ETAT_BOITE.uids.filter(function (x) { return x > dernierUid; });
      u.sort(function (a, b) { return a - b; });
      return u.slice(0, max || 20);
    },
    lireMessage: async function (uid) { return ETAT_BOITE.messages[uid] || ''; },
    finir: async function () { FERME = true; }
  };
};

var handler = require('../api/emails');

// ---- Fabrique requête/réponse -------------------------------------------------
function reqRepGet(query, secretHeader) {
  var req = { method: 'GET', url: query, headers: {}, on: function () { return req; } };
  if (secretHeader) req.headers['x-webhook-secret'] = secretHeader;
  var res = { writeHead: function (code) { res.code = code; }, end: function (c) { res.corps = JSON.parse(c); } };
  return { req: req, res: res };
}

function reset(boite) {
  APPELS = []; REGLES = []; FERME = false;
  ETAT_BOITE = boite || { uids: [], messages: {}, erreurLogin: false };
}

function config() {
  process.env.WEBHOOK_SECRET = 'abc';
  process.env.SUPABASE_URL = 'https://supa.test';
  process.env.SUPABASE_SERVICE_KEY = 'cle';
  process.env.SMTP_HOST = 'ex3.mail.ovh.net';
  process.env.SMTP_USER = 'corentin.surand@umob.fr';
  process.env.SMTP_PASS = 'mdp';
}

// ---- Tests route --------------------------------------------------------------
test('secret manquant : 401', async function () {
  config(); reset();
  var rr = reqRepGet('/api/emails?poll=1');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.code, 401);
});

test('config absente : 500', async function () {
  delete process.env.SUPABASE_URL;
  reset();
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  process.env.SUPABASE_URL = 'https://supa.test';
  assert.equal(rr.res.code, 500);
});

test('nominal : 2 nouveaux emails, 2 importes, boite fermee, journal ok', async function () {
  config(); reset({
    uids: [101, 102],
    messages: {
      101: 'From: Client Un <client@example.com>\r\nMessage-ID: <m101@x>\r\nSubject: Panne scooter\r\n\r\nBonjour, mon scooter ne charge plus.',
      102: 'From: client2@example.com\r\n\r\nSujet et message-id absents'
    }
  });
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.code, 200);
  assert.equal(rr.res.corps.importes, 2);
  assert.equal(rr.res.corps.ignores, 0);
  assert.ok(FERME, 'LOGOUT/fermeture attendus');
  var inserts = APPELS.filter(function (a) { return a.opts.method === 'POST' && a.url.indexOf('on_conflict') !== -1; });
  assert.equal(inserts.length, 2);
  var corps1 = JSON.parse(inserts[0].opts.body)[0];
  assert.equal(corps1.sens, 'entrant');
  assert.equal(corps1.from_addr, 'client@example.com');
  assert.equal(corps1.message_id, 'm101@x');
  assert.equal(corps1.uid_imap, 101);
  var journaux = APPELS.filter(function (a) { return a.url.indexOf('/journal') !== -1; });
  assert.ok(journaux.length >= 1);
  assert.match(JSON.parse(journaux[0].opts.body).message, /poll IMAP ok/);
});

test('email de nous-meme ignore', async function () {
  config(); reset({
    uids: [201],
    messages: { 201: 'From: corentin.surand@umob.fr\r\nSubject: Test\r\n\r\nmoi' }
  });
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.corps.importes, 0);
  assert.equal(rr.res.corps.ignores, 1);
});

test('premier run (dernierUid=0) : 25 uids -> seulement les 8 derniers', async function () {
  config(); reset({
    uids: Array.from({ length: 25 }, function (_, i) { return i + 1; }),
    messages: {}
  });
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.code, 200);
  assert.deepEqual(rr.res.corps.uids, [18, 19, 20, 21, 22, 23, 24, 25]);
});

test('LOGIN IMAP refuse : 502 + journal ERREUR', async function () {
  config(); reset({ uids: [], messages: {}, erreurLogin: true });
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.code, 502);
  assert.match(rr.res.corps.erreur, /LOGIN refuse/);
  var journaux = APPELS.filter(function (a) { return a.url.indexOf('/journal') !== -1; });
  assert.ok(journaux.length >= 1);
  assert.match(JSON.parse(journaux[0].opts.body).message, /ERREUR/);
});

test('colonne uid_imap absente (400) : repli brut + insert SANS uid_imap', async function () {
  config(); reset({ uids: [301, 302], messages: { 301: 'From: a@b.fr\r\n\r\nx', 302: 'From: c@d.fr\r\n\r\ny' } });
  REGLES = [
    { test: function (u) { return u.indexOf('select=uid_imap') !== -1; }, status: 400, corps: { code: 'PGRST204' } },
    { test: function (u) { return u.indexOf('select=brut') !== -1; }, status: 200, corps: [{ brut: { uid_imap: 300 } }] },
    { test: function (u) { return u.indexOf('on_conflict') !== -1; }, status: 201, corps: [] }
  ];
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.corps.colonne_uid, false);
  assert.equal(rr.res.corps.importes, 2);
  assert.deepEqual(rr.res.corps.uids, [301, 302]);
  var inserts = APPELS.filter(function (a) { return a.opts.method === 'POST' && a.url.indexOf('on_conflict') !== -1; });
  inserts.forEach(function (ins) {
    assert.equal(JSON.parse(ins.opts.body)[0].uid_imap, undefined, 'pas de colonne uid_imap quand absente');
  });
});

test('insert 409 doublon : ignore sans echec global', async function () {
  config(); reset({ uids: [401], messages: { 401: 'From: a@b.fr\r\n\r\nx' } });
  REGLES = [{ test: function (u) { return u.indexOf('on_conflict') !== -1; }, status: 409, corps: { code: '23505' } }];
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.code, 200);
  assert.equal(rr.res.corps.importes, 0);
  assert.equal(rr.res.corps.ignores, 1);
  assert.ok(FERME);
});

test('message vide : echec compte, route 200', async function () {
  config(); reset({ uids: [501], messages: {} });
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.code, 200);
  assert.equal(rr.res.corps.echecs, 1);
});

test('date invalide : recu_a = now, pas de crash', async function () {
  config(); reset({ uids: [601], messages: { 601: 'From: a@b.fr\r\nDate: pas-une-date\r\n\r\nx' } });
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.corps.importes, 1);
  var ins = APPELS.filter(function (a) { return a.opts.method === 'POST' && a.url.indexOf('on_conflict') !== -1; })[0];
  assert.ok(JSON.parse(ins.opts.body)[0].recu_a);
});

// ---- Unitaires lib/mail.js ----------------------------------------------------
test('parseMessage : base64 accents + emoji, sujet B, nom Q, from addr', function () {
  var brut = 'From: =?UTF-8?Q?J=C3=A9r=C3=B4me_Martin?= <jerome@example.com>\r\nSubject: =?UTF-8?B?UsOpcGFyYXRpb24=?=\r\nMessage-ID: <abc@def>\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\nQ2hhcmdlIGVtZW50ZSBwbHVzIMOgIHNjb290ZXIg8J+btQ==';
  var m = mail.parseMessage(brut);
  assert.equal(m.from_addr, 'jerome@example.com');
  assert.equal(m.from_nom, 'Jérôme Martin');
  assert.equal(m.sujet, 'Réparation');
  assert.equal(m.message_id, 'abc@def');
  assert.ok(m.texte.indexOf('Charge') === 0);
  assert.ok(m.texte.indexOf(String.fromCodePoint(0x1F6F5)) !== -1, 'emoji décodé');
});

test('parseMessage : quoted-printable + multipart, plain prioritaire sur html', function () {
  var brut = [
    'From: a@b.fr', 'Subject: SAV',
    'Content-Type: multipart/alternative; boundary="XYZ"', '',
    '--XYZ', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable', '',
    'Bonjour caf=C3=A9,', 'ma batterie est HS.',
    '--XYZ', 'Content-Type: text/html', '',
    '<p>Bonjour <b>café</b></p>', '--XYZ--'
  ].join('\r\n');
  var m = mail.parseMessage(brut);
  assert.match(m.texte, /batterie est HS/);
  assert.ok(m.texte.indexOf('<p>') === -1, 'html non retenu quand plain existe');
  assert.ok(m.texte.indexOf('café') !== -1, 'quoted-printable décodé');
});

test('parseMessage : repli html detague sans plain', function () {
  var m = mail.parseMessage('From: a@b.fr\r\nContent-Type: text/html\r\n\r\n<p>Bonjour <b>UV</b></p>');
  assert.ok(m.texte.indexOf('<') === -1);
  assert.match(m.texte, /Bonjour UV/);
});

test('decoderB64 maison : accents + emoji', function () {
  assert.equal(mail.decoderB64('Q2Fmw6k='), 'Café');
  assert.equal(mail.decoderB64('8J+btQ=='), String.fromCodePoint(0x1F6F5));
});

// ---- Unitaires lib/imap.js ----------------------------------------------------
test('extraireReponse : faux OK dans un litteral ignore (octets), complet vs tronque', function () {
  var corps = 'From: a@b.fr\r\nSujet: contient A5 OK au milieu\r\n\r\nligne avec accents éà';
  var lit = Buffer.from(corps, 'utf8').length;
  var buf2 = Buffer.concat([
    Buffer.from('* 1 FETCH (BODY[] {' + lit + '}\r\n', 'latin1'),
    Buffer.from(corps, 'utf8'),
    Buffer.from(')\r\n', 'latin1'),
    Buffer.from('A5 OK Fetch completed\r\n', 'latin1')
  ]);
  var r = imapLib.extraireReponse(buf2, 'A5');
  assert.ok(r !== null, 'réponse complète attendue');
  assert.match(r.texte, /<LIT>/);
  assert.ok(r.texte.indexOf('A5 OK Fetch completed') !== -1);
  assert.equal(r.consommation, buf2.length);
  var tronque = buf2.slice(0, buf2.length - 30);
  assert.equal(imapLib.extraireReponse(tronque, 'A5'), null, 'tronque : null');
});

test('uidsDeRecherche + litteralFetch + estOk', function () {
  assert.deepEqual(imapLib.uidsDeRecherche('* SEARCH 5 12 30\r\nA2 OK'), [5, 12, 30]);
  assert.deepEqual(imapLib.uidsDeRecherche('A2 OK Search completed'), []);
  assert.equal(imapLib.litteralFetch('* FETCH {3}\r\n<LIT>abc</LIT>),\r\nA3 OK'), 'abc');
  assert.equal(imapLib.litteralFetch('A3 OK sans litteral'), null);
  assert.ok(imapLib.estOk('A1 OK [CAPABILITY x] ready', 'A1'));
  assert.ok(!imapLib.estOk('A1 NO Authentication error', 'A1'));
  assert.ok(!imapLib.estOk('A1 BAD Command', 'A1'));
});

// ---- Tests lecture (ex email-messages, désormais dans /api/emails) -----------
test('lecture liste : plus recents en bas (asc), total, sans poll', async function () {
  config(); reset();
  REGLES = [{ test: function (u2) { return u2.indexOf('order=id.desc') !== -1; }, status: 200, corps: [{ id: 3, sujet: 'C' }, { id: 2, sujet: 'B' }, { id: 1, sujet: 'A' }] }];
  var rr = reqRepGet('/api/emails?secret=abc&liste=1&limite=50');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.code, 200);
  assert.equal(rr.res.corps.ok, true);
  assert.equal(rr.res.corps.total, 3);
  assert.deepEqual(rr.res.corps.messages.map(function (m) { return m.sujet; }), ['A', 'B', 'C']);
});

test('lecture par email : filtre or(from,to) + ordre asc', async function () {
  config(); reset();
  REGLES = [{ test: function (u2) { return u2.indexOf('order=id.asc') !== -1; }, status: 200, corps: [{ id: 1, from_addr: 'x@y.fr' }] }];
  var rr = reqRepGet('/api/emails?secret=abc&email=x@y.fr&limite=100');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.code, 200);
  assert.equal(rr.res.corps.email, 'x@y.fr');
  var appel = APPELS.find(function (a) { return a.url.indexOf('order=id.asc') !== -1; });
  assert.ok(appel, 'appel Supabase attendu');
  assert.ok(appel.url.indexOf('from_addr.eq.x%40y.fr') !== -1, 'filtre from');
  assert.ok(appel.url.indexOf('to_addr.eq.x%40y.fr') !== -1, 'filtre to');
});

test('lecture sans secret : 401', async function () {
  config(); reset();
  var rr = reqRepGet('/api/emails?liste=1');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.code, 401);
});

test('teardown : restaure ouvrirBoite et fetch', function () {
  imapLib.ouvrirBoite = ouvrirReel;
  global.fetch = fetchReel;
  assert.equal(typeof imapLib.ouvrirBoite, 'function');
});

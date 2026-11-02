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
  // FUS-5 : plus de on_conflict (pas de contrainte unique) -> POST /emails direct,
  // doublon evite par pre-verification GET message_id
  var inserts = APPELS.filter(function (a) { return a.opts.method === 'POST' && a.url.indexOf('/emails') !== -1; });
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
    { test: function (u) { return u.indexOf('/emails') !== -1 && u.indexOf('?') === -1; }, status: 201, corps: [] }
  ];
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.corps.colonne_uid, false);
  assert.equal(rr.res.corps.importes, 2);
  assert.deepEqual(rr.res.corps.uids, [301, 302]);
  var inserts = APPELS.filter(function (a) { return a.opts.method === 'POST' && a.url.indexOf('/emails') !== -1; });
  inserts.forEach(function (ins) {
    assert.equal(JSON.parse(ins.opts.body)[0].uid_imap, undefined, 'pas de colonne uid_imap quand absente');
  });
});

test('doublon deja en base : pre-verification GET -> doublons, pas d insert', async function () {
  config(); reset({ uids: [401], messages: { 401: 'From: a@b.fr\r\nMessage-ID: <dup@x>\r\n\r\nx' } });
  REGLES = [{ test: function (u) { return u.indexOf('message_id=eq.dup') !== -1; }, status: 200, corps: [{ id: 7 }] }];
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.code, 200);
  assert.equal(rr.res.corps.importes, 0);
  assert.equal(rr.res.corps.doublons, 1);
  assert.equal(rr.res.corps.echecs, 0);
  assert.ok(FERME);
});

test('insert echoue deux fois : echec compte, corps erreur capture, route 200', async function () {
  config(); reset({ uids: [401], messages: { 401: 'From: a@b.fr\r\n\r\nx' } });
  REGLES = [{ test: function (u) { return u.indexOf('select=id') === -1; }, status: 409, corps: { code: '23505' } }];
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.code, 200);
  assert.equal(rr.res.corps.importes, 0);
  assert.equal(rr.res.corps.echecs, 1);
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
  var ins = APPELS.filter(function (a) { return a.opts.method === 'POST' && a.url.indexOf('/emails') !== -1; })[0];
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

// ---- FIX CHARSET 02/11 : Windows-1252 / ISO-8859-1 honorés --------------------
test('quoted-printable windows-1252 : accents + euro décodés (pas de mojibake)', function () {
  var brut = [
    'From: a@b.fr', 'Subject: Signe',
    'Content-Type: text/plain; charset=Windows-1252',
    'Content-Transfer-Encoding: quoted-printable', '',
    'Caf=E9 co=FBte 1500=80'
  ].join('\r\n');
  var m = mail.parseMessage(brut);
  assert.ok(m.texte.indexOf('Café') !== -1, 'accent 1252');
  assert.ok(m.texte.indexOf('coûte') !== -1, '^ 1252 (0xFB = u circumflex)');
  assert.ok(m.texte.indexOf('1500€') !== -1, 'euro 0x80 en 1252 (0x80 en utf8 = suite invalide)');
});

test('base64 iso-8859-1 : octets simples décodés selon le charset déclaré', function () {
  var brut = [
    'From: a@b.fr', 'Subject: B64 latin1',
    'Content-Type: text/plain; charset=iso-8859-1',
    'Content-Transfer-Encoding: base64', '',
    '6Q==' // octet 0xE9 = é en latin1
  ].join('\r\n');
  var m = mail.parseMessage(brut);
  assert.equal(m.texte, 'é');
});

test('encoded-word en-tete windows-1252 : =?windows-1252?Q?...?= décodé', function () {
  assert.equal(mail.decoderMot('=?iso-8859-1?Q?J=E9r=F4me_Martin?='), 'Jérôme Martin');
  assert.equal(mail.decoderMot('=?windows-1252?Q?Paiement_de_1500=80?='), 'Paiement de 1500€');
});

test('multipart html windows-1252 : repli détagé lisible, entités html', function () {
  var brut = [
    'From: a@b.fr', 'Subject: Outlook',
    'Content-Type: multipart/alternative; boundary="W"', '',
    '--W', 'Content-Type: text/html; charset=Windows-1252',
    'Content-Transfer-Encoding: quoted-printable', '',
    '<p>Une demande relative =E0 vos scooters&nbsp;? Cliquez =94&nbsp;ici=85</p>',
    '--W--'
  ].join('\r\n');
  var m = mail.parseMessage(brut);
  assert.ok(m.texte.indexOf('à vos scooters') !== -1, 'accent corps html 1252');
  assert.ok(m.texte.indexOf('“') !== -1 || m.texte.indexOf('ici') !== -1, 'typo 1252');
  assert.ok(m.texte.indexOf('<') === -1 && m.texte.indexOf('&nbsp;') === -1, 'dété et entités nettoyées');
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


// ---- C5.3 : stockage du corps HTML (rendu fidèle signatures/logos) ------------
test('C5.3 parseMessage multipart : m.html conserve la partie text/html', function () {
  var brut = [
    'From: a@b.fr', 'Subject: SAV',
    'Content-Type: multipart/alternative; boundary="XYZ"', '',
    '--XYZ', 'Content-Type: text/plain; charset=UTF-8', '',
    'Bonjour,', 'ma batterie est HS.',
    '--XYZ', 'Content-Type: text/html; charset=UTF-8', '',
    '<p>Bonjour <b>café</b></p>', '--XYZ--'
  ].join('\r\n');
  var m = mail.parseMessage(brut);
  assert.ok(m.html, 'html present');
  assert.ok(m.html.indexOf('<b>caf\u00e9</b>') !== -1, 'html avec accents conservé');
  assert.match(m.texte, /batterie est HS/, 'plain toujours prioritaire pour texte');
});

test('C5.3 parseMessage : image cid: inline en data URI dans m.html', function () {
  var brut = [
    'From: a@b.fr', 'Subject: Signature',
    'Content-Type: multipart/related; boundary="REL"', '',
    '--REL', 'Content-Type: text/html; charset=UTF-8', '',
    '<p>Bonjour</p><img src="cid:logo@x"> fin', '',
    '--REL', 'Content-Type: image/png', 'Content-Transfer-Encoding: base64',
    'Content-ID: <logo@x>', '',
    'iVBORw0KGgoAAAANSU', '--REL--'
  ].join('\r\n');
  var m = mail.parseMessage(brut);
  assert.ok(m.html, 'html present');
  assert.ok(m.html.indexOf('data:image/png;base64,iVBORw0KGgoAAAANSU') !== -1, 'cid remplace par data URI');
  assert.ok(m.html.indexOf('cid:') === -1, 'plus aucun cid restant');
  assert.ok(m.texte.indexOf('data:') === -1, 'texte detague non pollue');
});

test('C5.3b parseMessage : multipart IMBRIQUE (Exchange mixed>related>alternative) — html + cid inline', function () {
  var brut = [
    'From: "Corentin SURAND" <corentin.surand@umob.fr>', 'Subject: TR: TEST',
    'Content-Type: multipart/mixed; boundary="MIX"', '',
    '--MIX', 'Content-Type: multipart/related; boundary="REL"', '',
    '--REL', 'Content-Type: multipart/alternative; boundary="ALT"', '',
    '--ALT', 'Content-Type: text/plain; charset=UTF-8', '', 'TEST plain', '',
    '--ALT', 'Content-Type: text/html; charset=UTF-8', '',
    '<p>TEST</p><img src="cid:image001.gif@01DD6AAB.B30C9100">', '',
    '--ALT--', '',
    '--REL', 'Content-Type: image/gif;', '\tname="image001.gif"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <image001.gif@01DD6AAB.B30C9100>', '', 'R0lGODlhAQABAAAA', '',
    '--REL--', '--MIX--'
  ].join('\r\n');
  var m = mail.parseMessage(brut);
  assert.ok(m.html, 'html present dans un nest profond');
  assert.ok(m.html.indexOf('data:image/gif;base64,R0lGODlhAQABAAAA') !== -1, 'cid imbrique inline en data URI');
  assert.ok(m.html.indexOf('cid:') === -1, 'plus aucun cid restant');
  assert.match(m.texte, /TEST plain/, 'plain prioritaire');
});

test('C5.3 parseMessage : non-multipart text/html -> html = corps decode, texte detague', function () {
  var m = mail.parseMessage('From: a@b.fr\r\nContent-Type: text/html\r\n\r\n<p>Bonjour <b>UV</b></p>');
  assert.ok(m.html.indexOf('<p>Bonjour <b>UV</b></p>') !== -1, 'html conserve tel quel');
  assert.match(m.texte, /Bonjour UV/, 'texte toujours detague');
});

test('C5.3 poller : colonne corps_html presente -> insere avec corps_html', async function () {
  config(); reset({
    uids: [701],
    messages: {
      701: 'From: a@b.fr\r\nSubject: Sig\r\nContent-Type: multipart/alternative; boundary="Z"\r\n\r\n--Z\r\nContent-Type: text/plain\r\n\r\nplain\r\n--Z\r\nContent-Type: text/html\r\n\r\n<p><b>html</b></p>\r\n--Z--'
    }
  });
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.corps.colonne_html, true);
  assert.equal(rr.res.corps.importes, 1);
  var ins = APPELS.filter(function (a) { return a.opts.method === 'POST' && a.url.indexOf('/emails') !== -1; })[0];
  var ligne = JSON.parse(ins.opts.body)[0];
  assert.ok(ligne.corps_html.indexOf('<b>html</b>') !== -1, 'corps_html insere');
});

test('C5.3 poller : colonne corps_html absente (400) -> insert SANS corps_html', async function () {
  config(); reset({
    uids: [702],
    messages: {
      702: 'From: c@d.fr\r\nSubject: H\r\nContent-Type: text/html\r\n\r\n<p>hello</p>'
    }
  });
  REGLES = [
    { test: function (u) { return u.indexOf('select=corps_html') !== -1; }, status: 400, corps: { code: 'PGRST204' } },
    { test: function (u) { return u.indexOf('select=id') === -1; }, status: 200, corps: [] },
    { test: function (u) { return u.indexOf('select=id') !== -1; }, status: 201, corps: [] }
  ];
  var rr = reqRepGet('/api/emails?poll=1', 'abc');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.corps.colonne_html, false);
  assert.equal(rr.res.corps.importes, 1);
  var ins = APPELS.filter(function (a) { return a.opts.method === 'POST' && a.url.indexOf('/emails') !== -1; })[0];
  assert.equal(JSON.parse(ins.opts.body)[0].corps_html, undefined, 'pas de corps_html quand colonne absente');
});

test('C5.3 lecture : select corps_html echoue (400) -> repli select de base', async function () {
  config(); reset();
  REGLES = [
    { test: function (u2) { return u2.indexOf('corps_html') !== -1; }, status: 400, corps: { code: 'PGRST204' } },
    { test: function (u2) { return u2.indexOf('order=id.desc') !== -1; }, status: 200, corps: [{ id: 1, sujet: 'A' }] }
  ];
  var rr = reqRepGet('/api/emails?secret=abc&liste=1&limite=50');
  await handler(rr.req, rr.res);
  assert.equal(rr.res.code, 200);
  assert.equal(rr.res.corps.total, 1);
  assert.ok(APPELS.filter(function (a) { return a.url.indexOf('corps_html') !== -1; }).length >= 1, 'premier essai avec corps_html');
  assert.ok(APPELS.filter(function (a) { return a.url.indexOf('corps_html') === -1 && a.url.indexOf('order=id.desc') !== -1; }).length >= 1, 'repli sans corps_html');
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

test('C5.3c parseMessage : signature VOLUMINEUSE (gif Outlook 585 Ko = 752k chars b64) acceptee', function () {
  var b64 = new Array(700001).join('A');           // ~700k chars > ancienne cap 600k
  var brut = [
    'From: Corentin Surand <corentin.surand@umob.fr>',
    'To: service.technique@umob.fr',
    'Subject: TEST',
    'Date: Mon, 02 Nov 2026 12:44:42 +0000',
    'Message-ID: <vol@test.umob.fr>',
    'Content-Type: multipart/related; boundary="_002_test_"',
    '',
    '--_002_test_',
    'Content-Type: text/html; charset="iso-8859-1"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<html><body>Retest bg <img src="cid:image001.gif@01DD6AAB.B30C9100"> fin</body></html>',
    '--_002_test_',
    'Content-Type: image/gif; name="image001.gif"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <image001.gif@01DD6AAB.B30C9100>',
    '',
    b64,
    '--_002_test_--',
    ''
  ].join('\r\n');
  var m = mail.parseMessage(brut);
  assert.ok(m.html.indexOf('data:image/gif;base64,') !== -1, 'image 700k chars inlinee en data URI');
  assert.strictEqual((m.html.match(/cid:/g) || []).length, 0, 'plus aucun cid residuel');
  assert.ok(m.html.length > 700000, 'html contient la data URI complete (cap relevee)');
});

test('C5-ENV-3 ouvrirBoite.dossierEnvoyes : LIST → trouve « Éléments envoyés »', async function () {
  var imap = require('../lib/imap');
  var conn = {
    dejaSalue: true,
    command: async function (cmd) {
      if (cmd.indexOf('LOGIN') === 0) return 'A1 OK LOGIN';
      if (cmd.indexOf('SELECT') === 0) return 'A2 OK [READ-WRITE] SELECT';
      if (cmd.indexOf('LIST') === 0) return '* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren) "/" "Corbeille"\r\n* LIST (\\HasNoChildren) "/" "Éléments envoyés"\r\nA3 OK LIST';
      return 'A4 OK';
    },
    fermer: function () {}
  };
  var boite = await imap.ouvrirBoite({ host: 'h', user: 'u', pass: 'p' }, { connexion: async function () { return conn; } });
  var dos = await boite.dossierEnvoyes();
  assert.strictEqual(dos, 'Éléments envoyés');
  await boite.finir();
});

test('C5-ENV-3 ouvrirBoite.envoyerCopie : APPEND avec littéral {N} octets + tag A900 OK', async function () {
  var imap = require('../lib/imap');
  var ecrits = [];
  var conn = {
    dejaSalue: true,
    ecrireBrut: function (t) { ecrits.push(String(t)); },
    attendreContinuation: async function () {},
    accu: function () { return ''; },
    command: async function (cmd) {
      if (cmd.indexOf('LOGIN') === 0) return 'A1 OK LOGIN';
      if (cmd.indexOf('SELECT') === 0) return 'A2 OK SELECT';
      if (cmd.indexOf('NOOP') === 0) return '+ Ready for literal\r\nA900 OK [APPENDUID] APPEND\r\nA3 OK NOOP';
      return 'A4 OK';
    },
    fermer: function () {}
  };
  var boite = await imap.ouvrirBoite({ host: 'h', user: 'u', pass: 'p' }, { connexion: async function () { return conn; } });
  var msg = 'Subject: test\r\n\r\nCorps avec accents éà\r\n';
  await boite.envoyerCopie('Éléments envoyés', msg);
  var append = ecrits.filter(function (e) { return e.indexOf('APPEND') !== -1; })[0];
  assert.ok(append, 'commande APPEND écrite');
  assert.ok(append.indexOf('A900 APPEND "Éléments envoyés" (\\Seen) {') !== -1, 'tag A900 + dossier échappé + drapeau \\Seen');
  assert.strictEqual(append.match(/\{(\d+)\}/)[1], String(Buffer.byteLength(msg, 'utf8')), 'taille du littéral en OCTETS utf-8');
  assert.ok(ecrits.indexOf(msg) !== -1, 'le message complet est écrit tel quel après la continuation');
  await boite.finir();
});

test('C5-ENV-3 envoyerCopie : APPEND refusé par le serveur → erreur explicite', async function () {
  var imap = require('../lib/imap');
  var conn = {
    dejaSalue: true,
    ecrireBrut: function () {},
    attendreContinuation: async function () {},
    accu: function () { return ''; },
    accu: function () { return ''; },
    command: async function (cmd) {
      if (cmd.indexOf('LOGIN') === 0) return 'A1 OK LOGIN';
      if (cmd.indexOf('SELECT') === 0) return 'A2 OK SELECT';
      if (cmd.indexOf('NOOP') === 0) return 'A900 NO [TRYCREATE] APPEND\r\nA3 OK NOOP';
      return 'A4 OK';
    },
    fermer: function () {}
  };
  var boite = await imap.ouvrirBoite({ host: 'h', user: 'u', pass: 'p' }, { connexion: async function () { return conn; } });
  await assert.rejects(function () { return boite.envoyerCopie('Inconnu', 'x'); }, /APPEND refuse/);
});

test('C5-ENV-3 dossierEnvoyes : nom ACCENTUÉ en littéral IMAP (<LIT>) + exclusion DEVIS ENVOYES', async function () {
  var imap = require('../lib/imap');
  var conn = {
    dejaSalue: true,
    command: async function (cmd) {
      if (cmd.indexOf('LOGIN') === 0) return 'A1 OK LOGIN';
      if (cmd.indexOf('SELECT') === 0) return 'A2 OK SELECT';
      if (cmd.indexOf('LIST') === 0) return '* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren) "/" "1. DEVIS ENVOYES"\r\n* LIST (\\HasNoChildren) "/" <LIT>Éléments envoyés</LIT>\r\nA3 OK LIST';
      return 'A4 OK';
    },
    fermer: function () {}
  };
  var boite = await imap.ouvrirBoite({ host: 'h', user: 'u', pass: 'p' }, { connexion: async function () { return conn; } });
  assert.strictEqual(await boite.dossierEnvoyes(), 'Éléments envoyés');
  await boite.finir();
});

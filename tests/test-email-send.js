// ============================================================================
// Tests /api/email-send (brique C5) — node --test
// Le vrai dialogue SMTP de lib/smtp.js est exercé via une connexion factice ;
// seuls les sockets réseau et Supabase sont mockés.
// ============================================================================
const test = require('node:test');
const assert = require('node:assert');
const reelSmtp = require('../lib/smtp');

var appelsFetch = [];
var reponseInsert = null;      // si défini : échec Supabase simulé

globalThis.fetch = async function(url, options) {
  url = String(url); options = options || {};
  appelsFetch.push({ url: url, options: options });
  if (reponseInsert && url.indexOf('emails') !== -1) {
    const r = reponseInsert; reponseInsert = null;
    return { ok: false, status: r.status, text: async () => JSON.stringify(r.corps || {}) };
  }
  return { ok: true, status: 201, text: async () => '' };
};

process.env.WEBHOOK_SECRET = 'secret-de-test-c5';
process.env.SUPABASE_URL = 'https://umob-crm.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'cle-service-test';
process.env.SMTP_HOST = 'ssl0.ovh.net';
process.env.SMTP_PORT = '465';
process.env.SMTP_USER = 'sav@umob.fr';
process.env.SMTP_PASS = 'motdepasse-test';
process.env.EMAIL_FROM = 'sav@umob.fr';

// Scénario SMTP nominal : 220, 250(EHLO), 334, 334, 235, 250, 250, 354, 250, 221
function scenarioNominal(surcharge) {
  var s = [[220, ['220 OVH ESMTP']], [250, ['250-mail.ovh.net', '250 AUTH LOGIN']],
           [334, ['334 VXNlcm5hbWU6']], [334, ['334 UGFzc3dvcmQ6']],
           [235, ['235 ok']], [250, ['250 OK']], [250, ['250 OK']],
           [354, ['354 go']], [250, ['250 queued']], [221, ['221 bye']]];
  if (surcharge) { Object.keys(surcharge).forEach(function(i) { s[Number(i)] = surcharge[i]; }); }
  return s;
}

function fauxServeur(scenario) {
  var commandes = [], lectures = 0;
  return {
    commandes: commandes,
    connexion: async function() {
      return {
        ecrire: async function(txt) { commandes.push(txt); },
        lireCode: async function() {
          var e = scenario[lectures++] || { code: 250, lignes: ['250 OK'] };
          return { code: e[0], lignes: e[1] };
        },
        fermer: function() { commandes.push('__FERME__'); }
      };
    }
  };
}

// Branchement du faux serveur : le handler utilise smtp.envoyerSmtp → on
// remplace la propriété (même instance de module grâce au cache require).
smtp = reelSmtp;
var envoyerReel = reelSmtp.envoyerSmtp;
reelSmtp.envoyerSmtp = function(opts) {
  return envoyerReel(opts, { connexion: COURANT.connexion });
};

var COURANT = fauxServeur(scenarioNominal());

const handler = require('../api/email-send');

function faireRes() {
  return {
    statusCode: null, corps: null,
    status: function(c) { this.statusCode = c; return this; },
    setHeader: function() {},
    end: function() {},
    json: function(j) { this.corps = j; return this; }
  };
}
function reqPost(corps, secret, headers) {
  return {
    method: 'POST', url: '/api/email-send' + (secret ? '?secret=' + encodeURIComponent(secret) : ''),
    headers: headers || {}, body: JSON.stringify(corps || {})
  };
}
function reqGet(secret) {
  return { method: 'GET', url: '/api/email-send?secret=' + encodeURIComponent(secret), headers: {}, body: null };
}
function raz() { appelsFetch = []; reponseInsert = null; COURANT = fauxServeur(scenarioNominal()); }

// ---------------------------------------------------------------- secret

test('mauvais secret → 401', async () => {
  raz();
  const res = faireRes();
  await handler(reqPost({ a: 'client@ex.fr', texte: 'bonjour' }, 'faux'), res);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.corps.ok, false);
});

test('secret via header x-webhook-secret → accepté', async () => {
  raz();
  const res = faireRes();
  await handler(reqPost({ a: 'client@ex.fr', texte: 'bonjour' }, null, { 'x-webhook-secret': 'secret-de-test-c5' }), res);
  assert.strictEqual(res.statusCode, 200);
});

// ---------------------------------------------------------------- méthode

test('GET → 405', async () => {
  raz();
  const res = faireRes();
  await handler(reqGet('secret-de-test-c5'), res);
  assert.strictEqual(res.statusCode, 405);
});

test('OPTIONS → 204 avec CORS', async () => {
  raz();
  const res = faireRes();
  await handler({ method: 'OPTIONS', url: '/api/email-send', query: {}, headers: {}, body: null }, res);
  assert.strictEqual(res.statusCode, 204);
});

// ---------------------------------------------------------------- paramètres

test('sans destinataire → 400', async () => {
  raz();
  const res = faireRes();
  await handler(reqPost({ texte: 'bonjour' }, 'secret-de-test-c5'), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/a requis/.test(res.corps.erreur));
});

test('destinataire invalide → 400', async () => {
  raz();
  const res = faireRes();
  await handler(reqPost({ a: 'pas-un-email', texte: 'bonjour' }, 'secret-de-test-c5'), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/valide/.test(res.corps.erreur));
});

test('sans texte → 400', async () => {
  raz();
  const res = faireRes();
  await handler(reqPost({ a: 'client@ex.fr' }, 'secret-de-test-c5'), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/texte requis/.test(res.corps.erreur));
});

// ---------------------------------------------------------------- config

test('config SMTP absente → 500', async () => {
  raz();
  const sauve = process.env.SMTP_HOST; delete process.env.SMTP_HOST;
  const res = faireRes();
  await handler(reqPost({ a: 'client@ex.fr', texte: 'bonjour' }, 'secret-de-test-c5'), res);
  process.env.SMTP_HOST = sauve;
  assert.strictEqual(res.statusCode, 500);
  assert.ok(/SMTP/.test(res.corps.erreur));
});

// ---------------------------------------------------------------- envoi nominal

test('envoi nominal → 200, dialogue SMTP complet, insert emails + journal', async () => {
  raz();
  const res = faireRes();
  await handler(reqPost({ a: 'client@ex.fr', sujet: 'Votre scooter', texte: 'Bonjour, suite à notre échange…' }, 'secret-de-test-c5'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.brique, 'C5');
  assert.ok(res.corps.message_id);
  // dialogue SMTP : chaque commande dans l'ordre
  const c = COURANT.commandes;
  assert.ok(c[0].indexOf('EHLO') === 0, 'EHLO');
  assert.strictEqual(c[1], 'AUTH LOGIN');
  assert.ok(/^MAIL FROM:<sav@umob\.fr>$/.test(c[4]), 'MAIL FROM');
  assert.ok(/^RCPT TO:<client@ex\.fr>$/.test(c[5]), 'RCPT TO');
  assert.strictEqual(c[6], 'DATA');
  assert.ok(c[7].indexOf('Subject: =?UTF-8?B?') !== -1, 'sujet encodé');
  assert.ok(c[7].indexOf('Content-Transfer-Encoding: base64') !== -1);
  assert.ok(c[7].indexOf('From: <sav@umob.fr>') === 0, 'From en tête');
  assert.ok(c[7].slice(-3) === '\r\n.', 'message terminé par point');
  assert.strictEqual(c[8], 'QUIT');
  // insert Supabase : une ligne emails sens sortant + journal
  const insert = appelsFetch.find(a => a.url.indexOf('/emails') !== -1 && a.options.method === 'POST');
  assert.ok(insert, 'insert emails');
  const ligne = JSON.parse(insert.options.body)[0];
  assert.strictEqual(ligne.sens, 'sortant');
  assert.strictEqual(ligne.to_addr, 'client@ex.fr');
  assert.strictEqual(ligne.sujet, 'Votre scooter');
  assert.strictEqual(ligne.message_id, res.corps.message_id);
  assert.strictEqual(ligne.statut_reception, 'sent');
  assert.strictEqual(insert.options.headers['Content-Profile'], 'agent_sav');
  const journal = appelsFetch.find(a => a.url.indexOf('/journal') !== -1);
  assert.ok(journal, 'journal écrit');
  assert.strictEqual(JSON.parse(journal.options.body).etape, 'email_send');
});

test('sujet absent → sujet par défaut appliqué', async () => {
  raz();
  const res = faireRes();
  await handler(reqPost({ a: 'client@ex.fr', texte: 'bonjour' }, 'secret-de-test-c5'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(COURANT.commandes[7].indexOf('Subject:') !== -1);
});

// ---------------------------------------------------------------- erreurs SMTP

test('SMTP : mot de passe refusé (535) → 502', async () => {
  raz();
  COURANT = fauxServeur(scenarioNominal({ 4: [535, ['535 auth failure']] }));
  const res = faireRes();
  await handler(reqPost({ a: 'client@ex.fr', texte: 'bonjour' }, 'secret-de-test-c5'), res);
  assert.strictEqual(res.statusCode, 502);
  assert.ok(/535/.test(res.corps.detail), 'detail contient le code SMTP');
});

test('SMTP : destinataire refusé (550) → 502, pas d insert emails', async () => {
  raz();
  COURANT = fauxServeur(scenarioNominal({ 6: [550, ['550 no such user']] }));
  const res = faireRes();
  await handler(reqPost({ a: 'inconnu@ex.fr', texte: 'bonjour' }, 'secret-de-test-c5'), res);
  assert.strictEqual(res.statusCode, 502);
  const insert = appelsFetch.find(a => a.url.indexOf('/emails') !== -1 && a.options.method === 'POST');
  assert.strictEqual(insert, undefined, 'aucune ligne emails enregistrée');
});

test('SMTP injoignable (connexion rejetée) → 502', async () => {
  raz();
  COURANT = { connexion: async function() { throw new Error('connect ECONNREFUSED'); } };
  const res = faireRes();
  await handler(reqPost({ a: 'client@ex.fr', texte: 'bonjour' }, 'secret-de-test-c5'), res);
  assert.strictEqual(res.statusCode, 502);
  assert.ok(/ECONNREFUSED|SMTP/.test(res.corps.detail) || /injoignable|echoue/.test(res.corps.erreur));
});

// ---------------------------------------------------------------- robustesse

test('panne Supabase à l enregistrement → 200 quand même (best effort)', async () => {
  raz();
  reponseInsert = { status: 500, corps: { erreur: 'boom' } };
  const res = faireRes();
  await handler(reqPost({ a: 'client@ex.fr', texte: 'bonjour' }, 'secret-de-test-c5'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
});

// ---------------------------------------------------------------- unitaires lib/smtp

test('unitaire : sujetEncode encode les accents en encoded-word', () => {
  const s = reelSmtp.sujetEncode('Intervenção — été');
  assert.ok(s.indexOf('=?UTF-8?B?') === 0 && s.slice(-2) === '?=');
});

test('unitaire : corpsB64 découpe en lignes ≤ 76 caractères', () => {
  const c = reelSmtp.corpsB64('x'.repeat(1000));
  const lignes = c.split('\r\n');
  assert.ok(lignes.every(l => l.length <= 76));
  assert.ok(lignes.length > 1);
});

// ------------------------------------------------ régression V1 (incident réel 30/10)

// Faux socket façon Node : émet la bannière EN UN SEUL CHUNK (comme un vrai
// serveur SMTP) — le détecteur de fin V1 pendait exactement sur ce cas.
const EventEmitter = require('node:events');
function fauxSocket() {
  const so = new EventEmitter();
  so.setEncoding = function () {};
  so.write = function (t, cb) { if (typeof cb === 'function') cb(); };
  so.end = function () {};
  so.destroy = function () {};
  return so;
}

test('régression : bannière SMTP livrée en un seul chunk → ne pend plus', async () => {
  const so = fauxSocket();
  const f = reelSmtp.fluxDe(so);
  const promesse = f.lireCode();
  so.emit('data', '220 ex3.mail.ovh.net ESMTP ready\r\n');   // UN SEUL chunk
  const r = await promesse;
  assert.strictEqual(r.code, 220);
  assert.ok(r.lignes[0].indexOf('ex3.mail.ovh.net') !== -1);
});

test('régression : réponse SMTP multiligne (250- ... 250 ␣) → code final extrait', async () => {
  const so = fauxSocket();
  const f = reelSmtp.fluxDe(so);
  const promesse = f.lireCode();
  so.emit('data', '250-ex3.mail.ovh.net\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 52428800\r\n');
  const r = await promesse;
  assert.strictEqual(r.code, 250);
  assert.strictEqual(r.lignes.length, 3);
});

test('régression : réponses en plusieurs chunks et arrivées AVANT lireCode', async () => {
  const so = fauxSocket();
  const f2 = reelSmtp.fluxDe(so);
  // le code 354 arrive en deux morceaux, la ligne finale complète n'existe qu'au 2e
  const p = f2.lireCode();
  so.emit('data', '354 go ahead');
  so.emit('data', ' with mail\r\n');
  const r = await p;
  assert.strictEqual(r.code, 354);
  // réponse arrivée AVANT tout lireCode : livrée immédiatement à l'appel
  so.emit('data', '250 queued as ABC123\r\n');
  const r2 = await f2.lireCode();
  assert.strictEqual(r2.code, 250);
});

// ============================================================================
// Agent SAV U'mob v2 — B6.4 : tests de l'adaptateur email Resend (node --test)
// Exécution : node --test tests/test-email.js
// (aucune dépendance, aucun réseau réel — fetch est SIMULÉ)
// ============================================================================
const test = require('node:test');
const assert = require('node:assert');

// --- Simulation de fetch AVANT le require -----------------------------------
let appelsFetch = [];
globalThis.fetch = async function (url, options) {
  appelsFetch.push({ url: String(url), options: options || {} });
  const r = reponses.length ? reponses.shift() : { status: 200, corps: JSON.stringify({ id: 'email-1' }) };
  if (r.reject) return Promise.reject(new Error(r.reject));
  return Promise.resolve({
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    text: async () => (r.corps !== undefined ? String(r.corps) : '')
  });
};
let reponses = [];

const email = require('../lib/email.js');

function configCle() {
  process.env.RESEND_API_KEY = 're_test_123';
  process.env.EMAIL_FROM = 'sav@umob.fr';
  process.env.ALERT_EMAIL = 'equipe@example.fr';
}
function purgeCle() {
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.ALERT_EMAIL;
}

test('B6.4 SANS RESEND_API_KEY → { envoye: false } — JAMAIS de throw, AUCUN appel réseau', async () => {
  purgeCle();
  appelsFetch = []; reponses = [];
  const r = await email.envoyerEmail('Sujet', 'Corps');
  assert.strictEqual(r.envoye, false);
  assert.ok(r.raison.indexOf('RESEND_API_KEY') !== -1);
  assert.strictEqual(appelsFetch.length, 0);
});

test('B6.4 SANS EMAIL_FROM → { envoye: false, raison } (adresse vérifiée obligatoire)', async () => {
  process.env.RESEND_API_KEY = 're_test_123';
  delete process.env.EMAIL_FROM;
  appelsFetch = []; reponses = [];
  const r = await email.envoyerEmail('Sujet', 'Corps');
  assert.strictEqual(r.envoye, false);
  assert.ok(r.raison.indexOf('EMAIL_FROM') !== -1);
  assert.strictEqual(appelsFetch.length, 0);
  purgeCle();
});

test('B6.4 envoi : POST api.resend.com/emails, Bearer, from/to/sujet/corps EXACTS', async () => {
  configCle();
  appelsFetch = []; reponses = [];
  const r = await email.envoyerEmail('Agent SAV — digest', 'PRISES DE MAIN — 1 dossier');
  assert.strictEqual(r.envoye, true);
  assert.strictEqual(appelsFetch.length, 1);
  assert.strictEqual(appelsFetch[0].url, 'https://api.resend.com/emails');
  const o = appelsFetch[0].options;
  assert.strictEqual(o.method, 'POST');
  assert.strictEqual(o.headers.Authorization, 'Bearer re_test_123');
  const corps = JSON.parse(o.body);
  assert.strictEqual(corps.from, 'sav@umob.fr');
  assert.deepStrictEqual(corps.to, ['equipe@example.fr']);
  assert.strictEqual(corps.subject, 'Agent SAV — digest');
  assert.strictEqual(corps.text, 'PRISES DE MAIN — 1 dossier');
  purgeCle();
});

test('B6.4 sans ALERT_EMAIL → destinataire DÉFAUT corentin.surand@umob.fr (parité v136)', async () => {
  process.env.RESEND_API_KEY = 're_test_123';
  process.env.EMAIL_FROM = 'sav@umob.fr';
  delete process.env.ALERT_EMAIL;
  appelsFetch = []; reponses = [];
  const r = await email.envoyerEmail('S', 'C');
  assert.strictEqual(r.envoye, true);
  assert.deepStrictEqual(JSON.parse(appelsFetch[0].options.body).to, ['corentin.surand@umob.fr']);
  purgeCle();
});

test('B6.4 Resend en erreur HTTP (422 domaine non vérifié) → { envoye: false, raison }', async () => {
  configCle();
  appelsFetch = []; reponses = [{ status: 422, corps: 'domain not verified' }];
  const r = await email.envoyerEmail('S', 'C');
  assert.strictEqual(r.envoye, false);
  assert.ok(r.raison.indexOf('422') !== -1);
  assert.ok(r.raison.indexOf('domain not verified') !== -1);
  purgeCle();
});

test('B6.4 erreur réseau (fetch qui jette) → { envoye: false, raison } — jamais de throw', async () => {
  configCle();
  appelsFetch = []; reponses = [{ reject: 'ECONNRESET' }];
  const r = await email.envoyerEmail('S', 'C');
  assert.strictEqual(r.envoye, false);
  assert.ok(r.raison.indexOf('reseau') !== -1);
  purgeCle();
});

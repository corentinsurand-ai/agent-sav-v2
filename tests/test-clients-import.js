// ============================================================================
// Agent SAV U'mob v2 — C1-IMP : tests de /api/clients-import (node --test)
// Exécution : node --test tests/test-clients-import.js
// (12 tests — aucune dépendance : Supabase et fetch sont SIMULÉS)
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');

// --- Environnement de test AVANT le require des modules ----------------------
process.env.WEBHOOK_SECRET = 'secret-test-c1imp';
process.env.SUPABASE_URL = 'https://supabase-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'cle-service-test';

const handler = require('../api/clients-import.js');
const clients = require('../lib/clients.js');

// --- Simulation de res (Vercel) ----------------------------------------------
function faireRes() {
  return {
    statusCode: null,
    corps: null,
    entetes: {},
    setHeader(nom, val) { this.entetes[nom] = val; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.corps = obj; return this; },
    end() { return this; }
  };
}

function faireReq(methode, url, corps) {
  return { method: methode, url: url, query: {}, headers: {}, body: corps };
}

// --- Fake Supabase : capture les appels fetch --------------------------------
var appels = [];
function fetchSimule(url, options) {
  appels.push({ url: String(url), options: options || {} });
  return Promise.resolve({
    ok: true,
    status: 201,
    text: function() { return Promise.resolve('[]'); }
  });
}
globalThis.fetch = fetchSimule;

function urlDe(n) { return appels[n] ? appels[n].url : ''; }
function optionsDe(n) { return appels[n] ? appels[n].options : {}; }

// ----------------------------------------------------------------------------
test('GET sans secret → 401', async () => {
  var res = faireRes();
  await handler(faireReq('GET', '/api/clients-import'), res);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.corps.erreur, 'secret invalide');
  assert.strictEqual(res.entetes['Access-Control-Allow-Origin'], '*', 'CORS présent (plateforme C1 navigateur)');
});

test('OPTIONS (préflight navigateur) → 204 sans secret', async () => {
  var res = faireRes();
  await handler(faireReq('OPTIONS', '/api/clients-import'), res);
  assert.strictEqual(res.statusCode, 204);
  assert.strictEqual(res.entetes['Access-Control-Allow-Origin'], '*');
  assert.ok(String(res.entetes['Access-Control-Allow-Methods']).indexOf('GET') !== -1);
});

test('GET avec secret → info (aucun accès Supabase)', async () => {
  var res = faireRes();
  await handler(faireReq('GET', '/api/clients-import?secret=secret-test-c1imp'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.brique, 'C1-IMP');
  assert.strictEqual(appels.length, 0, 'aucune requête réseau');
});

test('POST mauvais secret → 401', async () => {
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import?secret=faux', { clients: [] }), res);
  assert.strictEqual(res.statusCode, 401);
});

test('POST sans clients → 400', async () => {
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import?secret=secret-test-c1imp', {}), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/clients/.test(res.corps.erreur));
});

test('POST client sans téléphone → 400 avec index', async () => {
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import?secret=secret-test-c1imp',
    { clients: [{ telephone: '', enseigne: 'TEST X' }] }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/client 1/.test(res.corps.erreur));
  assert.ok(/telephone/.test(res.corps.erreur));
});

test('POST client sans enseigne → 400', async () => {
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import?secret=secret-test-c1imp',
    { clients: [{ telephone: '06 12 34 56 78' }] }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(/enseigne/.test(res.corps.erreur));
});

test('POST 2 clients → écriture ecrireClients EXACTE (upsert téléphone, normalisation)', async () => {
  appels = [];
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import?secret=secret-test-c1imp', {
    clients: [
      {
        telephone: '06 12 34 56 78',
        plaques: ['tt-101-te', 'TT101TE', 'TT-102-TE'],
        enseigne: 'TEST PIZZA SERVICES',
        statut_risque: 'Bon payeur',
        lignes: [{ immat: 'TT101TE', nom_client: 'TEST PIZZA SERVICES' }]
      },
      {
        telephone: '+33 7 81 22 33 44',
        plaques: ['tt104te'],
        enseigne: 'TEST PHARMACIE CENTRALE',
        statut_risque: '',
        lignes: []
      }
    ]
  }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.ecrits, 2);

  // La 1re requête = l'insert clients (upsert on_conflict=telephone, Content-Profile agent_sav)
  assert.ok(urlDe(0).indexOf('/rest/v1/clients?on_conflict=telephone') !== -1,
    'upsert par telephone : ' + urlDe(0));
  assert.strictEqual(optionsDe(0).headers['Content-Profile'], 'agent_sav');
  assert.ok(String(optionsDe(0).headers['Prefer']).indexOf('merge-duplicates') !== -1);
  var lot = JSON.parse(optionsDe(0).body);
  assert.strictEqual(lot.length, 2);
  assert.strictEqual(lot[0].telephone, '33612345678');
  assert.strictEqual(lot[0].plaque, 'TT101TE / TT102TE', 'plaques normalisées et uniques');
  assert.strictEqual(lot[0].enseigne, 'TEST PIZZA SERVICES');
  assert.strictEqual(lot[0].statut_risque, 'Bon payeur');
  assert.ok(lot[0].brut && Array.isArray(lot[0].brut.lignes));
  assert.strictEqual(lot[1].telephone, '33781223344');
  assert.strictEqual(lot[1].statut_risque, null, 'statut vide → null (même forme que lireClients)');

  // La 2e requête = le journal (etape import_clients)
  assert.ok(urlDe(1).indexOf('/rest/v1/journal') !== -1, 'journal écrit : ' + urlDe(1));
  var j = JSON.parse(optionsDe(1).body);
  assert.strictEqual(j.etape, 'import_clients');

  // Réponse : résumé lisible
  assert.strictEqual(res.corps.clients[0].telephone, '33612345678');
  assert.strictEqual(res.corps.clients[0].plaque, 'TT101TE / TT102TE');
});

test('GET ?verifier=1 → lecture de contrôle (Accept-Profile agent_sav)', async () => {
  appels = [];
  var res = faireRes();
  await handler(faireReq('GET',
    '/api/clients-import?secret=secret-test-c1imp&verifier=1&prefixe=TEST', null), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(urlDe(0).indexOf('/rest/v1/clients?') !== -1, 'lecture clients : ' + urlDe(0));
  assert.ok(urlDe(0).indexOf('enseigne=like.TEST') !== -1, 'filtre prefixe : ' + urlDe(0));
  assert.ok(urlDe(0).indexOf('select=telephone,enseigne,plaque,statut_risque') !== -1);
  assert.strictEqual(optionsDe(0).headers['Accept-Profile'], 'agent_sav');
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.prefixe, 'TEST');
});

test('verifier sur config manquante → 500 explicite', async () => {
  process.env.SUPABASE_URL = '';
  try {
    var res = faireRes();
    await handler(faireReq('GET',
      '/api/clients-import?secret=secret-test-c1imp&verifier=1', null), res);
    assert.strictEqual(res.statusCode, 500);
    assert.ok(/Supabase/.test(res.corps.erreur));
  } finally {
    process.env.SUPABASE_URL = 'https://supabase-test.supabase.co';
  }
});

test('GET ?liste=1 → liste complète du miroir (brut inclus, limite)', async () => {
  appels = [];
  var res = faireRes();
  await handler(faireReq('GET',
    '/api/clients-import?secret=secret-test-c1imp&liste=1&limite=50', null), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(urlDe(0).indexOf('/rest/v1/clients?') !== -1, 'lecture clients : ' + urlDe(0));
  assert.ok(urlDe(0).indexOf('select=telephone,enseigne,plaque,statut_risque,brut') !== -1,
    'brut inclus : ' + urlDe(0));
  assert.ok(urlDe(0).indexOf('limit=50') !== -1, 'limite appliquée : ' + urlDe(0));
  assert.ok(urlDe(0).indexOf('order=maj_a.desc') !== -1, 'ordre déterministe : ' + urlDe(0));
  assert.strictEqual(optionsDe(0).headers['Accept-Profile'], 'agent_sav');
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.limite, 50);
});

test('GET ?liste=1 limite hors bornes → bornée à 5000', async () => {
  appels = [];
  var res = faireRes();
  await handler(faireReq('GET',
    '/api/clients-import?secret=secret-test-c1imp&liste=1&limite=999999', null), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(urlDe(0).indexOf('limit=5000') !== -1, 'limite bornée : ' + urlDe(0));
  assert.strictEqual(res.corps.limite, 5000);
});

// ============================================================================
// Agent SAV U'mob v2 — C6-AUTH-2 : tests jeton de session sur les routes
// Exécution : node --test tests/test-jeton.js
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');

process.env.WEBHOOK_SECRET = 'secret-test-c6a2';
process.env.AUTH_SECRET = 'auth-secret-test-c6a2';
process.env.SUPABASE_URL = 'https://supabase-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'cle-service-test';

const auth = require('../lib/auth.js');
const handlerClients = require('../api/clients-import.js');
const handlerWaSend = require('../api/whatsapp-send.js');
const handlerWaMsgs = require('../api/whatsapp-messages.js');
const handlerEmails = require('../api/emails.js');

function faireRes() {
  return {
    statusCode: null, corps: null,
    setHeader() {}, writeHead(code) { this.statusCode = code; return this; }, write() { return true; }, status(code) { this.statusCode = code; return this; },
    json(obj) { this.corps = obj; return this; }, end() { return this; }
  };
}
function faireReq(methode, url, corps) {
  return { method: methode, url: url, query: {}, headers: {}, body: corps };
}

// Fake Supabase : réponses vides suffisent (on teste le 401 vs non-401)
globalThis.fetch = async function () {
  return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
};

const JETON = auth.creerJeton(
  { id: 'u1', email: 'marine.leca@umob.fr', nom: 'Marine', role: 'collaborateur' },
  auth.secretSignature()
);

// --- authentifierRequete directement ---------------------------------------
test('authentifierRequete : jeton valide accepté, utilisateur retourné', () => {
  const r = auth.authentifierRequete('', JETON);
  assert.ok(r.ok);
  assert.equal(r.utilisateur.email, 'marine.leca@umob.fr');
});

test('authentifierRequete : secret machine toujours accepté', () => {
  assert.ok(auth.authentifierRequete('secret-test-c6a2', '').ok);
});

test('authentifierRequete : sans jeton ni secret → refus', () => {
  assert.ok(!auth.authentifierRequete('', '').ok);
  assert.ok(!auth.authentifierRequete('faux-secret', '').ok);
  assert.ok(!auth.authentifierRequete('', 'jeton.factice').ok);
});

test('authentifierRequete : jeton expiré refusé', () => {
  const expire = auth.creerJeton({ id: 'u1' }, auth.secretSignature(), -1000);
  assert.ok(!auth.authentifierRequete('', expire).ok);
});

// --- Route clients-import (GET) : jeton en query ------------------------------
test('clients-import : ?jeton= accepté (pas de 401)', async () => {
  const res = faireRes();
  await handlerClients(faireReq('GET', '/api/clients-import?liste=1&jeton=' + encodeURIComponent(JETON)), res);
  assert.notEqual(res.statusCode, 401);
});

test('clients-import : jeton dans header x-jeton accepté', async () => {
  const res = faireRes();
  const req = faireReq('GET', '/api/clients-import?liste=1');
  req.headers['x-jeton'] = JETON;
  await handlerClients(req, res);
  assert.notEqual(res.statusCode, 401);
});

test('clients-import : sans credential → 401', async () => {
  const res = faireRes();
  await handlerClients(faireReq('GET', '/api/clients-import?liste=1'), res);
  assert.equal(res.statusCode, 401);
});

// --- Route whatsapp-messages (GET) -------------------------------------------
test('whatsapp-messages : jeton accepté', async () => {
  const res = faireRes();
  await handlerWaMsgs(faireReq('GET', '/api/whatsapp-messages?jeton=' + encodeURIComponent(JETON)), res);
  assert.notEqual(res.statusCode, 401);
});

test('whatsapp-messages : sans credential → 401', async () => {
  const res = faireRes();
  await handlerWaMsgs(faireReq('GET', '/api/whatsapp-messages'), res);
  assert.equal(res.statusCode, 401);
});

// --- Route whatsapp-send (POST) : jeton dans le corps -------------------------
test('whatsapp-send : corps.jeton accepté', async () => {
  const res = faireRes();
  await handlerWaSend(faireReq('POST', '/api/whatsapp-send', { jeton: JETON, to: '33600000000' }), res);
  assert.notEqual(res.statusCode, 401);
});

test('whatsapp-send : sans credential → 401', async () => {
  const res = faireRes();
  await handlerWaSend(faireReq('POST', '/api/whatsapp-send', { to: '33600000000' }), res);
  assert.equal(res.statusCode, 401);
});

// --- Route emails : secret machine inchangé ----------------------------------
test('emails : secret machine toujours accepté', async () => {
  const res = faireRes();
  await handlerEmails(faireReq('POST', '/api/emails', { secret: 'secret-test-c6a2', action: 'lister' }), res);
  assert.notEqual(res.statusCode, 401);
});

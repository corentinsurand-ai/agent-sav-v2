// ============================================================================
// Agent SAV U'mob v2 — C8-ASSIST-1 : tests de l'assistant IA (/api/contexte POST)
// Exécution : node --test tests/test-assistant.js
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');

process.env.WEBHOOK_SECRET = 'secret-test-assist';
process.env.AUTH_SECRET = 'auth-secret-test-assist';
process.env.SUPABASE_URL = 'https://supabase-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'cle-service-test';
process.env.MISTRAL_API_KEY = 'cle-mistral-test';
process.env.RESPONDIO_TOKEN = 'rio-token-test';
delete process.env.MISTRAL_MODELE_ASSIST;

const auth = require('../lib/auth.js');
const handler = require('../api/contexte.js');

function faireRes() {
  return {
    statusCode: null, corps: null,
    setHeader() {}, writeHead(code) { this.statusCode = code; return this; }, write() { return true; }, status(code) { this.statusCode = code; return this; },
    json(obj) { this.corps = obj; return this; }, end() { return this; }
  };
}
function faireReq(methode, url, corps, query) {
  return { method: methode, url: url, query: query || {}, headers: {}, body: corps };
}

// --- Fakes fetch : Supabase (données) + Mistral (réponse) -------------------
var URLS_DEMANDEES = [];
var FAUX_MISTRAL = null;   // si null → 500 (panne)
var DERNIER_PROMPT = null; // corps de la requête Mistral (pour vérifier le contexte)
globalThis.fetch = async function (url, opts) {
  var u = String(url);
  URLS_DEMANDEES.push(u + ' ' + ((opts && opts.method) || 'GET'));
  if (u.indexOf('api.mistral.ai') !== -1) {
    try { DERNIER_PROMPT = JSON.parse(opts.body); } catch (e) { DERNIER_PROMPT = null; }
    if (!FAUX_MISTRAL) return { ok: false, status: 500, text: async () => '{"error":"ko"}' };
    return { ok: true, status: 200, text: async () => JSON.stringify(FAUX_MISTRAL) };
  }
  if (u.indexOf('clients?') !== -1) {
    return { ok: true, status: 200, text: async () => '[]', json: async () => [
      { telephone: '33684545236', enseigne: 'LM PIZZA PUCE', plaque: 'GX336VG / GX519VG', statut_risque: 'Sous surveillance',
        brut: { lignes: [ { immat: 'GX336VG', produit: 'COMPACT PRO', code_client: 'C2119', nom_contact: 'MICHELINI', prenom: 'Gabriel', email: 'lmpizzapuce@gmail.com', ville: 'LYON', contrat: 'Modèle Confort Plus n° CO2119 du 30/04/2023 au 26/07/2028' } ] } },
      { telephone: '33611111111', enseigne: 'PIZZA KARIM', plaque: 'AA111AA', statut_risque: 'OK',
        brut: { lignes: [ { immat: 'AA111AA', produit: 'SCOOT', code_client: 'C9999', nom_contact: 'KARIM', email: 'karim@pizzeria.fr', ville: 'LYON' } ] } }
    ] };
  }
  if (u.indexOf('comptages_maintenance') !== -1) {
    return { ok: true, status: 200, text: async () => '[]', json: async () => [
      { code_client: 'C2119', nom: 'LM PIZZA PUCE', donnees: { sites: [ { ville: 'LYON', pack: 'Confort Plus', droits: 2, restants: 2, consommes: 0, derniere: '2025-12-16', contrat_fin: '2028-07-26', par_annee: [ { debut: '2026-04-30', fin: '2027-04-30', restants: 2, consommes: 0, en_cours: true } ], dates_passages: ['2025-12-16', '2024-09-23'] } ] } },
      { code_client: 'C9999', nom: 'PIZZA KARIM', donnees: { sites: [] } }
    ] };
  }
  if (u.indexOf('respondio_contacts') !== -1) {
    return { ok: true, status: 200, text: async () => '[]', json: async () => [
      { prenom: 'Karim', nom: '', tel: '+33611111111', email: '', cycle_vie: 'Traitée', assignee: { firstName: 'Marine', lastName: 'Leca' } }
    ] };
  }
  if (u.indexOf('wa_messages') !== -1) {
    return { ok: true, status: 200, text: async () => '[]', json: async () => [
      { wa_id: '33611111111', nom_profil: 'Karim', texte: 'Bonjour, ma batterie est HS', sens: 'entrant', sender_nom: null, recu_a: '2026-11-05T09:00:00Z' }
    ] };
  }
  if (u.indexOf('emails') !== -1) {
    return { ok: true, status: 200, text: async () => '[]', json: async () => [
      { from_addr: 'karim@pizzeria.fr', from_nom: null, to_addr: 'service.technique@umob.fr', sujet: 'Scooter', texte: 'Merci', sens: 'entrant', recu_a: '2026-11-05T10:00:00Z' }
    ] };
  }
  return { ok: true, status: 200, text: async () => '[]', json: async () => [] };
};

const JETON = auth.creerJeton(
  { id: 'u1', email: 'marine.leca@umob.fr', nom: 'Marine', role: 'collaborateur' },
  auth.secretSignature()
);

test('POST sans jeton ni secret → 401', async () => {
  const r = faireRes();
  await handler(faireReq('POST', '/api/contexte', { question: 'coucou' }), r);
  assert.equal(r.statusCode, 401);
});

test('OPTIONS → 204 (CORS navigateur)', async () => {
  const r = faireRes();
  await handler(faireReq('OPTIONS', '/api/contexte'), r);
  assert.equal(r.statusCode, 204);
});

test('POST avec jeton mais question manquante → 400', async () => {
  const r = faireRes();
  await handler(faireReq('POST', '/api/contexte', { jeton: JETON }), r);
  assert.equal(r.statusCode, 400);
});

test('POST question + jeton → 200, réponse Mistral retournée, données dans le prompt', async () => {
  FAUX_MISTRAL = { choices: [{ message: { content: 'Voici la réponse de l\'assistant.' } }], model: 'mistral-small-latest', usage: {} };
  const r = faireRes();
  await handler(faireReq('POST', '/api/contexte', { question: 'Quels sont les derniers échanges avec Karim ?', jeton: JETON }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.corps.ok, true);
  assert.equal(r.corps.reponse, 'Voici la réponse de l\'assistant.');
  assert.equal(r.corps.modele, 'mistral-small-latest');
  // les données réelles ont été cherchées en base
  assert.ok(URLS_DEMANDEES.some(u => u.indexOf('respondio_contacts') !== -1));
  assert.ok(URLS_DEMANDEES.some(u => u.indexOf('wa_messages') !== -1));
  assert.ok(URLS_DEMANDEES.some(u => u.indexOf('emails') !== -1));
  FAUX_MISTRAL = null;
});

test('POST avec secret machine (pas de jeton) → authentifié aussi', async () => {
  FAUX_MISTRAL = { choices: [{ message: { content: 'ok' } }], model: 'm', usage: {} };
  const r = faireRes();
  await handler(faireReq('POST', '/api/contexte?secret=secret-test-assist', { question: 'Comment fonctionne la plateforme ?' }, { secret: 'secret-test-assist' }), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.corps.ok, true);
  FAUX_MISTRAL = null;
});

test('POST avec conversation ouverte → historique spécifique du client cherché', async () => {
  FAUX_MISTRAL = { choices: [{ message: { content: 'ok' } }], model: 'm', usage: {} };
  URLS_DEMANDEES = [];
  const r = faireRes();
  await handler(faireReq('POST', '/api/contexte', {
    question: 'Résume ce dossier', jeton: JETON,
    conversation: { nom: 'Karim', tel: '+33611111111', email: 'karim@pizzeria.fr', entreprise: 'PIZZA KARIM' }
  }), r);
  assert.equal(r.statusCode, 200);
  assert.ok(URLS_DEMANDEES.some(u => u.indexOf('wa_id=eq.33611111111') !== -1), 'historique WA du client demandé');
  assert.ok(URLS_DEMANDEES.some(u => u.indexOf('karim%40pizzeria.fr') !== -1), 'historique email du client demandé');
  FAUX_MISTRAL = null;
});

test('POST Mistral en panne → 502 propre', async () => {
  FAUX_MISTRAL = null;
  const r = faireRes();
  await handler(faireReq('POST', '/api/contexte', { question: 'test', jeton: JETON }), r);
  assert.equal(r.statusCode, 502);
  assert.equal(r.corps.ok, false);
  assert.ok(String(r.corps.erreur).indexOf('assistant indisponible') === 0);
});

test('GET inchangé : sans secret → 401', async () => {
  const r = faireRes();
  await handler(faireReq('GET', '/api/contexte?contact=123'), r);
  assert.equal(r.statusCode, 401);
});

test('GET inchangé : secret ok sans contact → 400', async () => {
  const r = faireRes();
  await handler(faireReq('GET', '/api/contexte?secret=secret-test-assist', {}, { secret: 'secret-test-assist' }), r);
  assert.equal(r.statusCode, 400);
});

// --- C8-ASSIST-2 : résolution du client + maintenances ----------------------

test('C8-ASSIST-2 : client nommé dans la question → fiche + MAINTENANCES dans le prompt', async () => {
  FAUX_MISTRAL = { choices: [{ message: { content: 'ok' } }], model: 'm', usage: {} };
  URLS_DEMANDEES = []; DERNIER_PROMPT = null;
  const r = faireRes();
  await handler(faireReq('POST', '/api/contexte', {
    question: 'Combien reste-t-il de maintenances à LM PIZZA PUCE pour l\'année en cours ?', jeton: JETON
  }), r);
  assert.equal(r.statusCode, 200);
  assert.ok(URLS_DEMANDEES.some(u => u.indexOf('clients?') !== -1), 'table clients interrogée');
  assert.ok(URLS_DEMANDEES.some(u => u.indexOf('comptages_maintenance') !== -1), 'comptages_maintenance interrogée');
  const sys = DERNIER_PROMPT.messages[0].content;
  assert.ok(sys.indexOf('### CLIENT CONCERNÉ') !== -1, 'fiche prioritaire présente');
  assert.ok(sys.indexOf('LM PIZZA PUCE') !== -1, 'bon client détecté (pas un autre)');
  assert.ok(sys.indexOf('restants: 2') !== -1, 'comptage maintenance injecté');
  assert.ok(sys.indexOf('ANNEE EN COURS') !== -1, 'année en cours injectée');
  assert.ok(sys.indexOf('PIZZA KARIM') === -1 || sys.indexOf('CLIENT CONCERNÉ') < sys.indexOf('PIZZA KARIM'), 'priorité au client détecté');
  FAUX_MISTRAL = null;
});

test('C8-ASSIST-2 : conversation ouverte → client résolu par le téléphone du canvas', async () => {
  FAUX_MISTRAL = { choices: [{ message: { content: 'ok' } }], model: 'm', usage: {} };
  URLS_DEMANDEES = []; DERNIER_PROMPT = null;
  const r = faireRes();
  await handler(faireReq('POST', '/api/contexte', {
    question: 'Combien il lui reste de maintenances ?', jeton: JETON,
    conversation: { nom: 'Gabriel Michelini', tel: '+33684545236', email: 'lmpizzapuce@gmail.com', entreprise: 'LM PIZZA PUCE' }
  }), r);
  assert.equal(r.statusCode, 200);
  const sys = DERNIER_PROMPT.messages[0].content;
  assert.ok(sys.indexOf('### CLIENT CONCERNÉ') !== -1, 'fiche du client de la conversation');
  assert.ok(sys.indexOf('LM PIZZA PUCE') !== -1);
  assert.ok(sys.indexOf('restants: 2') !== -1, 'maintenances du bon client');
  assert.ok(URLS_DEMANDEES.some(u => u.indexOf('wa_id=eq.33684545236') !== -1), 'historique WA ciblé');
  FAUX_MISTRAL = null;
});

test('C8-ASSIST-2 : client sans comptage maintenance → message « aucune donnée », pas d\'invention', async () => {
  FAUX_MISTRAL = { choices: [{ message: { content: 'ok' } }], model: 'm', usage: {} };
  DERNIER_PROMPT = null;
  const r = faireRes();
  await handler(faireReq('POST', '/api/contexte', {
    question: 'Combien reste-t-il de maintenances à PIZZA KARIM ?', jeton: JETON
  }), r);
  assert.equal(r.statusCode, 200);
  const sys = DERNIER_PROMPT.messages[0].content;
  assert.ok(sys.indexOf('CLIENT CONCERNÉ') !== -1 && sys.indexOf('PIZZA KARIM') !== -1);
  assert.ok(sys.indexOf('aucune donnée de maintenance') !== -1, 'absence explicite signalée au modèle');
  FAUX_MISTRAL = null;
});


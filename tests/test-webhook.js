// ============================================================================
// Agent SAV U'mob v2 — B1.1 : tests du webhook (node --test)
// Exécution : node --test tests/test-webhook.js
// (25 tests — aucune dépendance, Supabase et fetch sont SIMULÉS)
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');

// --- Environnement de test AVANT le require du handler -----------------------
process.env.WEBHOOK_SECRET = 'secret-de-test-b1';
process.env.SUPABASE_URL = 'https://umob-crm.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'cle-service-test';

const webhook = require('../api/webhook.js');
const normaliser = require('../lib/normaliser.js');

// --- Simulation de res (Vercel) ----------------------------------------------
function faireRes() {
  const res = {
    statusCode: null,
    corps: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.corps = obj; return this; },
    end() { return this; }
  };
  return res;
}

// --- Simulation de fetch : enregistre chaque appel, réponse paramétrable ----
let appelsFetch = [];
let reponses = []; // file de réponses simulées ; défaut 201 ok
function fetchSimule(url, options) {
  appelsFetch.push({ url: String(url), options: options || {} });
  const r = reponses.length ? reponses.shift() : { status: 201, ok: true, text: async () => '' };
  return Promise.resolve({
    status: r.status,
    ok: r.ok !== undefined ? r.ok : (r.status >= 200 && r.status < 300),
    text: async () => r.text || ''
  });
}
globalThis.fetch = fetchSimule;

function reqPost(query, body, headers) {
  return {
    method: 'POST',
    url: '/api/webhook' + (query ? '?' + query : ''),
    query: query ? Object.fromEntries(new URLSearchParams(query)) : {},
    headers: headers || {},
    body: body
  };
}

// Payload de référence : structure RÉELLE des webhooks respond.io (prouvée en prod)
function payloadStandard(overrides) {
  const p = {
    event_id: 'evt-001',
    contact: { id: '547249072' },
    conversation_id: 'conv-42',
    channel: { id: '558644', name: 'WhatsApp' },
    message: {
      messageId: 'msg-abc',
      channelId: '558644',
      traffic: 'incoming',
      sender: { source: 'contact' },
      message: { type: 'text', text: 'Bonjour, mon scooter ne démarre plus.' },
      status: [{ timestamp: 1762893600000, value: 'pending' }, { timestamp: 1762893605000, value: 'delivered' }]
    }
  };
  return Object.assign({}, p, overrides || {});
}

function dernierAppelMessages() {
  return appelsFetch.find(a => a.url.indexOf('/rest/v1/messages') !== -1) || null;
}
function dernierAppelJournal() {
  return appelsFetch.filter(a => a.url.indexOf('/rest/v1/journal') !== -1).pop() || null;
}
function corpsDernierMessage() {
  const a = dernierAppelMessages();
  return a ? JSON.parse(a.options.body) : null;
}

// ============================ GET SANTÉ ======================================
test('GET santé : 200, ok=true, brique B1', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook({ method: 'GET', url: '/api/webhook' }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.brique, 'B1');
});

test('GET santé : version B1.1', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook({ method: 'GET', url: '/api/webhook' }, res);
  assert.strictEqual(res.corps.version, 'B1.1');
});

// ============================ AUTHENTIFICATION ================================
test('POST sans secret → 401', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('', payloadStandard()), res);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(appelsFetch.length, 0);
});

test('POST secret incorrect → 401', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=mauvais', payloadStandard()), res);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(appelsFetch.length, 0);
});

test('POST secret correct via ?secret= → 200 ok', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard()), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
});

test('POST secret correct via header x-webhook-secret → 200 ok', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('', payloadStandard(), { 'x-webhook-secret': 'secret-de-test-b1' }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
});

// ============================ NORMALISATION ===================================
test('texte simple : extrait et inséré tel quel', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard()), res);
  assert.strictEqual(corpsDernierMessage().texte, 'Bonjour, mon scooter ne démarre plus.');
});

test('event_id du payload utilisé comme identifiant de dédup', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({ event_id: 'evt-DELUP-77' })), res);
  assert.strictEqual(corpsDernierMessage().event_id, 'evt-DELUP-77');
});

test('sans event_id : repli sur messageId stable', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  const p = payloadStandard();
  delete p.event_id;
  await webhook(reqPost('secret=secret-de-test-b1', p), res);
  assert.strictEqual(corpsDernierMessage().event_id, 'msg-abc');
});

test('contact_id extrait de payload.contact.id', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard()), res);
  assert.strictEqual(corpsDernierMessage().contact_id, '547249072');
});

test('canal combiné : nom en canal_nom, id en canal_id', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard()), res);
  const l = corpsDernierMessage();
  assert.strictEqual(l.canal_nom, 'WhatsApp');
  assert.strictEqual(l.canal_id, '558644');
});

test('horodatage : PLUS ANCIEN status[].timestamp (ms) → emis_a', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard()), res);
  const l = corpsDernierMessage();
  assert.strictEqual(l.emis_a, new Date(1762893600000).toISOString()); // 1 762 893 600 000, pas le delivered
});

test('photo sans légende → texte [média reçu] + media_url conservée', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({
    message: { messageId: 'm2', message: { type: 'image', url: 'https://cdn.exemple/photo.jpg' }, status: [{ timestamp: 1762893700000, value: 'sent' }] }
  })), res);
  const l = corpsDernierMessage();
  assert.strictEqual(l.texte, '[média reçu]');
  assert.strictEqual(l.media_url, 'https://cdn.exemple/photo.jpg');
  assert.strictEqual(l.type_media, 'image');
});

test('vocal → texte [message vocal reçu], media_url VIDÉE, type audio', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({
    message: { messageId: 'm3', message: { type: 'audio', mediaType: 'audio/ogg', url: 'https://cdn.exemple/vocal.ogg' }, status: [{ timestamp: 1762893800000, value: 'sent' }] }
  })), res);
  const l = corpsDernierMessage();
  assert.strictEqual(l.texte, '[message vocal reçu]');
  assert.strictEqual(l.media_url, null);
  assert.strictEqual(l.type_media, 'audio');
});

test('email client : préfixe Objet : + corps', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({
    channel: { id: '1', name: 'Email', source: 'smtp' },
    message: { messageId: 'm4', message: { type: 'email', subject: 'Problème batterie', message: 'Bonjour, la batterie ne tient plus la charge.' } }
  })), res);
  const l = corpsDernierMessage();
  assert.ok(l.texte.indexOf('Objet : Problème batterie') !== -1);
  assert.ok(l.texte.indexOf('la batterie ne tient plus') !== -1);
});

test('payload sans texte extractible → mention explicite (jamais de colonne vide)', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({ message: { messageId: 'm5' } })), res);
  assert.strictEqual(corpsDernierMessage().texte, '(message sans texte extrait — voir colonne brut)');
});

test('URL image extraite depuis une liste d\'attachments', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({
    message: { messageId: 'm6', message: { type: 'image', attachments: [{ type: 'image', mimeType: 'image/jpeg', url: 'https://cdn.exemple/joint.jpg' }] } }
  })), res);
  assert.strictEqual(corpsDernierMessage().media_url, 'https://cdn.exemple/joint.jpg');
});

// ============================ EMAILS INTERNES ==================================
test('email no-reply → statut ignore + journal webhook_email_interne', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({
    channel: { id: '1', name: 'Email', source: 'smtp' },
    message: { messageId: 'm7', message: { type: 'email', subject: 'Notification', message: 'from: no-reply@praxedo.eu — Intervention créée' } }
  })), res);
  assert.strictEqual(corpsDernierMessage().statut, 'ignore');
  const j = dernierAppelJournal();
  assert.ok(j, 'journal attendu');
  const cj = JSON.parse(j.options.body);
  assert.strictEqual(cj.etape, 'webhook_email_interne');
});

test('email Praxedo (création intervention) → statut ignore', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({
    channel: { id: '1', name: 'Email', source: 'smtp' },
    message: { messageId: 'm8', message: { type: 'email', subject: 'Création intervention par un technicien', message: 'EVE05511 créé.' } }
  })), res);
  assert.strictEqual(corpsDernierMessage().statut, 'ignore');
});

test('email interne Exchange (microsoftexchange…indiv3.local) → statut ignore', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({
    channel: { id: '1', name: 'Email', source: 'smtp' },
    message: { messageId: 'm9', message: { type: 'email', subject: 'RE: planning', message: 'de : microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@indiv3.local' } }
  })), res);
  assert.strictEqual(corpsDernierMessage().statut, 'ignore');
});

test('email client NORMAL (aucun motif interne) → statut en_file', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({
    channel: { id: '1', name: 'Email', source: 'smtp' },
    message: { messageId: 'm10', message: { type: 'email', subject: 'Scooter en panne', message: 'Bonjour, notre scooter U\'mob ne démarre pas ce matin.' } }
  })), res);
  assert.strictEqual(corpsDernierMessage().statut, 'en_file');
});

// ============================ COMPORTEMENT SUPABASE ============================
test('header Content-Profile: agent_sav sur chaque insert', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard()), res);
  assert.strictEqual(dernierAppelMessages().options.headers['Content-Profile'], 'agent_sav');
});

test('header Prefer: return=minimal (réponse légère)', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard()), res);
  assert.strictEqual(dernierAppelMessages().options.headers['Prefer'], 'return=minimal');
});

test('URL appelée : {SUPABASE_URL}/rest/v1/messages', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard()), res);
  assert.strictEqual(dernierAppelMessages().url, 'https://umob-crm.supabase.co/rest/v1/messages');
});

test('dédup : 409 (event_id déjà vu) → ok, doublon=true, PAS de journal enfile', async () => {
  appelsFetch = []; reponses = [{ status: 409, ok: false, text: 'duplicate key' }];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard()), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.doublon, true);
  assert.strictEqual(dernierAppelJournal(), null, 'aucun journal webhook_enfile sur un doublon');
});

test('panne Supabase (500) → 200 quand même (jamais d\'échec pour respond.io)', async () => {
  appelsFetch = []; reponses = [{ status: 500, ok: false, text: 'boom' }, { status: 201, ok: true, text: '' }];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard()), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.enregistre, false);
  const j = dernierAppelJournal();
  assert.ok(j, 'l\'incident doit être journalisé');
  assert.strictEqual(JSON.parse(j.options.body).etape, 'webhook_erreur_supabase');
});

test('message client normal → journal étape webhook_enfile écrit', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard()), res);
  const j = dernierAppelJournal();
  assert.ok(j, 'journal attendu');
  const cj = JSON.parse(j.options.body);
  assert.strictEqual(cj.etape, 'webhook_enfile');
  assert.strictEqual(cj.contact_id, '547249072');
});

// ============================ TYPES D'ÉVÉNEMENT =================================
test('event_type "message.received" (format réel respond.io) → traité', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({ event_type: 'message.received' })), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.enregistre, true);
  assert.ok(dernierAppelMessages(), 'insert messages attendu');
});

test('event_type "message_received" (underscore) → traité aussi (tolérance)', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({ event_type: 'message_received' })), res);
  assert.strictEqual(res.corps.enregistre, true);
  assert.ok(dernierAppelMessages(), 'insert messages attendu');
});

test('comment.created → 200, IGNORÉ (pas d\'insert messages), journal dédié', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({
    event_type: 'comment.created',
    text: '@Agent IA intervention 05511 créée'
  })), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.enregistre, false);
  assert.strictEqual(dernierAppelMessages(), null, 'aucun insert messages pour un commentaire');
  const j = dernierAppelJournal();
  assert.ok(j, 'journal attendu');
  assert.strictEqual(JSON.parse(j.options.body).etape, 'webhook_commentaire_ignore');
});

test('contact.updated → 200, IGNORÉ, journal webhook_ignore', async () => {
  appelsFetch = []; reponses = [];
  const res = faireRes();
  await webhook(reqPost('secret=secret-de-test-b1', payloadStandard({ event_type: 'contact.updated' })), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.enregistre, false);
  assert.strictEqual(dernierAppelMessages(), null);
  const j = dernierAppelJournal();
  assert.ok(j, 'journal attendu');
  assert.strictEqual(JSON.parse(j.options.body).etape, 'webhook_ignore');
});

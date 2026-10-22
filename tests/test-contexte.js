// ============================================================================
// Agent SAV U'mob v2 — B2.1 : tests de /api/contexte (node --test)
// Exécution : node --test tests/test-contexte.js
// (28 tests — aucune dépendance, respond.io et fetch sont SIMULÉS)
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');

// --- Environnement de test AVANT le require des modules ---------------------
process.env.WEBHOOK_SECRET = 'secret-de-test-b2';
process.env.RESPONDIO_TOKEN = 'token-respondio-test';

const contexte = require('../api/contexte.js');
const lib = require('../lib/contexte.js');
const respondio = require('../lib/respondio.js');

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

// --- Simulation de fetch : file de réponses FIFO + capture des appels -------
// L'assemblage est SÉQUENTIEL (fiche → historique → commentaires), l'ordre
// des réponses est donc déterministe.
let appelsFetch = [];
let reponses = [];
function fetchSimule(url, options) {
  appelsFetch.push({ url: String(url), options: options || {} });
  const r = reponses.length ? reponses.shift() : { status: 200, corps: {} };
  if (r.reject) return Promise.reject(new Error(r.reject));
  return Promise.resolve({
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    text: async () => (r.corps !== undefined ? JSON.stringify(r.corps) : '')
  });
}
globalThis.fetch = fetchSimule;

function reqGet(query, headers) {
  return {
    method: 'GET',
    url: '/api/contexte' + (query ? '?' + query : ''),
    query: query ? Object.fromEntries(new URLSearchParams(query)) : {},
    headers: headers || {},
    body: null
  };
}

// --- Fabriques : structures RÉELLES respond.io (prouvées en prod) -----------
function itemHistorique(overrides) {
  return Object.assign({
    messageId: 'msg-abc',
    channelMessageId: 'chmsg-1',
    contactId: '123',
    channelId: '558644',
    traffic: 'incoming',
    sender: { source: 'contact' },
    message: { type: 'text', text: 'Bonjour, mon scooter ne démarre plus.' },
    replyTo: null,
    status: [
      { timestamp: 1762893600000, value: 'pending' },
      { timestamp: 1762893605000, value: 'delivered' }
    ]
  }, overrides || {});
}

function ficheContact(overrides) {
  return Object.assign({
    id: '123',
    fullName: 'PIZZA AL FORNO (CLAMART)',
    firstName: '',
    lastName: '',
    lifecycle: { name: 'A qualifier' },
    tags: []
  }, overrides || {});
}

function reponsesStandards() {
  return [
    { status: 200, corps: ficheContact({ tags: ['Prise de main'] }) },
    { status: 200, corps: { items: [itemHistorique()] } },
    { status: 200, corps: { items: [{ id: 'c1', text: '@Agent IA intervention 05511', userId: '76226555', createdAt: 1762800000000 }] } }
  ];
}

// ============================================================================
// 1) EXTRACTION — unitaire, sans réseau
// ============================================================================

test('extraireIdMessage : ordre des préférences du prod (id > messageId)', () => {
  assert.strictEqual(lib.extraireIdMessage({ id: 'a', messageId: 'msg-1' }), 'a');
  assert.strictEqual(lib.extraireIdMessage({ messageId: 'msg-1' }), 'msg-1');
  assert.strictEqual(lib.extraireIdMessage({ uuid: 'u9', rowId: 'r1' }), 'u9');
});

test('extraireIdMessage : repli par scan des clés « id »', () => {
  assert.strictEqual(lib.extraireIdMessage({ customFooId: 'xyz', contactId: '123' }), 'xyz');
});

test('extraireIdMessage : contactId/channelId/userId JAMAIS retenus', () => {
  assert.strictEqual(lib.extraireIdMessage({ contactId: '123', channelId: '5', userId: '9', teamId: '1' }), '');
});

test('messageEnvoyeParHumain : sender.type=user → true', () => {
  assert.strictEqual(lib.messageEnvoyeParHumain({ sender: { type: 'user' } }), true);
});

test('messageEnvoyeParHumain : sender.source=user → true', () => {
  assert.strictEqual(lib.messageEnvoyeParHumain({ sender: { source: 'user' } }), true);
});

test('messageEnvoyeParHumain : contact/agent → false', () => {
  assert.strictEqual(lib.messageEnvoyeParHumain({ sender: { source: 'contact' } }), false);
  assert.strictEqual(lib.messageEnvoyeParHumain({ sender: { type: 'agent' } }), false);
  assert.strictEqual(lib.messageEnvoyeParHumain({}), false);
});

test('normaliserMessageItem : structure réelle → ts = PLUS ANCIEN status[]', () => {
  const m = lib.normaliserMessageItem(itemHistorique());
  assert.strictEqual(m.id, 'msg-abc');
  assert.strictEqual(m.ts, 1762893600000);
  assert.strictEqual(m.emis_a, new Date(1762893600000).toISOString());
  assert.strictEqual(m.texte, 'Bonjour, mon scooter ne démarre plus.');
  assert.strictEqual(m.sortant, false);
  assert.strictEqual(m.humain, false);
});

test('normaliserMessageItem : sortant + humain (collègue)', () => {
  const m = lib.normaliserMessageItem(itemHistorique({
    traffic: 'outgoing',
    sender: { type: 'user', userId: '76226555' }
  }));
  assert.strictEqual(m.sortant, true);
  assert.strictEqual(m.humain, true);
});

test('normaliserMessageItem : sortant agent IA → humain false', () => {
  const m = lib.normaliserMessageItem(itemHistorique({
    traffic: 'outgoing',
    sender: { source: 'agent' }
  }));
  assert.strictEqual(m.sortant, true);
  assert.strictEqual(m.humain, false);
});

test('normaliserMessageItem : rétro-compatibilité createdAt SANS status[]', () => {
  const m = lib.normaliserMessageItem({ messageId: 'm2', traffic: 'incoming', createdAt: 1762800000, message: { type: 'text', text: 'ok' } });
  assert.strictEqual(m.ts, 1762800000000); // secondes → ms via normaliserTs
  assert.strictEqual(m.texte, 'ok');
});

test('normaliserMessageItem : média → media + type_media', () => {
  const m = lib.normaliserMessageItem(itemHistorique({
    message: { type: 'image', url: 'https://cdn.respond.io/photo.jpg', mime: 'image/jpeg' }
  }));
  assert.strictEqual(m.media, 'https://cdn.respond.io/photo.jpg');
});

test('trierMessages : ordre brut API (récent d\'abord) → chronologique croissant', () => {
  const brut = [
    { ts: 3000, id: 'c' },
    { ts: 1000, id: 'a' },
    { ts: 2000, id: 'b' }
  ];
  const trie = lib.trierMessages(brut);
  assert.deepStrictEqual(trie.map(m => m.id), ['a', 'b', 'c']);
});

test('trierMessages : messages non datables en FIN', () => {
  const trie = lib.trierMessages([{ ts: 5000, id: 'x' }, { ts: 0, id: '?' }, { ts: 1000, id: 'y' }]);
  assert.deepStrictEqual(trie.map(m => m.id), ['y', 'x', '?']);
});

test('extraireContact : fullName + lifecycle + tags chaînes', () => {
  const c = lib.extraireContact(ficheContact({ tags: ['Prise de main', 'Traitée'] }));
  assert.strictEqual(c.nom, 'PIZZA AL FORNO (CLAMART)');
  assert.strictEqual(c.cycle, 'A qualifier');
  assert.deepStrictEqual(c.tags, ['Prise de main', 'Traitée']);
});

test('extraireContact : repli prénom+nom, tags objets {name}', () => {
  const c = lib.extraireContact({ firstName: 'Marie', lastName: 'Durand', lifecycle: { name: 'Traitée' }, tags: [{ name: 'Prise de main' }] });
  assert.strictEqual(c.nom, 'Marie Durand');
  assert.deepStrictEqual(c.tags, ['Prise de main']);
});

test('normaliserCommentaire : texte, auteur, horodatage', () => {
  const c = lib.normaliserCommentaire({ id: 'c1', text: '@Agent IA intervention 05511', userId: '76226555', createdAt: 1762800000000 });
  assert.strictEqual(c.texte, '@Agent IA intervention 05511');
  assert.strictEqual(c.auteur, '76226555');
  assert.strictEqual(c.ts, 1762800000000);
});

// ============================================================================
// 2) ADAPTATEUR respond.io (URL, auth, erreurs) — fetch simulé
// ============================================================================

test('lireContact : URL /contact/id:X + Bearer token', async () => {
  appelsFetch = []; reponses = [{ status: 200, corps: ficheContact() }];
  await respondio.lireContact('123');
  assert.strictEqual(appelsFetch[0].url, 'https://api.respond.io/v2/contact/id:123');
  assert.strictEqual(appelsFetch[0].options.headers.Authorization, 'Bearer token-respondio-test');
});

test('lireHistorique : URL message/list?limit=60 par défaut', async () => {
  appelsFetch = []; reponses = [{ status: 200, corps: { items: [] } }];
  await respondio.lireHistorique('123');
  assert.strictEqual(appelsFetch[0].url, 'https://api.respond.io/v2/contact/id:123/message/list?limit=60');
});

test('requeteHTTP : erreur >= 400 → exception avec code + extrait', async () => {
  appelsFetch = []; reponses = [{ status: 401, corps: { message: 'Invalid API key' } }];
  await assert.rejects(() => respondio.lireContact('123'), /respond\.io 401/);
});

// ============================================================================
// 3) API /api/contexte — handler Vercel complet
// ============================================================================

test('POST → 405', async () => {
  const res = faireRes();
  await contexte({ method: 'POST', url: '/api/contexte', query: {}, headers: {} }, res);
  assert.strictEqual(res.statusCode, 405);
});

test('GET sans secret → 401', async () => {
  appelsFetch = []; reponses = reponsesStandards();
  const res = faireRes();
  await contexte(reqGet('contact=123'), res);
  assert.strictEqual(res.statusCode, 401);
});

test('GET mauvais secret → 401', async () => {
  appelsFetch = []; reponses = reponsesStandards();
  const res = faireRes();
  await contexte(reqGet('contact=123&secret=faux'), res);
  assert.strictEqual(res.statusCode, 401);
});

test('GET sans contact → 400', async () => {
  appelsFetch = []; reponses = reponsesStandards();
  const res = faireRes();
  await contexte(reqGet('secret=secret-de-test-b2'), res);
  assert.strictEqual(res.statusCode, 400);
});

test('GET sans RESPONDIO_TOKEN → 500 message explicite', async () => {
  const sauve = process.env.RESPONDIO_TOKEN;
  delete process.env.RESPONDIO_TOKEN;
  const res = faireRes();
  await contexte(reqGet('secret=secret-de-test-b2&contact=123'), res);
  process.env.RESPONDIO_TOKEN = sauve;
  assert.strictEqual(res.statusCode, 500);
  assert.match(res.corps.erreur, /RESPONDIO_TOKEN manquant/);
});

test('GET complet : 3 appels dans l\'ordre, 200, fiche + messages + commentaires', async () => {
  appelsFetch = []; reponses = reponsesStandards();
  const res = faireRes();
  await contexte(reqGet('secret=secret-de-test-b2&contact=123'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.brique, 'B2');
  assert.strictEqual(res.corps.version, 'B2.1.1');
  assert.strictEqual(res.corps.contact_id, '123');
  assert.strictEqual(res.corps.limite, 60);
  // 3 appels dans l'ordre attendu (séquentiel)
  assert.strictEqual(appelsFetch.length, 3);
  assert.strictEqual(appelsFetch[0].url, 'https://api.respond.io/v2/contact/id:123');
  assert.strictEqual(appelsFetch[1].url, 'https://api.respond.io/v2/contact/id:123/message/list?limit=60');
  assert.strictEqual(appelsFetch[2].url, 'https://api.respond.io/v2/contact/id:123/comment');
  // Fiche
  assert.strictEqual(res.corps.contact.nom, 'PIZZA AL FORNO (CLAMART)');
  assert.strictEqual(res.corps.contact.cycle, 'A qualifier');
  assert.deepStrictEqual(res.corps.contact.tags, ['Prise de main']);
  // Message normalisé
  assert.strictEqual(res.corps.messages.length, 1);
  const m = res.corps.messages[0];
  assert.strictEqual(m.id, 'msg-abc');
  assert.strictEqual(m.ts, 1762893600000);
  assert.strictEqual(m.sortant, false);
  // Commentaire normalisé
  assert.strictEqual(res.corps.commentaires.length, 1);
  assert.strictEqual(res.corps.commentaires[0].texte, '@Agent IA intervention 05511');
  assert.strictEqual(res.corps.commentaires[0].auteur, '76226555');
  assert.deepStrictEqual(res.corps.avertissements, []);
});

test('GET avec limit=5 → URL limit=5 ; limit=500 → borné à 100', async () => {
  appelsFetch = []; reponses = reponsesStandards();
  const res = faireRes();
  await contexte(reqGet('secret=secret-de-test-b2&contact=123&limit=5'), res);
  assert.strictEqual(appelsFetch[1].url, 'https://api.respond.io/v2/contact/id:123/message/list?limit=5');
  assert.strictEqual(res.corps.limite, 5);

  appelsFetch = []; reponses = reponsesStandards();
  const res2 = faireRes();
  await contexte(reqGet('secret=secret-de-test-b2&contact=123&limit=500'), res2);
  assert.strictEqual(appelsFetch[1].url, 'https://api.respond.io/v2/contact/id:123/message/list?limit=100');
  assert.strictEqual(res2.corps.limite, 100);
});

test('historique respond.io en erreur → 200, messages vides, avertissement', async () => {
  appelsFetch = [];
  reponses = [
    { status: 200, corps: ficheContact() },
    { status: 500, corps: { message: 'boom' } },
    { status: 200, corps: { items: [] } }
  ];
  const res = faireRes();
  await contexte(reqGet('secret=secret-de-test-b2&contact=123'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.deepStrictEqual(res.corps.messages, []);
  assert.strictEqual(res.corps.commentaires.length, 0);
  assert.ok(res.corps.avertissements.length >= 1, 'avertissement messages attendu');
});

test('fiche en échec réseau → 200, contact.erreur remplie, historique INTACT', async () => {
  appelsFetch = [];
  reponses = [
    { reject: 'network down' },
    { status: 200, corps: { items: [itemHistorique()] } },
    { status: 200, corps: { items: [] } }
  ];
  const res = faireRes();
  await contexte(reqGet('secret=secret-de-test-b2&contact=123'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.corps.contact.erreur, 'contact.erreur attendue');
  assert.strictEqual(res.corps.messages.length, 1, 'historique best-effort préservé');
});

test('commentaires en échec → 200, commentaires vides, avertissement', async () => {
  appelsFetch = [];
  reponses = [
    { status: 200, corps: ficheContact() },
    { status: 200, corps: { items: [] } },
    { status: 404, corps: { message: 'nope' } }
  ];
  const res = faireRes();
  await contexte(reqGet('secret=secret-de-test-b2&contact=123'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.corps.commentaires, []);
  assert.ok(res.corps.avertissements.some(a => a.indexOf('commentaires') !== -1));
});

test('secret accepté via header x-webhook-secret', async () => {
  appelsFetch = []; reponses = reponsesStandards();
  const res = faireRes();
  await contexte(reqGet('contact=123', { 'x-webhook-secret': 'secret-de-test-b2' }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
});

// ============================================================================
// 4) DIAGNOSTIC brut=1 (méthode prod v135/v136) — mêmes appels + réponses
//    BRUTES respond.io pour diagnostiquer la prod réelle
// ============================================================================

test('brut=1 : réponse embarque fiche + messages + commentaires BRUTS', async () => {
  appelsFetch = []; reponses = reponsesStandards();
  const res = faireRes();
  await contexte(reqGet('secret=secret-de-test-b2&contact=123&brut=1'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.version, 'B2.1.1');
  // TOUJOURS 3 appels — le mode brut n'ajoute AUCUN appel API
  assert.strictEqual(appelsFetch.length, 3);
  // Fiche brute : la structure EXACTE renvoyée par respond.io, pas la normalisée
  assert.deepStrictEqual(res.corps.brut.fiche, ficheContact({ tags: ['Prise de main'] }));
  assert.strictEqual(res.corps.brut.fiche.lifecycle.name, 'A qualifier');
  // Messages bruts : items non normalisés (ici 1 item standard)
  assert.strictEqual(Array.isArray(res.corps.brut.messages), true);
  assert.strictEqual(res.corps.brut.messages.length, 1);
  assert.strictEqual(res.corps.brut.messages[0].messageId, 'msg-abc');
  // Commentaires bruts : items non normalisés
  assert.strictEqual(res.corps.brut.commentaires.length, 1);
  assert.strictEqual(res.corps.brut.commentaires[0].id, 'c1');
  // La section normalisée reste INTACTE
  assert.strictEqual(res.corps.contact.nom, 'PIZZA AL FORNO (CLAMART)');
});

test('sans brut : champ brut à null (aucun poids supplémentaire)', async () => {
  appelsFetch = []; reponses = reponsesStandards();
  const res = faireRes();
  await contexte(reqGet('secret=secret-de-test-b2&contact=123'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.brut, null);
});

test('brut=1 + section commentaires en 404 : brut.commentaires null, diagnostic dans avertissements', async () => {
  appelsFetch = [];
  reponses = [
    { status: 200, corps: ficheContact() },
    { status: 200, corps: { items: [itemHistorique()] } },
    { status: 404, corps: { message: 'nope' } }
  ];
  const res = faireRes();
  await contexte(reqGet('secret=secret-de-test-b2&contact=123&brut=1'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.brut.commentaires, null);
  assert.ok(res.corps.avertissements.some(a => a.indexOf('commentaires') !== -1));
  assert.ok(res.corps.avertissements.some(a => a.indexOf('404') !== -1));
  // Le reste du contexte reste INTACT (best-effort par section)
  assert.strictEqual(res.corps.contact.nom, 'PIZZA AL FORNO (CLAMART)');
  assert.strictEqual(res.corps.messages.length, 1);
});

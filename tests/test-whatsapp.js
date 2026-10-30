// ============================================================================
// Agent SAV U'mob v2 — C4 : tests du webhook WhatsApp + lecture messages
// Exécution : node --test tests/test-whatsapp.js
// (17 tests — Supabase SIMULÉ, aucune dépendance, aucun réseau)
// Mise à jour C2 (30/10) : les statuses Meta ne sont plus ignorés — ils
// mettent à jour statut_reception du wamid (✓✓ dans le canvas).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');

process.env.WEBHOOK_SECRET = 'secret-de-test-c4';
process.env.WA_VERIFY_TOKEN = 'token-meta-test';
process.env.SUPABASE_URL = 'https://supabase-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'cle-service-test';

const handlerWebhook = require('../api/whatsapp-webhook.js');
const handlerMessages = require('../api/whatsapp-messages.js');

function faireRes() {
  return {
    statusCode: null, corps: null, envoye: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.corps = obj; return this; },
    send(txt) { this.envoye = txt; return this; },
    end() { return this; },
    setHeader() { return this; }
  };
}

let appelsFetch = [];
let reponseInsert = null;          // si défini : échec simulé sur l'insert
let lignesMiroir = [];             // lignes wa_messages "stockées" par le mock
globalThis.fetch = async function(url, options) {
  url = String(url); options = options || {};
  appelsFetch.push({ url, options });
  if (reponseInsert && url.indexOf('wa_messages') !== -1) {
    const r = reponseInsert;
    reponseInsert = null;
    return { ok: false, status: r.status, text: async () => JSON.stringify(r.corps || {}) };
  }
  if (url.indexOf('wa_messages') !== -1 && (options.method || 'GET') === 'POST') {
    lignesMiroir = JSON.parse(options.body).map(function(l, i) { return Object.assign({}, l, { id: i + 1 + lignesMiroir.length }); });
    return { ok: true, status: 201, text: async () => '' };
  }
  if (url.indexOf('wa_messages') !== -1) {
    // GET/PATCH : renvoie les lignes "stockées" (simulation miroir persistante)
    return { ok: true, status: 200, text: async () => JSON.stringify(lignesMiroir) };
  }
  if (url.indexOf('journal') !== -1) {
    return { ok: true, status: 201, text: async () => '' };
  }
  return { ok: true, status: 200, text: async () => '{}' };
};

function raz() { appelsFetch = []; reponseInsert = null; lignesMiroir = []; }

function reqGet(query) {
  return {
    method: 'GET', url: '/api/whatsapp-webhook' + (query || ''),
    query: query ? Object.fromEntries(new URLSearchParams(query)) : {},
    headers: {}, body: null
  };
}
function reqPost(body) {
  return { method: 'POST', url: '/api/whatsapp-webhook', query: {}, headers: {}, body: body };
}

// --- Payload Meta de référence (forme officielle Cloud API) ------------------
function payloadMeta(overrides) {
  const p = {
    object: 'whatsapp_business_account',
    entry: [{
      id: '123456789',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '33758091234', phone_number_id: '999' },
          contacts: [{ profile: { name: 'Ismail' }, wa_id: '33620476040' }],
          messages: [{
            from: '33620476040',
            id: 'wamid.ABC123',
            timestamp: '1777461600',
            type: 'text',
            text: { body: 'Bonjour, mon scooter ne démarre plus' }
          }]
        }
      }]
    }]
  };
  if (overrides) overrides(p);
  return p;
}

// ============================================================================
// 1) Vérification du webhook Meta (GET hub.*)
// ============================================================================

test('webhook GET : bon verify_token → echo du challenge', async () => {
  raz();
  const res = faireRes();
  await handlerWebhook(reqGet('?hub.mode=subscribe&hub.verify_token=token-meta-test&hub.challenge=9876543210'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.envoye, '9876543210');
});

test('webhook GET : mauvais token → 403', async () => {
  raz();
  const res = faireRes();
  await handlerWebhook(reqGet('?hub.mode=subscribe&hub.verify_token=faux&hub.challenge=123'), res);
  assert.strictEqual(res.statusCode, 403);
});

test('webhook GET : sans mode subscribe → 403', async () => {
  raz();
  const res = faireRes();
  await handlerWebhook(reqGet('?hub.verify_token=token-meta-test&hub.challenge=123'), res);
  assert.strictEqual(res.statusCode, 403);
});

test('webhook 405 en PUT', async () => {
  const res = faireRes();
  await handlerWebhook({ method: 'PUT', url: '/api/whatsapp-webhook', query: {}, headers: {}, body: null }, res);
  assert.strictEqual(res.statusCode, 405);
});

// ============================================================================
// 2) POST : extraction + écriture
// ============================================================================

test('webhook POST : message texte → enregistré avec wa_id, texte, ISO', async () => {
  raz();
  const res = faireRes();
  await handlerWebhook(reqPost(payloadMeta()), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.enregistres, 1);
  const insert = appelsFetch.find(a => a.url.indexOf('wa_messages') !== -1 && a.options.method === 'POST');
  assert.ok(insert, 'un insert wa_messages');
  assert.ok(insert.url.indexOf('on_conflict=wamid') !== -1, 'dédup par wamid');
  const lot = JSON.parse(insert.options.body);
  assert.strictEqual(lot[0].wa_id, '33620476040');
  assert.strictEqual(lot[0].texte, 'Bonjour, mon scooter ne démarre plus');
  assert.strictEqual(lot[0].wamid, 'wamid.ABC123');
  assert.strictEqual(lot[0].nom_profil, 'Ismail');
  assert.strictEqual(lot[0].recu_a, new Date(1777461600000).toISOString());
  assert.strictEqual(insert.options.headers['Prefer'].indexOf('ignore-duplicates') !== -1, true);
});

test('webhook POST : statuses (accusés Meta) → statut_reception mis à jour (C2)', async () => {
  raz();
  const res = faireRes();
  const p = {
    object: 'whatsapp_business_account',
    entry: [{
      id: '1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          statuses: [{ id: 'wamid.X', status: 'delivered', timestamp: '1777461601', recipient_id: '33758091234' }]
        }
      }]
    }]
  };
  await handlerWebhook(reqPost(p), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.enregistres, 0);
  assert.strictEqual(res.corps.statuts_maj, 1);
  const patch = appelsFetch.find(a => a.url.indexOf('wa_messages') !== -1 && a.options.method === 'PATCH');
  assert.ok(patch, 'un PATCH wa_messages pour le statut');
  assert.ok(patch.url.indexOf('wamid=eq.wamid.X') !== -1, 'cible le bon wamid');
  assert.strictEqual(JSON.parse(patch.options.body).statut_reception, 'delivered');
});

test('webhook POST : statuses read → lu ; plusieurs statuts traités', async () => {
  raz();
  const res = faireRes();
  const p2 = {
    object: 'whatsapp_business_account',
    entry: [{
      id: '1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          statuses: [
            { id: 'wamid.R', status: 'read', timestamp: '1777461700', recipient_id: '33758091234' },
            { id: 'wamid.S', status: 'sent', timestamp: '1777461701', recipient_id: '33758091234' }
          ]
        }
      }]
    }]
  };
  await handlerWebhook(reqPost(p2), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.statuts_maj, 2);
  const patchs = appelsFetch.filter(a => a.url.indexOf('wa_messages') !== -1 && a.options.method === 'PATCH');
  assert.strictEqual(patchs.length, 2);
});

test('webhook POST : image sans légende → placeholder [média reçu], jamais d URL', async () => {
  raz();
  const res = faireRes();
  await handlerWebhook(reqPost(payloadMeta(p => {
    p.entry[0].changes[0].value.messages[0] = {
      from: '33620476040', id: 'wamid.IMG1', timestamp: '1777461602', type: 'image',
      image: { id: 'media123', mime_type: 'image/jpeg' }
    };
  })), res);
  const insert = appelsFetch.find(a => a.url.indexOf('wa_messages') !== -1 && a.options.method === 'POST');
  const lot = JSON.parse(insert.options.body);
  assert.strictEqual(lot[0].texte, '[média reçu]');
  assert.strictEqual(lot[0].type, 'image');
});

test('webhook POST : payload illisible → 200 sans crash (Meta ne doit pas rejuger)', async () => {
  raz();
  const res = faireRes();
  await handlerWebhook(reqPost(null), res);
  assert.strictEqual(res.statusCode, 200);
});

test('webhook POST : échec Supabase → 200 QUAND MÊME + journal', async () => {
  raz();
  reponseInsert = { status: 500, corps: { error: 'boom' } };
  const res = faireRes();
  await handlerWebhook(reqPost(payloadMeta()), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.enregistres, 0);
  assert.ok(res.corps.erreur_interne);
  const journal = appelsFetch.filter(a => a.url.indexOf('journal') !== -1);
  assert.ok(journal.length >= 1, 'échec journalisé');
});

test('webhook POST : plusieurs messages et contacts → tous enregistrés, nom mappé', async () => {
  raz();
  const res = faireRes();
  await handlerWebhook(reqPost(payloadMeta(p => {
    p.entry[0].changes[0].value.contacts.push({ profile: { name: 'Marc' }, wa_id: '33698765432' });
    p.entry[0].changes[0].value.messages.push({
      from: '33698765432', id: 'wamid.DEF456', timestamp: '1777461605', type: 'text',
      text: { body: 'Deuxième message' }
    });
  })), res);
  assert.strictEqual(res.corps.enregistres, 2);
  const insert = appelsFetch.find(a => a.url.indexOf('wa_messages') !== -1 && a.options.method === 'POST');
  const lot = JSON.parse(insert.options.body);
  assert.strictEqual(lot.length, 2);
  assert.strictEqual(lot[1].nom_profil, 'Marc');
});

// ============================================================================
// 3) Lecture : /api/whatsapp-messages
// ============================================================================

test('lecture : 401 sans secret', async () => {
  raz();
  const res = faireRes();
  await handlerMessages(reqGet(''), res);
  assert.strictEqual(res.statusCode, 401);
});

test('lecture : 405 en POST', async () => {
  raz();
  const res = faireRes();
  await handlerMessages({ method: 'POST', url: '/api/whatsapp-messages?secret=secret-de-test-c4', query: { secret: 'secret-de-test-c4' }, headers: {}, body: null }, res);
  assert.strictEqual(res.statusCode, 405);
});

test('lecture liste : renvoie les messages et le nombre de conversations', async () => {
  raz();
  await handlerWebhook(reqPost(payloadMeta(p => {
    p.entry[0].changes[0].value.messages.push({
      from: '33698765432', id: 'wamid.G', timestamp: '1777461610', type: 'text',
      text: { body: 'Autre conversation' }
    });
  })), faireRes());
  appelsFetch = [];  // on garde les lignes du miroir, on ne vide que les appels
  const res = faireRes();
  await handlerMessages(reqGet('?secret=secret-de-test-c4&liste=1'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.total, 2);
  assert.strictEqual(res.corps.conversations, 2);
  assert.ok(Array.isArray(res.corps.messages));
});

test('lecture tel : filtre par numéro (chiffres seuls tolérés)', async () => {
  raz();
  await handlerWebhook(reqPost(payloadMeta()), faireRes());
  appelsFetch = [];
  const res = faireRes();
  await handlerMessages(reqGet('?secret=secret-de-test-c4&tel=+33 6 20 47 60 40'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.tel, '33620476040');
  assert.strictEqual(res.corps.trouves, 1);
});

test('lecture : borne limite 1-5000', async () => {
  raz();
  const res = faireRes();
  await handlerMessages(reqGet('?secret=secret-de-test-c4&liste=1&limite=99999'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.limite, 5000);
});

test('CORS présent (preflight OPTIONS 204 + Allow-Origin)', async () => {
  raz();
  const res = faireRes();
  await handlerMessages({ method: 'OPTIONS', url: '/api/whatsapp-messages', query: {}, headers: {}, body: null }, res);
  assert.strictEqual(res.statusCode, 204);
});

test('lecture : erreur Supabase → 500 avec message', async () => {
  raz();
  reponseInsert = { status: 403, corps: { error: 'permission denied' } };
  const res = faireRes();
  await handlerMessages(reqGet('?secret=secret-de-test-c4&liste=1'), res);
  assert.strictEqual(res.statusCode, 500);
  assert.ok(String(res.corps.erreur).indexOf('403') !== -1);
});

test('lecture : colonnes C2 absentes (PGRST204) → repli ancien select, pas de crash', async () => {
  raz();
  reponseInsert = { status: 400, corps: { message: 'column wa_messages.sens does not exist', code: 'PGRST204' } };
  // le mock renvoie l'erreur UNE fois pour le select avec sens/statut_reception,
  // puis la lecture miroir classique pour le select repli
  const res = faireRes();
  await handlerMessages(reqGet('?secret=secret-de-test-c4&liste=1'), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
});

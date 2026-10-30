// ============================================================================
// Agent SAV U'mob v2 — tests /api/whatsapp-send (brique C2) — node --test
// Aucune dépendance : global.fetch est remplacé par un mock ; les variables
// d'environnement sont posées/rétablies autour de chaque test.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

var handler;
test.before(function() {
  handler = require(path.join(__dirname, '..', 'api', 'whatsapp-send.js'));
});

var ENVS = ['WEBHOOK_SECRET', 'WA_TOKEN', 'WA_PHONE_NUMBER_ID',
            'WA_API_VERSION', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
var SAUVE = {};

function poserEnv(vals) {
  ENVS.forEach(function(n) { delete process.env[n]; });
  Object.keys(vals || {}).forEach(function(n) { process.env[n] = vals[n]; });
}

test.beforeEach(function() { SAUVE = {}; ENVS.forEach(function(n) { SAUVE[n] = process.env[n]; }); });
test.afterEach(function() { ENVS.forEach(function(n) {
  if (SAUVE[n] === undefined) delete process.env[n]; else process.env[n] = SAUVE[n];
}); });

function resMock() {
  return {
    code: 0, corps: null, entetes: {},
    status: function(c) { this.code = c; return this; },
    json: function(j) { this.corps = j; return this; },
    send: function(t) { this.corps = t; return this; },
    end: function() { return this; },
    setHeader: function(k, v) { this.entetes[k] = v; }
  };
}

function reqMock(methode, corps, query) {
  return { method: methode, body: corps, query: query || {}, headers: {}, url: '/api/whatsapp-send' };
}

// fetch mocké : filet de capture des appels + filets de réponses programmables
var FETCH_LOG = [];
var FETCH_REPONSES = [];
var FETCH_FETCH = null;

test.before(function() {
  FETCH_FETCH = global.fetch;
  global.fetch = async function(url, opts) {
    FETCH_LOG.push({ url: String(url), opts: opts });
    if (FETCH_REPONSES.length) return FETCH_REPONSES.shift()();
    return (function() {
      var ok = true, status = 200, corps = '{}';
      return {
        get ok() { return ok; }, get status() { return status; },
        text: async function() { return corps; },
        json: async function() { return JSON.parse(corps); }
      };
    })();
  };
});
test.after(function() { global.fetch = FETCH_FETCH; });

test.beforeEach(function() { FETCH_LOG = []; FETCH_REPONSES = []; });

var ENVS_OK = {
  WEBHOOK_SECRET: 'S', WA_TOKEN: 'T', WA_PHONE_NUMBER_ID: 'PNID',
  SUPABASE_URL: 'https://umob-crm.supabase.co', SUPABASE_SERVICE_KEY: 'K'
};

test('C2-ENV : secret manquant → 401', async function() {
  poserEnv(ENVS_OK);
  var r = resMock();
  await handler(reqMock('POST', { tel: '33612345678', texte: 'bonjour' }, {}), r);
  assert.strictEqual(r.code, 401);
});

test('C2-ENV : secret invalide → 401', async function() {
  poserEnv(ENVS_OK);
  var r = resMock();
  await handler(reqMock('POST', { secret: 'mauvais', tel: '33612345678', texte: 'bonjour' }, {}), r);
  assert.strictEqual(r.code, 401);
});

test('C2-ENV : GET → 405', async function() {
  poserEnv(ENVS_OK);
  var r = resMock();
  await handler(reqMock('GET', null, { secret: 'S' }), r);
  assert.strictEqual(r.code, 405);
});

test('C2-ENV : tel manquant → 400', async function() {
  poserEnv(ENVS_OK);
  var r = resMock();
  await handler(reqMock('POST', { secret: 'S', texte: 'bonjour' }, {}), r);
  assert.strictEqual(r.code, 400);
});

test('C2-ENV : texte manquant → 400', async function() {
  poserEnv(ENVS_OK);
  var r = resMock();
  await handler(reqMock('POST', { secret: 'S', tel: '33612345678' }, {}), r);
  assert.strictEqual(r.code, 400);
});

test('C2-ENV : texte trop long → 400', async function() {
  poserEnv(ENVS_OK);
  var r = resMock();
  await handler(reqMock('POST', { secret: 'S', tel: '33612345678', texte: 'x'.repeat(4097) }, {}), r);
  assert.strictEqual(r.code, 400);
});

test('C2-ENV : config Meta absente → 500 explicite', async function() {
  poserEnv({ WEBHOOK_SECRET: 'S', SUPABASE_URL: 'u', SUPABASE_SERVICE_KEY: 'k' });
  var r = resMock();
  await handler(reqMock('POST', { secret: 'S', tel: '33612345678', texte: 'bonjour' }, {}), r);
  assert.strictEqual(r.code, 500);
  assert.ok(String(r.corps.erreur).indexOf('WA_TOKEN') !== -1);
});

test('C2-ENV : erreur Meta (token périmé) → 502 + détail', async function() {
  poserEnv(ENVS_OK);
  FETCH_REPONSES.push(function() {
    return { ok: false, status: 401,
      text: async function() { return JSON.stringify({ error: { message: 'token expiré' } }); } };
  });
  var r = resMock();
  await handler(reqMock('POST', { secret: 'S', tel: '33612345678', texte: 'bonjour' }, {}), r);
  assert.strictEqual(r.code, 502);
  var appelsMeta = FETCH_LOG.filter(function(l) { return String(l.url).indexOf('graph.facebook.com') !== -1; });
  assert.strictEqual(appelsMeta.length, 1);
  assert.ok(String(appelsMeta[0].url).indexOf('PNID') !== -1);
});

test('C2-ENV : envoi réussi → 200 + wamid + enregistrement sortant', async function() {
  poserEnv(ENVS_OK);
  FETCH_REPONSES.push(function() {
    return { ok: true, status: 200,
      text: async function() { return JSON.stringify({ messages: [{ id: 'wamid.XYZ' }] }); } };
  });
  FETCH_REPONSES.push(function() {
    return { ok: true, status: 201, text: async function() { return ''; } };
  });
  var r = resMock();
  await handler(reqMock('POST', { secret: 'S', tel: '+33 6 12 34 56 78', texte: ' Bonjour ! ' }, {}), r);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.corps.ok, true);
  assert.strictEqual(r.corps.wamid, 'wamid.XYZ');
  assert.strictEqual(r.corps.statut, 'envoye');
  // appel Meta : téléphone normalisé en chiffres seuls, texte trimé
  var corpsMeta = JSON.parse(FETCH_LOG[0].opts.body);
  assert.strictEqual(corpsMeta.to, '33612345678');
  assert.strictEqual(corpsMeta.text.body, 'Bonjour !');
  assert.strictEqual(corpsMeta.messaging_product, 'whatsapp');
  // enregistrement Supabase : sens sortant + statut sent
  var lot = JSON.parse(FETCH_LOG[1].opts.body);
  assert.strictEqual(lot[0].wa_id, '33612345678');
  assert.strictEqual(lot[0].sens, 'sortant');
  assert.strictEqual(lot[0].statut_reception, 'sent');
  assert.strictEqual(lot[0].wamid, 'wamid.XYZ');
});

test('C2-ENV : envoi OK mais Supabase en panne → 200 quand même (best effort)', async function() {
  poserEnv(ENVS_OK);
  FETCH_REPONSES.push(function() {
    return { ok: true, status: 200,
      text: async function() { return JSON.stringify({ messages: [{ id: 'wamid.ABC' }] }); } };
  });
  FETCH_REPONSES.push(function() { throw new Error('Supabase down'); });
  var r = resMock();
  await handler(reqMock('POST', { secret: 'S', tel: '33612345678', texte: 'bonjour' }, {}), r);
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.corps.wamid, 'wamid.ABC');
});

test('C2-ENV : secret accepté par header x-webhook-secret', async function() {
  poserEnv(ENVS_OK);
  var req = reqMock('POST', { tel: '33612345678', texte: 'bonjour' }, {});
  req.headers = { 'x-webhook-secret': 'S' };
  FETCH_REPONSES.push(function() {
    return { ok: true, status: 200,
      text: async function() { return JSON.stringify({ messages: [{ id: 'wamid.HDR' }] }); } };
  });
  FETCH_REPONSES.push(function() { return { ok: true, status: 201, text: async function() { return ''; } }; });
  var r = resMock();
  await handler(req, r);
  assert.strictEqual(r.code, 200);
});

test('C2-ENV : WA_API_VERSION personnalisée utilisée dans l’URL Meta', async function() {
  poserEnv(Object.assign({}, ENVS_OK, { WA_API_VERSION: 'v23.0' }));
  FETCH_REPONSES.push(function() {
    return { ok: true, status: 200,
      text: async function() { return JSON.stringify({ messages: [{ id: 'wamid.V' }] }); } };
  });
  FETCH_REPONSES.push(function() { return { ok: true, status: 201, text: async function() { return ''; } }; });
  var r = resMock();
  await handler(reqMock('POST', { secret: 'S', tel: '33612345678', texte: 'bonjour' }, {}), r);
  assert.strictEqual(r.code, 200);
  assert.ok(String(FETCH_LOG[0].url).indexOf('/v23.0/PNID/messages') !== -1);
});

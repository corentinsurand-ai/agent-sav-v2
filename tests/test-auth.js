// ============================================================================
// Agent SAV U'mob v2 — C6-AUTH : tests de l'authentification équipe
// Exécution : node --test tests/test-auth.js
// (lib/auth.js + branches C6-AUTH de /api/clients-import — Supabase SIMULÉ)
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');

// --- Environnement de test AVANT le require ----------------------------------
process.env.WEBHOOK_SECRET = 'secret-test-c6';
process.env.AUTH_SECRET = 'auth-secret-test-c6';
process.env.SUPABASE_URL = 'https://supabase-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'cle-service-test';

const auth = require('../lib/auth.js');
const handler = require('../api/clients-import.js');

// --- Simulation de res / req (Vercel) ----------------------------------------
function faireRes() {
  return {
    statusCode: null, corps: null, entetes: {},
    setHeader(nom, val) { this.entetes[nom] = val; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.corps = obj; return this; },
    end() { return this; }
  };
}
function faireReq(methode, url, corps) {
  return { method: methode, url: url, query: {}, headers: {}, body: corps };
}

// --- Fake Supabase : la table utilisateurs est pilotable ----------------------
var lignesUtilisateurs = [];
var appels = [];
globalThis.fetch = function (url, options) {
  var u = String(url);
  appels.push({ url: u, options: options || {} });
  var corps;
  if (u.indexOf('/rest/v1/journal') !== -1) corps = [];
  else if (u.indexOf('utilisateurs') !== -1) corps = lignesUtilisateurs;
  else corps = [];
  return Promise.resolve({
    ok: true, status: 200,
    text: function () { return Promise.resolve(JSON.stringify(corps)); }
  });
};

function utilisateurFake(role, actif, mdp) {
  return {
    id: 'id-' + role, email: role + '@umob.fr', nom: role === 'admin' ? 'Admin Test' : 'Collab Test',
    role: role, actif: actif !== false, mot_de_passe: auth.hacherMotDePasse(mdp)
  };
}

function dernierAppelEcriture() {
  for (var i = appels.length - 1; i >= 0; i--) {
    if ((appels[i].options.method === 'POST' || appels[i].options.method === 'PATCH') &&
        appels[i].url.indexOf('utilisateurs') !== -1) return appels[i];
  }
  return null;
}

// ============================================================================
// PARTIE 1 — lib/auth.js (pur)
// ============================================================================

test('auth: hacherMotDePasse → format scrypt$sel$hash, vérifiable', () => {
  var hash = auth.hacherMotDePasse('motdepasse1');
  assert.ok(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/.test(hash), hash);
  assert.strictEqual(auth.verifierMotDePasse('motdepasse1', hash), true);
  assert.strictEqual(auth.verifierMotDePasse('autre', hash), false);
});

test('auth: hash unique (sel aléatoire), hash malformé = false sans exception', () => {
  var h1 = auth.hacherMotDePasse('motdepasse1');
  var h2 = auth.hacherMotDePasse('motdepasse1');
  assert.notStrictEqual(h1, h2, 'le sel doit être aléatoire');
  assert.strictEqual(auth.verifierMotDePasse('x', ''), false);
  assert.strictEqual(auth.verifierMotDePasse('x', 'scrypt$zz$zz'), false);
  assert.strictEqual(auth.verifierMotDePasse('x', null), false);
});

test('auth: creerJeton/lireJeton — aller-retour + payload', () => {
  var jeton = auth.creerJeton({ id: 'u1', email: 'a@b.fr', nom: 'A', role: 'admin' }, 'cle', 60000);
  var p = auth.lireJeton(jeton, 'cle');
  assert.strictEqual(p.email, 'a@b.fr');
  assert.strictEqual(p.role, 'admin');
  assert.strictEqual(p.id, 'u1');
});

test('auth: jeton signé — mauvaise cle, tamper, expiré, malformé = null', () => {
  var jeton = auth.creerJeton({ id: 'u1', email: 'a@b.fr' }, 'cle', 60000);
  assert.strictEqual(auth.lireJeton(jeton, 'autre-cle'), null);
  assert.strictEqual(auth.lireJeton(jeton.slice(0, -2) + 'xx', 'cle'), null);
  var expire = auth.creerJeton({ id: 'u1' }, 'cle', -1000);
  assert.strictEqual(auth.lireJeton(expire, 'cle'), null, 'expiré');
  assert.strictEqual(auth.lireJeton('pas.un.jeton', 'cle'), null);
  assert.strictEqual(auth.lireJeton('', 'cle'), null);
  assert.throws(function () { auth.creerJeton({ id: 'u1' }, '', 1000); });
});

// ============================================================================
// PARTIE 2 — /api/clients-import branches C6-AUTH
// ============================================================================

test('connexion: identifiants valides → 200 + jeton + utilisateur SANS hash', async () => {
  lignesUtilisateurs = [utilisateurFake('admin', true, 'motdepasse1')];
  appels.length = 0;
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import',
    { connexion: { email: 'admin@umob.fr', mot_de_passe: 'motdepasse1' } }), res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.corps));
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.brique, 'C6-AUTH');
  assert.ok(res.corps.jeton && res.corps.jeton.indexOf('.') !== -1);
  assert.strictEqual(res.corps.utilisateur.email, 'admin@umob.fr');
  assert.strictEqual(res.corps.utilisateur.role, 'admin');
  assert.strictEqual(res.corps.utilisateur.mot_de_passe, undefined, 'JAMAIS de hash dans la réponse');
  // PATCH derniere_connexion passé en ISO
  var ecriture = dernierAppelEcriture();
  assert.ok(ecriture, 'derniere_connexion mise à jour');
  assert.ok(typeof JSON.parse(ecriture.options.body).derniere_connexion === 'string');
});

test('connexion: mauvais mot de passe → 401 identifiants invalides', async () => {
  lignesUtilisateurs = [utilisateurFake('collaborateur', true, 'motdepasse1')];
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import',
    { connexion: { email: 'collaborateur@umob.fr', mot_de_passe: 'FAUX' } }), res);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.corps.erreur, 'identifiants invalides');
});

test('connexion: compte inactif → 401 (même avec le bon mot de passe)', async () => {
  lignesUtilisateurs = [utilisateurFake('collaborateur', false, 'motdepasse1')];
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import',
    { connexion: { email: 'collaborateur@umob.fr', mot_de_passe: 'motdepasse1' } }), res);
  assert.strictEqual(res.statusCode, 401);
});

test('connexion: champ vide → 400 ; corps sans secret N EST PAS rejeté par le gate secret', async () => {
  lignesUtilisateurs = [];
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import', { connexion: { email: '' } }), res);
  assert.strictEqual(res.statusCode, 400);
  assert.notStrictEqual(res.statusCode, 401, 'ne doit pas répondre "secret invalide"');
});

test('GET ?auth=1&jeton=… : jeton valide + compte actif → 200 utilisateur', async () => {
  var u = utilisateurFake('collaborateur', true, 'motdepasse1');
  lignesUtilisateurs = [u];
  var jeton = auth.creerJeton(u, process.env.AUTH_SECRET);
  appels.length = 0;
  var res = faireRes();
  await handler(faireReq('GET', '/api/clients-import?auth=1&jeton=' + encodeURIComponent(jeton)), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.utilisateur.email, 'collaborateur@umob.fr');
});

test('GET ?auth=1 : jeton signé mais compte désactivé → 401 (fail closed)', async () => {
  var u = utilisateurFake('collaborateur', true, 'motdepasse1');
  var jeton = auth.creerJeton(u, process.env.AUTH_SECRET);
  lignesUtilisateurs = []; // compte absent/désactivé côté base
  var res = faireRes();
  await handler(faireReq('GET', '/api/clients-import?auth=1&jeton=' + encodeURIComponent(jeton)), res);
  assert.strictEqual(res.statusCode, 401);
});

test('GET ?auth=1 sans jeton → 401', async () => {
  lignesUtilisateurs = [];
  var res = faireRes();
  await handler(faireReq('GET', '/api/clients-import?auth=1'), res);
  assert.strictEqual(res.statusCode, 401);
});

test('GET ?auth=1&utilisateurs=1 en collaborateur → 403 admin requis', async () => {
  var u = utilisateurFake('collaborateur', true, 'motdepasse1');
  lignesUtilisateurs = [u];
  var jeton = auth.creerJeton(u, process.env.AUTH_SECRET);
  var res = faireRes();
  await handler(faireReq('GET', '/api/clients-import?auth=1&utilisateurs=1&jeton=' + encodeURIComponent(jeton)), res);
  assert.strictEqual(res.statusCode, 403);
});

test('POST utilisateur par un admin → 201, mot de passe haché scrypt (jamais en clair)', async () => {
  var admin = utilisateurFake('admin', true, 'motdepasse1');
  lignesUtilisateurs = [admin];
  var jeton = auth.creerJeton(admin, process.env.AUTH_SECRET);
  appels.length = 0;
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import?jeton=' + encodeURIComponent(jeton), {
    utilisateur: { email: 'nouveau@umob.fr', nom: 'Nouveau', role: 'collaborateur', mot_de_passe: 'motdepasse2' }
  }), res);
  assert.strictEqual(res.statusCode, 201, JSON.stringify(res.corps));
  var envoye = JSON.parse(dernierAppelEcriture().options.body);
  assert.ok(/^scrypt\$/.test(envoye.mot_de_passe), 'hash scrypt envoyé à Supabase');
  assert.notStrictEqual(envoye.mot_de_passe, 'motdepasse2', 'jamais de mot de passe en clair');
  assert.strictEqual(envoye.email, 'nouveau@umob.fr');
  assert.strictEqual(res.corps.utilisateur.mot_de_passe, undefined);
});

test('POST utilisateur par un collaborateur → 403', async () => {
  var collab = utilisateurFake('collaborateur', true, 'motdepasse1');
  lignesUtilisateurs = [collab];
  var jeton = auth.creerJeton(collab, process.env.AUTH_SECRET);
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import?jeton=' + encodeURIComponent(jeton), {
    utilisateur: { email: 'x@umob.fr', mot_de_passe: 'motdepasse2' }
  }), res);
  assert.strictEqual(res.statusCode, 403);
});

test('POST utilisateur : mot de passe trop court → 400', async () => {
  var admin = utilisateurFake('admin', true, 'motdepasse1');
  lignesUtilisateurs = [admin];
  var jeton = auth.creerJeton(admin, process.env.AUTH_SECRET);
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import?jeton=' + encodeURIComponent(jeton), {
    utilisateur: { email: 'x@umob.fr', mot_de_passe: 'court' }
  }), res);
  assert.strictEqual(res.statusCode, 400);
});

test('POST nouveau_mdp par un collaborateur (pas admin) → 200, hash PATCH sur SON id', async () => {
  var collab = utilisateurFake('collaborateur', true, 'motdepasse1');
  lignesUtilisateurs = [collab];
  var jeton = auth.creerJeton(collab, process.env.AUTH_SECRET);
  appels.length = 0;
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import?jeton=' + encodeURIComponent(jeton), {
    nouveau_mdp: 'nouveaumdp123'
  }), res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.corps));
  assert.strictEqual(res.corps.mot_de_passe_modifie, true);
  var ecriture = dernierAppelEcriture();
  assert.ok(ecriture.url.indexOf('id=eq.id-collaborateur') !== -1, 'PATCH sur son propre id : ' + ecriture.url);
  assert.ok(/^scrypt\$/.test(JSON.parse(ecriture.options.body).mot_de_passe));
});

test('POST activation par un admin → 200 PATCH actif', async () => {
  var admin = utilisateurFake('admin', true, 'motdepasse1');
  lignesUtilisateurs = [admin];
  var jeton = auth.creerJeton(admin, process.env.AUTH_SECRET);
  appels.length = 0;
  var res = faireRes();
  await handler(faireReq('POST', '/api/clients-import?jeton=' + encodeURIComponent(jeton), {
    activation: { email: 'collaborateur@umob.fr', actif: false }
  }), res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.corps));
  var ecriture = dernierAppelEcriture();
  assert.ok(ecriture.url.indexOf('email=eq.collaborateur%40umob.fr') !== -1, ecriture.url);
  assert.strictEqual(JSON.parse(ecriture.options.body).actif, false);
});

test('REGRESSION : la route import classique (secret) fonctionne toujours', async () => {
  lignesUtilisateurs = [];
  var res = faireRes();
  await handler(faireReq('GET', '/api/clients-import?secret=' + process.env.WEBHOOK_SECRET), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.version, 'C7-MAINT-1');
});

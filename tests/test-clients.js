// ============================================================================
// Agent SAV U'mob v2 — B2.2 : tests de /api/sync-clients (node --test)
// Exécution : node --test tests/test-clients.js
// (26 tests — aucune dépendance : Google, Supabase et fetch sont SIMULÉS,
//  le JWT est signé avec une vraie clé RSA générée à la volée puis VÉRIFIÉ)
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

// --- Clé RSA réelle pour tester la signature JWT ----------------------------
const paire = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// --- Environnement de test AVANT le require des modules ----------------------
process.env.WEBHOOK_SECRET = 'secret-de-test-b2';
process.env.CRON_SECRET = 'secret-cron-test';
process.env.SUPABASE_URL = 'https://supabase-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'cle-service-test';
process.env.GOOGLE_CLIENT_EMAIL = 'sav-syncl@umob-test.iam.gserviceaccount.com';
process.env.GOOGLE_PRIVATE_KEY = paire.privateKey;
process.env.GOOGLE_SHEET_ID = '1abcSheetTest123';

const google = require('../lib/google.js');
const clients = require('../lib/clients.js');
const handler = require('../api/sync-clients.js');

// --- Simulation de res (Vercel) ----------------------------------------------
function faireRes() {
  return {
    statusCode: null,
    corps: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.corps = obj; return this; },
    end() { return this; }
  };
}

// --- Fake Sheet « Infos Service Client » ------------------------------------
// Reproduit la structure réelle constatée en prod v136 : lignes de titre
// (1-3), EN-TÊTES ligne 4 (accents et casse mélangés, faute « Addresse »),
// données ensuite.
const ENTETES = ['Code client', 'Nom client', 'Addresse', 'Code postal', 'Ville',
  'Libellé produit', 'Immatriculation', 'Prénom', 'Nom contact', 'Fonction',
  'Mobile', 'Email', 'N° contrat', 'Libellé contrat', 'Date début', 'Date fin',
  'Etat', 'Risque', 'Impayés', 'Procédure collective', 'Transfert', 'Résiliation', 'Siren'];

const ONGLET = 'Client_contacts_risq_contr_prod';
const LIGNES = [
  ['Fichier clients U\'mob — onglet fusionné', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],  // 1 titre
  ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],  // 2 vide
  ['MàJ 25/09 par Nicolas', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],  // 3 titre
  ENTETES,                                                                                                                                                  // 4 en-têtes
  ['C001', 'PIZZA AL FORNO', '12 rue de la Paix', '75002', 'Paris', 'Scooter PX', 'aa-123-bb',
    'Marc', 'Dupont', 'Gérant', '06 12 34 56 78', 'marc@pizzaforno.fr', 'C-456', 'Maintenance',
    '01/01/2025', '31/12/2026', 'Actif', 'RISQUE FORT', '', '', '', '', '123456789'],                      // 5 client 1, scooter 1
  ['C001', 'PIZZA AL FORNO', '12 rue de la Paix', '75002', 'Paris', 'Scooter PY', 'cc-456-dd',
    'Marc', 'Dupont', 'Gérant', '06 12 34 56 78', 'marc@pizzaforno.fr', 'C-457', 'Maintenance',
    '01/01/2025', '31/12/2026', 'Actif', '', '', '', '', '', '123456789'],                                 // 6 client 1, scooter 2 (MÊME tél)
  ['C002', 'BISTRO LYON', '3 quai Rhône', '69002', 'Lyon', 'Scooter PZ', 'ff-112-hh',
    'Léa', 'Martin', '', '', 'lea@bistro.fr', 'C-458', 'Maintenance', '', '', 'Actif', '', '', '', '', ''],  // 7 SANS mobile → ignorée
  ['C003', 'SUSHI NICE', '8 prom Anglais', '06000', 'Nice', 'Scooter PW', 'ee-789-ff',
    'Kenji', 'Sato', 'Dirigeant', '+33 6 98 76 54 32', 'kenji@sushi.fr', 'C-459', 'Maintenance',
    '15/03/2025', '14/03/2027', 'Actif', 'IMPAYÉ 2 MENSUALITÉS', '', '', '', '', ''],             // 8 client 2
  ['C003', 'SUSHI NICE', '8 prom Anglais', '06000', 'Nice', 'Scooter PW', 'ee-789-ff',
    'Kenji', 'Sato', 'Dirigeant', '+33 6 98 76 54 32', 'kenji@sushi.fr', 'C-459', 'Maintenance',
    '15/03/2025', '14/03/2027', 'Actif', '', '', '', '', '', '']                                  // 9 client 2, DOUBLON immat → plaque UNIQUE
];

// Fake Sheet pour le test de chunking : 1200 lignes de données, un téléphone
// distinct par ligne (1200 clients → 3 lots de 500)
const LIGNES_GROSSES = [
  ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ENTETES
];
for (let i = 0; i < 1200; i++) {
  const n = String(i).padStart(4, '0');
  const tel = '06 ' + String(i).padStart(8, '0').replace(/(\d{2})(?=\d)/g, '$1 ');
  LIGNES_GROSSES.push(['G' + n, 'ENSEIGNE ' + n, '', '', '', '', 'AB-' + n.slice(0, 3) + '-CD',
    '', '', '', tel, '', '', '', '', '', '', '', '', '', '', '']);
}

let feuilleActive = LIGNES;   // quelle fake sheet le mock renvoie

// --- Simulation de fetch : routeur par URL -----------------------------------
let appelsFetch = [];
let reponsesErreurs = [];     // erreurs à renvoyer, ROUTÉES par fragment d'URL
let dernierAssertion = '';    // assertion JWT capturée sur le endpoint token

function fetchSimule(url, options) {
  url = String(url);
  options = options || {};
  appelsFetch.push({ url, options });

  for (let i = 0; i < reponsesErreurs.length; i++) {
    if (url.indexOf(reponsesErreurs[i].match) !== -1) {
      const r = reponsesErreurs.splice(i, 1)[0];
      return Promise.resolve({
        status: r.status,
        ok: false,
        text: async () => JSON.stringify(r.corps || {})
      });
    }
  }
  if (url.indexOf('oauth2.googleapis.com/token') !== -1) {
    const m = /assertion=([^&]+)/.exec(options.body || '');
    dernierAssertion = m ? decodeURIComponent(m[1]) : '';
    return Promise.resolve({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ access_token: 'jeton-test-b2', expires_in: 3600 })
    });
  }
  if (url.indexOf('sheets.googleapis.com') !== -1) {
    const m = /\/values\/([^?]+)/.exec(url);
    const plage = m ? decodeURIComponent(m[1]) : '';
    const corps = { values: repondrePlage(plage) };
    return Promise.resolve({ status: 200, ok: true, text: async () => JSON.stringify(corps) });
  }
  if (url.indexOf('supabase') !== -1) {
    return Promise.resolve({ status: 201, ok: true, text: async () => '' });
  }
  return Promise.resolve({ status: 200, ok: true, text: async () => '{}' });
}
globalThis.fetch = fetchSimule;

// Répond à une plage A1 du fake sheet actif
function repondrePlage(plage) {
  const tete = /^'(.+)'!1:10$/.exec(plage);
  if (tete) {
    return feuilleActive.slice(0, 10);
  }
  const col = /^'(.+)'!([A-Z]+):([A-Z]+)$/.exec(plage);
  if (col) {
    const idx = indiceColonne(col[2]);
    const sortie = [];
    for (let r = 0; r < feuilleActive.length; r++) {
      sortie.push(String((feuilleActive[r] && feuilleActive[r][idx] !== undefined) ? feuilleActive[r][idx] : ''));
    }
    return sortie;
  }
  return [];
}

function indiceColonne(lettres) {
  let n = 0;
  for (const ch of lettres) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function reqGet(query, headers) {
  return {
    method: 'GET',
    url: '/api/sync-clients' + (query ? '?' + query : ''),
    query: query ? Object.fromEntries(new URLSearchParams(query)) : {},
    headers: headers || {},
    body: null
  };
}

function razCompteurs() {
  appelsFetch = [];
  reponsesErreurs = [];
  google.reinitialiserCache();
}

// ============================================================================
// 1) UNITAIRE — normalisations
// ============================================================================

test('normaliserTelephone : formes françaises → 33 + chiffres', () => {
  assert.strictEqual(clients.normaliserTelephone('06 12 34 56 78'), '33612345678');
  assert.strictEqual(clients.normaliserTelephone('+33 6 12 34 56 78'), '33612345678');
  assert.strictEqual(clients.normaliserTelephone('0033 6 12 34 56 78'), '33612345678');
  assert.strictEqual(clients.normaliserTelephone('33612345678'), '33612345678');
  assert.strictEqual(clients.normaliserTelephone('6 12 34 56 78'), '33612345678');
});

test('normaliserTelephone : étranger conservé, vide ignoré', () => {
  assert.strictEqual(clients.normaliserTelephone('+32 2 123 45 67'), '3221234567');
  assert.strictEqual(clients.normaliserTelephone(''), '');
  assert.strictEqual(clients.normaliserTelephone(null), '');
  assert.strictEqual(clients.normaliserTelephone('   '), '');
});

test('normaliserImmat : aa-123-bb → AA123BB (portage v136)', () => {
  assert.strictEqual(clients.normaliserImmat('aa-123-bb'), 'AA123BB');
  assert.strictEqual(clients.normaliserImmat(' AB 007 CD '), 'AB007CD');
});

test('lettreColonne : 0→A, 25→Z, 26→AA, 52→BA', () => {
  assert.strictEqual(clients.lettreColonne(0), 'A');
  assert.strictEqual(clients.lettreColonne(25), 'Z');
  assert.strictEqual(clients.lettreColonne(26), 'AA');
  assert.strictEqual(clients.lettreColonne(52), 'BA');
});

test('trouverLigneEnTetes : en-têtes ligne 4 du fake sheet', () => {
  const i = clients.trouverLigneEnTetes(LIGNES, ['immat']);
  assert.strictEqual(i, 3);                       // 0-based → ligne 4
  assert.strictEqual(clients.trouverLigneEnTetes([['a'], ['b']], ['immat']), -1);
});

test('trouverColonne : accents/casse tolérés, motifs par priorité', () => {
  const ent = clients.normaliserEnTetes(['Code client', 'Addresse', 'Mobile facturation']);
  assert.strictEqual(clients.trouverColonne(ent, ['^code\\s*client']), 0);
  assert.strictEqual(clients.trouverColonne(ent, ['adresse', 'dresse']), 1); // faute « Addresse »
  assert.strictEqual(clients.trouverColonne(ent, ['mobile', '^tel']), 2);
  assert.strictEqual(clients.trouverColonne(ent, ['risque']), -1);
});

// ============================================================================
// 2) JWT — signature réelle RS256 vérifiée
// ============================================================================

test('obtenirJeton : JWT RS256 signé avec la clé privée, claims corrects', async () => {
  razCompteurs();
  const jeton = await google.obtenirJeton();
  assert.strictEqual(jeton, 'jeton-test-b2');
  const parties = dernierAssertion.split('.');
  assert.strictEqual(parties.length, 3);
  const entete = JSON.parse(Buffer.from(parties[0], 'base64url').toString('utf8'));
  assert.strictEqual(entete.alg, 'RS256');
  // Signature vérifiée avec la clé PUBLIQUE : c'est bien notre clé privée qui signe
  const ok = crypto.verify('RSA-SHA256',
    Buffer.from(parties[0] + '.' + parties[1]),
    paire.publicKey,
    Buffer.from(parties[2], 'base64url'));
  assert.ok(ok, 'signature JWT invalide');
  const claims = JSON.parse(Buffer.from(parties[1], 'base64url').toString('utf8'));
  assert.strictEqual(claims.iss, 'sav-syncl@umob-test.iam.gserviceaccount.com');
  assert.strictEqual(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.strictEqual(claims.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  assert.ok(claims.exp > claims.iat);
});

test('obtenirJeton : cache — les appels parallèles ne demandent QU\'UN token', async () => {
  razCompteurs();
  const dix = await Promise.all([
    google.obtenirJeton(), google.obtenirJeton(), google.obtenirJeton(),
    google.obtenirJeton(), google.obtenirJeton(), google.obtenirJeton(),
    google.obtenirJeton(), google.obtenirJeton(), google.obtenirJeton(),
    google.obtenirJeton()
  ]);
  const appelsToken = appelsFetch.filter(a => a.url.indexOf('oauth2.googleapis.com') !== -1);
  assert.strictEqual(appelsToken.length, 1, 'un seul échange de token attendu');
  assert.ok(dix.every(j => j === 'jeton-test-b2'));
});

test('obtenirJeton : clé privée collée avec les guillemets et les \\n du JSON — tolérée', async () => {
  razCompteurs();
  const sauve = process.env.GOOGLE_PRIVATE_KEY;
  // Forme exacte d'un copier-coller depuis le fichier JSON : guillemets +
  // séquences \n littérales
  process.env.GOOGLE_PRIVATE_KEY = '"' + sauve.replace(/\n/g, '\\n') + '"';
  const jeton = await google.obtenirJeton();
  assert.strictEqual(jeton, 'jeton-test-b2');
  const parties = dernierAssertion.split('.');
  const ok = crypto.verify('RSA-SHA256',
    Buffer.from(parties[0] + '.' + parties[1]),
    paire.publicKey,
    Buffer.from(parties[2], 'base64url'));
  assert.ok(ok, 'signature JWT invalide avec la clé entre guillemets');
  process.env.GOOGLE_PRIVATE_KEY = sauve;
});

test('lirePlage : erreur Google ≥ 400 → exception avec code et extrait', async () => {
  razCompteurs();
  reponsesErreurs.push({ match: "sheets.googleapis.com", status: 403, corps: { error: { message: "PERMISSION_DENIED" } } });
  await assert.rejects(
    () => google.lirePlage('1abc', "'onglet'!A:A"),
    /Google Sheets 403.*PERMISSION_DENIED/
  );
});

// ============================================================================
// 3) lireClients — lecture par en-têtes + regroupement par téléphone
// ============================================================================

test('lireClients : en-têtes détectés ligne 4, colonnes utiles détectées', async () => {
  razCompteurs();
  feuilleActive = LIGNES;
  const lecture = await clients.lireClients('1abc', ONGLET);
  assert.strictEqual(lecture.ligne_entetes, 4);
  assert.ok(lecture.colonnes.immat);
  assert.ok(lecture.colonnes.telephone);
  assert.ok(lecture.colonnes.risque);
  assert.ok(lecture.colonnes.siren);
  assert.ok(lecture.colonnes.contrat_debut);
});

test('lireClients : regroupement par téléphone, plaques uniques, risques', async () => {
  razCompteurs();
  feuilleActive = LIGNES;
  const lecture = await clients.lireClients('1abc', ONGLET);
  assert.strictEqual(lecture.lignes_lues, 5);        // 5 lignes de données
  assert.strictEqual(lecture.lignes_ignorees_sans_telephone, 1);   // BISTRO LYON
  assert.strictEqual(lecture.clients.length, 2);    // 2 téléphones distincts

  const pizza = lecture.clients[0];
  assert.strictEqual(pizza.telephone, '33612345678');
  assert.strictEqual(pizza.enseigne, 'PIZZA AL FORNO');
  assert.strictEqual(pizza.statut_risque, 'RISQUE FORT');
  assert.strictEqual(pizza.plaque, 'AA123BB / CC456DD');       // 2 scooters
  assert.strictEqual(pizza.brut.lignes.length, 2);
  assert.strictEqual(pizza.siren, '123456789');               // fiche société plateforme C1
  assert.strictEqual(pizza.brut.lignes[0].siren, '123456789');
  assert.ok(pizza.brut.lignes[0].contrat.indexOf('n° C-456') !== -1);
  assert.ok(pizza.brut.lignes[0].contrat.indexOf('du 01/01/2025') !== -1);
  assert.ok(pizza.brut.lignes[0].contrat.indexOf('état : Actif') !== -1);
  assert.strictEqual(pizza.brut.lignes[0].adresse_complete, '12 rue de la Paix 75002 Paris');

  const sushi = lecture.clients[1];
  assert.strictEqual(sushi.telephone, '33698765432');
  assert.strictEqual(sushi.plaque, 'EE789FF');   // DOUBLON d'immat → plaque unique
  assert.strictEqual(sushi.brut.lignes.length, 2);
});

test('lireClients : lecture colonne par colonne (une requête par colonne utile)', async () => {
  razCompteurs();
  feuilleActive = LIGNES;
  await clients.lireClients('1abc', ONGLET);
  const plages = appelsFetch
    .filter(a => a.url.indexOf('sheets.googleapis.com') !== -1)
    .map(a => decodeURIComponent(/\/values\/([^?]+)/.exec(a.url)[1]));
  assert.ok(plages.indexOf("'" + ONGLET + "'!1:10") !== -1, 'lecture des 10 premières lignes');
  assert.ok(plages.indexOf("'" + ONGLET + "'!A:A") !== -1, 'colonne A entière');
  assert.ok(plages.indexOf("'" + ONGLET + "'!G:G") !== -1, 'colonne G (Immatriculation)');
  assert.ok(plages.indexOf("'" + ONGLET + "'!K:K") !== -1, 'colonne K (Mobile)');
  assert.ok(plages.every(p => /^'.+'!(1:10|[A-Z]+:[A-Z]+)$/.test(p)), 'plages 1:10 ou colonne entière uniquement');
});

test('lireClients : colonne immat absente → erreur explicite (garde prod v136)', async () => {
  razCompteurs();
  const sansImmat = LIGNES.slice();
  sansImmat[3] = ENTETES.slice();
  sansImmat[3][6] = 'Numéro plaque';   // plus aucun « immat »
  feuilleActive = sansImmat;
  await assert.rejects(
    () => clients.lireClients('1abc', ONGLET),
    /Colonne Immatriculation introuvable/
  );
  feuilleActive = LIGNES;
});

// ============================================================================
// 4) ecrireClients — upsert Supabase par lots
// ============================================================================

test('ecrireClients : URL on_conflict, headers schéma/merge, lots de 500', async () => {
  razCompteurs();
  feuilleActive = LIGNES_GROSSES;
  const lecture = await clients.lireClients('1abc', ONGLET);
  assert.strictEqual(lecture.clients.length, 1200);
  const ecrits = await clients.ecrireClients(lecture.clients);
  assert.strictEqual(ecrits, 1200);
  const posts = appelsFetch.filter(a => a.url.indexOf('supabase') !== -1);
  assert.strictEqual(posts.length, 3, '1200 clients → 3 lots');
  assert.ok(posts[0].url.indexOf('/rest/v1/clients?on_conflict=telephone') !== -1);
  assert.strictEqual(posts[0].options.headers['Content-Profile'], 'agent_sav');
  assert.ok(posts[0].options.headers['Prefer'].indexOf('merge-duplicates') !== -1);
  const lot1 = JSON.parse(posts[0].options.body);
  assert.strictEqual(lot1.length, 500);
  const lot3 = JSON.parse(posts[2].options.body);
  assert.strictEqual(lot3.length, 200);
  assert.ok(lot1[0].telephone);
  assert.ok(lot1[0].maj_a);
});

// ============================================================================
// 5) HANDLER /api/sync-clients — auth, dry, synchro réelle
// ============================================================================

test('ecrireClients : SUPABASE_URL avec « /rest/v1 » en trop — URL corrigée (piège PGRST125)', async () => {
  razCompteurs();
  feuilleActive = LIGNES;
  const lecture = await clients.lireClients('1abc', ONGLET);
  const sauve = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = sauve + '/rest/v1/';   // le piège réel constaté en prod
  const ecrits = await clients.ecrireClients(lecture.clients);
  assert.strictEqual(ecrits, 2);
  const post = appelsFetch.filter(a => a.url.indexOf('supabase') !== -1)[0];
  assert.ok(post.url.indexOf('/rest/v1/rest/v1') === -1, 'jamais de /rest/v1 doublé');
  assert.ok(post.url.indexOf('/rest/v1/clients?on_conflict=telephone') !== -1);
  process.env.SUPABASE_URL = sauve;
});

test('handler : 405 en POST', async () => {
  const res = faireRes();
  await handler({ method: 'POST', url: '/api/sync-clients', query: {}, headers: {} }, res);
  assert.strictEqual(res.statusCode, 405);
});

test('handler : 401 sans secret / mauvais secret', async () => {
  const res1 = faireRes();
  await handler(reqGet('', {}), res1);
  assert.strictEqual(res1.statusCode, 401);
  const res2 = faireRes();
  await handler(reqGet('secret=faux', {}), res2);
  assert.strictEqual(res2.statusCode, 401);
});

test('handler : 401 aussi avec le secret en query erroné après ?', async () => {
  const res = faireRes();
  await handler(reqGet('secret=autre&dry=1', {}), res);
  assert.strictEqual(res.statusCode, 401);
});

test('handler : CRON Vercel accepté (Authorization Bearer CRON_SECRET)', async () => {
  razCompteurs();
  feuilleActive = LIGNES;
  const res = faireRes();
  await handler(reqGet('', { authorization: 'Bearer secret-cron-test' }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.ecrits, 2);
});

test('handler : 500 config manquante avec la liste des variables', async () => {
  razCompteurs();
  const sauve = process.env.GOOGLE_SHEET_ID;
  delete process.env.GOOGLE_SHEET_ID;
  const res = faireRes();
  await handler(reqGet('secret=secret-de-test-b2', {}), res);
  assert.strictEqual(res.statusCode, 500);
  assert.ok(String(res.corps.erreur).indexOf('GOOGLE_SHEET_ID') !== -1);
  process.env.GOOGLE_SHEET_ID = sauve;
});

test('handler dry=1 : analyse sans ÉCRIRE, échantillon renvoyé', async () => {
  razCompteurs();
  feuilleActive = LIGNES;
  const res = faireRes();
  await handler(reqGet('secret=secret-de-test-b2&dry=1', {}), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.version, 'B2.2');
  assert.strictEqual(res.corps.mode.indexOf('rien écrit') !== -1 || res.corps.mode.indexOf('RIEN écrit') !== -1, true);
  assert.strictEqual(res.corps.clients_detectes, 2);
  assert.strictEqual(res.corps.ecrits, 0);
  assert.strictEqual(res.corps.lignes_lues, 5);
  assert.strictEqual(res.corps.ligne_entetes, 4);
  assert.strictEqual(res.corps.echantillon.length, 2);
  assert.strictEqual(res.corps.echantillon[0].telephone, '33612345678');
  const posts = appelsFetch.filter(a => a.url.indexOf('supabase') !== -1);
  assert.strictEqual(posts.length, 0, 'dry ne doit JAMAIS écrire dans Supabase');
});

test('handler synchro réelle : upsert des clients détectés', async () => {
  razCompteurs();
  feuilleActive = LIGNES;
  const res = faireRes();
  await handler(reqGet('secret=secret-de-test-b2', {}), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.ecrits, 2);
  assert.strictEqual(res.corps.clients_detectes, 2);
  assert.strictEqual(typeof res.corps.duree_ms, 'number');
  const posts = appelsFetch.filter(a => a.url.indexOf('supabase') !== -1);
  assert.strictEqual(posts.length, 1);
  const rows = JSON.parse(posts[0].options.body);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].telephone, '33612345678');
  assert.strictEqual(rows[0].plaque, 'AA123BB / CC456DD');
  assert.strictEqual(rows[0].enseigne, 'PIZZA AL FORNO');
  assert.strictEqual(rows[0].statut_risque, 'RISQUE FORT');
  assert.ok(rows[0].brut.lignes.length === 2);
  assert.strictEqual(rows[0].brut.lignes[0].siren, '123456789');
});

test('handler : header x-webhook-secret accepté (comme webhook/contexte)', async () => {
  razCompteurs();
  feuilleActive = LIGNES;
  const res = faireRes();
  await handler(reqGet('', { 'x-webhook-secret': 'secret-de-test-b2' }), res);
  assert.strictEqual(res.statusCode, 200);
});

test('handler : erreur Google remonte en 500 avec message', async () => {
  razCompteurs();
  reponsesErreurs.push({ match: "sheets.googleapis.com", status: 403, corps: { error: { message: "PERMISSION_DENIED" } } });
  const res = faireRes();
  await handler(reqGet('secret=secret-de-test-b2', {}), res);
  assert.strictEqual(res.statusCode, 500);
  assert.ok(String(res.corps.erreur).indexOf('403') !== -1);
});


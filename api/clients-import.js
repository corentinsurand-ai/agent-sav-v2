// ============================================================================
// Agent SAV U'mob v2 — C1-IMP : /api/clients-import — import manuel de clients
//
// RÔLE : importer des clients directement dans agent_sav.clients (miroir
// clients) SANS passer par le Google Sheet — utilisé pour créer des comptes
// de TEST dans la plateforme (plateforme maison C1 : fiches sociétés,
// flottes, contrats). La même écriture EXACTE que la synchro Sheet (B2.2) :
// clients.ecrireClients (upsert par téléphone, idempotent, rejouable sans
// doublon) — donc une future synchro Sheet ne casse RIEN (elle écraserait
// juste les lignes par les mêmes clés téléphone).
//
//   GET  /api/clients-import?secret=<WEBHOOK_SECRET>            → info
//   POST /api/clients-import?secret=…  body {clients: […]}       → import
//        client = { telephone, plaques: ["TT101TE", …], enseigne,
//                   statut_risque, lignes: [ {immat, code_client, nom_client,
//                   adresse, cp, ville, produit, prenom, nom_contact,
//                   fonction, telephone, email, contrat_num,
//                   contrat_libelle, contrat_debut, contrat_fin,
//                   contrat_etat, risque, impayes, procedure_collective,
//                   transfert, contrat, adresse_complete}, … ] }
//   GET  ?secret=…&verifier=1&prefixe=TEST                       → lecture
//        des clients importés (miroir, pour vérifier l'import en prod)
//   GET  ?secret=…&liste=1&limite=1000                           → liste
//        complète du miroir (plateforme C1 : fiches sociétés, contacts,
//        plaques, contrats — brut inclus)
//
// Normalisations IDENTIQUES à la synchro : téléphone → 33612345678
// (normaliserTelephone), plaques → TT101TE (normaliserImmat), plaque
// agrégée = plaques uniques jointes par « / » (même forme que lireClients).
//
// Authentification : ?secret=<WEBHOOK_SECRET> ou header x-webhook-secret
// (mêmes règles exactes que /api/sync-clients.js). JAMAIS de secret dans le
// code. Journal : 1 ligne agent_sav.journal (etape import_clients).
//
// CORS : la plateforme C1 (prototype navigateur) appelle cette route en
// direct depuis le navigateur — sans Access-Control-Allow-Origin, la
// réponse est bloquée (« Failed to fetch »). Allow-Origin: * accepté pour
// ce prototype car l'authentification reste le secret (jamais dans le code).
//
// Réponses : 200 ; 400 corps invalide (clients vides, client sans téléphone
// ni enseigne) ; 401 secret invalide ; 405 méthode ; 500 config/Supabase.
// ============================================================================

var VERSION = 'C6-AUTH-1';
var SCHEMA = 'agent_sav';

var clients = require('../lib/clients.js');
var auth = require('../lib/auth.js');

function env(nom) { return process.env[nom] || ''; }

// Secret : ?secret= (query) ou header x-webhook-secret — même logique que
// api/sync-clients.js (repli manuel sur req.url inclus).
function secretDe(req) {
  var secret = '';
  try {
    if (req.query && req.query.secret) secret = String(req.query.secret);
  } catch (e) {}
  if (!secret) {
    var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice((req.url || '').indexOf('?') + 1) : '';
    var m = u.match(/(?:^|&)secret=([^&]*)/);
    if (m) secret = m[1];
  }
  if (!secret && req.headers && req.headers['x-webhook-secret']) {
    secret = String(req.headers['x-webhook-secret']);
  }
  return secret;
}

function paramDe(req, nom) {
  try {
    if (req.query && req.query[nom] !== undefined) return String(req.query[nom]);
  } catch (e) {}
  var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice((req.url || '').indexOf('?') + 1) : '';
  var m = u.match(new RegExp('(?:^|&)' + nom + '=([^&]*)'));
  return m ? m[1] : '';
}

// --- Supabase (REST PostgREST) — mêmes conventions que api/test.js ---------
function urlSupabase(table, params) {
  var base = env('SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  return base + '/rest/v1/' + table + (params ? '?' + params : '');
}

async function supabaseGet(table, params) {
  var res = await fetch(urlSupabase(table, params), {
    method: 'GET',
    headers: {
      'apikey': env('SUPABASE_SERVICE_KEY'),
      'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
      'Accept-Profile': SCHEMA
    }
  });
  var corps = '';
  try { corps = await res.text(); } catch (e) { corps = ''; }
  if (!res.ok) throw new Error('Supabase ' + res.status + ' — ' + corps.substring(0, 300));
  return corps ? JSON.parse(corps) : [];
}

async function journaliser(texte, detail) {
  try {
    var res = await fetch(urlSupabase('journal', ''), {
      method: 'POST',
      headers: {
        'apikey': env('SUPABASE_SERVICE_KEY'),
        'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
        'Content-Profile': SCHEMA
      },
      body: JSON.stringify({ etape: 'import_clients', texte: texte, detail: detail })
    });
    return res.ok;
  } catch (e) { return false; }
}

// --- C6-AUTH-1 : Supabase écriture (utilisateurs) ----------------------------

async function supabaseEcrire(table, methode, params, corpsObjet) {
  var res = await fetch(urlSupabase(table, params), {
    method: methode,
    headers: {
      'apikey': env('SUPABASE_SERVICE_KEY'),
      'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
      'Content-Type': 'application/json',
      'Accept-Profile': SCHEMA,
      'Content-Profile': SCHEMA,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(corpsObjet)
  });
  var texte = '';
  try { texte = await res.text(); } catch (e) { texte = ''; }
  if (!res.ok) throw new Error('Supabase ' + res.status + ' — ' + texte.substring(0, 300));
  return texte ? JSON.parse(texte) : [];
}

// Jeton de la requête : ?jeton= (query), header x-jeton, ou body.jeton.
function jetonDe(req, corps) {
  var j = paramDe(req, 'jeton');
  if (!j && req.headers && req.headers['x-jeton']) j = String(req.headers['x-jeton']);
  if (!j && corps && corps.jeton) j = String(corps.jeton);
  return j;
}

// Utilisateur courant depuis son jeton — VÉRIFIE aussi actif en base
// (un compte désactivé est déconnecté immédiatement). Retourne null si
// jeton invalide, expiré, compte absent ou désactivé.
async function utilisateurDuJeton(jeton) {
  var payload = auth.lireJeton(jeton, auth.secretSignature());
  if (!payload || !payload.id) return null;
  try {
    var lignes = await supabaseGet('utilisateurs',
      'select=id,email,nom,role,actif&id=eq.' + encodeURIComponent(payload.id));
    if (!lignes.length || lignes[0].actif !== true) return null;
    return { id: lignes[0].id, email: lignes[0].email, nom: lignes[0].nom, role: lignes[0].role };
  } catch (e) {
    return null; // base injoignable → session refusée (fail closed)
  }
}

// --- Normalisation d'un client reçu → forme EXACTE de lireClients ----------
// {telephone: '33612345678', plaque: 'TT101TE / TT102TE', enseigne,
//  statut_risque, brut: {lignes: […]}}
function normaliserClientEntre(c) {
  c = (c && typeof c === 'object') ? c : {};
  var tel = clients.normaliserTelephone(c.telephone || '');
  if (!tel || tel.length < 10) {
    return { erreur: 'telephone invalide ou absent' };
  }
  var enseigne = String(c.enseigne || '').trim();
  if (!enseigne) {
    return { erreur: 'enseigne absente' };
  }
  var plaquesUniques = [];
  var plaques = Array.isArray(c.plaques) ? c.plaques : (c.plaque ? [c.plaque] : []);
  for (var i = 0; i < plaques.length; i++) {
    var p = clients.normaliserImmat(plaques[i]);
    if (p && plaquesUniques.indexOf(p) === -1) plaquesUniques.push(p);
  }
  var lignes = Array.isArray(c.lignes) ? c.lignes : [];
  return {
    client: {
      telephone: tel,
      plaque: plaquesUniques.length ? plaquesUniques.join(' / ') : '',
      enseigne: enseigne,
      statut_risque: String(c.statut_risque || '').trim() || null,
      brut: { lignes: lignes }
    }
  };
}

module.exports = async function handler(req, res) {
  // CORS — la plateforme C1 (navigateur) lit cette route en direct.
  try { res.setHeader('Access-Control-Allow-Origin', '*'); } catch (e) {}
  if (req.method === 'OPTIONS') {
    try {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret, x-jeton');
    } catch (e) {}
    return res.status(204).end();
  }

  // ==========================================================================
  // C6-AUTH-1 — AUTHENTIFICATION ÉQUIPE (AVANT le secret : les collaborateurs
  // n'ont PAS le secret, ils ont un compte agent_sav.utilisateurs + jeton).
  // ==========================================================================
  var corpsAuth = req.body;
  if (!corpsAuth || typeof corpsAuth !== 'object') {
    try { corpsAuth = JSON.parse(String(req.body || '{}')); } catch (e) { corpsAuth = {}; }
  }
  var demandeAuth = paramDe(req, 'auth') === '1' ||
    (req.method === 'POST' && (corpsAuth.connexion || corpsAuth.utilisateur || corpsAuth.activation || typeof corpsAuth.nouveau_mdp === 'string'));
  if (demandeAuth) {

    // ---- POST {connexion:{email, mot_de_passe}} → jeton --------------------
    if (req.method === 'POST' && corpsAuth.connexion && typeof corpsAuth.connexion === 'object') {
      if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_KEY')) {
        return res.status(500).json({ ok: false, erreur: 'configuration Supabase manquante' });
      }
      var emailC = String(corpsAuth.connexion.email || '').trim().toLowerCase();
      var mdpC = String(corpsAuth.connexion.mot_de_passe || corpsAuth.connexion.mdp || '');
      if (!emailC || !mdpC) {
        return res.status(400).json({ ok: false, erreur: 'email et mot_de_passe requis' });
      }
      var lignesU = [];
      try {
        lignesU = await supabaseGet('utilisateurs',
          'select=id,email,nom,role,actif,mot_de_passe&email=eq.' + encodeURIComponent(emailC));
      } catch (e) {
        return res.status(500).json({ ok: false, erreur: 'erreur base utilisateurs : ' + String((e && e.message) || e).substring(0, 200) });
      }
      var u = lignesU.length ? lignesU[0] : null;
      if (!u || u.actif !== true || !auth.verifierMotDePasse(mdpC, u.mot_de_passe)) {
        return res.status(401).json({ ok: false, erreur: 'identifiants invalides' });
      }
      try { await supabaseEcrire('utilisateurs', 'PATCH', '?id=eq.' + encodeURIComponent(u.id), { derniere_connexion: new Date().toISOString() }); } catch (e) {}
      var utilisateur = { id: u.id, email: u.email, nom: u.nom, role: u.role };
      return res.status(200).json({
        ok: true, brique: 'C6-AUTH', version: VERSION,
        jeton: auth.creerJeton(utilisateur, auth.secretSignature()),
        utilisateur: utilisateur
      });
    }

    if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_KEY')) {
      return res.status(500).json({ ok: false, erreur: 'configuration Supabase manquante' });
    }

    // Le jeton est requis pour tout le reste des branches auth.
    var courant = await utilisateurDuJeton(jetonDe(req, corpsAuth));
    if (!courant) {
      return res.status(401).json({ ok: false, erreur: 'jeton invalide ou expire' });
    }

    // ---- GET ?auth=1&jeton=… → vérification + utilisateur courant ---------
    if (req.method === 'GET' && paramDe(req, 'utilisateurs') !== '1') {
      return res.status(200).json({
        ok: true, brique: 'C6-AUTH', version: VERSION, utilisateur: courant
      });
    }

    // ---- C6-AUTH-1 : changement de SON propre mot de passe (jeton requis) -
    if (req.method === 'POST' && typeof corpsAuth.nouveau_mdp === 'string') {
      if (corpsAuth.nouveau_mdp.length < 8) {
        return res.status(400).json({ ok: false, erreur: 'mot de passe : 8 caracteres minimum' });
      }
      try {
        await supabaseEcrire('utilisateurs', 'PATCH', '?id=eq.' + encodeURIComponent(courant.id), {
          mot_de_passe: auth.hacherMotDePasse(corpsAuth.nouveau_mdp)
        });
        return res.status(200).json({ ok: true, brique: 'C6-AUTH', version: VERSION, mot_de_passe_modifie: true });
      } catch (e) {
        return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
      }
    }

    // ---- Admin uniquement à partir d'ici ----------------------------------
    if (courant.role !== 'admin') {
      return res.status(403).json({ ok: false, erreur: 'role admin requis' });
    }

    // GET ?auth=1&utilisateurs=1 → liste des comptes (JAMAIS de hash)
    if (req.method === 'GET') {
      try {
        var listeU = await supabaseGet('utilisateurs',
          'select=id,email,nom,role,actif,cree_a,derniere_connexion&order=cree_a.asc');
        return res.status(200).json({ ok: true, brique: 'C6-AUTH', version: VERSION, utilisateurs: listeU });
      } catch (e) {
        return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
      }
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });
    }

    // POST {utilisateur:{email,nom,role,mot_de_passe}} → création d'un compte
    if (corpsAuth.utilisateur && typeof corpsAuth.utilisateur === 'object') {
      var nu = corpsAuth.utilisateur;
      var emailN = String(nu.email || '').trim().toLowerCase();
      var mdpN = String(nu.mot_de_passe || nu.mdp || '');
      var roleN = String(nu.role || 'collaborateur');
      if (!emailN || !mdpN) return res.status(400).json({ ok: false, erreur: 'email et mot_de_passe requis' });
      if (mdpN.length < 8) return res.status(400).json({ ok: false, erreur: 'mot de passe : 8 caracteres minimum' });
      if (roleN !== 'admin' && roleN !== 'collaborateur') {
        return res.status(400).json({ ok: false, erreur: 'role invalide (admin|collaborateur)' });
      }
      try {
        var crees = await supabaseEcrire('utilisateurs', 'POST', '', {
          email: emailN, nom: String(nu.nom || '').trim(), role: roleN,
          mot_de_passe: auth.hacherMotDePasse(mdpN), actif: true
        });
        var fait = Array.isArray(crees) ? crees[0] : crees;
        return res.status(201).json({
          ok: true, brique: 'C6-AUTH', version: VERSION,
          utilisateur: fait ? { id: fait.id, email: fait.email, nom: fait.nom, role: fait.role, actif: fait.actif } : null
        });
      } catch (e) {
        return res.status(409).json({ ok: false, erreur: 'creation impossible (email deja pris ?) : ' + String((e && e.message) || e).substring(0, 200) });
      }
    }

    // POST {activation:{email, actif}} → activer/désactiver un compte
    if (corpsAuth.activation && typeof corpsAuth.activation === 'object') {
      var emailA = String(corpsAuth.activation.email || '').trim().toLowerCase();
      var actifA = corpsAuth.activation.actif === true;
      if (!emailA) return res.status(400).json({ ok: false, erreur: 'email requis' });
      try {
        var majA = await supabaseEcrire('utilisateurs', 'PATCH',
          '?email=eq.' + encodeURIComponent(emailA), { actif: actifA });
        return res.status(200).json({ ok: true, brique: 'C6-AUTH', version: VERSION, modifies: majA.length });
      } catch (e) {
        return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
      }
    }


    return res.status(400).json({ ok: false, erreur: 'action auth inconnue (connexion | utilisateur | activation | nouveau_mdp)' });
  }


  if (secretDe(req) !== env('WEBHOOK_SECRET') || !env('WEBHOOK_SECRET')) {
    return res.status(401).json({ ok: false, erreur: 'secret invalide' });
  }

  if (req.method === 'GET') {
    // GET ?verifier=1&prefixe=TEST → lecture de contrôle des clients importés
    if (paramDe(req, 'verifier') === '1') {
      if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_KEY')) {
        return res.status(500).json({ ok: false, erreur: 'configuration Supabase manquante' });
      }
      try {
        var prefixe = paramDe(req, 'prefixe') || 'TEST';
        var lignes = await supabaseGet('clients',
          'select=telephone,enseigne,plaque,statut_risque&enseigne=like.' + encodeURIComponent(prefixe + '*'));
        return res.status(200).json({
          ok: true, brique: 'C1-IMP', version: VERSION,
          prefixe: prefixe, trouves: lignes.length, clients: lignes
        });
      } catch (e) {
        return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
      }
    }

    // GET ?liste=1[&limite=N] → liste des clients du miroir (plateforme C1 :
    // fiches sociétés, contacts, plaques, contrats — brut inclus)
    if (paramDe(req, 'liste') === '1') {
      if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_KEY')) {
        return res.status(500).json({ ok: false, erreur: 'configuration Supabase manquante' });
      }
      try {
        var limite = parseInt(paramDe(req, 'limite'), 10) || 1000;
        if (limite < 1) limite = 1;
        if (limite > 5000) limite = 5000;
        var lignesListe = await supabaseGet('clients',
          'select=telephone,enseigne,plaque,statut_risque,brut&order=maj_a.desc&limit=' + limite);
        return res.status(200).json({
          ok: true, brique: 'C1-IMP', version: VERSION,
          limite: limite, trouves: lignesListe.length, clients: lignesListe
        });
      } catch (e) {
        return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
      }
    }

    return res.status(200).json({
      ok: true, brique: 'C1-IMP', version: VERSION,
      role: 'import manuel de clients dans agent_sav.clients (meme ecriture que la synchro Sheet B2.2)',
      post: '{ clients: [ { telephone, plaques: [immat], enseigne, statut_risque, lignes: [lignes du Sheet] } ] }',
      verifier: 'GET ?verifier=1&prefixe=TEST',
      liste: 'GET ?liste=1&limite=1000 — liste complete du miroir (plateforme C1)'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });
  }

  if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_KEY')) {
    return res.status(500).json({ ok: false, erreur: 'configuration Supabase manquante (SUPABASE_URL, SUPABASE_SERVICE_KEY)' });
  }

  // Corps (Vercel parse déjà le JSON ; repli texte tolérant comme webhook)
  var corps = req.body;
  if (!corps && typeof req.body !== 'object') {
    try { corps = JSON.parse(String(req.body || '{}')); } catch (e) { corps = null; }
  }
  if (!corps || typeof corps !== 'object' || !Array.isArray(corps.clients) || !corps.clients.length) {
    return res.status(400).json({ ok: false, erreur: 'corps invalide : { clients: [...] } requis' });
  }
  if (corps.clients.length > 100) {
    return res.status(400).json({ ok: false, erreur: 'trop de clients (max 100 par appel)' });
  }

  var normalises = [];
  for (var i = 0; i < corps.clients.length; i++) {
    var r = normaliserClientEntre(corps.clients[i]);
    if (r.erreur) {
      return res.status(400).json({ ok: false, erreur: 'client ' + (i + 1) + ' : ' + r.erreur });
    }
    normalises.push(r.client);
  }

  try {
    var ecrits = await clients.ecrireClients(normalises);
    await journaliser('import manuel de ' + ecrits + ' client(s)', {
      version: VERSION,
      enseignes: normalises.map(function(c) { return c.enseigne; }),
      telephones: normalises.map(function(c) { return c.telephone; })
    });
    return res.status(200).json({
      ok: true, brique: 'C1-IMP', version: VERSION,
      ecrits: ecrits,
      clients: normalises.map(function(c) {
        return { telephone: c.telephone, enseigne: c.enseigne, plaque: c.plaque, statut_risque: c.statut_risque };
      })
    });
  } catch (e) {
    return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
  }
};

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

var VERSION = 'C1-IMP-2';
var SCHEMA = 'agent_sav';

var clients = require('../lib/clients.js');

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
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret');
    } catch (e) {}
    return res.status(204).end();
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

// ============================================================================
// Agent SAV U'mob v2 — B2.2 : /api/sync-clients — synchro Sheet → Supabase
//
// RÔLE : lire le Google Sheet « Infos Service Client » (onglet fusionné) et
// écrire son miroir dans agent_sav.clients (upsert par téléphone — idempotent,
// rejouable sans doublon). C'est la DONNÉE CLIENT que le cerveau (B3+) lira à
// chaque message pour contextualiser (enseigne, plaque, risque, contrat…),
// exactement comme l'ancien système lisait le fichier en direct — sauf qu'ici
// la lecture Sheet est SYNCHRONISÉE, pas refaite à chaque message.
//
//   GET /api/sync-clients?secret=<WEBHOOK_SECRET>
//       &dry=1     → ANALYSE SANS ÉCRIRE (validation : stats + échantillon
//                    des 3 premiers clients détectés, aucun écrit Supabase)
//
// Authentification (deux canaux) :
//   - manuelle/testing  : ?secret=<WEBHOOK_SECRET> ou header x-webhook-secret
//     (mêmes règles exactes que /api/webhook et /api/contexte)
//   - CRON Vercel       : header Authorization: Bearer <CRON_SECRET> — Vercel
//     l'ajoute automatiquement aux déclenchements cron quand CRON_SECRET
//     existe (vercel.json : synchro quotidienne 05:00 UTC = 07:00 Paris).
//     → le secret ne figure JAMAIS dans vercel.json (fichier public GitHub).
//
// Réponses : 200 synchro faite ; 401 secret invalide ; 405 non-GET ;
// 500 configuration manquante (GOOGLE_*) ou erreur Google/Supabase (message
// explicite).
// ============================================================================

var VERSION = 'B2.2';

var clients = require('../lib/clients.js');

function env(nom) { return process.env[nom] || ''; }

// Secret : ?secret= (query) ou header x-webhook-secret — même logique que
// api/webhook.js et api/contexte.js (repli manuel sur req.url inclus)
function secretDe(req) {
  var secret = '';
  try {
    if (req.query && req.query.secret) secret = String(req.query.secret);
  } catch (e) {}
  if (!secret) {
    var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice(req.url.indexOf('?') + 1) : '';
    var m = u.match(/(?:^|&)secret=([^&]*)/);
    if (m) secret = m[1];
  }
  if (!secret && req.headers && req.headers['x-webhook-secret']) {
    secret = String(req.headers['x-webhook-secret']);
  }
  return secret;
}

// Auth cron Vercel : Authorization: Bearer <CRON_SECRET>
function secretCronOk(req) {
  if (!env('CRON_SECRET') || !req.headers || !req.headers.authorization) return false;
  return String(req.headers.authorization) === 'Bearer ' + env('CRON_SECRET');
}

// Paramètre query avec repli manuel (même logique que /api/contexte)
function paramDe(req, nom) {
  try {
    if (req.query && req.query[nom] !== undefined) return String(req.query[nom]);
  } catch (e) {}
  var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice(req.url.indexOf('?') + 1) : '';
  var m = u.match(new RegExp('(?:^|&)' + nom + '=([^&]*)'));
  return m ? m[1] : '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });
  }

  if (!secretCronOk(req)) {
    var secret = secretDe(req);
    if (!env('WEBHOOK_SECRET') || secret !== env('WEBHOOK_SECRET')) {
      return res.status(401).json({ ok: false, erreur: 'secret invalide' });
    }
  }

  var manquantes = [];
  if (!env('GOOGLE_CLIENT_EMAIL')) manquantes.push('GOOGLE_CLIENT_EMAIL');
  if (!env('GOOGLE_PRIVATE_KEY')) manquantes.push('GOOGLE_PRIVATE_KEY');
  if (!env('GOOGLE_SHEET_ID')) manquantes.push('GOOGLE_SHEET_ID');
  if (manquantes.length) {
    return res.status(500).json({
      ok: false,
      erreur: 'configuration Google manquante : ' + manquantes.join(', ') +
        ' — variables d\'environnement Vercel à ajouter puis Redeploy'
    });
  }

  var dry = paramDe(req, 'dry') === '1';

  var debut = Date.now();
  try {
    var lecture = await clients.lireClients(
      env('GOOGLE_SHEET_ID'), env('GOOGLE_SHEET_ONGLET') || clients.ONGLET_DEFAUT);

    var ecrits = 0;
    if (!dry) {
      ecrits = await clients.ecrireClients(lecture.clients);
    }

    var corps = {
      ok: true,
      brique: 'B2',
      version: VERSION,
      onglet: env('GOOGLE_SHEET_ONGLET') || clients.ONGLET_DEFAUT,
      ligne_entetes: lecture.ligne_entetes,
      colonnes_detectees: lecture.colonnes,
      lignes_lues: lecture.lignes_lues,
      lignes_ignorees_sans_telephone: lecture.lignes_ignorees_sans_telephone,
      clients_detectes: lecture.clients.length,
      ecrits: ecrits,
      mode: dry ? 'analyse (dry — RIEN écrit)' : 'synchronisation',
      duree_ms: Date.now() - debut
    };
    if (dry) {
      corps.echantillon = lecture.clients.slice(0, 3);
    }
    return res.status(200).json(corps);
  } catch (e) {
    return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
  }
};

// ============================================================================
// Agent SAV U'mob v2 — B2.1 : /api/contexte — OUTIL DE VALIDATION, LECTURE SEULE
//
// RÔLE : assembler et montrer le contexte complet d'un contact (fiche + messages
// + commentaires) pour VALIDER la brique B2 en prod réelle. C'est aussi la
// base de ce que le cerveau (B3+) lira à chaque message — mais B2 ne répond
// JAMAIS au client, n'écrit JAMAIS chez respond.io, n'insère JAMAIS dans
// Supabase : 100 % lecture.
//
//   GET /api/contexte?secret=<WEBHOOK_SECRET>&contact=<id>&limit=<1-100>
//
//   - secret  : OBLIGATOIRE (mêmes règles que le webhook : ?secret=... ou
//               header x-webhook-secret) — les données clients ne sont
//               jamais exposées sans secret.
//   - contact : OBLIGATOIRE — l'identifiant respond.io du contact.
//   - limit   : OPTIONNEL — nombre de messages d'historique (défaut 60,
//               borné 1-100, comme l'action « conversation » du prod v132).
//
// Réponses : 200 avec le contexte (les erreurs respond.io deviennent des
// « avertissements », pas des 500 — chaque section est best-effort) ;
// 400 contact manquant ; 401 secret invalide ; 405 méthode non GET ;
// 500 si RESPONDIO_TOKEN n'est pas configuré.
// ============================================================================

var VERSION = 'B2.1';

var contexte = require('../lib/contexte.js');

function env(nom) { return process.env[nom] || ''; }

// Secret : ?secret=... (query) ou header x-webhook-secret — même logique
// exacte que api/webhook.js (B1), y compris le repli manuel sur req.url.
function secretDe(req) {
  var secret = '';
  try {
    if (req.query && req.query.secret) secret = String(req.query.secret);
  } catch (e) {}
  if (!secret) {
    var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice(req.url.indexOf('?') + 1) : '';
    var m = u.match(/(?:^|&)secret=([^&]*)/);
    if (m) secret = decodeURIComponent(m[1]);
  }
  if (!secret && req.headers && req.headers['x-webhook-secret']) secret = String(req.headers['x-webhook-secret']);
  return secret;
}

function paramDe(req, nom) {
  try {
    if (req.query && req.query[nom]) return String(req.query[nom]);
  } catch (e) {}
  var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice(req.url.indexOf('?') + 1) : '';
  var m = u.match(new RegExp('(?:^|&)' + nom + '=([^&]*)'));
  if (m) return decodeURIComponent(m[1]);
  return '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });
  }

  var secret = secretDe(req);
  if (!env('WEBHOOK_SECRET') || secret !== env('WEBHOOK_SECRET')) {
    return res.status(401).json({ ok: false, erreur: 'secret invalide' });
  }

  if (!env('RESPONDIO_TOKEN')) {
    return res.status(500).json({ ok: false, erreur: 'RESPONDIO_TOKEN manquant — ajoutez la clé API respond.io dans les variables d\'environnement Vercel puis Redeploy' });
  }

  var contact = paramDe(req, 'contact');
  if (!contact) {
    return res.status(400).json({ ok: false, erreur: 'parametre contact manquant' });
  }

  var limite = parseInt(paramDe(req, 'limit'), 10);
  if (!isFinite(limite) || limite < 1) limite = 60;   // défaut prod
  if (limite > 100) limite = 100;                    // borne « conversation » v132

  try {
    var ctx = await contexte.assemblerContexte(contact, limite);
    return res.status(200).json({
      ok: true,
      brique: 'B2',
      version: VERSION,
      contact_id: contact,
      limite: limite,
      contact: ctx.contact,
      messages: ctx.messages,
      commentaires: ctx.commentaires,
      avertissements: ctx.avertissements
    });
  } catch (e) {
    return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
  }
};

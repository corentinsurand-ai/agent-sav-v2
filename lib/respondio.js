// ============================================================================
// Agent SAV U'mob v2 — B2.1 : adaptateur respond.io (LECTURE SEULE)
//
// RÔLE (et SEUL rôle) : parler à l'API respond.io en LECTURE. C'est la seule
// couche de tout le système autorisée à appeler respond.io (principe
// architecture v1.1 : le cerveau ne connaît pas le canal). Aucune écriture,
// aucun POST : B2 ne peut rien modifier chez respond.io.
//
// Portage fidèle du prod v2.20.136 :
//   - requeteHTTP : Bearer RESPONDIO_TOKEN, erreur si code >= 400
//     (200 premiers caractères du corps), JSON parsé
//   - lireHistorique : GET /contact/id:{id}/message/list?limit={N} → items
//     (recupererHistoriqueRapide, limite par défaut 60)
//   - lireContact    : GET /contact/id:{id} → fiche (nom, lifecycle, tags)
//   - lireCommentaires : GET /contact/id:{id}/comment → items (best-effort)
//
// La clé API (RESPONDIO_TOKEN) vit UNIQUEMENT dans les variables
// d'environnement Vercel — jamais dans le code, jamais sur GitHub.
// ============================================================================

var RESPONDIO_API = 'https://api.respond.io/v2';

function env(nom) { return process.env[nom] || ''; }

// Portage de requeteHTTP (v136) : throw si >= 400, corps JSON parsé.
async function requeteHTTP(url) {
  var res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': 'Bearer ' + env('RESPONDIO_TOKEN'),
      'Content-Type': 'application/json'
    }
  });
  var texte = '';
  try { texte = await res.text(); } catch (e) { texte = ''; }
  if (res.status >= 400) {
    throw new Error('respond.io ' + res.status + ' : ' + texte.substring(0, 200));
  }
  return texte ? JSON.parse(texte) : null;
}

// Fiche contact : nom (fullName ou prénom+nom), cycle de vie (lifecycle.name),
// tags (tableau — contient notamment « Prise de main », critère unique de
// reprise humaine). Portage des lectures prod (l. 1546 + 3673).
async function lireContact(contactId) {
  return requeteHTTP(RESPONDIO_API + '/contact/id:' + contactId);
}

// Historique du contact : items du PLUS RÉCENT au plus ancien (ordre brut de
// l'API, constaté en prod v2.20.97). Le tri chronologique est fait par
// lib/contexte.js, pas ici.
async function lireHistorique(contactId, limite) {
  var reponse = await requeteHTTP(
    RESPONDIO_API + '/contact/id:' + contactId + '/message/list?limit=' + (limite || 60));
  return (reponse && reponse.items) ? reponse.items : [];
}

// Commentaires internes du contact (consignes des collègues). L'ordre et la
// structure des items sont normalisés toléramment dans lib/contexte.js.
async function lireCommentaires(contactId) {
  var reponse = await requeteHTTP(RESPONDIO_API + '/contact/id:' + contactId + '/comment');
  return (reponse && reponse.items) ? reponse.items : [];
}

module.exports = {
  lireContact: lireContact,
  lireHistorique: lireHistorique,
  lireCommentaires: lireCommentaires
};

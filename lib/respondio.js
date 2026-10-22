// ============================================================================
// Agent SAV U'mob v2 — B2.1/B6.1 : adaptateur respond.io (lecture + ÉCRITURE)
//
// RÔLE (et SEUL rôle) : parler à l'API respond.io. C'est la seule couche de
// tout le système autorisée à appeler respond.io (principe architecture
// v1.1 : le cerveau ne connaît pas le canal).
//
//   LECTURE  (B2.1) : GET historique / fiche contact / commentaires.
//   ÉCRITURE (B6.1) : les 5 opérations du mode actif B4.2, portage EXACT des
//   formes du prod v2.20.136 — envoyer un message (l.7612 : POST /message
//   {channelId, message:{type:'text',text}}), poser un cycle (l.6283 : POST
//   /lifecycle/update {name}), ajouter un tag (l.2866 : POST /tag [nom]),
//   retirer un tag (l.2972 : DELETE /tag [nom], singulier), écrire un
//   commentaire interne (l.2864 : POST /comment {text}).
//
// IMPORTANT : ces fonctions d'écriture ne sont appelées par PERSONNE en mode
// observation. Le seul site d'appel est api/process.js, derrière le double
// verrou MODE_AGENT=actif + B42_EXECUTION=1 (feu vert de Corentin). Elles
// vivent ici pour que la bascule B4.2 soit un CHANGEMENT DE CONFIGURATION,
// pas une livraison de code.
//
// La clé API (RESPONDIO_TOKEN) vit UNIQUEMENT dans les variables
// d'environnement Vercel — jamais dans le code, jamais sur GitHub.
// ============================================================================

var RESPONDIO_API = 'https://api.respond.io/v2';

function env(nom) { return process.env[nom] || ''; }

// Portage de requeteHTTP (v136) : throw si >= 400, corps JSON parsé.
// B6.1 : methode + corps optionnels (GET sans corps par défaut — les
// lectures existantes ne changent pas d'un octet).
async function requeteHTTP(url, methode, corps) {
  var options = {
    method: methode || 'GET',
    headers: {
      'Authorization': 'Bearer ' + env('RESPONDIO_TOKEN'),
      'Content-Type': 'application/json'
    }
  };
  if (corps !== undefined && corps !== null) {
    options.body = JSON.stringify(corps);
  }
  var res = await fetch(url, options);
  var texte = '';
  try { texte = await res.text(); } catch (e) { texte = ''; }
  if (res.status >= 400) {
    throw new Error('respond.io ' + res.status + ' : ' + texte.substring(0, 200));
  }
  return texte ? JSON.parse(texte) : null;
}

// ---------------------------------------------------------------- LECTURES --

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

// --------------------------------------------------------------- ÉCRITURES --

// Envoyer un message texte au contact. Portage v136 l.7612 : channelId
// numérique (ou null → respond.io choisit le canal par défaut) ;
// RESPONDIO_CHANNEL_ID est le repli du prod, conservé tel quel.
async function envoyerMessage(contactId, texte, channelId) {
  var corps = {
    channelId: Number(channelId || env('RESPONDIO_CHANNEL_ID')) || null,
    message: { type: 'text', text: String(texte || '') }
  };
  return requeteHTTP(RESPONDIO_API + '/contact/id:' + contactId + '/message', 'POST', corps);
}

// Poser le cycle de vie (CASSE EXACTE — le nom vient de lib/cycles.js
// CYCLES, jamais construit par le LLM). Portage v136 l.6283.
async function poserCycle(contactId, nomCycle) {
  return requeteHTTP(
    RESPONDIO_API + '/contact/id:' + contactId + '/lifecycle/update', 'POST', { name: String(nomCycle || '') });
}

// Ajouter un tag (« Prise de main », « Demande Commerciale »). Le corps est
// un TABLEAU (portage v136 l.2866 : POST /tag [nom]).
async function ajouterTag(contactId, nomTag) {
  return requeteHTTP(RESPONDIO_API + '/contact/id:' + contactId + '/tag', 'POST', [String(nomTag || '')]);
}

// Retirer un tag — format SINGULIER documenté (portage v136 l.2972 : le
// DELETE /tags pluriel et le POST /tags/delete ont été abandonnés en prod
// au profit de DELETE /tag).
async function retirerTag(contactId, nomTag) {
  return requeteHTTP(RESPONDIO_API + '/contact/id:' + contactId + '/tag', 'DELETE', [String(nomTag || '')]);
}

// Commentaire interne (consignes, TRANSFERT SAV — jamais visible du client).
async function ecrireCommentaire(contactId, texte) {
  return requeteHTTP(RESPONDIO_API + '/contact/id:' + contactId + '/comment', 'POST', { text: String(texte || '') });
}

// B6.4 — Fermer la conversation d'un contact (fin de dossier : purge après
// TOUTES les interventions Praxedo réalisées). Portage v2.20.66 l.4587 :
// POST /contact/id:{id}/conversation/close (sans corps).
async function fermerConversation(contactId) {
  return requeteHTTP(RESPONDIO_API + '/contact/id:' + contactId + '/conversation/close', 'POST');
}

// B6.4 — Renommer la fiche contact (« Nom (Société - Ville) », lib/renommage.js
// — DÉSACTIVÉ par défaut, env RENOMMAGE_ACTIF=1). Portage v2.19.8 : PATCH
// /contact/id:{id} {fullName}. NB : la forme exacte du corps sera revérifiée
// à la première activation réelle (le corps v2.19.8 est commenté dans
// l'ancien code) — la décision reste OFF tant qu'elle n'est pas validée.
async function renommerContact(contactId, nom) {
  return requeteHTTP(RESPONDIO_API + '/contact/id:' + contactId, 'PATCH', { fullName: String(nom || '') });
}

module.exports = {
  lireContact: lireContact,
  lireHistorique: lireHistorique,
  lireCommentaires: lireCommentaires,
  envoyerMessage: envoyerMessage,
  poserCycle: poserCycle,
  ajouterTag: ajouterTag,
  retirerTag: retirerTag,
  ecrireCommentaire: ecrireCommentaire,
  fermerConversation: fermerConversation,
  renommerContact: renommerContact
};

// ============================================================================
// Agent SAV U'mob v2 — B6.7 : LEÇONS DE TERRAIN (cahier des charges §6)
//
// LA BOUCLE D'APPRENTISSAGE, en module PUR (zéro réseau, testable à 100 %) :
//   notations de Corentin (B6.6) → leçons agent_sav.lecons (B1, + déclencheurs
//   B6.7) → INJECTION CIBLÉE dans le prompt du cerveau (le crochet existait
//   depuis B6.3 : construireMessages({lecons})) → promotion en règle dure
//   après ≥ 2 occurrences (décision Corentin, jamais automatique).
//
// PRINCIPES (règle projet « ne pas surcharger l'agent ») :
//   - INJECTION CIBLÉE : une leçon AVEC déclencheurs n'entre dans le prompt
//     QUE si un de ses mots-clés apparaît dans la conversation (« crevaison »
//     dans le message → la leçon crevaison entre) ; une leçon SANS déclencheurs
//     s'applique à chaque tour (comportement B6.3 inchangé).
//   - JAMAIS EMPILOS : 3 leçons MAX par tour, triées par occurrences décroissantes.
//   - Déterministe : normalisation accents/casse/espaces, sous-chaîne simple.
// ============================================================================

var MAX_LECONS_PAR_TOUR = 3;

function normaliserTexte(t) {
  return String(t || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents
    .replace(/[^a-z0-9]+/g, " ")    // ponctuation → espaces
    .replace(/\s+/g, " ")
    .trim();
}

// Les déclencheurs d'une leçon : « crevaison, pneu, crevé » → 3 mots-clés
// normalisés (≥ 3 caractères pour éviter les fragments accidentels).
function declencheursDe(lecon) {
  var brut = String((lecon && lecon.declencheurs) || "").split(/[,;/]+/);
  var mots = [];
  for (var i = 0; i < brut.length; i++) {
    var m = normaliserTexte(brut[i]);
    if (m.length >= 3 && mots.indexOf(m) === -1) mots.push(m);
  }
  return mots;
}

function statutInjectable(lecon) {
  var s = String((lecon && lecon.statut) || "");
  return s === "active" || s === "validee";
}

function porteeApplicable(lecon, contactId) {
  if (!lecon || String(lecon.portee) !== "client") return true; // générale : toujours
  return !!contactId && String(lecon.contact_id || "") === String(contactId);
}

function leconApplicable(lecon, texteNormalise, contactId) {
  if (!statutInjectable(lecon)) return false;
  if (!porteeApplicable(lecon, contactId)) return false;
  var declencheurs = declencheursDe(lecon);
  if (!declencheurs.length) return true; // sans déclencheurs : chaque tour
  for (var i = 0; i < declencheurs.length; i++) {
    if (texteNormalise.indexOf(declencheurs[i]) !== -1) return true;
  }
  return false;
}

// LES leçons applicables à CE tour : texte = conversation complète (messages
// client + réponses), contactId identifie le dossier (téléphone en console,
// contact respond.io en prod). Retour : les RÈGLES (textes), max 3, par
// occurrences décroissantes (les plus éprouvées d'abord).
function leconsApplicables(lecons, texte, contactId) {
  var n = normaliserTexte(texte);
  var gardees = [];
  var source = Array.isArray(lecons) ? lecons : [];
  for (var i = 0; i < source.length; i++) {
    var l = source[i];
    if (!l || !leconApplicable(l, n, contactId)) continue;
    gardees.push(l);
  }
  gardees.sort(function (a, b) {
    var oa = Number(a.occurrences) || 0;
    var ob = Number(b.occurrences) || 0;
    if (ob !== oa) return ob - oa;
    return String(a.regle || "").localeCompare(String(b.regle || ""));
  });
  var regles = [];
  for (var j = 0; j < gardees.length && regles.length < MAX_LECONS_PAR_TOUR; j++) {
    var r = String((gardees[j] && gardees[j].regle) || "").trim();
    if (r && regles.indexOf(r) === -1) regles.push(r);
  }
  return regles;
}

// Une notation RENFORCE-t-elle une leçon ? OUI si la leçon a des déclencheurs
// et que le COMMENTAIRE de la note en cite un (« tu dois demander… crevaison… »
// renforce la leçon crevaison). Une leçon sans déclencheurs n'est JAMAIS
// renforcée par un commentaire (rien de déterministe à matcher).
function commentaireCiteLecon(lecon, commentaire) {
  var declencheurs = declencheursDe(lecon);
  if (!declencheurs.length) return false;
  var n = normaliserTexte(commentaire);
  if (!n) return false;
  for (var i = 0; i < declencheurs.length; i++) {
    if (n.indexOf(declencheurs[i]) !== -1) return true;
  }
  return false;
}

// Texte de conversation assemblé depuis des messages {texte} (prod) ou la
// mémoire du bac à sable — le matching se fait sur TOUTE la conversation,
// pas seulement le dernier message (une leçon déclenchée au tour 1 reste
// applicable tant que le sujet est vivant).
function texteDeConversation(messages) {
  var bouts = [];
  var source = Array.isArray(messages) ? messages : [];
  for (var i = 0; i < source.length; i++) {
    if (source[i] && source[i].texte) bouts.push(String(source[i].texte));
  }
  return bouts.join(" ");
}

module.exports = {
  normaliserTexte: normaliserTexte,
  declencheursDe: declencheursDe,
  leconApplicable: leconApplicable,
  leconsApplicables: leconsApplicables,
  commentaireCiteLecon: commentaireCiteLecon,
  texteDeConversation: texteDeConversation,
  MAX_LECONS_PAR_TOUR: MAX_LECONS_PAR_TOUR
};

// ============================================================================
// Agent SAV U'mob v2 — B3.3 : les gardes (code DÉTERMINISTE avant envoi)
//
// RÔLE (cahier des charges v1 §6.2, architecture v1.1 §3.4) : la réponse
// candidate du cerveau est vérifiée par du CODE, contre le FORMULAIRE (B3.1)
// — zéro appel modèle, zéro loterie, millisecondes. Faute → UNE régénération
// avec le rappel précis de la règle ; récidive → repli neutre. Le client ne
// voit JAMAIS une réponse fautive.
//
// Chaque garde est une règle dure du cahier des charges, déterministe par
// construction. Une garde nouvelle ne s'ajoute que si une leçon l'exige
// (§6.5) — JAMAIS par empilement préventif.
//
// Node PUR : aucun réseau, aucune connaissance de respond.io/Mistral.
// Entrée : { reponse, escalade, etat } (le formulaire B3.1).
// Sortie : { ok, fautes: [{ code, rappel }] } — chaque rappel est le texte
// EXACT réinjecté au cerveau pour l'unique régénération.
// ============================================================================

var etatLib = require('./etat.js');

// Apostrophes typographiques → ASCII (le modèle écrit « U'mob » ou « U'mob »)
function ascii(s) { return String(s || '').replace(/[\u2018\u2019]/g, "'"); }

// ----------------------------------------------------------------------------
// G1 — RÈGLE 8 : signature « -Agent IA U'mob- » sur chaque message
// ----------------------------------------------------------------------------
function gSignature(t) {
  if (!/Agent IA U'?mob/.test(t)) {
    return { code: 'signature', rappel: "RÈGLE 8 : termine chaque message par la signature « -Agent IA U'mob- »." };
  }
  return null;
}

// ----------------------------------------------------------------------------
// G2 — RÈGLE 2 : toute demande d'info = question OUVERTE.
// Formes fermées : « Pouvez-vous… », « Avez-vous… », « est-ce que vous… »…
// Exception explicite du cahier des charges : « Est-ce que tout est correct ? »
// (étape 4, récapitulatif).
// ----------------------------------------------------------------------------
function gFermee(t) {
  var fermee = /(?:pouvez|peux|pourriez|pourrait|voudriez|voulez|auriez|avez|êtes|savez|acceptez|connaissez|pourras)[ -](?:vous|tu)\b|est-ce que (?:vous|tu)\b/i;
  if (fermee.test(t) && !/est-ce que tout est correct/i.test(t)) {
    return { code: 'question_fermee', rappel: "RÈGLE 2 : toute demande d'information est une question OUVERTE (« Quelle est… »), jamais « Pouvez-vous… ? ». Reformule la question." };
  }
  return null;
}

// ----------------------------------------------------------------------------
// G3 — RÈGLE 9 : pas d'invention — prix, délai chiffré, « gratuit » sans source
// ----------------------------------------------------------------------------
function gInvention(t) {
  if (/\d+\s*(?:€|euros?)/i.test(t) || /\bgratuit(?:ement)?\b/i.test(t) ||
      /\b(?:sous|dans les|d'ici|en)\s*\d+\s*(?:jours|heures|minutes|semaines)/i.test(t)) {
    return { code: 'invention', rappel: "RÈGLE 9 : PAS d'invention — aucun prix, délai chiffré ou « gratuit » qui n'est pas confirmé dans le dossier. Retire-le." };
  }
  return null;
}

// ----------------------------------------------------------------------------
// G4 — RÈGLE 1/4 : plaque redemandée alors qu'elle est CONNUE
// (la faute n°1 de l'ancien agent — impossible par construction, et gardée)
// ----------------------------------------------------------------------------
function gPlaqueRedemandee(t, etat) {
  if (!etat.plaques.length) return null;
  var demande = /(?:quelle(?:s)?|quels?|donn\w*|pr[ée]cis\w*|indiqu\w*|communiqu\w*|envoy\w*)[^.!?]*?(?:immatriculation|plaque)/i;
  if (demande.test(t)) {
    return { code: 'plaque_redemandee', rappel: "RÈGLE 1/4 : l'immatriculation est DÉJÀ CONNUE (" + etat.plaques.map(etatLib.formaterPlaque).join(', ') + ") — ne la redemande jamais." };
  }
  return null;
}

// ----------------------------------------------------------------------------
// G5 — RÈGLE 1/6 : téléphone à contacter redemandé alors qu'il est FOURNI
// ----------------------------------------------------------------------------
function gTelephoneRedemande(t, etat) {
  if (!etat.telephone_contact) return null;
  var demande = /(?:quelle(?:s)?|quels?|donn\w*|pr[ée]cis\w*|indiqu\w*|communiqu\w*)[^.!?]*?(?:num[ée]ro|t[ée]l[ée]phone)/i;
  if (demande.test(t)) {
    return { code: 'telephone_redemande', rappel: "RÈGLE 1 : le téléphone à contacter est DÉJÀ FOURNI (" + etat.telephone_contact + ") — ne le redemande jamais." };
  }
  return null;
}

// ----------------------------------------------------------------------------
// G6 — RÈGLE 7 : récapitulatif multi-scooters INCOMPLET
// Un récapitulatif (mot récap présente) avec plusieurs immatriculations
// connues doit citer CHAQUE scooter, quel que soit le format d'écriture.
// ----------------------------------------------------------------------------
function gRecapIncomplet(t, etat) {
  if (etat.plaques.length < 2) return null;
  if (!/r[ée]capitulatif|\br[ée]cap\b/i.test(t)) return null;
  var plat = t.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  var manquantes = [];
  for (var i = 0; i < etat.plaques.length; i++) {
    if (plat.indexOf(etat.plaques[i]) === -1) manquantes.push(etatLib.formaterPlaque(etat.plaques[i]));
  }
  if (manquantes.length) {
    return { code: 'recap_incomplet', rappel: "RÈGLE 7 : un récapitulatif couvre TOUTES les demandes — le/les scooter(s) manquant : " + manquantes.join(', ') + "." };
  }
  return null;
}

// ----------------------------------------------------------------------------
// G7 — RÈGLE 3 : relance pendant que le client est parti chercher une info
// ----------------------------------------------------------------------------
function gRelance(t, etat) {
  if (!etat.client_cherche_info) return null;
  if (t.indexOf('?') !== -1) {
    return { code: 'relance_client_cherche', rappel: "RÈGLE 3 : le client est parti chercher une info — accueille et ATTENDS, ne relance jamais (aucune question dans ta réponse)." };
  }
  return null;
}

// ----------------------------------------------------------------------------
// G8 — TON (§1) : vocabulaire voiture interdit — on parle scooter électrique
// ----------------------------------------------------------------------------
function gVocabulaireVoiture(t) {
  if (/\b(p[eé]dale|p[eé]dales|carburant|essence)\b/i.test(t)) {
    return { code: 'vocabulaire_voiture', rappel: "TON : vocabulaire scooter électrique uniquement (batterie, chargeur, neiman, levier de frein) — jamais « pédale », « carburant », « essence »." };
  }
  return null;
}

// ----------------------------------------------------------------------------
// G9 — réponse vide sans escalade : le client a écrit, il faut une réponse
// ou une escalade explicite (le silence n'existe QUE déterministe, B3.2)
// ----------------------------------------------------------------------------
function gReponseVide(reponse, escalade) {
  if (!reponse && !escalade) {
    return { code: 'reponse_vide', rappel: "Le client a écrit : il faut une réponse pour lui, ou une escalade explicite (\"escalade\": true avec la raison)." };
  }
  return null;
}

// ----------------------------------------------------------------------------
// Vérification COMPLÈTE d'une réponse candidate.
// Renvoie { ok, fautes: [{code, rappel}] } — ok uniquement si AUCUNE faute.
// ----------------------------------------------------------------------------
function verifier(entree) {
  var e = entree || {};
  var reponse = ascii(String(e.reponse || ''));
  var escalade = e.escalade === true;
  var etat = e.etat || etatLib.etatVierge();
  var fautes = [];

  var g9 = gReponseVide(reponse, escalade);
  if (g9) { fautes.push(g9); return { ok: false, fautes: fautes }; }
  if (!reponse) return { ok: true, fautes: [] }; // silence + escalade : rien à vérifier

  var gardes = [gSignature, gFermee, gInvention, gPlaqueRedemandee, gTelephoneRedemande, gRecapIncomplet, gRelance, gVocabulaireVoiture];
  for (var i = 0; i < gardes.length; i++) {
    var f = gardes[i](reponse, etat);
    if (f) fautes.push(f);
  }
  return { ok: fautes.length === 0, fautes: fautes };
}

// ----------------------------------------------------------------------------
// REPLI NEUTRE — la réponse de dernier recours après récidive d'une garde.
// Aucune info, aucune promesse, aucune question. Le processeur (B4) pose le
// tag « Prise de main » avec : un humain reprend le dossier.
// ----------------------------------------------------------------------------
function messageRepliNeutre() {
  return "Merci pour votre message. Un membre de l'équipe U'mob reprend ce dossier dans les plus brefs délais.\n-Agent IA U'mob-";
}

module.exports = {
  verifier: verifier,
  messageRepliNeutre: messageRepliNeutre
};

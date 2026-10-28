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
// B5.4.3 EXCEPTION : une plaque citée HORS PARC (vérifiée déterministe par le
// processeur, injectée en `plaques_hors_parc`) n'est PAS « connue » au sens
// du parc — l'agent DOIT demander sa saisie exacte.
// ----------------------------------------------------------------------------
function gPlaqueRedemandee(t, etat, horsParc, citeHorsParc) {
  if (!etat.plaques.length) return null;
  // B5.4.3 : une plaque hors parc NON RÉSOLUE est en attente de saisie
  // exacte — dans CE contexte, une demande d'immatriculation est toujours
  // légitime (elle porte sur la plaque introuvable, pas sur une connue).
  if (horsParc.length) return null;
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
// G10 — B5.4.3 : plaque HORS PARC citée dans un message MIXTE mais ignorée
// par la réponse. Le processeur a vérifié la plaque (déterministe) et l'a
// injectée : la réponse DOIT le dire au client (citer la plaque, ou « notre
// parc » / « saisie exacte » / « immatriculation »). Si escalade, le motif
// de transfert l'explique au collègue — pas de faute.
// ----------------------------------------------------------------------------
function gPlaqueHorsParcIgnoree(t, horsParc, citeHorsParc) {
  if (!horsParc.length) return null;
  if (citeHorsParc) return null;
  if (/(saisie exacte|notre parc|immatriculation)/i.test(t)) return null;
  return { code: 'plaque_hors_parc_ignoree', rappel: "PLAQUE HORS PARC : la plaque " + horsParc.map(etatLib.formaterPlaque).join(', ') + " citée par le client n'est PAS dans notre parc — dis-le clairement au client et demande la saisie exacte (question OUVERTE), tout en répondant au reste de son message." };
}

// ----------------------------------------------------------------------------
// G11 — B5.4.3 : après le « oui » du client au récapitulatif, une réponse
// qui ANNONCE le transfert à l'équipe DOIT porter "escalade": true (c'est
// ÇA qui déclenche le transfert, le tag et le cycle « A créer dans
// Praxedo »). Une annonce sans escalade est une clôture muette : le dossier
// ne part jamais (incident console Corentin 23/10 — « Vos demandes sont
// bien enregistrées, l'équipe technique prendra contact » + escalade:false
// → le cycle ne changeait pas).
// NB : l'étape de l'état pré-fusion vaut toujours 1 (rien ne la dérive des
// messages) — on utilise l'étape que le MODÈLE réclame (formulaire.etape,
// passée en `etape_candidate`), au sens « le dossier est à l'étape
// transfert/clôture ».
// ----------------------------------------------------------------------------
function gTransfertSansEscalade(t, escalade, etape) {
  if (escalade) return null;
  if (Number(etape || 1) < 5) return null;
  if (t.indexOf('?') !== -1) return null; // une question en attente ≠ un transfert
  if (/(?:transm(?:et|ets)|transf(?:è|e)r(?:e|é|ée)?\b|fait suivre|fait passer|passe (?:le )?dossier|prendra contact|équipe technique|équipe s[' ]occupe|part (?:à|a) l[' ]équipe)/i.test(t)) {
    return { code: 'transfert_sans_escalade', rappel: "ÉTAPE 5 = TRANSFERT : tu annonces que le dossier part à l'équipe — mets \"escalade\": true avec la raison (ex. « dossier complet — transfert SAV »), sinon le dossier ne part jamais." };
  }
  return null;
}

// ----------------------------------------------------------------------------
// G12 — B6.3 : CAMPAGNE PUSH (v2.20.116) : quand le dernier message du
// client répond à une campagne d'entretien (signal du formulaire B3.1),
// la réponse de l'agent accuse réception et interroge le BESOIN — elle ne
// fait PAS une qualification standard : demander l'immatriculation d'entrée
// est la faute type (le client répond à un push, il n'a pas de panne
// déclarée). Règle : la demande d'immatriculation sur dossier push = faute.
// ----------------------------------------------------------------------------
function gCampagnePush(t, etat) {
  if (!etat.campagne_push) return null;
  var demande = /(?:quelle(?:s)?|donn\w*|pr[ée]cis\w*|indiqu\w*|communiqu\w*|envoy\w*)[^.!?]*?(?:immatriculation|plaque)/i;
  if (demande.test(t)) {
    return { code: 'campagne_push_plaque', rappel: "CAMPAGNE PUSH : le client répond à une campagne d'entretien ou à la prise de contact d'un collègue — remercie-le de son retour — ce n'est pas une demande à accuser réception — et pose une question OUVERTE sur son besoin ; NE demande PAS son immatriculation (ce n'est pas une qualification standard)." };
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
  var horsParc = (e.plaques_hors_parc || []).map(String);
  // B5.4.3 — étape de TRANSFERT réclamée par le modèle (formulaire.etape) :
  // l'état pré-fusion ne porte jamais d'étape (rien ne la dérive des messages).
  var etapeTransfert = Math.max(Number(etat.etape || 1), Number(e.etape_candidate || 0));
  var fautes = [];

  // La réponse cite-t-elle une plaque hors parc (tous formats d'écriture) ?
  var platReponse = reponse.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  function citeHorsParc() {
    for (var i = 0; i < horsParc.length; i++) {
      if (platReponse.indexOf(horsParc[i].toUpperCase()) !== -1) return true;
    }
    return false;
  }

  var g9 = gReponseVide(reponse, escalade);
  if (g9) { fautes.push(g9); return { ok: false, fautes: fautes }; }
  if (!reponse) return { ok: true, fautes: [] }; // silence + escalade : rien à vérifier

  var gardes = [
    function (t) { return gSignature(t); },
    function (t) { return gFermee(t); },
    function (t) { return gInvention(t); },
    function (t) { return gPlaqueRedemandee(t, etat, horsParc, citeHorsParc()); },
    function (t) { return gTelephoneRedemande(t, etat); },
    function (t) { return gRecapIncomplet(t, etat); },
    function (t) { return gRelance(t, etat); },
    function (t) { return gVocabulaireVoiture(t); },
    function (t) { return gPlaqueHorsParcIgnoree(t, horsParc, citeHorsParc()); },
    function (t) { return gTransfertSansEscalade(t, escalade, etapeTransfert); },
    function (t) { return gCampagnePush(t, etat); }
  ];
  for (var i = 0; i < gardes.length; i++) {
    var f = gardes[i](reponse);
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

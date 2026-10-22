// ============================================================================
// Agent SAV U'mob v2 — B4.1 : le processeur (orchestration Node PUR)
//
// RÔLE (architecture v1.1 §3.4) : enchaîner les briques validées une à une
// pour UN message d'un contact :
//
//   1. ÉTAT      — formulaire reconstruit sur TOUT l'historique + fiche
//                  respond.io + ligne clients (B3.1 + B2.1 + B2.2)
//   2. SILENCE   — déterministe : prise de main ou pas d'entrant → le modèle
//                  n'est MÊME PAS appelé (B3.2 silenceNecessaire)
//   3. CERVEAU   — construireMessages → appelMistral (INJECTÉ) → parserReponse
//   4. GARDES    — code déterministe (B3.3) : faute → UNE régénération AVEC
//                  rappels, récidive → repli neutre + prise de main
//   5. FUSION    — mise à jour du formulaire, whitelist stricte (B3.2)
//   6. MODE      — OBSERVATION par défaut : la réponse est journalisée
//                  « non envoyée ». AUCUN envoi réel n'existe dans ce fichier —
//                  l'envoi + les cycles respond.io arrivent en B4.2.
//
// ZÉRO RÉSEAU ICI : Mistral est INJECTÉ en paramètre (le vrai adaptateur vit
// dans lib/mistral.js, branché par api/process.js). Supabase et respond.io
// vivent dans api/process.js. Ce fichier est donc testable à 100 % sans
// réseau — même esprit cerveau ≠ canal que B2 et B3.
//
// BORNE (cahier des charges §6.4) : 1 appel Mistral en temps normal,
// 2 MAX si une garde (ou un JSON illisible) déclenche une régénération.
// Jamais de 3e appel : au 2e échec → repli neutre + prise de main.
// ============================================================================

var cerveau = require("./cerveau.js");
var gardes = require("./gardes.js");
var etatLib = require("./etat.js");

var RAPPEL_FORMAT =
  "Ta réponse précédente n'était pas lisible : du JSON était attendu. " +
  "Réponds UNIQUEMENT avec un objet JSON, sans texte autour, au format " +
  '{"reponse":"le message pour le client","formulaire":{"champ":"valeur"},"escalade":false,"raison_escalade":""}';

function codesFautes(fautes) {
  return (fautes || []).map(function (f) { return f.code; });
}

// ----------------------------------------------------------------------------
// traiterMessage — UNE conversation (le plus récent entrant du contact).
//
//   entree = {
//     contactId : "547249072",
//     ctx       : contexte assemblé B2.1 {contact, messages, commentaires, avertissements},
//     client    : ligne agent_sav.clients ou null (enseigne, plaques flotte, statut risque),
//     lecons    : ["règle active à appliquer si la situation s'y prête"] (max 5),
//     mode      : "observation" (défaut) | "actif" (B4.2 — rétrogradé en observation avec avertissement),
//     mistral   : async (messages) => texte du modèle  (le SEUL point réseau, injecté)
//   }
//
//   retour = {
//     statut : "traite" | "silence" | "repli",
//     reponse, escalade, raison_escalade,
//     etat   : formulaire final (à persister dans agent_sav.dossiers),
//     journal: [{etape, texte, detail}] — à écrire dans agent_sav.journal,
//     appels : nombre d'appels Mistral réellement effectués (0, 1 ou 2),
//     mode   : mode effectif
//   }
// ----------------------------------------------------------------------------
async function traiterMessage(entree) {
  var e = entree || {};
  var ctx = e.ctx || { contact: {}, messages: [], commentaires: [], avertissements: [] };
  var mistral = e.mistral;
  var mode = e.mode === "actif" ? "actif" : "observation";
  var appels = 0;
  var journal = [];

  function log(etape, texte, detail) {
    journal.push({
      contact_id: e.contactId || null,
      etape: etape,
      texte: String(texte || "").substring(0, 500),
      detail: detail || null
    });
  }

  // Repli neutre — dernier recours déterministe (B3.3) : aucune info, aucune
  // promesse, aucune question + un humain reprend le dossier.
  function repli(raison) {
    var rep = gardes.messageRepliNeutre();
    log("process_repli", "repli neutre : " + raison);
    log("process_prise_de_main", "un humain doit reprendre le dossier (repli neutre)");
    return {
      statut: "repli",
      reponse: rep,
      escalade: true,
      raison_escalade: raison,
      etat: etat,
      journal: journal,
      appels: appels,
      mode: mode
    };
  }

  // 1) ÉTAT — reconstruit sur TOUT l'historique (cahier des charges §7 :
  // jamais un extrait) + signaux équipe de la fiche + fiche client.
  var etat = etatLib.etatDepuisContexte(ctx);
  if (e.client) etatLib.appliquerClient(etat, e.client);

  // 2) SILENCE déterministe — zéro appel modèle, zéro loterie
  var sil = cerveau.silenceNecessaire({ etat: etat, messages: ctx.messages });
  if (sil.silence) {
    log("process_silence", "silence : " + sil.raison);
    return {
      statut: "silence",
      reponse: "",
      escalade: false,
      raison_escalade: "",
      etat: etat,
      journal: journal,
      appels: 0,
      mode: mode
    };
  }

  if (typeof mistral !== "function") {
    // Garde de contrat : sans adaptateur, on ne devine JAMAIS une réponse.
    return repli("adaptateur Mistral absent du processeur");
  }

  // 3) CERVEAU — 1er appel (sur 2 max)
  var messages = cerveau.construireMessages({
    contact: ctx.contact || {},
    client: e.client || null,
    etat: etat,
    messages: ctx.messages || [],
    lecons: e.lecons || []
  });
  var texte = await mistral(messages);
  appels++;
  var candidat = cerveau.parserReponse(texte);

  if (!candidat.ok) {
    log("process_reponse_illisible", "réponse du modèle illisible — régénération format");
    messages = messages.concat([
      { role: "assistant", content: String(texte || "").substring(0, 500) },
      { role: "user", content: RAPPEL_FORMAT }
    ]);
    texte = await mistral(messages);
    appels++;
    candidat = cerveau.parserReponse(texte);
    if (!candidat.ok) {
      return repli("réponse du modèle illisible après régénération");
    }
  }

  // 4) GARDES — code déterministe : faute → 1 régénération AVEC rappels,
  // récidive → repli neutre (cahier des charges §6.2). Jamais de 3e appel.
  var verdict = gardes.verifier({ reponse: candidat.reponse, escalade: candidat.escalade, etat: etat });
  if (!verdict.ok) {
    log("process_gardes", "fautes détectées : " + codesFautes(verdict.fautes).join(", "), { fautes: codesFautes(verdict.fautes) });
    if (appels >= 2) {
      return repli("récidive des gardes (budget de régénération déjà consommé)");
    }
    var rappels = verdict.fautes.map(function (f) { return "- " + f.rappel; }).join("\n");
    messages = messages.concat([
      { role: "assistant", content: JSON.stringify({ reponse: candidat.reponse, escalade: candidat.escalade, raison_escalade: candidat.raison_escalade }) },
      { role: "user", content: "RAPPEL — ta réponse précédente viole des règles du cahier des charges :\n" + rappels + "\nRédige la réponse corrigée pour le client et réponds à nouveau UNIQUEMENT en JSON au format demandé." }
    ]);
    texte = await mistral(messages);
    appels++;
    var c2 = cerveau.parserReponse(texte);
    if (!c2.ok) {
      return repli("réponse du modèle illisible après régénération");
    }
    var v2 = gardes.verifier({ reponse: c2.reponse, escalade: c2.escalade, etat: etat });
    if (!v2.ok) {
      log("process_gardes", "récidive : " + codesFautes(v2.fautes).join(", "), { fautes: codesFautes(v2.fautes) });
      return repli("récidive des gardes après régénération");
    }
    log("process_gardes", "régénération conforme");
    candidat = c2;
  }

  // 5) FUSION — le formulaire mis à jour par le modèle, whitelist stricte :
  // jamais d'écrasement d'une info déjà fournie par le client (B3.2).
  if (candidat.formulaire) {
    etat = cerveau.fusionnerMajEtat(etat, candidat.formulaire);
  }

  // 6) ESCALADE — la raison est journalisée pour le collègue (§8)
  if (candidat.escalade) {
    log("process_escalade", "escalade demandée par le cerveau : " + candidat.raison_escalade);
  }

  // 7) MODE — B4.1 : observation uniquement. L'envoi réel + les cycles
  // respond.io arrivent en B4.2 ; par sécurité, "actif" est rétrogradé.
  if (mode === "actif") {
    log("process_avertissement", "MODE_ACTIF demandé mais l'envoi réel arrive en B4.2 — traitement maintenu en observation");
    mode = "observation";
  }
  log("observation", "réponse prête — NON ENVOYÉE (mode observation)", {
    envoyee: false,
    reponse: candidat.reponse,
    escalade: candidat.escalade,
    raison_escalade: candidat.raison_escalade,
    appels_mistral: appels
  });

  return {
    statut: "traite",
    reponse: candidat.reponse,
    escalade: candidat.escalade,
    raison_escalade: candidat.raison_escalade,
    etat: etat,
    journal: journal,
    appels: appels,
    mode: mode
  };
}

module.exports = { traiterMessage: traiterMessage };

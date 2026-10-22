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

// B4.2-PREP.1 — Réponse canonique du RESET/RAZ : IDENTIQUE à l'ancien système
// (parité vérifiable sur l'écran B5 sur le même fil).
var REPONSE_RESET =
  "Mémoire de la conversation réinitialisée. Votre prochain message sera traité comme une nouvelle demande.\n-Agent IA U'mob-";

// B4.2-PREP.2 — Réponse canonique du rejet plaque hors parc : IDENTIQUE à
// l'ancien système (garde cas A — divergence n°2, parité visible sur B5).
var REPONSE_PLAQUE =
  "Cette plaque ne correspond pas à notre parc. Quelle est la saisie exacte de la plaque ?";

// B5.4.1 (correctif cas A, incident console GE-365-DD/GR-335-TT) — formate
// une plaque normalisée (GR335TT) au format lisible de l'ancien système
// (GR-335-TT), pour le canonique de transfert cas A (v2.20.9/v2.20.10).
function formaterPlaque(p) {
  var n = String(p || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (n.length === 7) return n.substring(0, 2) + "-" + n.substring(2, 5) + "-" + n.substring(5);
  return String(p || "");
}

// B5.4.1 — une demande de VÉRIFICATION de plaque a-t-elle DÉJÀ été envoyée
// dans cette conversation ? Portage de compterVerificationsPlaqueAgent
// (v2.20.6) : détecte le canonique v2 (« ne correspond pas à notre parc…
// saisie exacte de la plaque ») ET les vérifications de l'ancien agent
// (« vérifier l'immatriculation », « je ne retrouve pas cette
// immatriculation », « plaque non reconnue »…) — le cas A doit se
// déclencher sur les DEUX pendant la période de comparaison.
function verificationPlaqueDejaDemandee(messages) {
  var msgs = messages || [];
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (!m || !m.sortant) continue;
    var t = String(m.texte || "");
    if (/(plaque|immatriculation)/i.test(t) &&
        /(v[ée]rifi|rev[ée]rifi|retrouve pas|ne correspond pas|saisie exacte|non reconnue)/i.test(t)) {
      return true;
    }
  }
  return false;
}

// B4.2-PREP.1 — RESET/RAZ : texte SEUL exact (casse et espaces tolérés), pas
// de média. « veuillez reset le gps » n'est PAS un RESET : sinon une phrase
// banale purgerait la mémoire d'un dossier en cours.
function estResetRaz(m) {
  if (!m || m.sortant) return false;
  if (m.media) return false;
  var t = String(m.texte || "").trim().toUpperCase();
  return t === "RESET" || t === "RAZ";
}

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

  // 0) RESET / RAZ — purge de la mémoire (l'équivalent v2 du couperMemoire de
  // l'ancien système). DÉTERMINISTE et AVANT TOUT, même avant le silence de
  // prise de main : dans l'ancien système, le RESET retire toujours le tag.
  // Le formulaire du dossier repart à ZÉRO (état vierge) ; la fiche client
  // B2.2 (enseigne, plaques flotte, statut risque) est RÉAPPLIQUÉE : ce sont
  // des données du client, pas de la conversation. Zéro appel Mistral.
  var entrantReset = cerveau.dernierEntrant(ctx.messages || []);
  if (estResetRaz(entrantReset)) {
    var etatNeuf = etatLib.etatDepuisContexte({ contact: {}, messages: [], commentaires: [], avertissements: [] });
    if (e.client) etatLib.appliquerClient(etatNeuf, e.client);
    log("process_reset", "RESET/RAZ détecté — mémoire de la conversation purgée (formulaire du dossier remis à zéro)");
    log("observation", "réponse canonique RESET — NON ENVOYÉE (mode observation)", {
      envoyee: false,
      type: "reset",
      reponse: REPONSE_RESET,
      escalade: false,
      raison_escalade: "",
      appels_mistral: 0
    });
    return {
      statut: "reset",
      reponse: REPONSE_RESET,
      escalade: false,
      raison_escalade: "",
      etat: etatNeuf,
      journal: journal,
      appels: 0,
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

  // 2bis) GARDE PLAQUE PARC (B4.2-PREP.2 — divergence n°2, garde cas A de
  // l'ancien système) — CORRECTIF B5.4.1 : le cas A de l'ancien a DEUX
  // étapes (v2.20.6/9/10), le v2 n'avait porté que la première.
  //
  //   ÉTAPE 1 (1re vérification) : une plaque citée POUR LA PREMIÈRE FOIS par
  //   le client est vérifiée contre le parc. Absente → rejet canonique
  //   (« Cette plaque ne correspond pas à notre parc… »), DÉTERMINISTE,
  //   0 appel Mistral. Une plaque RÉPÉTÉE ou de la FLOTTE n'est JAMAIS
  //   revérifiée ici.
  //
  //   ÉTAPE 2 (TRANSFERT AUTO, porté en B5.4.1) : une vérification a DÉJÀ été
  //   envoyée dans le fil et le client REDONNE une plaque TOUJOURS absente
  //   du parc (confirmée, corrigée ou nouvelle) → TRANSFERT AUTOMATIQUE
  //   DÉTERMINISTE, 0 Mistral : réponse canonique « Merci pour la
  //   confirmation. Je ne retrouve pas l'immatriculation… » + escalade —
  //   en mode actif B4.2 : cycle « A qualifier » + tag « Prise de main » +
  //   commentaire TRANSFERT SAV. SANS cette étape, la conversation restait
  //   bloquée à re-demander la plaque indéfiniment et le cycle ne changeait
  //   JAMAIS (incident console GE-365-DD → GR-335-TT, 23/10).
  //
  //   RÈGLES COMMUNES : les plaques FLOTTE du client (B2.2) ne sont jamais
  //   bloquantes (règle 4) ; une erreur du parc n'entraîne JAMAIS de rejet
  //   ni de transfert (règle 6 : dans le doute, la qualification poursuit) ;
  //   un message MIXTE (au moins une plaque du message AU parc) ne transfère
  //   PAS — la plaque reconnue débloque la qualification.
  //   ZÉRO RÉSEAU ICI : la vérification est INJECTÉE (api/process.js).
  var entrantPlaque = cerveau.dernierEntrant(ctx.messages || []);
  if (entrantPlaque && typeof e.parc === "function") {
    var plaquesDites = etatLib.extrairePlaques(String(entrantPlaque.texte || ""));
    if (plaquesDites.length) {
      var verificationDejaEnvoyee = verificationPlaqueDejaDemandee(ctx.messages || []);
      if (!verificationDejaEnvoyee) {
        // --- ÉTAPE 1 : 1re vérification (nouvelles plaques uniquement) ----
        var msgsAvant = (ctx.messages || []).filter(function (m) { return m !== entrantPlaque; });
        var etatAvant = etatLib.etatDepuisContexte({
          contact: ctx.contact || {},
          messages: msgsAvant,
          commentaires: ctx.commentaires || [],
          avertissements: []
        });
        if (e.client) etatLib.appliquerClient(etatAvant, e.client);
        var nouvelles = plaquesDites.filter(function (p) { return etatAvant.plaques.indexOf(p) === -1; });
        var absentes = [];
        for (var ip = 0; ip < nouvelles.length; ip++) {
          var dansParc = true;
          try {
            dansParc = !!(await e.parc(nouvelles[ip]));
          } catch (errParc) {
            dansParc = true; // best effort : dans le doute, on ne rejette pas
          }
          if (!dansParc) absentes.push(nouvelles[ip]);
        }
        if (absentes.length) {
          log("process_plaque", "plaque(s) absente(s) du parc : " + absentes.join(", ") + " — rejet canonique (garde cas A, 0 Mistral)");
          log("observation", "rejet plaque hors parc — NON ENVOYÉE (mode observation)", {
            envoyee: false,
            type: "plaque",
            reponse: REPONSE_PLAQUE,
            escalade: false,
            raison_escalade: "",
            appels_mistral: 0
          });
          return {
            statut: "traite",
            reponse: REPONSE_PLAQUE,
            escalade: false,
            raison_escalade: "",
            etat: etat,
            journal: journal,
            appels: 0,
            mode: mode
          };
        }
      } else {
        // --- ÉTAPE 2 : TRANSFERT AUTO cas A (v2.20.6/9/10, porté B5.4.1) ---
        // Le client a déjà reçu UNE demande de vérification : TOUTES les
        // plaques de CE message sont revérifiées (y compris répétées — la
        // confirmation du client doit être TRANCHÉE, pas re-questionnée).
        var absentesCasA = [];
        for (var ic = 0; ic < plaquesDites.length; ic++) {
          var dansParcCasA = true;
          try {
            dansParcCasA = !!(await e.parc(plaquesDites[ic]));
          } catch (errParcCasA) {
            dansParcCasA = true; // best effort : jamais de transfert sur erreur
          }
          if (!dansParcCasA) absentesCasA.push(plaquesDites[ic]);
        }
        if (absentesCasA.length === plaquesDites.length) {
          var plaqueTxt = formaterPlaque(absentesCasA[0]);
          var raisonCasA =
            "PLAQUE NON IDENTIFIÉE AU PARC (cas A) : le client a redonné la plaque " + plaqueTxt +
            " après vérification, elle n'est pas au parc — un collègue identifie le scooter (fichier, Praxedo, téléphone) puis reprend la demande";
          var reponseCasA =
            "Merci pour la confirmation. Je ne retrouve pas l'immatriculation " + plaqueTxt +
            " dans notre parc. Je transmets votre demande à un membre de notre équipe, qui aura accès à notre conversation et vous répondra au plus vite.\n\n-Agent IA U'mob-";
          log("process_transfert_cas_a", "cas A : " + absentesCasA.join(", ") +
            " confirmée(s) absente(s) du parc après vérification — transfert automatique déterministe (0 Mistral)");
          log("observation", "transfert cas A — réponse canonique NON ENVOYÉE (mode observation)", {
            envoyee: false,
            type: "cas_a",
            reponse: reponseCasA,
            escalade: true,
            raison_escalade: raisonCasA,
            appels_mistral: 0
          });
          return {
            statut: "traite",
            reponse: reponseCasA,
            escalade: true,
            raison_escalade: raisonCasA,
            etat: etat,
            journal: journal,
            appels: 0,
            mode: mode
          };
        }
        // message mixte (au moins une plaque du message est AU parc) ou
        // plaque corrigée reconnue : PAS de transfert — la plaque reconnue
        // débloque, la qualification poursuit par le cerveau.
      }
    }
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

module.exports = { traiterMessage: traiterMessage, estResetRaz: estResetRaz, REPONSE_RESET: REPONSE_RESET, REPONSE_PLAQUE: REPONSE_PLAQUE, formaterPlaque: formaterPlaque, verificationPlaqueDejaDemandee: verificationPlaqueDejaDemandee };


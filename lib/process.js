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
//                  « non envoyée », et les écritures B4.2 (envoi, cycle,
//                  tags, commentaire) sont CALCULÉES + journalisées
//                  (actions_b42) SANS être exécutées. L'exécution réelle vit
//                  dans api/process.js, armée par B42_EXECUTION=1 +
//                  MODE_AGENT=actif (feu vert de Corentin).
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

var cyclesLib = require("./cycles.js");
var actionsLib = require("./actions.js"); // B6.1 — les écritures B4.2, STRUCTURÉES
var consignesLib = require("./consignes.js"); // B6.3 — consignes internes @Agent IA
var praxedoLib = require("./praxedo.js"); // B6.4 — armement du suivi Praxedo

// B4.2-PREP.1 — RESET/RAZ : texte SEUL exact (casse et espaces tolérés), pas
// de média. « veuillez reset le gps » n'est PAS un RESET : sinon une phrase
// banale purgerait la mémoire d'un dossier en cours.
function estResetRaz(m) {
  if (!m || m.sortant) return false;
  if (m.media) return false;
  var t = String(m.texte || "").trim().toUpperCase();
  return t === "RESET" || t === "RAZ";
}

// B5.4.3 — MOTS SIGNIFICATIFS : le message client contient-il autre chose
// que la/les plaque(s) ? Une plaque inconnue citée SEULE (« c est GR-335-TT »)
// reste du territoire du canonique (0 Mistral) ; une plaque inconnue citée
// AVEC une description (« levier de frein avant cassé. GF-887-DD a une
// crevaison arrière ») est un message MIXTE : le cerveau doit répondre à TOUT
// le message — dire que la plaque n'est pas au parc ET montrer au client que
// son problème est compris (décision de Corentin 23/10, B5.4.3).
var MOTS_VIDES = {
  "les": 1, "des": 1, "une": 1, "aux": 1, "est": 1, "sont": 1, "ete": 1,
  "etre": 1, "ont": 1, "avez": 1, "avons": 1, "suis": 1, "mais": 1,
  "pas": 1, "plus": 1, "jamais": 1, "rien": 1, "non": 1, "oui": 1,
  "pour": 1, "avec": 1, "sans": 1, "dans": 1, "sur": 1, "sous": 1,
  "par": 1, "chez": 1, "donc": 1, "alors": 1, "aussi": 1, "comme": 1,
  "quand": 1, "que": 1, "qui": 1, "quoi": 1, "tres": 1, "trop": 1,
  "bien": 1, "peu": 1, "deja": 1, "encore": 1, "ici": 1, "elle": 1,
  "elles": 1, "eux": 1, "lui": 1, "toi": 1, "moi": 1, "nous": 1,
  "vous": 1, "mon": 1, "ton": 1, "son": 1, "ses": 1, "mes": 1, "tes": 1,
  "nos": 1, "vos": 1, "leur": 1, "leurs": 1, "tous": 1, "tout": 1,
  "toute": 1, "toutes": 1, "cette": 1, "cet": 1, "ces": 1, "via": 1,
  "peut": 1, "peux": 1, "pouvez": 1, "puis": 1, "fait": 1, "faire": 1,
  "avoir": 1, "vait": 1, "etais": 1, "etait": 1
};

// Nombre de mots significatifs (≥ 3 lettres, hors mots grammaticaux) restant
// dans le texte APRÈS en avoir retiré toutes les variantes d'écriture des
// plaques citées (GF-887-DD, GF887DD, GF 887 DD…).
function motsSignificatifs(texte) {
  var t = String(texte || "").toLowerCase()
    .replace(/['\u2019]/g, " ")
    .replace(/[^a-z0-9\s-]/g, " ");
  var mots = t.split(/\s+/).filter(Boolean);
  var n = 0;
  for (var i = 0; i < mots.length; i++) {
    var m = mots[i].replace(/^-+|-+$/g, "");
    if (m.length < 3) continue;
    if (MOTS_VIDES[m]) continue;
    n++;
  }
  return n;
}

// Message MIXTE : la plaque n'est pas seule, le client a décrit autre chose
// (un problème, une question…) — seuil : au moins 2 mots significatifs hors
// plaque. « mon scooter AA-123-BB ne démarre pas » → mixte (scooter,
// démarre) ; « c est GR-335-TT » → pas mixte → canonique déterministe.
function messageMixte(texte, plaques) {
  var t = String(texte || "");
  var ps = plaques || [];
  for (var i = 0; i < ps.length; i++) {
    var motif = String(ps[i] || "").toUpperCase().replace(/(.)/g, "$1[-\\s. ]*");
    t = t.replace(new RegExp(motif, "gi"), " ");
  }
  return motsSignificatifs(t) >= 2;
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
  // B5.4.3 — une plaque hors parc citée dans un message MIXTE (avec une
  // description, un problème…) : le canonique seul IGNORE le reste du
  // message (incident Corentin 23/10 — « il doit quand même dire au client
  // qu'il a compris le problème »). On INJECTE le résultat de la vérification
  // au cerveau (l'autorité du parc reste DÉTERMINISTE, ici) et une garde
  // vérifie que la réponse traite bien la plaque inconnue.
  var plaquesHorsParc = [];   // → gardes.verifier (G10 + exception G4)
  var directivesPlaque = [];  // → leçons du prompt cerveau

  function log(etape, texte, detail) {
    journal.push({
      contact_id: e.contactId || null,
      etape: etape,
      texte: String(texte || "").substring(0, 500),
      detail: detail || null
    });
  }

  // B6.1 — LES ACTIONS B4.2 : ce que le mode actif écrirait sur respond.io
  // (envoi, cycle, tags, commentaire) — STRUCTURÉ et ordonné, journalisé en
  // observation (detail.actions_b42 + retour), JAMAIS exécuté ici. L'exécution
  // réelle vit dans api/process.js derrière MODE_AGENT=actif + B42_EXECUTION=1
  // (feu vert de Corentin). Le canal vient de la fiche respond.io si connu.
  function actionsB42(statut, type, reponse, escalade, raison, etat, cyclePrevu) {
    return actionsLib.actionsPrevues({
      statut: statut,
      type: type,
      reponse: reponse,
      escalade: escalade,
      raison_escalade: raison,
      etat: etat,
      cycle_prevu: cyclePrevu,
      canal: (ctx.contact && ctx.contact.channelId) || null
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
      mode: mode,
      actions_b42: actionsB42("repli", "cerveau", rep, true, raison, etat, null)
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
    var actionsReset = actionsB42("reset", "reset", REPONSE_RESET, false, "", etatNeuf,
      cyclesLib.cyclePrevu({ statut: "reset", type: "reset", escalade: false, raison_escalade: "", etat: etatNeuf, reponse: REPONSE_RESET }));
    log("observation", "réponse canonique RESET — NON ENVOYÉE (mode observation)", {
      envoyee: false,
      type: "reset",
      reponse: REPONSE_RESET,
      escalade: false,
      raison_escalade: "",
      appels_mistral: 0,
      cycle_prevu: cyclesLib.cyclePrevu({ statut: "reset", type: "reset", escalade: false, raison_escalade: "", etat: etatNeuf, reponse: REPONSE_RESET }),
      actions_b42: actionsReset
    });
    return {
      statut: "reset",
      reponse: REPONSE_RESET,
      escalade: false,
      raison_escalade: "",
      etat: etatNeuf,
      journal: journal,
      appels: 0,
      mode: mode,
      actions_b42: actionsReset
    };
  }

  // 1) ÉTAT — reconstruit sur TOUT l'historique (cahier des charges §7 :
  // jamais un extrait) + signaux équipe de la fiche + fiche client.
  var etat = etatLib.etatDepuisContexte(ctx);
  if (e.client) etatLib.appliquerClient(etat, e.client);

  // 1bis) CONSIGNES INTERNES @Agent IA (B6.3 — LECTURE SEULE, déterministe) :
  // les collègues pilotent l'agent par commentaire (« @Agent IA … »).
  // En mode observation, la consigne est DÉTECTÉE et JOURNALISÉE — aucune
  // action n'en découle ici (l'exécution — reprise, armement Praxedo,
  // réponse au collègue — est branchée en B4.2 derrière le feu vert).
  // La plaque citée par un COLLÈGUE est VALIDÉE (v2.20.58) : elle rejoint le
  // formulaire du dossier, elle ne sera JAMAIS redemandée au client.
  var commentaires = ctx.commentaires || [];
  var consignesDetectees = [];
  for (var ic = 0; ic < commentaires.length; ic++) {
    var analyse = consignesLib.analyser(commentaires[ic]);
    if (!analyse.pour_agent) continue;
    consignesDetectees.push(analyse);
    for (var pc = 0; pc < analyse.plaques.length; pc++) {
      if (etat.plaques.indexOf(analyse.plaques[pc]) === -1) {
        etat.plaques.push(analyse.plaques[pc]);
      }
    }
  }
  if (consignesDetectees.length) {
    var derniereConsigne = consignesDetectees[consignesDetectees.length - 1];
    log("consigne_detectee", "consigne @Agent IA lue — LECTURE SEULE en observation : " +
      (derniereConsigne.consigne || "(consigne vide)"), {
      nombre: consignesDetectees.length,
      question_interne: derniereConsigne.question_interne,
      reprise: derniereConsigne.reprise,
      attend_reponse: derniereConsigne.attend_reponse,
      references: derniereConsigne.references,
      plaques: derniereConsigne.plaques
    });
  }

  // Le canal (B6.3 — ton par canal, portage v2.10) : résolu par l'appelant
  // (api/process.js) depuis la fiche respond.io ; '' = non résolu → le
  // cerveau écrit dans le ton simple du cahier des charges.
  var canal = String(e.canal || "");

  // 1ter) B6.4 — TOUR CONSIGNE (declencheur='consigne') : une consigne
  // @Agent IA est EN FILE (webhook comment.created → api/webhook enfila la
  // ligne avec canal_nom='consigne' — les commentaires ne sont PAS lisibles
  // par GET respond.io, B2.1). Le pilotage par les collègues est EXÉCUTÉ
  // ici (branchement B4.2 des briques B6.3) :
  //   - QUESTION INTERNE (« @Agent IA ? … ») → réponse au collègue EN
  //     COMMENTAIRE (Mistral LIBRE, jamais au client) ;
  //   - RÉFÉRENCES PRAXEDO citées → ARMEMENT : cycle « En cours de
  //     réalisation » + compte-rendu de vérification + suivi_refs stockés ;
  //   - REPRISE + ATTENTE CLIENT → silence journalisé (v2.20.119) ;
  //   - REPRISE simple → la chaîne NORMALE reprend sur le dernier message
  //     client (bypass du silence de prise de main) ;
  //   - une consigne ne retire JAMAIS un tag (v2.20.106) ;
  //   - dédup 15 min (v2.20.99) contre etat.consigne_vue (persisté).
  var repriseDemandee = false;
  if (e.declencheur === "consigne" && e.consigne && typeof e.consigne === "object") {
    var analyseConsigne = consignesLib.analyser({ texte: String(e.consigne.texte || "") });
    if (analyseConsigne.pour_agent) {
      var maintenantC = Number(e.maintenant) || Date.now();

      // Champs persistants du dossier (jamais perdus par la reconstruction)
      var suiviRefs = (e.suiviRefsPrecedents || []).slice();
      if (e.consigneVue && e.consigneVue.cle) {
        var dedup = consignesLib.dedup15min(maintenantC, e.contactId, analyseConsigne.consigne,
          [{ cle: e.consigneVue.cle, ts: Number(e.consigneVue.ts) || 0 }]);
        if (!dedup.nouvelle) {
          log("consigne_dedup", "consigne @Agent IA répétée < 15 min — ignorée (v2.20.99)", { cle: dedup.cle });
          return {
            statut: "silence",
            tour: "consigne",
            reponse: "",
            escalade: false,
            raison_escalade: "",
            etat: etat,
            journal: journal,
            appels: 0,
            mode: mode,
            actions_b42: []
          };
        }
      }
      etat.consigne_vue = { cle: consignesLib.cleDedup(e.contactId, analyseConsigne.consigne), ts: maintenantC };

      // La plaque citée par un COLLÈGUE est VALIDÉE (v2.20.58)
      for (var pcC = 0; pcC < analyseConsigne.plaques.length; pcC++) {
        if (etat.plaques.indexOf(analyseConsigne.plaques[pcC]) === -1) {
          etat.plaques.push(analyseConsigne.plaques[pcC]);
        }
      }

      // --- QUESTION INTERNE : réponse au collègue en commentaire ---------
      if (analyseConsigne.question_interne) {
        if (typeof mistral !== "function") return repli("adaptateur Mistral absent du processeur");
        var msgsQ = cerveau.construireMessagesQuestion({
          question: consignesLib.questionInterne(analyseConsigne.consigne),
          dossier: consignesLib.etatDossier4Points({
            cycle: (ctx.contact && ctx.contact.cycle) || "",
            etat: etat,
            suiviRefs: suiviRefs
          }),
          nom: (ctx.contact && ctx.contact.nom) || "",
          messages: ctx.messages || []
        });
        var texteQ = String(await mistral(msgsQ, { texteLibre: true })).trim().slice(0, 2000);
        if (!texteQ) texteQ = "(pas de réponse à cette question — dossier à vérifier à la main)";
        var actionsQ = [{ action: "commentaire", texte: texteQ }];
        log("consigne_question", "question interne d'un collègue — réponse en COMMENTAIRE interne (jamais au client)", { question: analyseConsigne.consigne, reponse: texteQ });
        log(mode === "actif" && e.execution_armee === true ? "process_actif" : "observation",
          mode === "actif" && e.execution_armee === true ? "réponse au collègue prête — action commentaire transmise (mode actif ARMÉ)" : "réponse au collègue prête — NON POSTÉE (mode observation)", {
          tour: "consigne",
          type: "question_interne",
          appels_mistral: 1,
          actions_b42: actionsQ
        });
        return {
          statut: "consigne",
          tour: "consigne",
          type: "question_interne",
          reponse: "",
          escalade: false,
          raison_escalade: "",
          etat: etat,
          journal: journal,
          appels: 1,
          mode: mode,
          actions_b42: actionsQ
        };
      }

      // --- RÉFÉRENCES PRAXEDO : ARMEMENT du suivi (v2.20.63/68) ----------
      if (analyseConsigne.references.length) {
        for (var rA = 0; rA < analyseConsigne.references.length; rA++) {
          if (suiviRefs.indexOf(analyseConsigne.references[rA]) === -1) {
            suiviRefs.push(analyseConsigne.references[rA]);
          }
        }
        etat.suivi_refs = suiviRefs;

        // Compte-rendu de vérification : chaque ref contrôlée contre le
        // middleware Praxedo (3 états — une ERREUR n'est JAMAIS une absence).
        var verifications = [];
        if (typeof e.praxedo === "function") {
          for (var rV = 0; rV < analyseConsigne.references.length; rV++) {
            var etatV = "";
            try { etatV = await e.praxedo(analyseConsigne.references[rV]); }
            catch (errPrax) { etatV = "erreur"; }
            verifications.push({ reference: analyseConsigne.references[rV], verification: etatV });
          }
        } else {
          for (var rN = 0; rN < analyseConsigne.references.length; rN++) {
            verifications.push({ reference: analyseConsigne.references[rN], verification: "indisponible" });
          }
        }

        var armement = praxedoLib.decisionArmement({
          cycleActuel: (ctx.contact && ctx.contact.cycle) || "",
          references: analyseConsigne.references
        });
        var actionsA = [];
        if (armement) {
          actionsA.push({ action: "poser_cycle", cycle: armement.cycle, raison: armement.raison });
        }
        var lignesCR = [];
        for (var rC = 0; rC < verifications.length; rC++) {
          var vC = verifications[rC];
          lignesCR.push("- " + vC.reference + " : " +
            (vC.verification === "trouvee" ? "retrouvée dans Praxedo." :
             vC.verification === "introuvable" ? "INTROUVABLE dans Praxedo — vérifier la référence." :
             vC.verification === "erreur" ? "vérification en erreur (Praxedo indisponible ?) — reprise au prochain passage." :
             "vérification indisponible (middleware Praxedo non configuré)."));
        }
        actionsA.push({
          action: "commentaire",
          texte: "SUIVI PRAXEDO ARMÉ : " + analyseConsigne.references.join(", ") + "\n" +
            "Vérification des références :\n" + lignesCR.join("\n") + "\n" +
            "La conversation passera seule en « Traitée » dès que TOUTES les interventions seront réalisées dans Praxedo (vérification toutes les 2 h)."
        });
        log("consigne_armement", "références Praxedo citées par un collègue — suivi armé : " +
          analyseConsigne.references.join(", "), {
          references: analyseConsigne.references,
          suivi_refs: suiviRefs,
          cycle_pose: armement ? armement.cycle : null,
          verifications: verifications
        });
        log(mode === "actif" && e.execution_armee === true ? "process_actif" : "observation",
          mode === "actif" && e.execution_armee === true ? "armement Praxedo — actions transmises (mode actif ARMÉ)" : "armement Praxedo — NON EXÉCUTÉ (mode observation)", {
          tour: "consigne",
          type: "armement",
          appels_mistral: 0,
          actions_b42: actionsA
        });
        return {
          statut: "consigne",
          tour: "consigne",
          type: "armement",
          reponse: "",
          escalade: false,
          raison_escalade: "",
          etat: etat,
          journal: journal,
          appels: 0,
          mode: mode,
          actions_b42: actionsA
        };
      }

      // --- ATTENTE CLIENT : l'agent attend, il ne relance jamais --------
      if (analyseConsigne.attend_reponse) {
        log("consigne_attente_client", "consigne : attendre la réponse du client — silence (v2.20.119)");
        return {
          statut: "silence",
          tour: "consigne",
          type: "attente_client",
          reponse: "",
          escalade: false,
          raison_escalade: "",
          etat: etat,
          journal: journal,
          appels: 0,
          mode: mode,
          actions_b42: []
        };
      }

      // --- B6.5.1 RELAIS CLIENT : le collègue demande à l'agent de
      // TRANSMETTRE une demande au client (« demande au client l'adresse »,
      // « dis-lui que… ») → l'agent rédige le message AU CLIENT. Le message
      // passe les MÊMES GARDES que la chaîne normale (signature, question
      // fermée, invention) : faute → UNE régénération avec les rappels
      // (borne 2 appels), récidive → transmission LITTÉRALE de la consigne
      // (zéro invention par construction : les mots de l'équipe).
      if (analyseConsigne.relais_client) {
        if (typeof mistral !== "function") return repli("adaptateur Mistral absent du processeur");
        var msgsRelais = cerveau.construireMessagesRelais({
          consigne: analyseConsigne.consigne,
          dossier: consignesLib.etatDossier4Points({
            cycle: (ctx.contact && ctx.contact.cycle) || "",
            etat: etat,
            suiviRefs: suiviRefs
          }),
          nom: (ctx.contact && ctx.contact.nom) || "",
          messages: ctx.messages || []
        });
        var texteRelais = String(await mistral(msgsRelais, { texteLibre: true })).trim().slice(0, 2000);
        var appelsRelais = 1;
        var gRelais = gardes.verifier({ reponse: texteRelais, escalade: false, etat: etat });
        if (!gRelais.ok) {
          log("relais_gardes", "relais client : garde déclenchée — UNE régénération avec rappels (borne 2 appels)", { fautes: gRelais.fautes.map(function (fg) { return fg.code; }) });
          var msgsRelais2 = msgsRelais.slice();
          msgsRelais2[msgsRelais2.length - 1] = { role: "user",
            content: msgsRelais2[msgsRelais2.length - 1].content +
              "\n\n=== CORRECTIONS EXIGÉES (gardes qualité) ===\n" +
              gRelais.fautes.map(function (fg) { return "- " + fg.rappel; }).join("\n") +
              "\n\nRédige à nouveau le message au client en corrigeant ces points. Texte brut, sans JSON." };
          texteRelais = String(await mistral(msgsRelais2, { texteLibre: true })).trim().slice(0, 2000);
          appelsRelais = 2;
          var gRelais2 = gardes.verifier({ reponse: texteRelais, escalade: false, etat: etat });
          if (!gRelais2.ok) {
            log("relais_gardes", "relais client non conforme après régénération — transmission LITTÉRALE de la consigne de l'équipe (zéro invention)", { fautes: gRelais2.fautes.map(function (fg2) { return fg2.code; }) });
            texteRelais = "Message de l'équipe SAV : « " + analyseConsigne.consigne + " »\n-Agent IA U'mob-";
          }
        }
        var actionsRelais = [{ action: "envoyer_message", texte: texteRelais }];
        log("consigne_relais_client", "consigne de relais — l'agent transmet la demande de l'équipe AU CLIENT", {
          consigne: analyseConsigne.consigne,
          reponse: texteRelais
        });
        log(mode === "actif" && e.execution_armee === true ? "process_actif" : "observation",
          mode === "actif" && e.execution_armee === true ? "relais client — envoi AU CLIENT transmis (mode actif ARMÉ)" : "relais client — message AU CLIENT prêt — NON ENVOYÉ (mode observation)", {
          tour: "consigne",
          type: "relais_client",
          appels_mistral: appelsRelais,
          actions_b42: actionsRelais
        });
        return {
          statut: "consigne",
          tour: "consigne",
          type: "relais_client",
          reponse: texteRelais, // AU CLIENT (B4.2 enverrait ce message)
          escalade: false,
          raison_escalade: "",
          etat: etat,
          journal: journal,
          appels: appelsRelais,
          mode: mode,
          actions_b42: actionsRelais
        };
      }

      // --- REPRISE (v2.20.54) : la chaîne NORMALE reprend sur le dernier
      // message client — bypass du silence de prise de main. La consigne ne
      // retire JAMAIS le tag (v2.20.106 : le retrait est une décision
      // DÉTERMINISTE séparée — lib/scan.js / lib/praxedo.js).
      if (analyseConsigne.reprise) {
        repriseDemandee = true;
        log("consigne_reprise", "consigne de reprise — la chaîne reprend sur le dernier message client (bypass du silence de prise de main ; le tag n'est PAS retiré ici)");
      } else {
        log("consigne_info", "consigne @Agent IA sans action automatique associée — journalisée", { consigne: analyseConsigne.consigne });
      }
    }
  }

  // 2) SILENCE déterministe — zéro appel modèle, zéro loterie
  var sil = cerveau.silenceNecessaire({ etat: etat, messages: ctx.messages });
  if (sil.silence) {
    // B6.4 — bypass UNIQUEMENT pour la reprise : le collègue a demandé à
    // l'agent de reprendre la main ; on traite le dernier message client.
    if (repriseDemandee && sil.raison === "prise de main humaine") {
      log("process_reprise", "reprise : silence de prise de main BYPASSÉ — l'agent reprend sur le dernier message client");
    } else {
      log("process_silence", "silence : " + sil.raison);
      return {
        statut: "silence",
        reponse: "",
        escalade: false,
        raison_escalade: "",
        etat: etat,
        journal: journal,
        appels: 0,
        mode: mode,
        actions_b42: [] // silence : un humain a la main, aucune écriture
      };
    }
  }

  if (typeof mistral !== "function") {
    // Garde de contrat : sans adaptateur, on ne devine JAMAIS une réponse.
    return repli("adaptateur Mistral absent du processeur");
  }

  // 2bis) GARDE PLAQUE PARC (B4.2-PREP.2 — divergence n°2, garde cas A de
  // l'ancien système). Une plaque citée POUR LA PREMIÈRE FOIS par le client
  // est vérifiée contre le parc. Absente → rejet canonique (« Cette plaque
  // ne correspond pas à notre parc… »), DÉTERMINISTE, 0 appel Mistral.
  // Une plaque RÉPÉTÉE ou de la FLOTTE n'est JAMAIS revérifiée (au 2e échec,
  // la qualification poursuit par le cerveau — comportement VALIDÉ par
  // Corentin B5.4, confirmé B5.4.2 : la plaque n'est PAS bloquante, règle 6).
  //   RÈGLES : les plaques FLOTTE du client (B2.2) ne sont jamais bloquantes
  //   (règle 4) ; une erreur du parc n'entraîne JAMAIS de rejet (règle 6 :
  //   dans le doute, la qualification poursuit).
  //   ZÉRO RÉSEAU ICI : la vérification est INJECTÉE (api/process.js).
  var entrantPlaque = cerveau.dernierEntrant(ctx.messages || []);
  if (entrantPlaque && typeof e.parc === "function") {
    var plaquesDites = etatLib.extrairePlaques(String(entrantPlaque.texte || ""));
    if (plaquesDites.length) {
      // --- ÉTAPE 1 : 1re vérification (nouvelles plaques uniquement) ----
      var msgsAvant = (ctx.messages || []).filter(function (m) { return m !== entrantPlaque; });
      var etatAvant = etatLib.etatDepuisContexte({
        contact: ctx.contact || {},
        messages: msgsAvant,
        commentaires: ctx.commentaires || [],
        avertissements: []
      });
      if (e.client) etatLib.appliquerClient(etatAvant, e.client);
      // B6.7.2 — les plaques FLOTTE ne sont plus dans plaques : elles restent
      // exclues de la vérification (règle 4 : la flotte n'est jamais bloquante).
      var nouvelles = plaquesDites.filter(function (p) {
        return etatAvant.plaques.indexOf(p) === -1 &&
          (etatAvant.plaques_flotte || []).indexOf(p) === -1;
      });
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
        // B6.3 — PHOTO RÉCENTE (portage v2.20.124) : une photo reçue MOINS DE
        // 5 MIN avant ce texte peut PORTER la plaque (le client photographie
        // le scooter puis tape l'immatriculation à côté). Le rejet canonique
        // serait une fin de non-recevoir sèche sur un dossier où le client a
        // DÉJÀ fourni la preuve → PAS de canonique : le cerveau répond, avec
        // la leçon « relis la plaque sur la photo ».
        var photoRecente = false;
        var tsTexteCourant = Number(entrantPlaque.ts) || 0;
        if (tsTexteCourant) {
          var msgsTous = ctx.messages || [];
          for (var iph = 0; iph < msgsTous.length; iph++) {
            var mph = msgsTous[iph] || {};
            if (mph.sortant || mph === entrantPlaque) continue;
            var estPhoto = mph.type_media === "image" ||
              (mph.media && !mph.type_media && !mph.texte);
            if (!estPhoto) continue;
            var ecartPhoto = tsTexteCourant - (Number(mph.ts) || 0);
            if (ecartPhoto >= 0 && ecartPhoto <= 5 * 60 * 1000) photoRecente = true;
          }
        }
        if (photoRecente) {
          plaquesHorsParc = absentes.slice();
          directivesPlaque.push(
            "LA PLAQUE « " + absentes.map(function (p) { return etatLib.formaterPlaque(p); }).join(" », « ") +
            " » citée par le client n'est pas retrouvée au parc (vérification déjà faite), MAIS il vient d'envoyer une photo il y a moins de 5 minutes : la plaque est peut-être visible dessus. " +
            "Ne rejette pas sèchement : réponds à son message, et demande-lui de relire la plaque sur la photo ou de donner la saisie exacte de l'immatriculation (question OUVERTE)."
          );
          log("process_plaque_photo", "plaque(s) absente(s) du parc : " + absentes.join(", ") +
            " — mais photo reçue < 5 min avant le texte : pas de rejet canonique, le cerveau répond (leçon « relis la plaque sur la photo »)");
        } else if (messageMixte(String(entrantPlaque.texte || ""), absentes)) {
          plaquesHorsParc = absentes.slice();
          directivesPlaque.push(
            "LA PLAQUE « " + absentes.map(function (p) { return etatLib.formaterPlaque(p); }).join(" », « ") +
            " » citée par le client n'est PAS dans notre parc (vérification déterministe déjà faite : ne la revérifie pas, ne l'invente pas). " +
            "Réponds AUSSI au reste de son message (montre que tu as compris sa demande), MAIS indique-lui clairement que tu ne retrouves pas cette plaque dans notre parc et demande la saisie exacte de l'immatriculation (question OUVERTE)."
          );
          log("process_plaque_mixte", "plaque(s) absente(s) du parc : " + absentes.join(", ") +
            " — message avec du contenu en plus : le cerveau répond à TOUT le message (plaque inconnue signalée en leçon)");
        } else {
          log("process_plaque", "plaque(s) absente(s) du parc : " + absentes.join(", ") + " — rejet canonique (garde cas A, 0 Mistral)");
          var actionsPlaque = actionsB42("traite", "plaque", REPONSE_PLAQUE, false, "", etat,
            cyclesLib.cyclePrevu({ statut: "traite", type: "plaque", escalade: false, raison_escalade: "", etat: etat, reponse: REPONSE_PLAQUE }));
          log("observation", "rejet plaque hors parc — NON ENVOYÉE (mode observation)", {
            envoyee: false,
            type: "plaque",
            reponse: REPONSE_PLAQUE,
            escalade: false,
            raison_escalade: "",
            appels_mistral: 0,
            cycle_prevu: cyclesLib.cyclePrevu({ statut: "traite", type: "plaque", escalade: false, raison_escalade: "", etat: etat, reponse: REPONSE_PLAQUE }),
            actions_b42: actionsPlaque
          });
          return {
            statut: "traite",
            reponse: REPONSE_PLAQUE,
            escalade: false,
            raison_escalade: "",
            etat: etat,
            journal: journal,
            appels: 0,
            mode: mode,
            actions_b42: actionsPlaque
          };
        }
      }
    }
  }

  // 3) CERVEAU — 1er appel (sur 2 max)
  var messages = cerveau.construireMessages({
    contact: ctx.contact || {},
    client: e.client || null,
    etat: etat,
    messages: ctx.messages || [],
    lecons: (e.lecons || []).concat(directivesPlaque),
    canal: canal // B6.3 — ton par canal (EMAIL / WHATSAPP)
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
  var verdict = gardes.verifier({ reponse: candidat.reponse, escalade: candidat.escalade, etat: etat, plaques_hors_parc: plaquesHorsParc, etape_candidate: (candidat.formulaire && Number(candidat.formulaire.etape)) || 0 });
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
    var v2 = gardes.verifier({ reponse: c2.reponse, escalade: c2.escalade, etat: etat, plaques_hors_parc: plaquesHorsParc, etape_candidate: (c2.formulaire && Number(c2.formulaire.etape)) || 0 });
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

  // 7) MODE — B4.1 : observation par défaut. L'EXÉCUTION des actions B4.2
  // (envoi + cycle + tags + commentaire) vit dans api/process.js ; ici on
  // calcule et on JOURNALISE les actions. "actif" n'est HONORÉ que si
  // l'appelant confirme que l'exécution est ARMÉE (execution_armee : env
  // B42_EXECUTION=1 — feu vert de Corentin) ; sinon rétrogradé, comme avant.
  if (mode === "actif" && e.execution_armee !== true) {
    log("process_avertissement", "MODE_ACTIF demandé mais l'exécution B4.2 n'est pas armée (B42_EXECUTION absent) — traitement maintenu en observation");
    mode = "observation";
  }
  var actifArme = mode === "actif";
  var actionsFin = actionsB42("traite", "cerveau", candidat.reponse, candidat.escalade, candidat.raison_escalade, etat,
    cyclesLib.cyclePrevu({ statut: "traite", type: "cerveau", escalade: candidat.escalade, raison_escalade: candidat.raison_escalade, etat: etat, reponse: candidat.reponse }));
  log(actifArme ? "process_actif" : "observation",
    actifArme ? "réponse prête — actions B4.2 transmises à l'adaptateur (mode actif ARMÉ)" : "réponse prête — NON ENVOYÉE (mode observation)", {
    envoyee: actifArme,
    reponse: candidat.reponse,
    escalade: candidat.escalade,
    raison_escalade: candidat.raison_escalade,
    appels_mistral: appels,
    cycle_prevu: cyclesLib.cyclePrevu({ statut: "traite", type: "cerveau", escalade: candidat.escalade, raison_escalade: candidat.raison_escalade, etat: etat, reponse: candidat.reponse }),
    actions_b42: actionsFin
  });

  return {
    statut: "traite",
    reponse: candidat.reponse,
    escalade: candidat.escalade,
    raison_escalade: candidat.raison_escalade,
    etat: etat,
    journal: journal,
    appels: appels,
    mode: mode,
    actions_b42: actionsFin
  };
}

module.exports = { traiterMessage: traiterMessage, estResetRaz: estResetRaz, REPONSE_RESET: REPONSE_RESET, REPONSE_PLAQUE: REPONSE_PLAQUE, messageMixte: messageMixte, motsSignificatifs: motsSignificatifs };


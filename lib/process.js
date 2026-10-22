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
      mode: mode,
      actions_b42: [] // silence : un humain a la main, aucune écriture
    };
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
        // B5.4.3 — deux territoires :
        //   - message PLAQUE SEULE (ou quasi) : canonique déterministe 0
        //     Mistral, inchangé (parité ancien, comportement validé) ;
        //   - message MIXTE (la plaque + une description/un problème) : le
        //     canonique ignorerait le reste du message — le CERVEAU répond à
        //     tout, avec le résultat de la vérification INJECTÉ en leçon.
        if (messageMixte(String(entrantPlaque.texte || ""), absentes)) {
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
    lecons: (e.lecons || []).concat(directivesPlaque)
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


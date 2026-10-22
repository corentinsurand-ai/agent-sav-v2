// ============================================================================
// Agent SAV U'mob v2 — B5 : le moteur de comparaison (Node PUR)
//
// RÔLE (cahier des charges §9 — le filet de sécurité) : pour CHAQUE
// observation journalisée par B4.1 (etape = "observation", envoyee:false),
// retrouver côte à côte :
//   - le MESSAGE CLIENT qui a déclenché l'observation,
//   - la réponse RÉELLE de l'ancien agent (le 1er message sortant envoyé
//     APRÈS ce message client dans l'historique respond.io),
//   - la réponse SIMULÉE du nouveau cerveau (detail.reponse, jamais envoyée).
//
// Zéro réseau ici : les entrées de journal et les contextes assemblés B2.1
// sont fournis par l'adaptateur (api/observations.js) — testable à 100 %.
// ============================================================================

// B5.3 (divergence n°3) — ACTIONS SIMULÉES : ce que le mode ACTIF B4.2 ferait
// pour cette observation (journalisées ici, JAMAIS exécutées — l'écriture
// respond.io n'existe pas en mode observation). Fidèle à l'ancien système :
// un transfert SAV = cycle + tag « Prise de main » + commentaire interne
// TRANSFERT SAV avec le motif (capture réelle 23/10).
// B5.4.2 : le cycle posé vient du mapping §5 (lib/cycles.js —
// detail.cycle_prevu du journal d'observation) ; les anciennes entrées sans
// cycle_prevu retombent sur « A qualifier » (compatibilité ascendante).
function actionsSimulees(type, escalade, raison, cycle) {
  var actions = [];
  if (type === "reset") {
    actions.push("réponse canonique RESET (déterministe, 0 appel Mistral)");
    actions.push("retrait du tag « Prise de main » (si présent) — mémoire purgée");
    return actions;
  }
  if (type === "plaque") {
    actions.push("rejet canonique plaque hors parc (garde cas A, 0 appel Mistral)");
    actions.push("cycle inchangé — au 2e échec la qualification poursuit");
    return actions;
  }
  if (escalade) {
    actions.push("cycle → « " + (cycle || "A qualifier") + " »");
    actions.push("tag « Prise de main » posé");
    actions.push("commentaire interne « TRANSFERT SAV — merci de reprendre la main sur ce dossier »");
    actions.push("motif du transfert : " + (raison ? String(raison) : "(non précisé)"));
    return actions;
  }
  actions.push("aucun transfert — l'agent IA poursuit la conversation (cycle inchangé)");
  return actions;
}

function tsDe(iso) {
  if (!iso) return 0;
  var t = Date.parse(iso);
  return isNaN(t) ? 0 : t;
}

// ----------------------------------------------------------------------------
// lignesComparaison(entrees, contextes) — la table de comparaison §9.
//
//   entrees   : lignes agent_sav.journal (ordre quelconque), chacune :
//               {contact_id, horodatage, detail: {reponse, envoyee, escalade,
//                raison_escalade, appels_mistral}}
//   contextes : { "<contact_id>": ctx B2.1 assemblé {contact, messages…} }
//               (un contexte absent/illisible → ligne avec avertissement)
//
//   retour : [{contact_id, nom, date, message_client, media_client,
//              reponse_ancien, reponse_nouveau, escalade, raison_escalade,
//              appels_mistral, avertissement}]
// ----------------------------------------------------------------------------
function lignesComparaison(entrees, contextes) {
  var liste = (entrees || []).slice();
  // chronologique : de la plus ancienne à la plus récente (lecture du fil)
  liste.sort(function (a, b) { return tsDe(a.horodatage) - tsDe(b.horodatage); });

  var lignes = [];
  for (var i = 0; i < liste.length; i++) {
    var e = liste[i] || {};
    var cid = String(e.contact_id || "");
    var t = tsDe(e.horodatage);
    var detail = (e.detail && typeof e.detail === "object") ? e.detail : {};
    var typeObservation = String(detail.type || "cerveau");
    var ligne = {
      contact_id: cid,
      nom: "",
      date: e.horodatage || "",
      message_client: "",
      media_client: "",
      reponse_ancien: "",
      reponse_nouveau: String(detail.reponse || ""),
      escalade: detail.escalade === true,
      raison_escalade: String(detail.raison_escalade || ""),
      appels_mistral: detail.appels_mistral || 0,
      avertissement: "",
      // B5.3 (divergence n°3) — cycle/tags ACTUELS de la fiche respond.io
      // (l'API ne permet PAS de relire leur historique : seule la valeur du
      // moment est lisible) + actions que B4.2 mode actif SIMULERAIT.
      cycle_ancien: "",
      tags_ancien: [],
      type_observation: typeObservation,
      // B5.4.2 — le cycle que B4.2 poserait, calculé DÉTERMINISTEMENT par
      // lib/cycles.js (table §5) et journalisé par lib/process.js.
      cycle_prevu: (detail.cycle_prevu && detail.cycle_prevu.cycle) || null,
      cycle_prevu_raison: (detail.cycle_prevu && detail.cycle_prevu.raison) || "",
      actions_simulees: actionsSimulees(
        typeObservation,
        detail.escalade === true,
        String(detail.raison_escalade || ""),
        (detail.cycle_prevu && detail.cycle_prevu.cycle) || null
      )
    };

    var ctx = (contextes || {})[cid];
    if (!ctx) {
      ligne.avertissement = "contexte respond.io indisponible au moment de la lecture";
      lignes.push(ligne);
      continue;
    }
    ligne.nom = (ctx.contact && ctx.contact.nom) || "";
    ligne.cycle_ancien = String((ctx.contact && ctx.contact.cycle) || "");
    ligne.tags_ancien = ((ctx.contact && ctx.contact.tags) || []).slice();
    var messages = (ctx.messages || []).slice();

    // 1) Le message client : le DERNIER ENTRANT au moment de l'observation
    //    (ts <= horodatage du journal). Un message plus révenu ensuite est
    //    exclu — l'observation date du traitement, pas de maintenant.
    var indexClient = -1;
    for (var j = 0; j < messages.length; j++) {
      var m = messages[j];
      if (m.sortant) continue;
      if (t > 0 && m.ts > 0 && m.ts > t) continue; // arrivé APRÈS l'observation
      indexClient = j;
    }
    if (indexClient === -1) {
      // Repli anti-dérive d'horloge (respond.io et Supabase n'ont pas la même
      // montre) : sans ce repli, quelques secondes de décalage rendraient le
      // message client introuvable.
      for (var j2 = 0; j2 < messages.length; j2++) {
        if (!messages[j2].sortant) indexClient = j2;
      }
    }
    if (indexClient === -1) {
      // respond.io en panne au moment de la lecture : assemblerContexte ne
      // jette JAMAIS (best-effort B2.1) — il renvoie 0 messages + un
      // avertissement "messages : respond.io …". On le distingue d'un
      // historique sain mais sans message récent.
      var panneHistorique = false;
      var avs = ctx.avertissements || [];
      for (var a = 0; a < avs.length; a++) {
        if (String(avs[a]).indexOf("messages :") === 0) panneHistorique = true;
      }
      ligne.avertissement = (messages.length === 0 && panneHistorique)
        ? "contexte respond.io indisponible au moment de la lecture"
        : "message client introuvable dans l'historique";
      lignes.push(ligne);
      continue;
    }
    var mc = messages[indexClient];
    ligne.message_client = String(mc.texte || "");
    ligne.media_client = String(mc.media || "");
    if (!ligne.message_client && ligne.media_client) ligne.message_client = "(média reçu)";

    // 2) La réponse RÉELLE de l'ancien agent : le 1er SORTANT APRÈS ce
    //    message client (l'ancien agent ou un collègue — tout ce qui part
    //    réellement). Le nouveau système n'écrit JAMAIS dans respond.io.
    for (var k = indexClient + 1; k < messages.length; k++) {
      if (messages[k].sortant) {
        ligne.reponse_ancien = String(messages[k].texte || "");
        break;
      }
    }
    if (!ligne.reponse_ancien) {
      ligne.reponse_ancien = ""; // l'écran affichera « aucune réponse (encore) »
    }

    lignes.push(ligne);
  }
  return lignes;
}

module.exports = { lignesComparaison: lignesComparaison, actionsSimulees: actionsSimulees };


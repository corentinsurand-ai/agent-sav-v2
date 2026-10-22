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
      avertissement: ""
    };

    var ctx = (contextes || {})[cid];
    if (!ctx) {
      ligne.avertissement = "contexte respond.io indisponible au moment de la lecture";
      lignes.push(ligne);
      continue;
    }
    ligne.nom = (ctx.contact && ctx.contact.nom) || "";
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

module.exports = { lignesComparaison: lignesComparaison };

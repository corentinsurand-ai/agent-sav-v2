// ============================================================================
// Agent SAV U'mob v2 — B6.1 : les ACTIONS B4.2, en STRUCTURÉ (Node PUR)
//
// RÔLE (audit « tout se construit dans la v2 » + architecture v1.1) : dire
// EXACTEMENT ce que le mode ACTIF (B4.2) ferait après ce tour — en actions
// STRUCTURÉES et ordonnées, prêtes à être exécutées par l'adaptateur
// (lib/respondio.js, seule couche autorisée à écrire chez respond.io).
//
//   actionsPrevues(entree) → [{action:"envoyer_message", texte, canal}, …]
//     1. envoyer_message   — POST /contact/id:{id}/message (réponse au client)
//     2. poser_cycle       — POST /contact/id:{id}/lifecycle/update {name}
//     3. ajouter_tag       — POST /contact/id:{id}/tag ["Prise de main"]
//     4. retirer_tag       — DELETE /contact/id:{id}/tag ["Prise de main"]
//     5. commentaire       — POST /contact/id:{id}/comment {text}
//
//   FORMES d'écriture respond.io (portage EXACT du prod v2.20.136 :
//   envoyerMessage l.7612 {channelId, message:{type:'text',text}} ;
//   cycle : POST /lifecycle/update {name} l.6283 ; tag : POST /tag [nom]
//   l.2866 ; retrait : DELETE /tag [nom] l.2972 ; commentaire POST /comment
//   {text} l.2864). Les corps sont construits ici (PUR), l'adaptateur
//   exécute — jamais l'inverse.
//
//   DECISION Corentin 23/10 respectée : AUCUNE assignation, AUCUNE mention
//   @user (routage Marine/Nicolas EXCLU) — le commentaire « TRANSFERT SAV »
//   est adressé à l'équipe, sans mention.
//
//   texteTransfertSav(entree) — le commentaire INTERNE que B4.2 poserait :
//   récapitulatif complet (dossier complet) ou RAISON + MANQUES PRÉCIS
//   (v2.20.95/89 adaptés : le téléphone reste le SEUL bloquant, la plaque
//   n'est jamais bloquante). Le suivi Praxedo « @Agent IA intervention… »
//   (v2.20.68) n'est PAS encore cité — il le sera quand la brique Praxedo
//   existera dans la v2 (B6+).
//
// ZÉRO réseau, zéro dépendance : testable à 100 %. Le mode observation
// journalise ces actions (detail.actions_b42) SANS jamais les exécuter —
// l'exécution réelle n'existe que derrière MODE_AGENT=actif +
// B42_EXECUTION=1 (api/process.js, feu vert de Corentin requis).
// ============================================================================

var cyclesLib = require("./cycles.js");
var etatLib = require("./etat.js");

var TAG_PRISE_DE_MAIN = "Prise de main";       // portage exact v136 l.364
var TAG_COMMERCIAL = "Demande Commerciale";    // portage exact v136 l.363

// ---------------------------------------------------------------------------
// Manques du dossier (déterministe, v2.20.95/89 adaptés) :
//   - BLOQUANT   : telephone_contact (règle 6 — le SEUL bloquant du transfert)
//                 + panne (sans description, rien à créer dans Praxedo)
//   - NON BLOQUANT : la plaque (l'équipe la retrouve, v2.20.89)
// ---------------------------------------------------------------------------
function manquesDossier(etat) {
  var e = etat || {};
  var bloquants = [];
  var nonBloquants = [];
  if (!e.telephone_contact) bloquants.push("le numéro de la personne à contacter sur place (jour de l'intervention)");
  if (!e.panne) bloquants.push("la description de la panne");
  if (!e.plaques || !e.plaques.length) nonBloquants.push("la plaque du scooter (information NON bloquante : vous pouvez la retrouver vous-même)");
  return { bloquants: bloquants, nonBloquants: nonBloquants, complet: bloquants.length === 0 };
}

// ---------------------------------------------------------------------------
// Corps des appels respond.io (PUR — formes EXACTES du prod v136, testées) :
// ---------------------------------------------------------------------------
function corpsMessage(texte, channelId) {
  return {
    channelId: Number(channelId) || null,
    message: { type: "text", text: String(texte || "") }
  };
}

function corpsCycle(nomCycle) {
  return { name: String(nomCycle || "") };
}

function corpsTag(nomTag) {
  return [String(nomTag || "")];
}

// ---------------------------------------------------------------------------
// texteTransfertSav — commentaire interne « TRANSFERT SAV » (v2, sans
// assignation). Récapitulatif complet si le dossier est complet, sinon
// RAISON DU TRANSFERT + manques précis (le collègue sait POURQUOI il reprend
// la main et CE QUI MANQUE pour passer à « A créer dans Praxedo »).
// ---------------------------------------------------------------------------
function texteTransfertSav(entree) {
  var e = entree || {};
  var etat = e.etat || {};
  var raison = String(e.raison_escalade || "").trim();

  var texte = "TRANSFERT SAV : merci de reprendre la main sur cette conversation.";

  if (cyclesLib.dossierComplet(etat)) {
    texte += "\n\n— RÉCAPITULATIF DE LA QUALIFICATION —";
    if (etat.enseigne) texte += "\nEnseigne : " + etat.enseigne;
    if (etat.nom) texte += "\nDemandeur : " + etat.nom;
    texte += "\nScooter : " + ((etat.plaques || []).length
      ? etat.plaques.map(function (p) { return etatLib.formaterPlaque(p); }).join(", ")
      : "plaque non communiquée (non bloquante)");
    texte += "\nProblème : " + (etat.panne || "—");
    texte += "\nTéléphone à contacter sur place : " + (etat.telephone_contact || "—");
    if (etat.jours_fermeture) texte += "\nJours de fermeture : " + etat.jours_fermeture;
    texte += "\n\nACTION À FAIRE : créer l'intervention dans Praxedo, planifier le créneau avec le client, puis retirer le tag « Prise de main » pour rendre la main à l'agent IA.";
    return texte;
  }

  // Transfert SANS dossier complet : RAISON + manques précis (v2.20.95).
  var m = manquesDossier(etat);
  var raisonFinale = raison || "qualification incomplète au moment du transfert";
  texte += "\n\nRAISON DU TRANSFERT : " + raisonFinale + ".";
  if (m.bloquants.length || m.nonBloquants.length) {
    var manques = m.bloquants.concat(m.nonBloquants);
    texte += "\nIL MANQUE PRÉCISÉMENT : " + manques.join(" ; ") + ".";
    if (m.bloquants.length) {
      texte += "\nPOUR PASSER À « A créer dans Praxedo » : compléter le(s) point(s) bloquant(s) ci-dessus avec le client.";
    }
  } else {
    texte += "\nVérifier le récapitulatif avec le client avant toute création Praxedo.";
  }
  texte += "\nRetirer le tag « Prise de main » après traitement pour rendre la main à l'agent IA.";
  return texte;
}

// ---------------------------------------------------------------------------
// actionsPrevues(entree) — LA liste ordonnée des écritures B4.2.
//
//   entree = {
//     statut : "traite" | "silence" | "repli" | "reset",
//     type   : "cerveau" | "reset" | "plaque",
//     reponse, escalade, raison_escalade,
//     etat        : formulaire final,
//     cycle_prevu : { cycle, raison } | null  (lib/cycles.js),
//     canal       : channelId respond.io (si connu — sinon l'adaptateur
//                  utilisera RESPONDIO_CHANNEL_ID, comme le prod v136)
//   }
//
//   Chaque action porte TOUT ce qu'il faut pour l'exécuter : rien n'est
//   décidé ailleurs. Ordre : envoyer la réponse d'ABORD (le client ne doit
//   jamais attendre), puis le cycle, puis les tags, puis le commentaire.
// ---------------------------------------------------------------------------
function actionsPrevues(entree) {
  var e = entree || {};
  var statut = String(e.statut || "");
  var type = String(e.type || "cerveau");
  var etat = e.etat || {};
  var actions = [];

  // SILENCE (prise de main humaine / pas d'entrant) : rien à faire.
  if (statut === "silence") {
    return actions;
  }

  // RESET / RAZ : réponse canonique + retrait du tag « Prise de main » si
  // l'agent l'avait (l'ancien système retire TOUJOURS le tag au RESET).
  if (type === "reset" || statut === "reset") {
    actions.push({ action: "envoyer_message", texte: String(e.reponse || ""), canal: e.canal || null });
    if (etat.prise_de_main) {
      actions.push({ action: "retirer_tag", tag: TAG_PRISE_DE_MAIN });
    }
    return actions;
  }

  // Rejet plaque hors parc (garde cas A) : réponse canonique, cycle
  // inchangé (la plaque n'est pas bloquante, la qualification poursuit),
  // aucun tag.
  if (type === "plaque") {
    actions.push({ action: "envoyer_message", texte: String(e.reponse || ""), canal: e.canal || null });
    return actions;
  }

  // Réponse (cerveau ou repli neutre) : ENVOI d'abord.
  actions.push({ action: "envoyer_message", texte: String(e.reponse || ""), canal: e.canal || null });

  // Cycle §5 (mapping déterministe lib/cycles.js).
  var cp = e.cycle_prevu || {};
  if (cp.cycle) {
    actions.push({ action: "poser_cycle", cycle: String(cp.cycle), raison: String(cp.raison || "") });
  }

  // Transfert (escalade) : tag + commentaire interne.
  if (e.escalade) {
    if (etat.demande_commerciale) {
      actions.push({ action: "ajouter_tag", tag: TAG_COMMERCIAL });
      actions.push({
        action: "commentaire",
        texte: "DEMANDE COMMERCIALE : merci de reprendre la main sur cette conversation." +
          "\n\nRAISON DU TRANSFERT : demande commerciale (prix, offre, achat, location) — bascule vers l'équipe commerciale." +
          (String(e.raison_escalade || "").trim() ? "\nPrécision : " + String(e.raison_escalade).trim() : "") +
          "\nRetirer le tag « Prise de main » après traitement pour rendre la main à l'agent IA."
      });
    } else {
      actions.push({ action: "ajouter_tag", tag: TAG_PRISE_DE_MAIN });
      actions.push({
        action: "commentaire",
        texte: texteTransfertSav({ etat: etat, raison_escalade: e.raison_escalade })
      });
    }
  }

  return actions;
}

// ---------------------------------------------------------------------------
// executerActions(actions, io) — exécute les actions via un adaptateur
// INJECTÉ io = { envoyerMessage, poserCycle, ajouterTag, retirerTag,
// ecrireCommentaire } (async). Retourne le compte-rendu d'exécution :
// [{action, ok, erreur}]. Une action qui échoue N'INTERROMP JAMAIS les
// suivantes (une demande ne doit jamais être perdue — même contrat que le
// prod v2.20.18 : commentaire et tag posés malgré l'assignation en échec).
// Pure orchestration : testable avec un io factice, zéro réseau ici.
// ---------------------------------------------------------------------------
async function executerActions(actions, io) {
  var comptes = [];
  var liste = actions || [];
  for (var i = 0; i < liste.length; i++) {
    var a = liste[i] || {};
    var c = { action: a.action, ok: false, erreur: "" };
    try {
      if (a.action === "envoyer_message") {
        await io.envoyerMessage(a.texte, a.canal);
      } else if (a.action === "poser_cycle") {
        await io.poserCycle(a.cycle);
      } else if (a.action === "ajouter_tag") {
        await io.ajouterTag(a.tag);
      } else if (a.action === "retirer_tag") {
        await io.retirerTag(a.tag);
      } else if (a.action === "commentaire") {
        await io.ecrireCommentaire(a.texte);
      }
      c.ok = true;
    } catch (err) {
      c.ok = false;
      c.erreur = String((err && err.message) || err).substring(0, 200);
    }
    comptes.push(c);
  }
  return comptes;
}

module.exports = {
  TAG_PRISE_DE_MAIN: TAG_PRISE_DE_MAIN,
  TAG_COMMERCIAL: TAG_COMMERCIAL,
  manquesDossier: manquesDossier,
  corpsMessage: corpsMessage,
  corpsCycle: corpsCycle,
  corpsTag: corpsTag,
  texteTransfertSav: texteTransfertSav,
  actionsPrevues: actionsPrevues,
  executerActions: executerActions
};

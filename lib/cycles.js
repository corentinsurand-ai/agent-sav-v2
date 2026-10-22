// ============================================================================
// Agent SAV U'mob v2 — B5.4.2 : le mapping ÉTAT → CYCLE respond.io (Node PUR)
//
// RÔLE (cahier des charges §5, table VALIDÉE + architecture v1.1) : déterminer
// LE cycle de vie respond.io que le mode ACTIF (B4.2) poserait pour ce
// message — en CODE DÉTERMINISTE, jamais par le LLM (« le LLM ne décide que
// de l'étape, les cycles sont posés par l'adaptateur »). C'est ce module qui
// rend les cycles VISIBLES : console de test (affichage à chaque échange) et
// écran B5 (journal detail.cycle_prevu), avant même que B4.2 n'exécute quoi
// que ce soit.
//
//   Table §5 (noms EXACTS respond.io — cycles-respondio.md fait foi) :
//   - Nouvelle Demande            : accueil / nouvelle demande (DÉFAUT — rien
//                                   à poser, le cycle est déjà là)
//   - DE Commerciales             : demande commerciale → bascule commerciale
//   - Bloquée Impayé              : client marqué « Impayé »
//   - A qualifier                 : qualification incomplète, ou transfert
//                                   humain SANS dossier complet
//   - Attente client              : aucun message du client depuis 2 h
//                                   (vérification horaire — PAS posé au tour
//                                   même, posé par le scan 2 h en prod)
//   - Attente Paiement ou pré-auto CB : client « A risque » / « Mauvais payeur »
//   - A créer dans Praxedo        : transfert SAV AVEC dossier complet
//                                   (récapitulatif validé par le client)
//   - En cours de réalisation     : Praxedo (B6+) — jamais posé ici
//   - Traitée                     : clôture Praxedo (B6+) — jamais posé ici
//
// ZÉRO réseau, zéro dépendance : testable à 100 %.
// ============================================================================

var CYCLES = {
  NOUVELLE: 'Nouvelle Demande',
  COMMERCIAL: 'DE Commerciales',
  IMPAYE: 'Bloquée Impayé',
  A_QUALIFIER: 'A qualifier',
  ATTENTE_CLIENT: 'Attente client',
  PAIEMENT: 'Attente Paiement ou pré-auto CB',
  INTER: 'A créer dans Praxedo',
  EN_COURS: 'En cours de réalisation',
  TRAITEE: 'Traitée'
};

// Dossier COMPLET (cahier des charges étapes 3-5 + règle 6) : la qualification
// est menée à son terme et le récapitulatif a été VALIDÉ par le client
// (étape ≥ 5). Seul le TÉLÉPHONE À CONTACTER bloque le transfert (règle 6) ;
// la plaque n'est PAS bloquante (l'équipe la retrouve) mais la panne doit
// être décrite. NB : la validation du récapitulatif est franchie par
// l'étape ≥ 5 maintenue par le cerveau via le formulaire.
function dossierComplet(etat) {
  var e = etat || {};
  return !!e.telephone_contact && !!e.panne && (Number(e.etape) || 1) >= 5;
}

// ----------------------------------------------------------------------------
// cyclePrevu(entree) → { cycle: <nom EXACT|null>, raison: "…" }
//
//   entree = {
//     statut : "traite" | "silence" | "repli" | "reset",
//     type   : "cerveau" | "reset" | "plaque" (type d'observation),
//     escalade, etat (formulaire final), reponse (texte de la réponse)
//   }
//
//   cycle = null → AUCUN cycle à poser (cycle inchangé).
//   CASSE EXACTE garantie : les noms viennent de CYCLES, jamais construits.
// ----------------------------------------------------------------------------
function cyclePrevu(entree) {
  var e = entree || {};
  var statut = String(e.statut || '');
  var type = String(e.type || 'cerveau');
  var etat = e.etat || {};
  var reponse = String(e.reponse || '');

  // RESET : mémoire purgée + retrait du tag — le cycle est inchangé (le
  // prochain message du client repartira sur « Nouvelle Demande » par défaut).
  if (statut === 'reset' || type === 'reset') {
    return { cycle: null, raison: 'cycle inchangé — au retour du client, « Nouvelle Demande » par défaut' };
  }

  // Silence (prise de main / pas d'entrant) : un humain a la main, le cycle
  // est géré par l'équipe — rien à poser.
  if (statut === 'silence') {
    return { cycle: null, raison: 'cycle inchangé — un humain a la main' };
  }

  // Rejet plaque hors parc (garde cas A étape 1) : la plaque n'est PAS
  // bloquante (règle 6) — la qualification poursuit, aucun cycle à poser.
  if (type === 'plaque') {
    return { cycle: null, raison: 'cycle inchangé — la plaque n\'est pas bloquante, la qualification poursuit' };
  }

  // TRANSFERT (escalade) : le cycle dépend de la NATURE du transfert.
  if (e.escalade) {
    // 1) Demande commerciale (étape 0 de l'ancien : la bascule commerciale
    //    prime sur tout — jamais de qualification SAV, jamais de plaque).
    if (etat.demande_commerciale) {
      return { cycle: CYCLES.COMMERCIAL, raison: 'demande commerciale → bascule vers l\'équipe commerciale' };
    }
    // 2) Dossier à risque (blocage AVANT traitement — réponse neutre +
    //    transfert automatique, jamais d'engagement) : le cycle désigne le
    //    MOTIF de blocage, pas « A qualifier ».
    var risque = String(etat.statut_risque || '').toLowerCase();
    if (risque.indexOf('impay') !== -1) {
      return { cycle: CYCLES.IMPAYE, raison: 'client marqué « Impayé » dans son dossier — transfert automatique' };
    }
    if (risque.indexOf('risque') !== -1 || risque.indexOf('mauvais payeur') !== -1 || risque.indexOf('payeur') !== -1) {
      return { cycle: CYCLES.PAIEMENT, raison: 'client « A risque » / « Mauvais payeur » — paiement attendu avant Praxedo' };
    }
    // 3) Transfert SAV : dossier complet → l'intervention est à créer ;
    //    incomplet → un humain reprend et qualifie.
    if (dossierComplet(etat)) {
      return { cycle: CYCLES.INTER, raison: 'transfert SAV avec dossier complet (récapitulatif validé par le client)' };
    }
    return { cycle: CYCLES.A_QUALIFIER, raison: 'qualification incomplète — un humain reprend le dossier' };
  }

  // Conversation EN COURS : la réponse pose une question au client → en prod,
  // le scan horaire posera « Attente client » si le client ne répond pas
  // pendant 2 h (vérification horaire de l'ancien système, portée telle quelle).
  if (statut === 'traite' && reponse.indexOf('?') !== -1) {
    return { cycle: CYCLES.ATTENTE_CLIENT, raison: 'question posée au client — « Attente client » sera posé après 2 h sans réponse (vérification horaire)' };
  }

  // Réponse d'information sans question : la conversation poursuit, cycle
  // inchangé.
  return { cycle: null, raison: 'cycle inchangé — l\'agent IA poursuit la conversation' };
}

module.exports = {
  CYCLES: CYCLES,
  cyclePrevu: cyclePrevu,
  dossierComplet: dossierComplet
};

// ============================================================================
// Agent SAV U'mob v2 — B6.3 : le suivi Praxedo (Node PUR)
//
// RÔLE (portage v2.20.63-117 de l'ancien système) : après l'armement d'une
// intervention dans Praxedo, l'agent SUIT la réalisation et fait tourner le
// dossier — en DÉTERMINISTE, jamais par le LLM :
//
//   - statutRealisee(ev) : un événement/vérification Praxedo dit-il
//     « réalisée » ? (codes DONE/REALIZED/REALISE/COMPLETED/VALIDATED/
//     CLOSED, sinon texte réalis/done/completed/terminé — v2.20.70).
//   - verifierReference({code, statutHttp, corps}) : UNE vérification de
//     référence, 3 états — 'trouvee' | 'introuvable' | 'erreur'. Une ERREUR
//     (HTTP ≥ 400, JSON invalide) n'est JAMAIS une référence introuvable
//     (v2.20.103) : on ne purge pas un dossier sur un Praxedo indisponible.
//     Le matching est BIDIRECTIONNEL (la ref cherchée == la ref de
//     l'intervention, casse indifférente, ou l'une contient l'autre).
//   - scanSuivis(maintenant, contacts) : le passage horaire sur les dossiers
//     avec interventions suivies — THROTTLE 2 h par contact (ts_check).
//     TOUTES les refs réalisées → dossier à PURGER + cycle « Traitée » +
//     retrait du suivi + fermeture de la conversation (v2.20.66). Les
//     statuts sont FOURNIS par l'appelant (le middleware Praxedo existe déjà
//     indépendamment — docs praxedo-api.md) : ce module reste SANS réseau.
//   - retirerTagDecision(maintenant, tsPose, cycleActuel, conversationFermee) :
//     retrait du tag « Prise de main » ≥ 2 h après sa pose, UNIQUEMENT sur
//     ÉTAT OBSERVÉ (cycle contenant « trait » peu importe l'auteur OU
//     conversation fermée — v2.20.117).
//   - decisionArmement({cycleActuel, references}) : une référence d'
//     intervention citée par un collègue (consigne @Agent IA) ARME le
//     dossier : cycle « En cours de réalisation » (v2.20.63), jamais posé
//     avant (parité : le mode observation ne touche jamais les cycles).
//
// ZÉRO réseau : décisions pures, temps injecté. L'exécution (appel Praxedo,
// posage respond.io) est branchée en B4.2 derrière le feu vert de Corentin.
// ============================================================================

var CYCLE_INTER = "A créer dans Praxedo";
var CYCLE_EN_COURS = "En cours de réalisation";
var CYCLE_TRAITEE = "Traitée";

var CODES_REALISE = { DONE: 1, REALIZED: 1, REALISE: 1, COMPLETED: 1, VALIDATED: 1, CLOSED: 1 };
var THROTTLE_SCAN_MS = 2 * 60 * 60 * 1000; // 2 h (v2.20.90)
var SEUIL_RETRAIT_TAG_MS = 2 * 60 * 60 * 1000; // 2 h (v2.20.117)

// Un statut Praxedo (code ou texte) dit-il « réalisée » ? (v2.20.70)
// Tolérant : événement objet (status/statut/etat/state) OU chaîne brute.
function statutRealisee(ev) {
  if (typeof ev === "string") return /R[ÉE]ALIS|DONE|COMPLETED|TERMIN/i.test(ev) ||
    CODES_REALISE[ev.toUpperCase().trim()] === true ? true : false;
  var e = ev || {};
  var brut = String(e.status || e.statut || e.etat || e.state || "");
  var code = brut.toUpperCase().trim();
  if (code && CODES_REALISE[code]) return true;
  return /R[ÉE]ALIS|DONE|COMPLETED|TERMIN/i.test(brut);
}

// ----------------------------------------------------------------------------
// verifierReference({ code, statutHttp, corps }) → 'trouvee' | 'introuvable' |
// 'erreur' — UNE vérification, PURE (le middleware existe déjà ; le retry
// réseau 500 ms vit dans l'adaptateur, pas ici).
//   - statutHttp ≥ 400 OU corps JSON invalide → 'erreur' (≠ introuvable !)
//   - found === false explicite → 'introuvable'
//   - liste = interventions | resultats | data | intervention unique
//   - matching BIDIRECTIONNEL : la ref cherchée et celle de l'intervention
//     s'équivalent (casse indifférente, ou l'une contient l'autre, ref ≥ 4)
// ----------------------------------------------------------------------------
function verifierReference(entree) {
  var e = entree || {};
  var statut = Number(e.statutHttp) || 0;
  var corps = String(e.corps || "");
  if (statut === 0 || statut >= 400) return "erreur";
  var d;
  try {
    d = JSON.parse(corps);
  } catch (err) {
    return "erreur";
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) return "erreur";
  if (d.found === false) return "introuvable";

  var liste = Array.isArray(d.interventions) ? d.interventions
    : Array.isArray(d.resultats) ? d.resultats
    : Array.isArray(d.data) ? d.data
    : (d.intervention && typeof d.intervention === "object") ? [d.intervention]
    : [];

  var cherchee = String(e.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cherchee) return "erreur";

  for (var i = 0; i < liste.length; i++) {
    var it = liste[i] || {};
    var cands = [it.reference, it.ref, it.code, it.numero, it.num_intervention, it.id];
    for (var j = 0; j < cands.length; j++) {
      var v = String(cands[j] || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!v || v.length < 4) continue;
      if (v === cherchee || v.indexOf(cherchee) !== -1 || cherchee.indexOf(v) !== -1) {
        return "trouvee";
      }
    }
  }
  return "introuvable";
}

// ----------------------------------------------------------------------------
// scanSuivis(maintenant, contacts) → les décisions du passage horaire.
//   maintenant : epoch ms (injecté)
//   contacts : [{
//     contactId, suiviRefs: ["EVE12345", …] (refs suivies, [] = rien à suivre),
//     tsCheck (epoch ms du dernier passage — 0 si jamais),
//     statuts: { REF: <événement brut Praxedo OU chaîne de statut> }
//   }]
//   retour, PAR CONTACT (dans l'ordre d'entrée) :
//   { contactId, a_traiter, toutes_realisees, restantes, statuts_vus, purger,
//     cycle, raison }
//     - a_traiter : throttle 2 h passé (sinon le contact est épargné)
//     - toutes_realisees : suiviRefs non vide ET chaque ref réalisée
//     - purger (= toutes_realisees) : dossier à purger + mémoire coupée +
//       retrait du suivi + fermeture de la conversation (v2.20.66) ; le
//       cycle à poser est « Traitée ».
//     - une ref sans statut connu = NON réalisée (jamais purgée par défaut)
// ----------------------------------------------------------------------------
function scanSuivis(maintenant, contacts) {
  var sortie = [];
  var liste = contacts || [];
  var maintenant = Number(maintenant) || 0;

  for (var i = 0; i < liste.length; i++) {
    var c = liste[i] || {};
    var refs = c.suiviRefs || [];
    var statuts = c.statuts || {};
    var tsCheck = Number(c.tsCheck) || 0;

    var aTraiter = maintenant - tsCheck >= THROTTLE_SCAN_MS;
    var restantes = [];
    var statutsVus = {};
    var toutes = refs.length > 0;

    for (var r = 0; r < refs.length; r++) {
      var ref = String(refs[r]);
      var ev = statuts[ref];
      var evBrut = (typeof ev === "string") ? { status: ev } : (ev || {});
      var ok = statutRealisee(evBrut);
      statutsVus[ref] = ok;
      if (!ok) {
        toutes = false;
        restantes.push(ref);
      }
    }

    var purger = aTraiter && toutes;
    sortie.push({
      contactId: c.contactId,
      a_traiter: aTraiter,
      toutes_realisees: toutes,
      restantes: restantes,
      statuts_vus: statutsVus,
      purger: purger,
      cycle: purger ? CYCLE_TRAITEE : null,
      raison: purger
        ? "toutes les interventions suivies sont réalisées — dossier terminé : cycle « Traitée », mémoire coupée, suivi retiré, conversation fermée"
        : (!aTraiter
          ? "throttle 2 h : déjà vérifié récemment"
          : (refs.length
            ? "encore " + restantes.length + " intervention(s) en cours : " + restantes.join(", ")
            : "aucune intervention suivie"))
    });
  }
  return sortie;
}

// ----------------------------------------------------------------------------
// retirerTagDecision(maintenant, tsPose, cycleActuel, conversationFermee) →
// { retirer, raison } — retrait du tag « Prise de main » UNIQUEMENT si
// ≥ 2 h depuis sa pose ET état OBSERVÉ (cycle contenant « trait », peu
// importe qui l'a posé, OU conversation fermée — v2.20.117). Un dossier en
// cours ne perd JAMAIS sa prise de main sur un simple minutage.
// ----------------------------------------------------------------------------
function retirerTagDecision(maintenant, tsPose, cycleActuel, conversationFermee) {
  var age = (Number(maintenant) || 0) - (Number(tsPose) || 0);
  var etatObserve = /trait/i.test(String(cycleActuel || "")) || conversationFermee === true;
  var retirer = etatObserve && age >= SEUIL_RETRAIT_TAG_MS;
  return {
    retirer: retirer,
    raison: retirer
      ? "tag « Prise de main » retiré : ≥ 2 h et état observé (terminé ou fermé)"
      : (!etatObserve
        ? "tag conservé : le dossier n'est pas terminé"
        : "tag conservé : moins de 2 h depuis la pose")
  };
}

// ----------------------------------------------------------------------------
// decisionArmement({ cycleActuel, references }) → { action, cycle, raison } |
// null — une référence d'intervention citée par un collègue (consigne
// @Agent IA « arme l'intervention EVE… ») fait passer le dossier en
// « En cours de réalisation » (v2.20.63). Sans référence citée, ou cycle
// déjà plus avancé (En cours / Traitée), AUCUNE décision : le mode
// observation ne touche jamais les cycles.
// ----------------------------------------------------------------------------
function decisionArmement(entree) {
  var e = entree || {};
  var refs = (e.references || []).filter(Boolean);
  if (!refs.length) return null;
  var cycle = String(e.cycleActuel || "");
  if (cycle === CYCLE_EN_COURS || cycle === CYCLE_TRAITEE) return null;
  return {
    action: "poser_cycle",
    cycle: CYCLE_EN_COURS,
    references: refs.slice(),
    raison: "intervention armée dans Praxedo : " + refs.join(", ") + " — cycle « En cours de réalisation »"
  };
}

module.exports = {
  CYCLE_INTER: CYCLE_INTER,
  CYCLE_EN_COURS: CYCLE_EN_COURS,
  CYCLE_TRAITEE: CYCLE_TRAITEE,
  THROTTLE_SCAN_MS: THROTTLE_SCAN_MS,
  SEUIL_RETRAIT_TAG_MS: SEUIL_RETRAIT_TAG_MS,
  statutRealisee: statutRealisee,
  verifierReference: verifierReference,
  scanSuivis: scanSuivis,
  retirerTagDecision: retirerTagDecision,
  decisionArmement: decisionArmement
};

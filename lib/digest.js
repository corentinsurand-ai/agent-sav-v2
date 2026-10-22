// ============================================================================
// Agent SAV U'mob v2 — B6.3 : le digest « prise de main » (Node PUR)
//
// RÔLE (portage v2.20.83 de l'ancien système) : quand un humain prend la
// main sur un dossier (tag « Prise de main »), l'équipe doit en être
// INFORMÉE — sans noyer la boîte mail : les prises de main sont
// CONSOLIDÉES en UN digest.
//
//   - RÈGLE IMMÉDIATE : à la POSE d'une prise de main, le digest part tout
//     de suite… SAUF si le dernier digest date de moins de 15 MIN → il est
//     DIFFÉRÉ au scan horaire (JAMAIS perdu — v2.20.83).
//   - SCAN HORAIRE : le scan n'envoie QUE si le dernier digest date de
//     ≥ 45 MIN (jamais deux digests rapprochés).
//   - FENÊTRE : 9h-18h (en dehors : différé au prochain passage en fenêtre).
//   - corpsDigest(prises) : le corps consolidé — chaque prise de main sur
//     une ligne (contact, nom, raison).
//
// ZÉRO réseau : l'envoi email réel est branché en B4.2 derrière le feu vert
// de Corentin ; ici, tout est DÉCISION pure, temps injecté.
// ============================================================================

var FENETRE_DEBUT = 9;   // 9h
var FENETRE_FIN = 18;    // 18h
var DELAI_POSER_DIGEST_MS = 15 * 60 * 1000;  // 15 min entre digests (pose)
var DELAI_SCAN_DIGEST_MS = 45 * 60 * 1000;  // 45 min (scan horaire)

// Heure locale dans la fenêtre d'envoi ? (9h-18h — v2.20.83)
function dansFenetre(heure) {
  var h = Number(heure);
  if (isNaN(h)) return false;
  return h >= FENETRE_DEBUT && h < FENETRE_FIN;
}

// ----------------------------------------------------------------------------
// digestNecessaire(entree) → { necessaire, differe, raison }
//   entree = {
//     maintenant      : epoch ms (injecté),
//     dernier_digest_ts : epoch ms du dernier digest envoyé (0/null = jamais),
//     trigger         : "pose" (à la pose d'une prise de main — immédiat)
//                       | "scan" (le passage horaire),
//     heure           : heure locale (0-23) — fournie par l'appelant
//   }
//   NB : une prise de main différée n'est JAMAIS perdue : elle repasse au
//   prochain scan horaire tant que la liste des prises non consolidées
//   n'est pas vide (l'appelant garde la liste).
// ----------------------------------------------------------------------------
function digestNecessaire(entree) {
  var e = entree || {};
  var maintenant = Number(e.maintenant) || 0;
  var dernier = Number(e.dernier_digest_ts) || 0;
  var trigger = e.trigger === "scan" ? "scan" : "pose";
  var enFenetre = e.heure === undefined || e.heure === null ? true : dansFenetre(e.heure);

  if (!enFenetre) {
    return {
      necessaire: false,
      differe: true,
      raison: "hors fenêtre 9h-18h — différé au prochain passage en fenêtre (jamais perdu)"
    };
  }

  if (trigger === "pose") {
    if (dernier && maintenant - dernier < DELAI_POSER_DIGEST_MS) {
      return {
        necessaire: false,
        differe: true,
        raison: "dernier digest < 15 min — différé au scan horaire (jamais perdu)"
      };
    }
    return { necessaire: true, differe: false, raison: "prise de main posée — digest immédiat" };
  }

  // scan horaire
  if (!dernier || maintenant - dernier >= DELAI_SCAN_DIGEST_MS) {
    return { necessaire: true, differe: false, raison: "scan horaire — ≥ 45 min depuis le dernier digest" };
  }
  return { necessaire: false, differe: false, raison: "dernier digest < 45 min — rien à envoyer" };
}

// ----------------------------------------------------------------------------
// corpsDigest(prises) — le corps consolidé du digest.
//   prises = [{ contactId, nom, raison, ts }] (prises de main non consolidées)
// ----------------------------------------------------------------------------
function corpsDigest(prises) {
  var liste = (prises || []).filter(function (p) { return p && p.contactId; });
  var corps = "PRISES DE MAIN — " + liste.length + " dossier(s) repris par l'équipe :\n";
  for (var i = 0; i < liste.length; i++) {
    var p = liste[i];
    corps += "- " + String(p.nom || "Contact") + " (contact " + p.contactId + ")" +
      (p.raison ? " : " + String(p.raison) : "") + "\n";
  }
  return corps;
}

module.exports = {
  FENETRE_DEBUT: FENETRE_DEBUT,
  FENETRE_FIN: FENETRE_FIN,
  DELAI_POSER_DIGEST_MS: DELAI_POSER_DIGEST_MS,
  DELAI_SCAN_DIGEST_MS: DELAI_SCAN_DIGEST_MS,
  dansFenetre: dansFenetre,
  digestNecessaire: digestNecessaire,
  corpsDigest: corpsDigest
};

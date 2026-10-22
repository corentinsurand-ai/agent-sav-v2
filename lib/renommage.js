// ============================================================================
// Agent SAV U'mob v2 — B6.3 : le renommage des contacts (Node PUR)
//
// RÔLE (portage v2.19.8 de l'ancien système) : renommer la fiche respond.io
// en « Nom du contact (Société - Ville) » quand la ligne client est
// IDENTIFIÉE — pour que l'équipe voie l'enseigne dans la file sans ouvrir
// la fiche. Deux gardes historiques :
//   - JAMAIS renommer un nom DÉJÀ renommé (contient « ( » suivi de la
//     société) — un renommage sur un renommage écraserait le nom du contact ;
//   - DÉSACTIVÉ en v2.20 (« les contacts sont importés au bon format ») :
//     la décision est OFF par défaut (parité v2.20.136) — elle ne s'activera
//     que par config explicite de Corentin.
//
// ZÉRO réseau : le renommage réel (PATCH respond.io) est branché en B4.2
// derrière le feu vert ; ici, DÉCISION pure.
// ============================================================================

// Un nom contient-il déjà un suffixe « (…) » de renommage ? (v2.19.8)
function dejaRenomme(nom) {
  return /\s\(/.test(String(nom || ""));
}

// Le nom proposé : « Nom du contact (Société - Ville) » — enseigne seule si
// la ville manque, rien si la fiche client est incomplète.
function nomPropose(nom, client) {
  var c = client || {};
  var parties = [];
  if (c.enseigne) parties.push(String(c.enseigne));
  if (c.ville) parties.push(String(c.ville));
  if (!parties.length) return String(nom || "");
  return String(nom || "").trim() + " (" + parties.join(" - ") + ")";
}

// ----------------------------------------------------------------------------
// decisionRenommage(entree) → { renommer, nouveau_nom, raison }
//   entree = { actif (DÉFAUT FALSE — parité v2.20.136), nom, client }
// ----------------------------------------------------------------------------
function decisionRenommage(entree) {
  var e = entree || {};
  var nom = String(e.nom || "").trim();

  if (e.actif !== true) {
    return {
      renommer: false,
      nouveau_nom: "",
      raison: "renommage désactivé (parité v2.20.136 — contacts importés au bon format)"
    };
  }
  if (!nom) return { renommer: false, nouveau_nom: "", raison: "contact sans nom" };
  if (dejaRenomme(nom)) {
    return { renommer: false, nouveau_nom: "", raison: "contact déjà renommé — jamais deux fois" };
  }
  var propose = nomPropose(nom, e.client);
  if (!propose || propose === nom) {
    return { renommer: false, nouveau_nom: "", raison: "fiche client incomplète (enseigne/ville manquante)" };
  }
  return { renommer: true, nouveau_nom: propose, raison: "fiche identifiée — nom enrichi Société - Ville" };
}

module.exports = {
  dejaRenomme: dejaRenomme,
  nomPropose: nomPropose,
  decisionRenommage: decisionRenommage
};

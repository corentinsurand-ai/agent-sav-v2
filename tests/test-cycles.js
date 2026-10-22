// ============================================================================
// Agent SAV U'mob v2 — tests B5.4.2 : lib/cycles.js (le mapping §5 état → cycle)
//
// Node PUR, zéro réseau : cyclePrevu doit être DÉTERMINISTE, à la CASSE
// EXACTE respond.io (cycles-respondio.md fait foi), et ne JAMAIS inventer
// « En cours de réalisation » / « Traitée » (Praxedo B6+, hors périmètre).
// ============================================================================

var test = require("node:test");
var assert = require("node:assert");

var cycles = require("../lib/cycles.js");
var CYCLES = cycles.CYCLES;
var cyclePrevu = cycles.cyclePrevu;
var dossierComplet = cycles.dossierComplet;

// ---------------------------------------------------------------------------
// CASSE EXACTE — les noms respond.io, jamais construits autrement
// ---------------------------------------------------------------------------
test("CYCLES : les 9 noms EXACTS respond.io (casse identique à cycles-respondio.md)", function () {
  assert.strictEqual(CYCLES.NOUVELLE, "Nouvelle Demande");
  assert.strictEqual(CYCLES.COMMERCIAL, "DE Commerciales");
  assert.strictEqual(CYCLES.IMPAYE, "Bloquée Impayé");
  assert.strictEqual(CYCLES.A_QUALIFIER, "A qualifier");
  assert.strictEqual(CYCLES.ATTENTE_CLIENT, "Attente client");
  assert.strictEqual(CYCLES.PAIEMENT, "Attente Paiement ou pré-auto CB");
  assert.strictEqual(CYCLES.INTER, "A créer dans Praxedo");
  assert.strictEqual(CYCLES.EN_COURS, "En cours de réalisation");
  assert.strictEqual(CYCLES.TRAITEE, "Traitée");
});

test("jamais posé par cyclePrevu : « En cours de réalisation » ni « Traitée » (Praxedo B6+)", function () {
  var cas = [
    { statut: "traite", type: "cerveau", escalade: true, etat: dossierPlein(), reponse: "ok" },
    { statut: "traite", type: "cerveau", escalade: false, etat: {}, reponse: "voici l'info" },
    { statut: "traite", type: "cerveau", escalade: true, etat: {}, reponse: "?" }
  ];
  for (var i = 0; i < cas.length; i++) {
    var r = cyclePrevu(cas[i]);
    assert.ok(r.cycle !== CYCLES.EN_COURS && r.cycle !== CYCLES.TRAITEE, JSON.stringify(cas[i]));
  }
});

// ---------------------------------------------------------------------------
// dossierComplet — règle 6 : la plaque n'est PAS bloquante, le téléphone OUI
// ---------------------------------------------------------------------------
function dossierPlein() {
  return { telephone_contact: "0612345678", panne: "la batterie ne charge plus", etape: 5 };
}

test("dossierComplet : téléphone + panne + étape ≥ 5 → vrai (SANS plaque — règle 6)", function () {
  assert.strictEqual(dossierComplet(dossierPlein()), true);
});

test("dossierComplet sans plaque : la plaque n'est PAS bloquante (règle 6)", function () {
  var e = dossierPlein();
  e.plaques = [];
  assert.strictEqual(dossierComplet(e), true);
});

test("dossierComplet : sans téléphone → faux (seul bloquant, règle 6)", function () {
  var e = dossierPlein();
  e.telephone_contact = "";
  assert.strictEqual(dossierComplet(e), false);
});

test("dossierComplet : sans panne → faux", function () {
  var e = dossierPlein();
  e.panne = "";
  assert.strictEqual(dossierComplet(e), false);
});

test("dossierComplet : étape 4 (récapitulatif pas encore validé) → faux", function () {
  var e = dossierPlein();
  e.etape = 4;
  assert.strictEqual(dossierComplet(e), false);
});

// ---------------------------------------------------------------------------
// cyclePrevu — transferts (escalade)
// ---------------------------------------------------------------------------
test("escalade + dossier complet → « A créer dans Praxedo »", function () {
  var r = cyclePrevu({ statut: "traite", type: "cerveau", escalade: true, raison_escalade: "transfert", etat: dossierPlein(), reponse: "récapitulatif validé" });
  assert.strictEqual(r.cycle, "A créer dans Praxedo");
});

test("escalade sans téléphone (dossier incomplet) → « A qualifier »", function () {
  var r = cyclePrevu({ statut: "traite", type: "cerveau", escalade: true, raison_escalade: "transfert", etat: { panne: "crevaison", etape: 5 }, reponse: "…" });
  assert.strictEqual(r.cycle, "A qualifier");
});

test("escalade étape < 5 → « A qualifier » (qualification incomplète)", function () {
  var r = cyclePrevu({ statut: "traite", type: "cerveau", escalade: true, raison_escalade: "transfert", etat: { telephone_contact: "0612345678", panne: "freins", etape: 3 }, reponse: "…" });
  assert.strictEqual(r.cycle, "A qualifier");
});

test("escalade + demande commerciale → « DE Commerciales » (prime sur tout)", function () {
  var r = cyclePrevu({ statut: "traite", type: "cerveau", escalade: true, raison_escalade: "commercial", etat: { demande_commerciale: true, telephone_contact: "0612345678", panne: "x", etape: 5 }, reponse: "…" });
  assert.strictEqual(r.cycle, "DE Commerciales");
});

test("escalade + statut_risque « Impayé » → « Bloquée Impayé »", function () {
  var r = cyclePrevu({ statut: "traite", type: "cerveau", escalade: true, raison_escalade: "risque", etat: { statut_risque: "Impayé", telephone_contact: "0612345678", panne: "x", etape: 5 }, reponse: "…" });
  assert.strictEqual(r.cycle, "Bloquée Impayé");
});

test("escalade + « Mauvais payeur » → « Attente Paiement ou pré-auto CB »", function () {
  var r = cyclePrevu({ statut: "traite", type: "cerveau", escalade: true, raison_escalade: "risque", etat: { statut_risque: "Mauvais payeur", telephone_contact: "0612345678", panne: "x", etape: 5 }, reponse: "…" });
  assert.strictEqual(r.cycle, "Attente Paiement ou pré-auto CB");
});

test("priorité : commerciale > impayé (la bascule commerciale prime)", function () {
  var r = cyclePrevu({ statut: "traite", type: "cerveau", escalade: true, raison_escalade: "x", etat: { demande_commerciale: true, statut_risque: "Impayé" }, reponse: "" });
  assert.strictEqual(r.cycle, "DE Commerciales");
});

// ---------------------------------------------------------------------------
// cyclePrevu — conversation en cours, reset, plaque, silence
// ---------------------------------------------------------------------------
test("traite sans escalade + réponse avec « ? » → « Attente client » (posé après 2 h, vérification horaire)", function () {
  var r = cyclePrevu({ statut: "traite", type: "cerveau", escalade: false, etat: {}, reponse: "Pouvez-vous préciser le modèle de votre scooter ?" });
  assert.strictEqual(r.cycle, "Attente client");
  assert.ok(r.raison.indexOf("2 h") !== -1, "la raison doit mentionner la vérification horaire 2 h");
});

test("traite sans escalade + réponse SANS question → cycle inchangé (null)", function () {
  var r = cyclePrevu({ statut: "traite", type: "cerveau", escalade: false, etat: {}, reponse: "C'est noté, je transmets l'information." });
  assert.strictEqual(r.cycle, null);
});

test("RESET → cycle inchangé (null) — pas de « Nouvelle Demande » inventé", function () {
  var r = cyclePrevu({ statut: "reset", type: "reset", escalade: false, etat: {}, reponse: "Mémoire réinitialisée" });
  assert.strictEqual(r.cycle, null);
});

test("rejet plaque hors parc (type plaque) → cycle inchangé (null)", function () {
  var r = cyclePrevu({ statut: "traite", type: "plaque", escalade: false, etat: {}, reponse: "Cette plaque ne correspond pas à notre parc. Quelle est la saisie exacte de la plaque ?" });
  assert.strictEqual(r.cycle, null);
});

test("silence (humain a la main) → cycle inchangé (null)", function () {
  var r = cyclePrevu({ statut: "silence", type: "cerveau", escalade: false, etat: {}, reponse: "" });
  assert.strictEqual(r.cycle, null);
});

test("entrée vide → cycle inchangé (null), jamais de crash", function () {
  var r = cyclePrevu(null);
  assert.strictEqual(r.cycle, null);
});

test("chaque résultat porte une RAISON lisible", function () {
  var r = cyclePrevu({ statut: "traite", type: "cerveau", escalade: true, etat: dossierPlein(), reponse: "ok" });
  assert.ok(String(r.raison || "").length > 5);
});

// ============================================================================
// Agent SAV U'mob v2 — B6.3 : tests du SUIVI PRAXEDO (node --test, PUR —
// aucun réseau : les statuts Praxedo sont INJECTÉS, le temps aussi)
// ============================================================================
const { test } = require("node:test");
const assert = require("node:assert");
const praxedo = require("../lib/praxedo.js");

const H = 3600 * 1000;
const T0 = 1780000000000; // référence injectée — jamais Date.now()

// -------------------------------------------------------- STATUT RÉALISÉE ----
test("B6.3 statutRealisee : codes (v2.20.70)", () => {
  assert.strictEqual(praxedo.statutRealisee({ status: "DONE" }), true);
  assert.strictEqual(praxedo.statutRealisee({ status: "REALIZED" }), true);
  assert.strictEqual(praxedo.statutRealisee({ status: "REALISE" }), true);
  assert.strictEqual(praxedo.statutRealisee({ status: "COMPLETED" }), true);
  assert.strictEqual(praxedo.statutRealisee({ status: "VALIDATED" }), true);
  assert.strictEqual(praxedo.statutRealisee({ status: "CLOSED" }), true);
});

test("B6.3 statutRealisee : texte « Intervention réalisée »", () => {
  assert.strictEqual(praxedo.statutRealisee({ status: "Intervention réalisée par le technicien" }), true);
  assert.strictEqual(praxedo.statutRealisee({ status: "terminée sur place" }), true);
});

test("B6.3 statutRealisee : statut en cours / planifié → FALSE", () => {
  assert.strictEqual(praxedo.statutRealisee({ status: "PLANNED" }), false);
  assert.strictEqual(praxedo.statutRealisee({ status: "En cours" }), false);
  assert.strictEqual(praxedo.statutRealisee({}), false);
  assert.strictEqual(praxedo.statutRealisee({ status: "" }), false);
});

test("B6.3 statutRealisee : champs alternatifs (statut/etat/état + chaîne brute)", () => {
  assert.strictEqual(praxedo.statutRealisee({ statut: "DONE" }), true);
  assert.strictEqual(praxedo.statutRealisee({ etat: "REALIZED" }), true);
  assert.strictEqual(praxedo.statutRealisee("completed"), true);
  assert.strictEqual(praxedo.statutRealisee("en route"), false);
});

// ----------------------------------------------------- VÉRIFIER RÉFÉRENCE ----
test("B6.3 verifierReference : liste interventions + ref exacte → TROUVÉE", () => {
  const r = praxedo.verifierReference({
    code: "EVE123456",
    statutHttp: 200,
    corps: JSON.stringify({ interventions: [{ reference: "EVE123456", status: "PLANNED" }] })
  });
  assert.strictEqual(r, "trouvee");
});

test("B6.3 verifierReference : formes alternatives resultats/data/intervention unique", () => {
  assert.strictEqual(praxedo.verifierReference({ code: "4455", statutHttp: 200, corps: JSON.stringify({ resultats: [{ ref: "4455" }] }) }), "trouvee");
  assert.strictEqual(praxedo.verifierReference({ code: "EVE99", statutHttp: 200, corps: JSON.stringify({ data: [{ code: "EVE99" }] }) }), "trouvee");
  assert.strictEqual(praxedo.verifierReference({ code: "EVE88", statutHttp: 200, corps: JSON.stringify({ intervention: { numero: "EVE88" } }) }), "trouvee");
});

test("B6.3 verifierReference : matching BIDIRECTIONNEL (casse + contenance)", () => {
  assert.strictEqual(praxedo.verifierReference({ code: "EVE123456", statutHttp: 200, corps: JSON.stringify({ data: [{ reference: "eve-123456-UMOB" }] }) }), "trouvee");
  assert.strictEqual(praxedo.verifierReference({ code: "INTER-4455-X", statutHttp: 200, corps: JSON.stringify({ data: [{ reference: "4455" }] }) }), "trouvee");
});

test("B6.3 verifierReference : found === false explicite → INTROUVABLE", () => {
  const r = praxedo.verifierReference({ code: "EVE123456", statutHttp: 200, corps: JSON.stringify({ found: false }) });
  assert.strictEqual(r, "introuvable");
});

test("B6.3 verifierReference : liste SANS la ref → INTROUVABLE", () => {
  const r = praxedo.verifierReference({ code: "EVE123456", statutHttp: 200, corps: JSON.stringify({ interventions: [{ reference: "EVE999999" }] }) });
  assert.strictEqual(r, "introuvable");
});

test("B6.3 verifierReference : HTTP ≥ 400 → ERREUR (≠ introuvable — v2.20.103)", () => {
  assert.strictEqual(praxedo.verifierReference({ code: "EVE123456", statutHttp: 500, corps: "oops" }), "erreur");
  assert.strictEqual(praxedo.verifierReference({ code: "EVE123456", statutHttp: 404, corps: "not found" }), "erreur");
});

test("B6.3 verifierReference : JSON invalide → ERREUR, pas introuvable", () => {
  assert.strictEqual(praxedo.verifierReference({ code: "EVE123456", statutHttp: 200, corps: "<html>pipo</html>" }), "erreur");
  assert.strictEqual(praxedo.verifierReference({ code: "EVE123456", statutHttp: 200, corps: "" }), "erreur");
});

test("B6.3 verifierReference : sans code cherché → ERREUR (garde d'entrée)", () => {
  assert.strictEqual(praxedo.verifierReference({ code: "", statutHttp: 200, corps: "{}" }), "erreur");
});

test("B6.3 verifierReference : une ERREUR ne purge JAMAIS un dossier (usage)", () => {
  // v2.20.103 : si Praxedo est indisponible, on ne purge PAS le dossier
  const contact = { contactId: "1", suiviRefs: ["EVE1"], tsCheck: 0, statuts: {} };
  const [d] = praxedo.scanSuivis(T0, [contact]);
  assert.strictEqual(d.purger, false); // ref sans statut connu = non réalisée
  assert.strictEqual(d.restantes.length, 1);
});

// ---------------------------------------------------------- SCAN SUIVIS ----
test("B6.3 scanSuivis : throttle 2 h — déjà vérifié récemment → épargné", () => {
  const contacts = [{ contactId: "1", suiviRefs: ["EVE1"], tsCheck: T0 - 1 * H, statuts: { EVE1: { status: "DONE" } } }];
  const [d] = praxedo.scanSuivis(T0, contacts);
  assert.strictEqual(d.a_traiter, false);
  assert.strictEqual(d.purger, false); // jamais purgé hors du throttle
});

test("B6.3 scanSuivis : ≥ 2 h + TOUTES réalisées → PURGER + « Traitée » (v2.20.66)", () => {
  const contacts = [{
    contactId: "1",
    suiviRefs: ["EVE1", "EVE2"],
    tsCheck: T0 - 3 * H,
    statuts: { EVE1: { status: "DONE" }, EVE2: "REALIZED" }
  }];
  const [d] = praxedo.scanSuivis(T0, contacts);
  assert.strictEqual(d.a_traiter, true);
  assert.strictEqual(d.toutes_realisees, true);
  assert.strictEqual(d.purger, true);
  assert.strictEqual(d.cycle, "Traitée");
  assert.deepStrictEqual(d.restantes, []);
});

test("B6.3 scanSuivis : partiel → PAS de purge, restantes listées", () => {
  const contacts = [{
    contactId: "1",
    suiviRefs: ["EVE1", "EVE2"],
    tsCheck: T0 - 3 * H,
    statuts: { EVE1: { status: "DONE" }, EVE2: { status: "PLANNED" } }
  }];
  const [d] = praxedo.scanSuivis(T0, contacts);
  assert.strictEqual(d.a_traiter, true);
  assert.strictEqual(d.toutes_realisees, false);
  assert.strictEqual(d.purger, false);
  assert.deepStrictEqual(d.restantes, ["EVE2"]);
  assert.strictEqual(d.statuts_vus.EVE1, true);
  assert.strictEqual(d.statuts_vus.EVE2, false);
});

test("B6.3 scanSuivis : rien suivi → jamais purgé, aucune fausse « Traitée »", () => {
  const contacts = [{ contactId: "1", suiviRefs: [], tsCheck: 0, statuts: {} }];
  const [d] = praxedo.scanSuivis(T0, contacts);
  assert.strictEqual(d.a_traiter, true);
  assert.strictEqual(d.toutes_realisees, false);
  assert.strictEqual(d.purger, false);
});

// ------------------------------------------------------ RETRAIT DU TAG ----
test("B6.3 retirerTagDecision : ≥ 2 h + cycle « Traitée » → RETIRÉ (v2.20.117)", () => {
  const d = praxedo.retirerTagDecision(T0, T0 - 3 * H, "Traitée", false);
  assert.strictEqual(d.retirer, true);
});

test("B6.3 retirerTagDecision : ≥ 2 h + conversation fermée → RETIRÉ", () => {
  const d = praxedo.retirerTagDecision(T0, T0 - 3 * H, "A qualifier", true);
  assert.strictEqual(d.retirer, true);
});

test("B6.3 retirerTagDecision : moins de 2 h → conservé", () => {
  const d = praxedo.retirerTagDecision(T0, T0 - 1 * H, "Traitée", false);
  assert.strictEqual(d.retirer, false);
});

test("B6.3 retirerTagDecision : dossier EN COURS → JAMAIS retiré, même ≥ 2 h", () => {
  const d = praxedo.retirerTagDecision(T0, T0 - 5 * H, "En cours de réalisation", false);
  assert.strictEqual(d.retirer, false);
});

test("B6.3 retirerTagDecision : cycle contenant « trait » peu importe l'AUTEUR", () => {
  const d = praxedo.retirerTagDecision(T0, T0 - 3 * H, "traitée à la main par un humain", false);
  assert.strictEqual(d.retirer, true);
});

// ---------------------------------------------------------- ARMEMENT ----
test("B6.3 decisionArmement : ref citée + dossier « A créer dans Praxedo » → « En cours de réalisation »", () => {
  const d = praxedo.decisionArmement({ cycleActuel: "A créer dans Praxedo", references: ["EVE123456"] });
  assert.strictEqual(d.action, "poser_cycle");
  assert.strictEqual(d.cycle, "En cours de réalisation");
  assert.deepStrictEqual(d.references, ["EVE123456"]);
});

test("B6.3 decisionArmement : SANS référence citée → AUCUNE décision (parité observation)", () => {
  assert.strictEqual(praxedo.decisionArmement({ cycleActuel: "A créer dans Praxedo", references: [] }), null);
  assert.strictEqual(praxedo.decisionArmement({ cycleActuel: "A créer dans Praxedo" }), null);
});

test("B6.3 decisionArmement : cycle DÉJÀ avancé → pas de régression de cycle", () => {
  assert.strictEqual(praxedo.decisionArmement({ cycleActuel: "En cours de réalisation", references: ["EVE1"] }), null);
  assert.strictEqual(praxedo.decisionArmement({ cycleActuel: "Traitée", references: ["EVE1"] }), null);
});

test("B6.3 AUCUNE assignation ni mention @user dans le module (décision Corentin 23/10)", () => {
  const fs = require("node:fs");
  const source = fs.readFileSync(require.resolve("../lib/praxedo.js"), "utf8");
  assert.ok(source.indexOf("@user") === -1);
  assert.ok(source.indexOf("assign") === -1);
});

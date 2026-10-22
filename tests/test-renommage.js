// ============================================================================
// Agent SAV U'mob v2 — B6.3 : tests du RENOMMAGE des contacts (node --test, PUR)
// ============================================================================
const { test } = require("node:test");
const assert = require("node:assert");
const renommage = require("../lib/renommage.js");

test("B6.3 dejaRenomme : « Nom (Société - Ville) » → DÉJÀ renommé (v2.19.8)", () => {
  assert.strictEqual(renommage.dejaRenomme("Marco (Pizza Milano - Lyon)"), true);
});

test("B6.3 dejaRenomme : nom simple → pas renommé", () => {
  assert.strictEqual(renommage.dejaRenomme("Marco"), false);
  assert.strictEqual(renommage.dejaRenomme(""), false);
});

test("B6.3 nomPropose : enseigne + ville → « Nom (Société - Ville) »", () => {
  assert.strictEqual(
    renommage.nomPropose("Marco", { enseigne: "Pizza Milano", ville: "Lyon" }),
    "Marco (Pizza Milano - Lyon)"
  );
});

test("B6.3 nomPropose : enseigne seule si la ville manque", () => {
  assert.strictEqual(
    renommage.nomPropose("Marco", { enseigne: "Pizza Milano" }),
    "Marco (Pizza Milano)"
  );
});

test("B6.3 nomPropose : fiche incomplète → nom inchangé", () => {
  assert.strictEqual(renommage.nomPropose("Marco", {}), "Marco");
});

test("B6.3 decisionRenommage : DÉSACTIVÉ par défaut (parité v2.20.136)", () => {
  const d = renommage.decisionRenommage({ nom: "Marco", client: { enseigne: "Pizza Milano", ville: "Lyon" } });
  assert.strictEqual(d.renommer, false);
  assert.ok(d.raison.indexOf("désactivé") !== -1);
});

test("B6.3 decisionRenommage : activé + fiche identifiée → renommage proposé", () => {
  const d = renommage.decisionRenommage({ actif: true, nom: "Marco", client: { enseigne: "Pizza Milano", ville: "Lyon" } });
  assert.strictEqual(d.renommer, true);
  assert.strictEqual(d.nouveau_nom, "Marco (Pizza Milano - Lyon)");
});

test("B6.3 decisionRenommage : JAMAIS deux fois (déjà renommé → refus)", () => {
  const d = renommage.decisionRenommage({ actif: true, nom: "Marco (Pizza Milano - Lyon)", client: { enseigne: "Pizza Milano", ville: "Lyon" } });
  assert.strictEqual(d.renommer, false);
  assert.ok(d.raison.indexOf("déjà renommé") !== -1);
});

test("B6.3 decisionRenommage : activé mais fiche incomplète → refus", () => {
  const d = renommage.decisionRenommage({ actif: true, nom: "Marco", client: {} });
  assert.strictEqual(d.renommer, false);
  assert.ok(d.raison.indexOf("incomplète") !== -1);
});

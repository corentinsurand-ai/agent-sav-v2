// ============================================================================
// Agent SAV U'mob v2 — B6.7 : tests du module PUR lib/lecons.js (node --test)
// Exécution : node --test tests/test-lecons.js
// Zéro réseau : la boucle d'apprentissage (déclencheurs, ciblage, cap 3,
// renfort par commentaire) est testable à 100 % hors ligne.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const lecons = require("../lib/lecons.js");

// --- normalisation -----------------------------------------------------------
test("normaliserTexte : accents, casse, ponctuation → base comparable", () => {
  assert.strictEqual(lecons.normaliserTexte("CréVâison"), "crevaison");
  assert.strictEqual(lecons.normaliserTexte("PNEU; avant !"), "pneu avant");
  assert.strictEqual(lecons.normaliserTexte("  Pneu   arrière  "), "pneu arriere");
  assert.strictEqual(lecons.normaliserTexte(""), "");
  assert.strictEqual(lecons.normaliserTexte(null), "");
  assert.strictEqual(lecons.normaliserTexte(123), "123");
});

// --- déclencheurs ------------------------------------------------------------
test("declencheursDe : « crevaison, pneu ; crevé » → 3 mots normalisés (split , ; /)", () => {
  assert.deepStrictEqual(
    lecons.declencheursDe({ declencheurs: "crevaison, pneu ; crevé" }),
    ["crevaison", "pneu", "creve"]
  );
  assert.deepStrictEqual(
    lecons.declencheursDe({ declencheurs: "a / bb ; ccc" }),
    ["ccc"], "les fragments < 3 caractères sont ignorés"
  );
  assert.deepStrictEqual(lecons.declencheursDe({}), []);
  assert.deepStrictEqual(lecons.declencheursDe({ declencheurs: ", ; /" }), []);
  // dédoublonnage
  assert.deepStrictEqual(
    lecons.declencheursDe({ declencheurs: "pneu, Pneu, PNEU" }),
    ["pneu"]
  );
});

// --- applicabilité ------------------------------------------------------------
test("leçon SANS déclencheurs → applicable à CHAQUE tour (comportement B6.3)", () => {
  const l = { regle: "toujours proposer un prêt", declencheurs: "", portee: "generale", statut: "active" };
  assert.strictEqual(lecons.leconApplicable(l, "bonjour", ""), true);
  assert.strictEqual(lecons.leconApplicable(l, "", ""), true);
});

test("leçon AVEC déclencheurs → applicable SI ET SEULEMENT SI un mot-clé est cité (accent insensible)", () => {
  const l = { regle: "crevaison : avant ou arrière", declencheurs: "crevaison, crevé", portee: "generale", statut: "active" };
  assert.strictEqual(lecons.leconApplicable(l, lecons.normaliserTexte("j'ai une crevaison"), ""), true);
  assert.strictEqual(lecons.leconApplicable(l, lecons.normaliserTexte("mon pneu est crevé"), ""), true);
  assert.strictEqual(lecons.leconApplicable(l, lecons.normaliserTexte("mon scooter ne démarre pas"), ""), false);
});

test("statut annulee / promue → JAMAIS injectée ; active et validee le sont", () => {
  const base = { regle: "r", declencheurs: "", portee: "generale" };
  assert.strictEqual(lecons.leconApplicable(Object.assign({}, base, { statut: "active" }), "x", ""), true);
  assert.strictEqual(lecons.leconApplicable(Object.assign({}, base, { statut: "validee" }), "x", ""), true);
  assert.strictEqual(lecons.leconApplicable(Object.assign({}, base, { statut: "annulee" }), "x", ""), false);
  assert.strictEqual(lecons.leconApplicable(Object.assign({}, base, { statut: "promue" }), "x", ""), false);
  assert.strictEqual(lecons.leconApplicable(Object.assign({}, base, { statut: "" }), "x", ""), false);
});

test("portée client → réservée à SON contact_id ; portée générale → tous", () => {
  const l = { regle: "ce client préfère être appelé", declencheurs: "", portee: "client", contact_id: "0612345678", statut: "active" };
  assert.strictEqual(lecons.leconApplicable(l, "bonjour", "0612345678"), true);
  assert.strictEqual(lecons.leconApplicable(l, "bonjour", "0698765432"), false);
  assert.strictEqual(lecons.leconApplicable(l, "bonjour", ""), false);
  const g = { regle: "générale", declencheurs: "", portee: "generale", statut: "active" };
  assert.strictEqual(lecons.leconApplicable(g, "bonjour", "0698765432"), true);
});

// --- leconsApplicables : cap 3 + tri par occurrences ---------------------------
test("leconsApplicables : MAX 3 leçons par tour, triées par occurrences décroissantes", () => {
  const source = [
    { regle: "A (1 occurrence)", declencheurs: "", portee: "generale", occurrences: 1, statut: "active" },
    { regle: "B (5 occurrences)", declencheurs: "", portee: "generale", occurrences: 5, statut: "active" },
    { regle: "C (3 occurrences)", declencheurs: "", portee: "generale", occurrences: 3, statut: "active" },
    { regle: "D (2 occurrences)", declencheurs: "", portee: "generale", occurrences: 2, statut: "active" },
    { regle: "E annulée (9 occurrences)", declencheurs: "", portee: "generale", occurrences: 9, statut: "annulee" }
  ];
  const res = lecons.leconsApplicables(source, "bonjour", "");
  assert.strictEqual(res.length, lecons.MAX_LECONS_PAR_TOUR);
  assert.strictEqual(res.length, 3);
  assert.deepStrictEqual(res, ["B (5 occurrences)", "C (3 occurrences)", "D (2 occurrences)"],
    "les plus éprouvées d'abord, l'annulée jamais, la 4e (A) coupée par le cap");
});

test("leconsApplicables : ne renvoie que les RÈGLES (textes), dédupliquées, non vides", () => {
  const source = [
    { regle: " même texte ", declencheurs: "crevaison", occurrences: 2, portee: "generale", statut: "active" },
    { regle: "même texte", declencheurs: "crevaison", occurrences: 1, portee: "generale", statut: "validee" },
    { regle: "", declencheurs: "crevaison", occurrences: 9, portee: "generale", statut: "active" }
  ];
  const res = lecons.leconsApplicables(source, "crevaison !", "");
  assert.deepStrictEqual(res, ["même texte"]);
});

test("leconsApplicables : entrée non-tableau ou leçons nulles → sans crash", () => {
  assert.deepStrictEqual(lecons.leconsApplicables(null, "x", ""), []);
  assert.deepStrictEqual(lecons.leconsApplicables([null, { regle: "ok", statut: "active" }], "x", ""), ["ok"]);
});

// --- renfort par commentaire ---------------------------------------------------
test("commentaireCiteLecon : un commentaire qui cite un déclencheur renforce la leçon", () => {
  const l = { regenle: "", declencheurs: "crevaison, pneu, crevé" };
  assert.strictEqual(lecons.commentaireCiteLecon(
    { declencheurs: "crevaison, pneu, crevé" },
    "tu dois demander lors d'une CREVAISON si avant ou arrière"), true);
  assert.strictEqual(lecons.commentaireCiteLecon(
    { declencheurs: "crevaison, pneu, crevé" }, "parfait, rien à dire"), false);
  // sans déclencheurs : JAMAIS renforcée (rien de déterministe à matcher)
  assert.strictEqual(lecons.commentaireCiteLecon({ declencheurs: "" }, "crevaison avant ou arrière"), false);
  assert.strictEqual(lecons.commentaireCiteLecon({ declencheurs: "pneu" }, ""), false);
});

// --- texte de conversation ------------------------------------------------------
test("texteDeConversation : assemble TOUS les textes du fil (matching sur la conversation complète)", () => {
  const messages = [
    { texte: "bonjour" },
    { texte: "Bonjour, comment puis-je vous aider ?" },
    { texte: "j'ai une crevaison" }
  ];
  const t = lecons.texteDeConversation(messages);
  assert.ok(t.indexOf("crevaison") !== -1);
  assert.ok(t.indexOf("bonjour") !== -1);
  assert.strictEqual(lecons.texteDeConversation(null), "");
  assert.strictEqual(lecons.texteDeConversation([{ texte: "" }, {}]), "");
});

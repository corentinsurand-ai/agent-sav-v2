// ============================================================================
// Agent SAV U'mob v2 — B6.3 : tests du DIGEST « prise de main » (node --test,
// PUR — aucun réseau, aucun envoi : le temps est injecté)
// ============================================================================
const { test } = require("node:test");
const assert = require("node:assert");
const digest = require("../lib/digest.js");

const MIN = 60 * 1000;
const T0 = 1780000000000; // référence injectée — jamais Date.now()

// ---------------------------------------------------------------- FENÊTRE ----
test("B6.3 dansFenetre : 9h-18h incluse (v2.20.83)", () => {
  assert.strictEqual(digest.dansFenetre(9), true);
  assert.strictEqual(digest.dansFenetre(12), true);
  assert.strictEqual(digest.dansFenetre(17), true);
});

test("B6.3 dansFenetre : 8h, 18h, la nuit → HORS fenêtre", () => {
  assert.strictEqual(digest.dansFenetre(8), false);
  assert.strictEqual(digest.dansFenetre(18), false);
  assert.strictEqual(digest.digestNecessaire({ maintenant: T0, dernier_digest_ts: 0, trigger: "pose", heure: 22 }).necessaire, false);
});

// --------------------------------------------------- DÉCLENCHEMENT « POSE » ----
test("B6.3 digestNecessaire : pose SANS dernier digest → IMMÉDIAT", () => {
  const r = digest.digestNecessaire({ maintenant: T0, dernier_digest_ts: 0, trigger: "pose", heure: 10 });
  assert.strictEqual(r.necessaire, true);
  assert.strictEqual(r.differe, false);
});

test("B6.3 digestNecessaire : dernier digest < 15 min → DIFFÉRÉ au scan horaire (jamais perdu)", () => {
  const r = digest.digestNecessaire({ maintenant: T0, dernier_digest_ts: T0 - 10 * MIN, trigger: "pose", heure: 10 });
  assert.strictEqual(r.necessaire, false);
  assert.strictEqual(r.differe, true);
});

test("B6.3 digestNecessaire : dernier digest ≥ 15 min → immédiat quand même", () => {
  const r = digest.digestNecessaire({ maintenant: T0, dernier_digest_ts: T0 - 16 * MIN, trigger: "pose", heure: 10 });
  assert.strictEqual(r.necessaire, true);
});

// ---------------------------------------------------- DÉCLENCHEMENT « SCAN » ----
test("B6.3 digestNecessaire : scan SANS dernier digest → envoyer", () => {
  const r = digest.digestNecessaire({ maintenant: T0, dernier_digest_ts: 0, trigger: "scan", heure: 10 });
  assert.strictEqual(r.necessaire, true);
});

test("B6.3 digestNecessaire : scan ≥ 45 min du dernier → envoyer", () => {
  const r = digest.digestNecessaire({ maintenant: T0, dernier_digest_ts: T0 - 46 * MIN, trigger: "scan", heure: 10 });
  assert.strictEqual(r.necessaire, true);
});

test("B6.3 digestNecessaire : scan < 45 min du dernier → RIEN", () => {
  const r = digest.digestNecessaire({ maintenant: T0, dernier_digest_ts: T0 - 30 * MIN, trigger: "scan", heure: 10 });
  assert.strictEqual(r.necessaire, false);
  assert.strictEqual(r.differe, false);
});

test("B6.3 digestNecessaire : le TRIGGER défaut est « pose » (pas de paramètre → immédiat)", () => {
  const r = digest.digestNecessaire({ maintenant: T0, dernier_digest_ts: 0, heure: 10 });
  assert.strictEqual(r.necessaire, true);
});

test("B6.3 digestNecessaire : hors fenêtre → différé (même au scan)", () => {
  const r = digest.digestNecessaire({ maintenant: T0, dernier_digest_ts: 0, trigger: "scan", heure: 7 });
  assert.strictEqual(r.necessaire, false);
  assert.strictEqual(r.differe, true);
});

// ------------------------------------------------------------------- CORPS ----
test("B6.3 corpsDigest : consolidé, UNE ligne par prise de main", () => {
  const c = digest.corpsDigest([
    { contactId: "111", nom: "Pizza Milano", raison: "client exige un humain", ts: T0 },
    { contactId: "222", nom: "Speed Livraison", raison: "", ts: T0 - 5 * MIN }
  ]);
  assert.ok(c.indexOf("2 dossier(s)") !== -1);
  assert.ok(c.indexOf("Pizza Milano (contact 111) : client exige un humain") !== -1);
  assert.ok(c.indexOf("Speed Livraison (contact 222)") !== -1);
});

test("B6.3 corpsDigest : liste vide ou entrée sans contact → en-tête seul", () => {
  const c = digest.corpsDigest([]);
  assert.ok(c.indexOf("0 dossier(s)") !== -1);
  const c2 = digest.corpsDigest([{ raison: "x" }]); // filtré : pas de contactId
  assert.ok(c2.indexOf("0 dossier(s)") !== -1);
});

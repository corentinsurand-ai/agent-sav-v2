// ============================================================================
// Agent SAV U'mob v2 — B5.4 : tests de la console de test /api/test (node --test)
// Exécution : node --test tests/test-console.js
// (~11 tests — zéro dépendance : Supabase et Mistral SIMULÉS)
//
// Ce qui est vérifié : auth (secret), méthodes, configuration, la chaîne
// RÉELLE branchée (rejet plaque hors parc canonique, RESET canonique, Mistral
// appelé exactement quand il doit l'être), la fiche client par téléphone,
// et l'INVARIANT ABSOLU du bac à sable : ZÉRO écriture Supabase (uniquement
// des GET) et ZÉRO accès respond.io.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

// --- Environnement de test AVANT tout require --------------------------------
process.env.WEBHOOK_SECRET = "secret-de-test-b54";
process.env.SUPABASE_URL = "https://umob-crm.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "cle-service-test";
process.env.MISTRAL_API_KEY = "mistral-cle-test";

const processLib = require("../lib/process.js");

// ============================================================================
// SIMULATIONS — fetch global : mini-PostgREST Supabase (clients) + Mistral
// ============================================================================
const db = {
  clients: [
    { telephone: "33620203963", plaque: "GG798NL", enseigne: "PIZZA SERVICES ETAMPES", statut_risque: null }
  ]
};
let appelsFetch = [];   // tous les appels réseau simulés
let appelsMistral = 0;  // chaque appel au modèle compte

const reponseConforme = JSON.stringify({
  reponse: "Merci pour votre message, nous prenons en charge votre demande.\n-Agent IA U'mob-",
  formulaire: {},
  escalade: false,
  raison_escalade: ""
});

function reinitialise() {
  appelsFetch = [];
  appelsMistral = 0;
}

function paramsDe(url) {
  const u = new URL(url);
  const p = {};
  u.searchParams.forEach((v, k) => { p[k] = v; });
  return p;
}

globalThis.fetch = async function (url, options) {
  url = String(url);
  options = options || {};
  appelsFetch.push({ url, method: options.method || "GET" });

  // ---- Mistral --------------------------------------------------------------
  if (url.indexOf("api.mistral.ai") !== -1) {
    appelsMistral++;
    return { status: 200, ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: reponseConforme } }] }) };
  }

  // ---- Supabase (mini-PostgREST : clients, GET seulement) --------------------
  if (url.indexOf("umob-crm.supabase.co") !== -1) {
    const params = paramsDe(url);
    const table = url.split("/rest/v1/")[1].split("?")[0];
    if (table === "clients") {
      let out = db.clients.slice();
      if (params["telephone"]) out = out.filter((r) => r.telephone === params["telephone"].slice(3));
      // B4.2-PREP.2 — filtre plaque=ilike.*AA123BB* (recherche pleine colonne)
      if (params["plaque"] && params["plaque"].slice(0, 6) === "ilike.") {
        const motif = params["plaque"].slice(6).replace(/^\*/, "").replace(/\*$/, "");
        out = out.filter((r) => String(r.plaque || "").toUpperCase().indexOf(motif.toUpperCase()) !== -1);
      }
      if (params["limit"]) out = out.slice(0, parseInt(params["limit"], 10));
      return { status: 200, ok: true, text: async () => JSON.stringify(out) };
    }
    return { status: 404, ok: false, text: async () => "table inconnue " + table };
  }

  throw new Error("URL non simulée : " + url);
};

const apiTest = require("../api/test.js");
const REPONSE_RESET = processLib.REPONSE_RESET;
const REPONSE_PLAQUE = processLib.REPONSE_PLAQUE;

// --- Simulation de res (Vercel) -----------------------------------------------
function faireRes() {
  return {
    statusCode: null,
    corps: null,
    html: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.corps = obj; return this; },
    send(t) { this.html = t; return this; },
    end() { return this; }
  };
}

function requete(query, corps, methode) {
  return {
    method: methode || "GET",
    url: "/api/test" + (query ? "?" + query : ""),
    query: query ? Object.fromEntries(new URLSearchParams(query)) : {},
    headers: {},
    body: corps
  };
}

// ============================================================================
// 1. L'endpoint : auth, méthodes, configuration
// ============================================================================

test("401 sans secret", async () => {
  const res = faireRes();
  await apiTest(requete("", null, "GET"), res);
  assert.strictEqual(res.statusCode, 401);
  assert.strictEqual(res.corps.ok, false);
});

test("405 méthode non autorisee (DELETE)", async () => {
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54", null, "DELETE"), res);
  assert.strictEqual(res.statusCode, 405);
});

test("500 configuration manquante (MISTRAL_API_KEY absente)", async () => {
  const sauve = process.env.MISTRAL_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54", null, "GET"), res);
  assert.strictEqual(res.statusCode, 500);
  assert.ok(String(res.corps.erreur).indexOf("MISTRAL_API_KEY") !== -1);
  process.env.MISTRAL_API_KEY = sauve; // jamais d'effet de bord sur les autres tests
});

test("GET sans telephone → la page HTML du bac à sable", async () => {
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(String(res.html).indexOf("Console de test") !== -1);
});

// ============================================================================
// 2. La chaîne RÉELLE branchée sur le bac à sable
// ============================================================================

test("message simple → traite, 1 appel Mistral, aucun transfert", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "Bonjour, mon scooter ne démarre pas", memoire: [] }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.statut, "traite");
  assert.strictEqual(res.corps.type, "cerveau");
  assert.strictEqual(res.corps.appels_mistral, 1);
  assert.strictEqual(appelsMistral, 1);
  assert.strictEqual(res.corps.escalade, false);
  assert.strictEqual(res.corps.actions_simulees.length, 1);
  assert.ok(res.corps.actions_simulees[0].indexOf("aucun transfert") !== -1);
  assert.ok(res.corps.reponse.indexOf("-Agent IA U'mob-") !== -1);
});

test("plaque HORS parc → rejet canonique, 0 Mistral, garde cas A, dans_parc false", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "mon scooter AA-123-BB ne démarre pas", memoire: [] }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.statut, "traite");
  assert.strictEqual(res.corps.reponse, REPONSE_PLAQUE);
  assert.strictEqual(res.corps.type, "plaque");
  assert.strictEqual(res.corps.appels_mistral, 0);
  assert.strictEqual(appelsMistral, 0);
  assert.ok(res.corps.actions_simulees[0].indexOf("rejet canonique plaque hors parc") !== -1);
  assert.strictEqual(res.corps.plaques_verifiees.length, 1);
  assert.strictEqual(res.corps.plaques_verifiees[0].plaque, "AA123BB");
  assert.strictEqual(res.corps.plaques_verifiees[0].dans_parc, false);
});

// ============================================================================
// B5.4.1 — CORRECTIF CAS A ÉTAPE 2 (incident console GE-365-DD / GR-335-TT) :
// après UNE vérification, une plaque redonnée toujours hors parc → TRANSFERT
// AUTO déterministe (0 Mistral) — chez l'ancien, le cycle PASSAIT à « A
// qualifier » à ce moment-là (v2.20.6/9/10) ; il ne changeait jamais.
// ============================================================================

test("cas A étape 2 : rejet puis 2e plaque hors parc (GE-365-DD → GR-335-TT) → TRANSFERT AUTO, 0 Mistral, cycle → A qualifier", async () => {
  reinitialise();
  // échange 1 : 1re plaque hors parc → rejet canonique (étape 1)
  const r1 = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "mon scooter GE-365-DD ne démarre pas", memoire: [] }, "POST"), r1);
  assert.strictEqual(r1.corps.type, "plaque");
  assert.strictEqual(r1.corps.reponse, REPONSE_PLAQUE);
  // échange 2 : le client donne une AUTRE plaque, toujours hors parc — la
  // mémoire du navigateur contient l'échange 1 (entrant + rejet sortant)
  const memoire = [
    { sortant: false, texte: "mon scooter GE-365-DD ne démarre pas", ts: 1792683540000 },
    { sortant: true, texte: r1.corps.reponse, ts: 1792683541000 }
  ];
  const r2 = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "c est GR-335-TT", memoire }, "POST"), r2);
  assert.strictEqual(r2.statusCode, 200);
  assert.strictEqual(r2.corps.statut, "traite");
  assert.strictEqual(r2.corps.type, "cas_a");
  assert.strictEqual(r2.corps.appels_mistral, 0);
  assert.strictEqual(appelsMistral, 0);
  assert.strictEqual(r2.corps.escalade, true);
  assert.ok(r2.corps.reponse.indexOf("Merci pour la confirmation. Je ne retrouve pas l'immatriculation GR-335-TT dans notre parc.") !== -1);
  assert.ok(r2.corps.reponse.indexOf("Agent IA U'mob") !== -1);
  assert.ok(r2.corps.raison_escalade.indexOf("PLAQUE NON IDENTIFIÉE AU PARC (cas A)") !== -1);
  // le bloc « B4.2 (mode actif) ferait » affiche le TRANSFERT complet
  const actions = r2.corps.actions_simulees.join(" | ");
  assert.ok(actions.indexOf("cycle → « A qualifier »") !== -1);
  assert.ok(actions.indexOf("tag « Prise de main » posé") !== -1);
  assert.ok(actions.indexOf("TRANSFERT SAV") !== -1);
});

test("cas A étape 2 : plaque corrigée AU parc après rejet → PAS de transfert, la qualification poursuit (1 Mistral)", async () => {
  reinitialise();
  const memoire = [
    { sortant: false, texte: "mon scooter GE-365-DD ne démarre pas", ts: 1792683540000 },
    { sortant: true, texte: REPONSE_PLAQUE, ts: 1792683541000 }
  ];
  const r = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "ah mince, c est le GG-798-NL", memoire }, "POST"), r);
  assert.strictEqual(r.corps.statut, "traite");
  assert.strictEqual(r.corps.type, "cerveau");
  assert.strictEqual(r.corps.appels_mistral, 1);
  assert.strictEqual(r.corps.escalade, false);
});

test("plaque DU parc → qualification normale, dans_parc true", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "mon scooter GG-798-NL ne démarre pas", memoire: [] }, "POST"), res);
  assert.strictEqual(res.corps.statut, "traite");
  assert.strictEqual(res.corps.appels_mistral, 1);
  assert.strictEqual(appelsMistral, 1);
  assert.strictEqual(res.corps.plaques_verifiees.length, 1);
  assert.strictEqual(res.corps.plaques_verifiees[0].plaque, "GG798NL");
  assert.strictEqual(res.corps.plaques_verifiees[0].dans_parc, true);
  assert.ok(res.corps.etat.plaques.indexOf("GG798NL") !== -1);
});

test("RESET (casse quelconque, avec historique) → statut reset, canonique, 0 Mistral", async () => {
  reinitialise();
  const memoire = [
    { sortant: false, texte: "Bonjour mon scooter GG-798-NL ne démarre pas", ts: 1792683528000 },
    { sortant: true, texte: "Bonjour ! Nous prenons en charge votre demande.", ts: 1792683529000 }
  ];
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54", { message: "reset", memoire }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.statut, "reset");
  assert.strictEqual(res.corps.reponse, REPONSE_RESET);
  assert.strictEqual(res.corps.type, "reset");
  assert.strictEqual(res.corps.appels_mistral, 0);
  assert.strictEqual(appelsMistral, 0);
  assert.ok(res.corps.actions_simulees[0].indexOf("réponse canonique RESET") !== -1);
  assert.ok(res.corps.actions_simulees[1].indexOf("retrait du tag") !== -1);
  // le formulaire repart à zéro (plus de plaque GG798NL dans l'état)
  assert.strictEqual(res.corps.etat.plaques.length, 0);
  assert.strictEqual(res.corps.etat.etape, 1);
});

test("téléphone → fiche client injectée (enseigne visible)", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { telephone: "+33620203963", message: "Bonjour, mon scooter ne démarre pas", memoire: [] }, "POST"), res);
  assert.strictEqual(res.corps.client !== null, true);
  assert.strictEqual(res.corps.client.enseigne, "PIZZA SERVICES ETAMPES");
  assert.deepStrictEqual(res.corps.client.plaques, ["GG798NL"]);
  assert.strictEqual(res.corps.etat.enseigne, "PIZZA SERVICES ETAMPES");
  assert.strictEqual(res.corps.statut, "traite");
});

test("GET ?telephone → fiche client (JSON), null si inconnu", async () => {
  const r1 = faireRes();
  await apiTest(requete("secret=secret-de-test-b54&telephone=0620203963"), r1);
  assert.strictEqual(r1.statusCode, 200);
  assert.strictEqual(r1.corps.ok, true);
  assert.strictEqual(r1.corps.client.enseigne, "PIZZA SERVICES ETAMPES");

  const r2 = faireRes();
  await apiTest(requete("secret=secret-de-test-b54&telephone=0699999999"), r2);
  assert.strictEqual(r2.statusCode, 200);
  assert.strictEqual(r2.corps.client, null);
});

test("message vide → 400", async () => {
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54", { message: "   ", memoire: [] }, "POST"), res);
  assert.strictEqual(res.statusCode, 400);
  assert.strictEqual(res.corps.ok, false);
});

// ============================================================================
// 3. L'INVARIANT du bac à sable : ZÉRO écriture, ZÉRO respond.io
// ============================================================================

test("zéro écriture Supabase (uniquement des GET) et aucun accès respond.io", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { telephone: "+33620203963", message: "mon scooter GG-798-NL ne démarre pas", memoire: [] }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);

  const supabase = appelsFetch.filter((a) => a.url.indexOf("umob-crm.supabase.co") !== -1);
  assert.ok(supabase.length > 0, "au moins une lecture clients attendue");
  assert.ok(supabase.every((a) => a.method === "GET"), "aucune écriture Supabase dans le bac à sable");
  assert.ok(appelsFetch.every((a) => a.url.indexOf("api.respond.io") === -1), "aucun accès respond.io");
  assert.strictEqual(appelsMistral, 1);
});

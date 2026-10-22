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

// mutable : certains tests (cycle_prevu « Attente client ») substituent une
// réponse du modèle qui pose une question au client.
let reponseConforme = JSON.stringify({
  reponse: "Merci pour votre message, nous prenons en charge votre demande.\n-Agent IA U'mob-",
  formulaire: {},
  escalade: false,
  raison_escalade: ""
});

const reponseConformeParDefaut = reponseConforme;

function reinitialise() {
  appelsFetch = [];
  appelsMistral = 0;
  reponseConforme = reponseConformeParDefaut;
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

test("plaque HORS parc SEULE → rejet canonique, 0 Mistral, garde cas A, dans_parc false", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "c est le AA-123-BB", memoire: [] }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.statut, "traite");
  assert.strictEqual(res.corps.reponse, REPONSE_PLAQUE);
  assert.strictEqual(res.corps.type, "plaque");
  assert.strictEqual(res.corps.appels_mistral, 0);
  assert.strictEqual(appelsMistral, 0);
  assert.strictEqual(res.corps.cycle_prevu.cycle, null);
  assert.ok(res.corps.actions_simulees[0].indexOf("rejet canonique plaque hors parc") !== -1);
  assert.strictEqual(res.corps.plaques_verifiees.length, 1);
  assert.strictEqual(res.corps.plaques_verifiees[0].plaque, "AA123BB");
  assert.strictEqual(res.corps.plaques_verifiees[0].dans_parc, false);
});

test("B5.4.3 MIXTE : plaque hors parc + description → le cerveau répond à TOUT (1 Mistral, type cerveau, cycle Attente client)", async () => {
  // Incident Corentin 23/10 : « il doit quand même dire au client qu'il a
  // compris le problème » — le canonique seul ignorait la description.
  reinitialise();
  reponseConforme = JSON.stringify({
    reponse: "J'ai bien noté le problème de démarrage de votre scooter. En revanche, je ne retrouve pas la plaque AA-123-BB dans notre parc — quelle est la saisie exacte de l'immatriculation ?\n-Agent IA U'mob-",
    formulaire: { panne: "ne démarre pas", etape: 3 },
    escalade: false,
    raison_escalade: ""
  });
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "mon scooter AA-123-BB ne démarre pas", memoire: [] }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.statut, "traite");
  assert.strictEqual(res.corps.type, "cerveau"); // PLUS de rejet canonique : le cerveau répond à tout
  assert.strictEqual(res.corps.appels_mistral, 1);
  assert.strictEqual(appelsMistral, 1);
  assert.notStrictEqual(res.corps.reponse, REPONSE_PLAQUE);
  assert.ok(res.corps.reponse.indexOf("ne démarre pas") !== -1 || res.corps.reponse.indexOf("démarrage") !== -1);
  assert.ok(res.corps.reponse.indexOf("AA-123-BB") !== -1);
  assert.strictEqual(res.corps.etat.panne, "ne démarre pas"); // la panne est capturée DÈS CE TOUR
  assert.strictEqual(res.corps.cycle_prevu.cycle, "Attente client"); // question posée au client
});

// ============================================================================
// B5.4.2 — comportement VALIDÉ par Corentin (le transfert reste la décision
// du CERVEAU, jamais de la garde plaque) + AFFICHAGE DU CYCLE que le mode
// actif B4.2 poserait (mapping §5, lib/cycles.js → detail.cycle_prevu).
// ============================================================================

test("rejet puis 2e plaque DIFFÉRENTE hors parc (GE-365-DD → GR-335-TT) → rejet canonique À NOUVEAU, 0 Mistral, cycle inchangé (comportement validé)", async () => {
  reinitialise();
  // échange 1 : 1re plaque hors parc (SEULE) → rejet canonique (étape 1)
  const r1 = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "c est le GE-365-DD", memoire: [] }, "POST"), r1);
  assert.strictEqual(r1.corps.type, "plaque");
  assert.strictEqual(r1.corps.reponse, REPONSE_PLAQUE);
  // échange 2 : le client donne une AUTRE plaque, toujours hors parc — la
  // mémoire du navigateur contient l'échange 1 (entrant + rejet sortant)
  const memoire = [
    { sortant: false, texte: "c est le GE-365-DD", ts: 1792683540000 },
    { sortant: true, texte: r1.corps.reponse, ts: 1792683541000 }
  ];
  const r2 = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "c est GR-335-TT", memoire }, "POST"), r2);
  assert.strictEqual(r2.statusCode, 200);
  assert.strictEqual(r2.corps.statut, "traite");
  // comportement restauré B5.4.2 : GR-335-TT est une plaque NOUVELLE hors
  // parc → rejet canonique à nouveau (la plaque n'est PAS bloquante, jamais
  // de transfert automatique — le cerveau tranche)
  assert.strictEqual(r2.corps.type, "plaque");
  assert.strictEqual(r2.corps.appels_mistral, 0);
  assert.strictEqual(appelsMistral, 0);
  assert.strictEqual(r2.corps.reponse, REPONSE_PLAQUE);
  assert.strictEqual(r2.corps.escalade, false);
  // B5.4.2 — le cycle que B4.2 poserait est AFFICHÉ (inchangé ici)
  assert.ok(r2.corps.cycle_prevu, "cycle_prevu présent dans la réponse JSON");
  assert.strictEqual(r2.corps.cycle_prevu.cycle, null);
  assert.ok(r2.corps.actions_simulees[0].indexOf("rejet canonique plaque hors parc") !== -1);
  assert.ok(r2.corps.actions_simulees.join(" | ").indexOf("cycle inchangé") !== -1);
});

test("plaque corrigée AU parc après rejet → la qualification poursuit (1 Mistral), cycle_prevu affiché", async () => {
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
  // B5.4.2 — réponse SANS question → cycle inchangé
  assert.strictEqual(r.corps.cycle_prevu.cycle, null);
});

test("B5.4.2 — réponse du cerveau qui POSE UNE QUESTION → cycle_prevu « Attente client » (posé après 2 h par le scan horaire)", async () => {
  reinitialise();
  reponseConforme = JSON.stringify({
    reponse: "Quel est le modèle exact de votre scooter ?\n-Agent IA U'mob-",
    formulaire: {},
    escalade: false,
    raison_escalade: ""
  });
  const r = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "mon scooter a un problème de batterie", memoire: [] }, "POST"), r);
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.corps.statut, "traite");
  assert.strictEqual(r.corps.type, "cerveau");
  assert.strictEqual(r.corps.appels_mistral, 1);
  assert.strictEqual(r.corps.cycle_prevu.cycle, "Attente client");
  assert.ok(r.corps.cycle_prevu.raison.indexOf("2 h") !== -1);
});

test("B5.4.2 — RESET → cycle_prevu inchangé (null), jamais de « Nouvelle Demande » inventé", async () => {
  reinitialise();
  const r = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "RESET", memoire: [{ sortant: false, texte: "mon scooter GG-798-NL ne démarre pas", ts: 1792683540000 }] }, "POST"), r);
  assert.strictEqual(r.corps.statut, "reset");
  assert.strictEqual(r.corps.cycle_prevu.cycle, null);
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

// ============================================================================
// B6.1 — les ACTIONS B4.2 STRUCTURÉES dans la console
// ============================================================================

test("B6.1 — escalade + dossier complet → actions_b42 : envoi, cycle « A créer dans Praxedo », tag PDM, commentaire TRANSFERT SAV", async () => {
  reinitialise();
  reponseConforme = JSON.stringify({
    reponse: "Merci pour votre confirmation. Je transmets votre dossier à notre équipe technique, qui prendra contact avec vous au plus vite.\n-Agent IA U'mob-",
    formulaire: { panne: "levier de frein cassé", telephone_contact: "0612345678", etape: 5 },
    escalade: true,
    raison_escalade: "dossier complet — transfert SAV"
  });
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "oui", memoire: [{ sortant: false, texte: "mon scooter AB-123-CD a le levier de frein cassé, appelez le 06 12 34 56 78", ts: 1792683540000 }] }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.statut, "traite");
  assert.strictEqual(res.corps.escalade, true);
  const a = res.corps.actions_b42;
  assert.ok(Array.isArray(a) && a.length === 4, "4 actions B4.2 attendues");
  assert.strictEqual(a[0].action, "envoyer_message");
  assert.strictEqual(a[1].action, "poser_cycle");
  assert.strictEqual(a[1].cycle, "A créer dans Praxedo");
  assert.strictEqual(a[2].action, "ajouter_tag");
  assert.strictEqual(a[2].tag, "Prise de main");
  assert.strictEqual(a[3].action, "commentaire");
  assert.ok(a[3].texte.indexOf("TRANSFERT SAV") === 0);
  assert.ok(a[3].texte.indexOf("RÉCAPITULATIF DE LA QUALIFICATION") !== -1);
  assert.ok(a[3].texte.indexOf("@user") === -1); // assignation EXCLUE
  // compat : actions_simulees toujours présentes (écran B5)
  assert.ok(res.corps.actions_simulees.length >= 1);
  // INVARIANT du bac à sable conservé : zéro écriture, zéro respond.io
  assert.ok(appelsFetch.every((x) => x.url.indexOf("api.respond.io") === -1));
});

test("B6.1 — la page embarque l'affichage des actions B4.2 (libellés + aperçu du commentaire interne)", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54"), res);
  assert.strictEqual(res.statusCode, 200);
  const html = String(res.html);
  assert.ok(html.indexOf("commentaire interne (jamais visible du client)") !== -1);
  assert.ok(html.indexOf("poser le cycle") !== -1);
  assert.ok(html.indexOf("B4.2 (mode actif) ferait") !== -1);
});

// ============================================================================
// B6.4 — la console embarque la version B6.4
// ============================================================================
test("B6.4 — la console répond en version B6.4", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "bonjour", memoire: [] }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.version, "B6.4");
});

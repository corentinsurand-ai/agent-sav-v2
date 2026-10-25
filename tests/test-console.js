// ============================================================================
// Agent SAV U'mob v2 — B5.4 : tests de la console de test /api/test (node --test)
// Exécution : node --test tests/test-console.js
// (37 tests — zéro dépendance : Supabase et Mistral SIMULÉS)
//
// Ce qui est vérifié : auth (secret), méthodes, configuration, la chaîne
// RÉELLE branchée (rejet plaque hors parc canonique, RESET canonique, Mistral
// appelé exactement quand il doit l'être), la fiche client par téléphone,
// et l.INVARIANT ABSOLU du bac à sable : ZÉRO écriture Supabase (uniquement
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
  ],
  notations: [], // B6.6 — LA table que le bac à sable a le droit d'écrire
  lecons: []     // B6.7 — la 2e table d'apprentissage
};
let appelsFetch = [];   // tous les appels réseau simulés
let appelsMistral = 0;  // chaque appel au modèle compte
let corpsMistral = [];  // B6.7 — le CORPS de chaque appel Mistral (le prompt envoyé)

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
  corpsMistral = [];
  reponseConforme = reponseConformeParDefaut;
  db.notations = []; // B6.6 — chaque test repart d'une table vide
  db.lecons = [];    // B6.7
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
    corpsMistral.push(String(options.body || "")); // B6.7 — capture du prompt
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
    // B6.6 — notations : GET (lecture) + POST (LA SEULE écriture du bac à sable)
    if (table === "notations") {
      if ((options.method || "GET") === "POST") {
        const ligne = JSON.parse(options.body || "{}");
        ligne.cree_a = new Date().toISOString();
        db.notations.unshift(ligne);
        return { status: 201, ok: true, text: async () => "" }; // Prefer: return=minimal
      }
      const limit = parseInt(params["limit"] || "200", 10);
      return { status: 200, ok: true, text: async () => JSON.stringify(db.notations.slice(0, limit)) };
    }
    // B6.7 — leçons : GET (lecture) + POST (création) + PATCH (renfort, statut)
    if (table === "lecons") {
      const methode = options.method || "GET";
      if (methode === "POST") {
        const ligne = JSON.parse(options.body || "{}");
        ligne.id = "lecon-" + (db.lecons.length + 1);
        db.lecons.unshift(ligne);
        return { status: 201, ok: true, text: async () => "" };
      }
      if (methode === "PATCH") {
        const idEq = params["id"] || "";
        const id = idEq.slice(0, 3) === "eq." ? idEq.slice(3) : idEq;
        const champs = JSON.parse(options.body || "{}");
        const cible = db.lecons.find((l) => String(l.id) === id);
        if (!cible) return { status: 404, ok: false, text: async () => "introuvable" };
        Object.assign(cible, champs);
        return { status: 204, ok: true, text: async () => "" };
      }
      const limit = parseInt(params["limit"] || "100", 10);
      return { status: 200, ok: true, text: async () => JSON.stringify(db.lecons.slice(0, limit)) };
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
// B6.5 — la console embarque la version
// ============================================================================
test("B6.7.1 — la console répond en version B6.7.1", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "bonjour", memoire: [] }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.version, "B6.7.1");
});

// ============================================================================
// B6.5 — COMMENTAIRES INTERNES @Agent IA (le tour consigne du bac à sable)
// ============================================================================

// INVARIANT réutilisée : le bac à sable n'écrit JAMAIS chez Supabase (que des
// GET) et n'accède JAMAIS à respond.io (Mistral en POST est normal : c'est
// l'appel réel au modèle).
function verifierZeroEcriture() {
  const ecritures = appelsFetch.filter((a) => a.method !== "GET" &&
    String(a.url).indexOf("supabase.co") !== -1);
  assert.strictEqual(ecritures.length, 0, "écritures Supabase détectées : " + JSON.stringify(ecritures));
  const respondio = appelsFetch.filter((a) => String(a.url).indexOf("respond.io") !== -1);
  assert.strictEqual(respondio.length, 0, "accès respond.io détecté");
}

test("B6.5 — commentaire SANS mention → ignoré (filtre webhook fidèle), 0 Mistral", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { commentaire: "vu avec le client, il rappelle demain", memoire: [], commentaires: [] }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.type, "commentaire_ignore");
  assert.strictEqual(res.corps.statut, "ignore");
  assert.strictEqual(res.corps.appels_mistral, 0);
  assert.strictEqual(appelsMistral, 0);
  assert.ok(res.corps.journal.some((x) => x.etape === "webhook_commentaire_ignore"));
  verifierZeroEcriture();
});

test("B6.5 — question interne → réponse au collègue en commentaire, 1 Mistral, jamais au client", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    {
      commentaire: "@Agent IA ? où en est le dossier de ce client ?",
      telephone: "0620203963",
      memoire: [{ sortant: false, texte: "bonjour mon scooter ne démarre plus", ts: 1000 }],
      commentaires: [], persistant: { suivi_refs: [], consigne_vue: null }
    }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.type, "question_interne");
  assert.strictEqual(res.corps.statut, "consigne");
  assert.strictEqual(res.corps.appels_mistral, 1);
  assert.strictEqual(appelsMistral, 1);
  assert.strictEqual(res.corps.reponse, ""); // JAMAIS de réponse client sur une question interne
  assert.ok(res.corps.reponse_commentaire.length > 0); // la réponse AU COLLÈGUE
  assert.strictEqual(res.corps.actions_b42.length, 1);
  assert.strictEqual(res.corps.actions_b42[0].action, "commentaire");
  assert.ok(res.corps.journal.some((x) => x.etape === "consigne_question"));
  // persistant renvoyé : dédup armée pour le tour suivant
  assert.ok(res.corps.persistant.consigne_vue && res.corps.persistant.consigne_vue.cle);
  verifierZeroEcriture();
});

test("B6.5.1 — relais client « demande au client l'adresse » → message AU CLIENT, 1 Mistral, jamais un commentaire", async () => {
  reinitialise();
  reponseConforme = "Bonjour, l'équipe SAV a besoin de l'adresse d'intervention pour votre scooter. Quelle est l'adresse complète où le technicien doit se présenter ?\n-Agent IA U'mob-";
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    {
      commentaire: "@Agent IA demande au client l'adresse pour l'intervention",
      memoire: [{ sortant: false, texte: "bonjour mon scooter ne démarre plus", ts: 1000 }],
      commentaires: [], persistant: { suivi_refs: [], consigne_vue: null }
    }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.type, "relais_client");
  assert.strictEqual(res.corps.statut, "consigne");
  assert.strictEqual(res.corps.appels_mistral, 1);
  assert.strictEqual(appelsMistral, 1);
  assert.ok(res.corps.reponse.indexOf("adresse") !== -1, "le message est POUR LE CLIENT");
  assert.ok(res.corps.reponse.indexOf("-Agent IA U'mob-") !== -1, "signature présente");
  assert.strictEqual(res.corps.reponse_commentaire, "", "aucun commentaire interne sur un relais");
  assert.strictEqual(res.corps.actions_b42.length, 1);
  assert.strictEqual(res.corps.actions_b42[0].action, "envoyer_message");
  assert.strictEqual(res.corps.analyse.relais_client, true);
  assert.ok(res.corps.journal.some((x) => x.etape === "consigne_relais_client"));
  // persistant renvoyé : dédup armée pour le tour suivant
  assert.ok(res.corps.persistant.consigne_vue && res.corps.persistant.consigne_vue.cle);
  verifierZeroEcriture();
});

test("B6.5 — référence Praxedo citée → armement : cycle « En cours de réalisation » + compte-rendu, refs persistées", async () => {
  reinitialise();
  delete process.env.PRAXEDO_INTERVENTIONS_URL;
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    {
      commentaire: "@Agent IA l intervention EVE12345 est lancée chez Praxedo",
      memoire: [], commentaires: [], persistant: { suivi_refs: [], consigne_vue: null }
    }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.type, "armement");
  assert.strictEqual(res.corps.statut, "consigne");
  assert.strictEqual(res.corps.appels_mistral, 0);
  assert.strictEqual(appelsMistral, 0);
  const cycles = res.corps.actions_b42.filter((a) => a.action === "poser_cycle");
  assert.strictEqual(cycles.length, 1);
  assert.strictEqual(cycles[0].cycle, "En cours de réalisation");
  assert.ok(res.corps.reponse_commentaire.indexOf("EVE12345") !== -1);
  assert.ok(res.corps.reponse_commentaire.indexOf("indisponible") !== -1); // sans middleware configuré
  assert.deepStrictEqual(res.corps.persistant.suivi_refs, ["EVE12345"]);
  assert.ok(res.corps.journal.some((x) => x.etape === "consigne_armement"));
  verifierZeroEcriture();
});

test("B6.5 — reprise avec message client en attente → l'agent répond AU CLIENT (simulé)", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    {
      commentaire: "@Agent IA poursuis avec ce client",
      memoire: [
        { sortant: false, texte: "mon scooter ne démarre pas du tout, aidez-moi", ts: 1000 }
      ],
      commentaires: [], persistant: { suivi_refs: [], consigne_vue: null }
    }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.type, "reprise");
  assert.strictEqual(res.corps.statut, "traite");
  assert.strictEqual(appelsMistral, 1);
  assert.ok(res.corps.reponse.length > 0); // la réponse est POUR LE CLIENT
  assert.ok(res.corps.journal.some((x) => x.etape === "consigne_reprise"));
  verifierZeroEcriture();
});

test("B6.5 — consigne info pure → journalisée, silence, 0 Mistral", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    {
      commentaire: "@Agent IA le client a un accent du sud, il parle fort",
      memoire: [{ sortant: false, texte: "bonjour", ts: 1000 }, { sortant: true, texte: "Bonjour, comment puis-je vous aider ?\n-Agent IA U'mob-", ts: 2000 }],
      commentaires: [], persistant: { suivi_refs: [], consigne_vue: null }
    }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.type, "info");
  // Fidèle au portage : une consigne info retombe dans la chaîne NORMALE, qui
  // re-traite le dernier message ENTRANT de l'historique (v136 pareil).
  assert.strictEqual(res.corps.statut, "traite");
  assert.strictEqual(appelsMistral, 1);
  assert.ok(res.corps.journal.some((x) => x.etape === "consigne_info"));
  verifierZeroEcriture();
});

test("B6.5 — dédup : consigne identique < 15 min (persistant.consigne_vue) → ignorée", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    {
      commentaire: "@Agent IA test consigne dedup",
      memoire: [],
      commentaires: [],
      persistant: {
        suivi_refs: [],
        consigne_vue: { cle: null, ts: Date.now() - 60000 } // cle remplie par le serveur en prod de test ; ici le serveur la recalcule
      }
    }, "POST"), res);
  // premier envoi avec consigne_vue sans cle → pas de dédup (cle absente) :
  // on vérifie le mécanisme via un second appel avec la vraie cle renvoyée
  assert.strictEqual(res.statusCode, 200);
  const persistant2 = res.corps.persistant;
  assert.ok(persistant2.consigne_vue && persistant2.consigne_vue.cle);
  const res2 = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    {
      commentaire: "@Agent IA test consigne dedup",
      memoire: [],
      commentaires: [],
      persistant: persistant2
    }, "POST"), res2);
  assert.strictEqual(res2.statusCode, 200);
  assert.strictEqual(res2.corps.type, "dedup");
  assert.strictEqual(res2.corps.statut, "silence");
  assert.strictEqual(appelsMistral, 0);
  assert.ok(res2.corps.journal.some((x) => x.etape === "consigne_dedup"));
  verifierZeroEcriture();
});

test("B6.5 — plaque citée par un collègue → VALIDÉE (elle rejoint l'état, v2.20.58)", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    {
      commentaire: "@Agent IA c est bien le scooter GH-456-IJ",
      memoire: [{ sortant: false, texte: "bonjour mon scooter ne démarre pas", ts: 1000 }],
      commentaires: [], persistant: { suivi_refs: [], consigne_vue: null }
    }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.corps.etat.plaques.indexOf("GH456IJ") !== -1);
  assert.ok(res.corps.analyse.plaques.indexOf("GH456IJ") !== -1);
  verifierZeroEcriture();
});

test("B6.5 — la plaque du collègue persiste au message client SUIVANT (commentaires passés en contexte)", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    {
      message: "du coup vous avez trouvé ?",
      memoire: [{ sortant: false, texte: "mon scooter ne démarre pas", ts: 1000 }],
      commentaires: ["@Agent IA c est bien le scooter GH-456-IJ"],
      persistant: { suivi_refs: [], consigne_vue: null }
    }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.statut, "traite");
  assert.ok(res.corps.etat.plaques.indexOf("GH456IJ") !== -1);
  assert.ok(res.corps.journal.some((x) => x.etape === "consigne_detectee"));
  verifierZeroEcriture();
});

test("B6.5 — 400 si ni message ni commentaire", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { telephone: "0612345678", memoire: [] }, "POST"), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(String(res.corps.erreur).indexOf("vide") !== -1);
});

test("B6.5 — la page sert l'interface commentaire (champ + bouton + rendus)", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54"), res);
  assert.strictEqual(res.statusCode, 200);
  const html = String(res.html);
  assert.ok(html.indexOf("btn-commenter") !== -1);
  assert.ok(html.indexOf("Commentaire interne") !== -1);
  assert.ok(html.indexOf("carteCommentaire") !== -1);
  assert.ok(html.indexOf("envoyerCommentaire") !== -1);
});

// ============================================================================
// B6.6 — NOTATIONS 1-5 PAR TYPE DE RÈGLE (la boucle d'amélioration)
// ============================================================================

// INVARIANT B6.6/B6.7 : le bac à sable n'écrit chez Supabase QUE dans les
// tables d'apprentissage agent_sav.notations et agent_sav.lecons (POST insert
// notation, POST insert leçon, PATCH renfort/statut) et n'accède JAMAIS à
// respond.io. Toute autre écriture = régression.
function verifierZeroEcritureSaufApprentissage(nbAttendu) {
  const ecritures = appelsFetch.filter((a) => a.method !== "GET" &&
    String(a.url).indexOf("supabase.co") !== -1);
  const attendu = nbAttendu || 1;
  assert.strictEqual(ecritures.length, attendu,
    attendu + " écriture(s) Supabase attendue(s) : " + JSON.stringify(ecritures));
  for (const e of ecritures) {
    assert.ok(String(e.url).indexOf("/rest/v1/notations") !== -1 ||
      String(e.url).indexOf("/rest/v1/lecons") !== -1,
      "l'écriture doit viser agent_sav.notations ou agent_sav.lecons : " + e.url);
  }
  const respondio = appelsFetch.filter((a) => String(a.url).indexOf("respond.io") !== -1);
  assert.strictEqual(respondio.length, 0, "accès respond.io détecté");
}

test("B6.6 — POST {noter} valide → 201, ligne déposée dans agent_sav.notations (SEULE écriture)", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    {
      noter: {
        conversation_id: "conv-test-1",
        note: 4,
        type_regle: "ton",
        commentaire: "un peu guindé",
        tour: "t3",
        type_tour: "cerveau",
        message_client: "bonjour mon scooter ne démarre pas",
        reponse_agent: "Merci pour votre message."
      }
    }, "POST"), res);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.notation.note, 4);
  assert.strictEqual(res.corps.notation.type_regle, "ton");
  assert.strictEqual(res.corps.notation.conversation_id, "conv-test-1");
  assert.strictEqual(res.corps.notation.commentaire, "un peu guindé");
  assert.strictEqual(db.notations.length, 1, "la ligne doit atterrir dans la table");
  assert.strictEqual(db.notations[0].type_regle, "ton");
  verifierZeroEcritureSaufApprentissage(1);
});

test("B6.6 — notation refusée : note hors 1-5 (0, 6, abc, 3.5) → 400, ZÉRO écriture", async () => {
  for (const note of [0, 6, "abc", 3.5]) {
    reinitialise();
    const res = faireRes();
    await apiTest(requete("secret=secret-de-test-b54",
      { noter: { conversation_id: "conv-test-1", note: note, type_regle: "ton" } }, "POST"), res);
    assert.strictEqual(res.statusCode, 400, "note " + JSON.stringify(note) + " doit être refusée");
    assert.strictEqual(res.corps.ok, false);
    assert.ok(String(res.corps.erreur).indexOf("note") !== -1);
    assert.strictEqual(db.notations.length, 0, "rien ne doit atterrir dans la table");
    verifierZeroEcriture();
  }
});

test("B6.6 — notation refusée : type_regle inconnu → 400, ZÉRO écriture", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { noter: { conversation_id: "conv-test-1", note: 3, type_regle: "regle_inventee" } }, "POST"), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(String(res.corps.erreur).indexOf("type_regle") !== -1);
  assert.strictEqual(db.notations.length, 0);
  verifierZeroEcriture();
});

test("B6.6 — notation refusée : conversation_id manquant → 400, ZÉRO écriture", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { noter: { note: 3, type_regle: "ton" } }, "POST"), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(String(res.corps.erreur).indexOf("conversation_id") !== -1);
  assert.strictEqual(db.notations.length, 0);
  verifierZeroEcriture();
});

test("B6.6 — GET ?notations=1 → liste + résumé par règle (moyennes arrondies)", async () => {
  reinitialise();
  // trois notes seedées : ton 4 puis 2 (moyenne 3), invention 5
  db.notations = [
    { conversation_id: "c1", note: 4, type_regle: "ton", commentaire: "", tour: "", type_tour: "", message_client: "", reponse_agent: "", cree_a: "2026-10-23T08:00:00Z" },
    { conversation_id: "c1", note: 2, type_regle: "ton", commentaire: "", tour: "", type_tour: "", message_client: "", reponse_agent: "", cree_a: "2026-10-23T08:01:00Z" },
    { conversation_id: "c2", note: 5, type_regle: "invention", commentaire: "", tour: "", type_tour: "", message_client: "", reponse_agent: "", cree_a: "2026-10-23T08:02:00Z" }
  ];
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54&notations=1"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.notations.length, 3);
  assert.strictEqual(res.corps.resume.total, 3);
  assert.strictEqual(res.corps.resume.moyenne, 3.67); // (4+2+5)/3 = 3,666… → 3.67
  assert.strictEqual(res.corps.resume.par_regle.ton.nb, 2);
  assert.strictEqual(res.corps.resume.par_regle.ton.moyenne, 3);
  assert.strictEqual(res.corps.resume.par_regle.ton.libelle, "Ton / politesse");
  assert.strictEqual(res.corps.resume.par_regle.invention.nb, 1);
  assert.strictEqual(res.corps.resume.par_regle.invention.moyenne, 5);
  verifierZeroEcriture();
});

test("B6.6 — la page sert le menu conversations + le widget de notation", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54"), res);
  assert.strictEqual(res.statusCode, 200);
  const html = String(res.html);
  ["menu-conv", "btn-conv-new", "Nouvelle conversation", "brancherNoter",
   "optionsRegles", "fermerEtNouvelle"].forEach(function (marqueur) {
    assert.ok(html.indexOf(marqueur) !== -1, "la page servie doit contenir " + marqueur);
  });
  // les 15 types de règle sont injectés par le serveur (source unique TYPES_REGLES)
  ["Ton / politesse", "Plaque redemandée", "Consignes (question interne, relais, armement)", "Autre"].forEach(function (libelle) {
    assert.ok(html.indexOf(libelle) !== -1, "la page servie doit contenir le libellé « " + libelle + " »");
  });
});

// ============================================================================
// B6.7 — LEÇONS DE TERRAIN : injection ciblée par déclencheurs
// ============================================================================

test("B6.7 — POST {lecon} valide → 201, ligne dans agent_sav.lecons, occurrences seedées par les notations passées", async () => {
  reinitialise();
  // deux notations PASSÉES dont le commentaire cite « crevaison » → seed 2
  db.notations = [
    { conversation_id: "c1", note: 3, type_regle: "vocabulaire_voiture", commentaire: "tu dois demander lors d'une crevaison si avant ou arrière", tour: "", type_tour: "", message_client: "", reponse_agent: "", cree_a: "2026-10-23T08:00:00Z" },
    { conversation_id: "c2", note: 2, type_regle: "vocabulaire_voiture", commentaire: "crevaison : avant ou arrière ? demander !", tour: "", type_tour: "", message_client: "", reponse_agent: "", cree_a: "2026-10-23T08:05:00Z" },
    { conversation_id: "c3", note: 5, type_regle: "ton", commentaire: "parfait", tour: "", type_tour: "", message_client: "", reponse_agent: "", cree_a: "2026-10-23T08:06:00Z" }
  ];
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { lecon: { regle: "Crevaison : demander si le pneu est AVANT ou ARRIÈRE", declencheurs: "crevaison, pneu, crevé", portee: "generale" } }, "POST"), res);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.lecon.regle, "Crevaison : demander si le pneu est AVANT ou ARRIÈRE");
  assert.strictEqual(res.corps.lecon.declencheurs, "crevaison, pneu, crevé");
  assert.strictEqual(res.corps.lecon.portee, "generale");
  assert.strictEqual(res.corps.lecon.occurrences, 2, "le seed compte les notations passées citant un déclencheur");
  assert.strictEqual(res.corps.lecon.statut, "active");
  assert.strictEqual(db.lecons.length, 1, "la ligne doit atterrir dans la table");
  assert.strictEqual(db.lecons[0].occurrences, 2);
  verifierZeroEcritureSaufApprentissage(1);
});

test("B6.7 — leçon refusée : regle manquante → 400, ZÉRO écriture", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { lecon: { declencheurs: "crevaison", portee: "generale" } }, "POST"), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(String(res.corps.erreur).indexOf("regle") !== -1);
  assert.strictEqual(db.lecons.length, 0);
  verifierZeroEcriture();
});

test("B6.7 — leçon refusée : portee invalide → 400, ZÉRO écriture", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { lecon: { regle: "toujours signer", portee: "univers" } }, "POST"), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(String(res.corps.erreur).indexOf("portee") !== -1);
  assert.strictEqual(db.lecons.length, 0);
  verifierZeroEcriture();
});

test("B6.7 — leçon refusée : portee client sans contact_id → 400, ZÉRO écriture", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { lecon: { regle: "ce client préfère être appelé", portee: "client" } }, "POST"), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(String(res.corps.erreur).indexOf("contact_id") !== -1);
  assert.strictEqual(db.lecons.length, 0);
  verifierZeroEcriture();
});

test("B6.7 — POST {noter} dont le commentaire cite un déclencheur → 201 + RENFORCEMENT (PATCH occurrences+1)", async () => {
  reinitialise();
  db.lecons = [{
    id: "lecon-1",
    regle: "Crevaison : demander si le pneu est AVANT ou ARRIÈRE",
    declencheurs: "crevaison, pneu, crevé",
    portee: "generale",
    contact_id: null,
    occurrences: 1,
    statut: "active"
  }];
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { noter: { conversation_id: "conv-x", note: 3, type_regle: "vocabulaire_voiture", commentaire: "tu dois demander lors d'une crevaison si avant ou arrière" } }, "POST"), res);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.lecons_renforcees.length, 1, "la leçon crevaison doit être renforcée");
  assert.strictEqual(res.corps.lecons_renforcees[0].id, "lecon-1");
  assert.strictEqual(res.corps.lecons_renforcees[0].occurrences, 2, "1 + 1 renfort");
  assert.strictEqual(db.lecons[0].occurrences, 2, "le PATCH a bien incrémenté la ligne");
  assert.strictEqual(db.notations.length, 1, "la note est déposée AUSSI");
  // écritures : POST notations + PATCH lecons — et RIEN d'autre
  verifierZeroEcritureSaufApprentissage(2);
});

test("B6.7 — POST {noter} sans lien avec une leçon → 201, ZÉRO renfort (pas de PATCH gratuit)", async () => {
  reinitialise();
  db.lecons = [{
    id: "lecon-1", regle: "Crevaison : demander avant ou arrière", declencheurs: "crevaison",
    portee: "generale", contact_id: null, occurrences: 1, statut: "active"
  }];
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { noter: { conversation_id: "conv-x", note: 5, type_regle: "ton", commentaire: "parfait, rien à dire" } }, "POST"), res);
  assert.strictEqual(res.statusCode, 201);
  assert.strictEqual(res.corps.lecons_renforcees.length, 0);
  assert.strictEqual(db.lecons[0].occurrences, 1, "occurrences inchangées");
  verifierZeroEcritureSaufApprentissage(1); // juste le POST notations
});

test("B6.7 — GET ?lecons=1 → la liste des leçons (tous statuts)", async () => {
  reinitialise();
  db.lecons = [
    { id: "lecon-2", regle: "Crevaison : avant ou arrière", declencheurs: "crevaison", portee: "generale", contact_id: null, occurrences: 2, statut: "active", creee_a: "2026-10-23T09:00:00Z", maj_a: "2026-10-23T09:00:00Z" },
    { id: "lecon-1", regle: "Toujours proposer un prêt de scooter", declencheurs: "", portee: "generale", contact_id: null, occurrences: 1, statut: "annulee", creee_a: "2026-10-22T09:00:00Z", maj_a: "2026-10-22T09:00:00Z" }
  ];
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54&lecons=1"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.lecons.length, 2);
  assert.strictEqual(res.corps.lecons[0].regle, "Crevaison : avant ou arrière");
  assert.strictEqual(res.corps.lecons[1].statut, "annulee", "tous statuts listés");
  verifierZeroEcriture();
});

test("B6.7 — {lecon_action} statut valide → 200 (annulee) / statut invalide → 400", async () => {
  // valide
  reinitialise();
  db.lecons = [{ id: "lecon-1", regle: "Crevaison : avant ou arrière", declencheurs: "crevaison", portee: "generale", contact_id: null, occurrences: 1, statut: "active", maj_a: "" }];
  let res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { lecon_action: { id: "lecon-1", statut: "validee" } }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.lecon_action.statut, "validee");
  assert.strictEqual(db.lecons[0].statut, "validee", "le PATCH a changé le statut");
  verifierZeroEcritureSaufApprentissage(1);
  // invalide
  reinitialise();
  db.lecons = [{ id: "lecon-1", regle: "x", declencheurs: "", portee: "generale", contact_id: null, occurrences: 1, statut: "active", maj_a: "" }];
  res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { lecon_action: { id: "lecon-1", statut: "archivee" } }, "POST"), res);
  assert.strictEqual(res.statusCode, 400);
  assert.ok(String(res.corps.erreur).indexOf("statut") !== -1);
  assert.strictEqual(db.lecons[0].statut, "active", "rien ne change");
  verifierZeroEcriture();
});

test("B6.7 — échange « j'ai une crevaison » avec leçon seedée → leçon INJECTÉE dans le prompt du cerveau", async () => {
  reinitialise();
  db.lecons = [{
    id: "lecon-1",
    regle: "Crevaison : demander si le pneu est AVANT ou ARRIÈRE",
    declencheurs: "crevaison, pneu, crevé",
    portee: "generale",
    contact_id: null,
    occurrences: 1,
    statut: "active"
  }];
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "bonjour j'ai une crevaison sur mon scooter", memoire: [] }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.ok, true);
  assert.strictEqual(res.corps.lecons_appliquees.length, 1);
  assert.ok(res.corps.lecons_appliquees[0].indexOf("AVANT ou ARRIÈRE") !== -1);
  assert.strictEqual(appelsMistral, 1);
  assert.strictEqual(corpsMistral.length, 1);
  assert.ok(corpsMistral[0].indexOf("AVANT ou ARRIÈRE") !== -1, "la leçon est dans le prompt envoyé à Mistral");
  assert.ok(corpsMistral[0].indexOf("=== LE") !== -1, "le crochet LEÇONS est présent dans le prompt");
  verifierZeroEcriture(); // un échange n'écrit JAMAIS chez Supabase
});

test("B6.7 — échange SANS le mot-clé → leçon ciblée absente du prompt (injection ciblée, pas permanente)", async () => {
  reinitialise();
  db.lecons = [{
    id: "lecon-1",
    regle: "Crevaison : demander si le pneu est AVANT ou ARRIÈRE",
    declencheurs: "crevaison, pneu, crevé",
    portee: "generale",
    contact_id: null,
    occurrences: 1,
    statut: "active"
  }];
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "bonjour mon scooter ne démarre pas", memoire: [] }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.lecons_appliquees.length, 0, "pas de crevaison → pas de leçon");
  assert.strictEqual(corpsMistral.length, 1);
  assert.ok(corpsMistral[0].indexOf("AVANT ou ARRIÈRE") === -1, "la leçon ne doit PAS polluer le prompt");
  verifierZeroEcriture();
});

test("B6.7 — leçon SANS déclencheurs → appliquée à CHAQUE tour (comportement B6.3 inchangé)", async () => {
  reinitialise();
  db.lecons = [{
    id: "lecon-2", regle: "Toujours proposer un scooter de prêt si immobilisation", declencheurs: "",
    portee: "generale", contact_id: null, occurrences: 1, statut: "active"
  }];
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54",
    { message: "bonjour", memoire: [] }, "POST"), res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.lecons_appliquees.length, 1);
  assert.ok(corpsMistral[0].indexOf("scooter de prêt") !== -1);
  verifierZeroEcriture();
});

test("B6.7 — la page sert la carte Leçons de terrain (liste, création, statuts)", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54"), res);
  assert.strictEqual(res.statusCode, 200);
  const html = String(res.html);
  ["Leçons de terrain", "liste-lecons", "btn-lecon-new", "lecon-texte",
   "lecon-declencheurs", "lecon-portee", "chargerLecons", "ajouterLecon",
   "actionLecon", "rendreLecons"].forEach(function (marqueur) {
    assert.ok(html.indexOf(marqueur) !== -1, "la page servie doit contenir " + marqueur);
  });
});

test("B6.7.1 — la page sert le localStorage des conversations (sauvegarde, restauration, purge)", async () => {
  reinitialise();
  const res = faireRes();
  await apiTest(requete("secret=secret-de-test-b54"), res);
  assert.strictEqual(res.statusCode, 200);
  const html = String(res.html);
  ["localStorage", "CLE_STOCKAGE", "sauvegarderSession", "restaurerSession",
   "effacerHistorique", "btn-conv-purge", "Effacer l'historique",
   "survit au rechargement"].forEach(function (marqueur) {
    assert.ok(html.indexOf(marqueur) !== -1, "la page servie doit contenir " + marqueur);
  });
  // la clé est VERSIONNÉE : un futur changement de format ne restaurera pas
  // des données illisibles (retour console vierge)
  assert.ok(html.indexOf("agent-sav-console-conversations-v1") !== -1,
    "la clé de stockage doit être versionnée");
  // restauration DÉFENSIVE : JSON corrompu → console vierge, jamais plantée
  assert.ok(html.indexOf("catch") !== -1);
});

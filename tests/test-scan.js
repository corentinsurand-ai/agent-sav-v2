// ============================================================================
// Agent SAV U'mob v2 — B6.4 : tests du scan horaire /api/scan (node --test)
// Exécution : node --test tests/test-scan.js
// (aucune dépendance : Supabase, respond.io, middleware Praxedo et Resend
// sont SIMULÉS via fetch)
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

// --- Environnement de test AVANT tout require --------------------------------
process.env.WEBHOOK_SECRET = "secret-de-test-scan";
process.env.CRON_SECRET = "cron-de-test-scan";
process.env.SUPABASE_URL = "https://umob-crm.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "cle-service-test";
process.env.RESPONDIO_TOKEN = "respondio-token-test";
process.env.PRAXEDO_INTERVENTIONS_URL = "https://middleware.test/praxedo";

delete process.env.MODE_AGENT;
delete process.env.B42_EXECUTION;
delete process.env.RESEND_API_KEY;

const apiScan = require("../lib/scan-route.js");

// --- État simulé --------------------------------------------------------------
let dbDossiers = {};        // contact_id → {contact_id, etat, cycle_actuel, maj_a}
let dbJournal = [];         // lignes {contact_id, etape, texte, detail, horodatage}
let appelsFetch = [];       // {url, method}
let appelsResend = [];
let reponsesMiddleware = [];// file : réponse du middleware par référence

const MAINTENANT = 1792700000000;

function reinitialise() {
  dbDossiers = {};
  dbJournal = [];
  appelsFetch = [];
  appelsResend = [];
  reponsesMiddleware = [];
  delete process.env.MODE_AGENT;
  delete process.env.B42_EXECUTION;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.ALERT_EMAIL;
}

function json(status, corps) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(corps) };
}

function itemRespondio(o) {
  return {
    messageId: o.ts * 1000 + 519,
    traffic: o.sortant ? "outgoing" : "incoming",
    message: { text: o.texte || "" },
    sender: { source: o.humain ? "user" : (o.sortant ? "api" : "contact") },
    status: o.sortant ? [{ timestamp: o.ts, value: "sent" }] : []
  };
}

// Fiches respond.io : cycle + tags paramétrables par test
let fiches = {};
let historiques = {};

function paramsDe(url) {
  const u = new URL(url);
  const p = {};
  u.searchParams.forEach((v, k) => { p[k] = v; });
  return { chemin: u.pathname, params: p };
}

globalThis.fetch = async function (url, options) {
  url = String(url);
  options = options || {};
  appelsFetch.push({ url: url, method: options.method || "GET", body: options.body || null });

  // ---- respond.io (fiche / historique / commentaires) ----------------------
  if (url.indexOf("api.respond.io") !== -1) {
    const m = url.match(/\/contact\/id:([^/?]+)(\/message\/list|\/comment)?/);
    const id = m ? m[1] : "";
    if (m && m[2] === "/message/list") return json(200, { items: (historiques[id] || []).slice() });
    if (m && m[2] === "/comment") return { status: 404, ok: false, text: async () => "not found" };
    return json(200, fiches[id] || { fullName: "Contact " + id, lifecycle: {}, tags: [] });
  }

  // ---- middleware Praxedo ---------------------------------------------------
  if (url.indexOf("middleware.test") !== -1) {
    const { params } = paramsDe(url);
    const ref = params.reference;
    const r = reponsesMiddleware.length ? reponsesMiddleware.shift() : { found: true, interventions: [{ reference: ref, statut_code: "DONE" }] };
    if (r.reject) return { status: 500, ok: false, text: async () => "boom" };
    return json(200, r);
  }

  // ---- Resend ---------------------------------------------------------------
  if (url.indexOf("api.resend.com") !== -1) {
    appelsResend.push(JSON.parse(options.body));
    return json(200, { id: "email-1" });
  }

  // ---- Supabase -------------------------------------------------------------
  if (url.indexOf("umob-crm.supabase.co") !== -1) {
    const { chemin, params } = paramsDe(url);
    const table = chemin.split("/rest/v1/")[1];
    const corps = options.body ? JSON.parse(options.body) : null;

    if (table === "dossiers" && options.method === "POST") {
      dbDossiers[corps.contact_id] = Object.assign(
        dbDossiers[corps.contact_id] || { contact_id: corps.contact_id, cycle_actuel: "Nouvelle Demande" },
        corps
      );
      return { status: 201, ok: true, text: async () => "" };
    }
    if (table === "dossiers") {
      let out = Object.keys(dbDossiers).map((k) => dbDossiers[k]);
      if (params["contact_id"]) out = out.filter((r) => r.contact_id === params["contact_id"].slice(3));
      if (params["order"] && params["order"].indexOf("desc") !== -1) {
        out = out.slice().sort((a, b) => String(b.maj_a || "").localeCompare(String(a.maj_a || "")));
      }
      if (params["limit"]) out = out.slice(0, parseInt(params["limit"], 10));
      return json(200, out);
    }
    if (table === "journal" && options.method === "POST") {
      dbJournal.push(Object.assign({ horodatage: new Date().toISOString() }, corps));
      return { status: 201, ok: true, text: async () => "" };
    }
    if (table === "journal") {
      let out = dbJournal.filter((r) => r.etape === (params["etape"] || "").slice(3));
      if (params["order"] && params["order"].indexOf("desc") !== -1) {
        out = out.slice().sort((a, b) => String(b.horodatage || "").localeCompare(String(a.horodatage || "")));
      }
      if (params["limit"]) out = out.slice(0, parseInt(params["limit"], 10));
      return json(200, out);
    }
    return json(404, { error: "table inconnue " + table });
  }

  throw new Error("URL non simulée : " + url);
};

function faireRes() {
  return {
    statusCode: null,
    corps: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.corps = obj; return this; },
    end() { return this; }
  };
}

function requete(query, headers, methode) {
  return {
    method: methode || "GET",
    url: "/api/scan" + (query ? "?" + query : ""),
    query: query ? Object.fromEntries(new URLSearchParams(query)) : {},
    headers: headers || {}
  };
}

function ecrituresRespondio() {
  return appelsFetch.filter((a) => a.url.indexOf("api.respond.io") !== -1 && a.method !== "GET");
}

function journalEtape(etape) {
  return dbJournal.filter((j) => j.etape === etape);
}

// ============================ AUTHENTIFICATION ================================
test("sans secret → 401", async () => {
  reinitialise();
  const r = await apiScan(requete(""), faireRes());
  assert.strictEqual(r.statusCode, 401);
  assert.strictEqual(r.corps.erreur, "secret invalide");
});

test("Bearer CRON_SECRET accepté (déclenchement cron externe)", async () => {
  reinitialise();
  const r = await apiScan(requete("", { authorization: "Bearer cron-de-test-scan" }), faireRes());
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.corps.version, "B6.4.2");
});

// ============================ ATTENTE CLIENT ==================================
test("observation : question au client sans réponse ≥ 2 h → journalisée, AUCUNE écriture respond.io", async () => {
  reinitialise();
  dbDossiers["c1"] = { contact_id: "c1", etat: {}, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "A qualifier" }, tags: [] };
  historiques["c1"] = [
    itemRespondio({ ts: MAINTENANT - 4 * 3600000, texte: "Bonjour" }),
    itemRespondio({ ts: MAINTENANT - 3 * 3600000, texte: "Quelle est l'immatriculation du scooter concerné, s'il vous plaît ?", sortant: true })
  ];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT), faireRes());
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.corps.mode, "observation");
  assert.strictEqual(r.corps.arme, false);
  assert.ok(r.corps.decisions.some((d) => d.decision === "attente_client"));
  assert.ok(journalEtape("scan_attente_client").length === 1);
  assert.strictEqual(ecrituresRespondio().length, 0, "aucune écriture respond.io en observation");
});

test("actif ARMÉ : attente client → cycle « Attente client » POSÉ chez respond.io", async () => {
  reinitialise();
  process.env.MODE_AGENT = "actif";
  process.env.B42_EXECUTION = "1";
  dbDossiers["c1"] = { contact_id: "c1", etat: {}, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "A qualifier" }, tags: [] };
  historiques["c1"] = [
    itemRespondio({ ts: MAINTENANT - 4 * 3600000, texte: "Bonjour" }),
    itemRespondio({ ts: MAINTENANT - 3 * 3600000, texte: "Quelle est l'immatriculation du scooter ?", sortant: true })
  ];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT), faireRes());
  assert.strictEqual(r.corps.arme, true);
  const cycles = appelsFetch.filter((a) => a.url.indexOf("/lifecycle/update") !== -1);
  assert.strictEqual(cycles.length, 1);
  assert.strictEqual(JSON.parse(cycles[0].body).name, "Attente client");
  assert.ok(journalEtape("scan_execute").length === 1);
});

test("le client a répondu (< 2 h) → rien à poser", async () => {
  reinitialise();
  dbDossiers["c1"] = { contact_id: "c1", etat: {}, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "A qualifier" }, tags: [] };
  historiques["c1"] = [
    itemRespondio({ ts: MAINTENANT - 3 * 3600000, texte: "Quelle est l'immatriculation ?", sortant: true }),
    itemRespondio({ ts: MAINTENANT - 30 * 60000, texte: "GG-798-NL" })
  ];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT), faireRes());
  assert.strictEqual(r.corps.decisions.length, 0);
  assert.strictEqual(journalEtape("scan_attente_client").length, 0);
});

// ============================ SUIVI PRAXEDO ===================================
test("actif ARMÉ : TOUTES les interventions réalisées → « Traitée » + conversation fermée + dossier purgé", async () => {
  reinitialise();
  process.env.MODE_AGENT = "actif";
  process.env.B42_EXECUTION = "1";
  dbDossiers["c1"] = { contact_id: "c1", etat: { suivi_refs: ["EVE05189"] }, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "En cours de réalisation" }, tags: [] };
  historiques["c1"] = [itemRespondio({ ts: MAINTENANT - 86400000, texte: "ok" })];
  reponsesMiddleware = [{ found: true, interventions: [{ reference: "EVE05189", statut_code: "DONE" }] }];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT), faireRes());
  assert.ok(r.corps.decisions.some((d) => d.decision === "praxedo_terminee"));
  assert.ok(journalEtape("scan_praxedo_terminee").length === 1);
  const cycles = appelsFetch.filter((a) => a.url.indexOf("/lifecycle/update") !== -1);
  assert.strictEqual(cycles.length, 1);
  assert.strictEqual(JSON.parse(cycles[0].body).name, "Traitée");
  assert.ok(appelsFetch.some((a) => a.url.indexOf("/conversation/close") !== -1), "conversation fermée");
  assert.deepStrictEqual(dbDossiers["c1"].etat, {}, "dossier purgé");
});

test("throttle 2 h : dossier vérifié il y a moins de 2 h → AUCUN appel middleware", async () => {
  reinitialise();
  dbDossiers["c1"] = { contact_id: "c1", etat: { suivi_refs: ["EVE05189"], ts_check_praxedo: MAINTENANT - 30 * 60000 }, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "En cours de réalisation" }, tags: [] };
  historiques["c1"] = [];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT), faireRes());
  assert.strictEqual(appelsFetch.filter((a) => a.url.indexOf("middleware.test") !== -1).length, 0);
  assert.strictEqual(journalEtape("scan_praxedo_terminee").length, 0);
});

test("intervention EN COURS → JAMAIS purgée, journal scan_praxedo_en_cours", async () => {
  reinitialise();
  dbDossiers["c1"] = { contact_id: "c1", etat: { suivi_refs: ["EVE05189"] }, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "En cours de réalisation" }, tags: [] };
  historiques["c1"] = [];
  reponsesMiddleware = [{ found: true, interventions: [{ reference: "EVE05189", statut_code: "PLANNED" }] }];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT), faireRes());
  assert.strictEqual(journalEtape("scan_praxedo_en_cours").length, 1);
  assert.strictEqual(journalEtape("scan_praxedo_terminee").length, 0);
  assert.ok(dbDossiers["c1"].etat.ts_check_praxedo === MAINTENANT, "le throttle est consommé");
});

test("middleware en ERREUR → JAMAIS purgée (erreur ≠ réalisée)", async () => {
  reinitialise();
  dbDossiers["c1"] = { contact_id: "c1", etat: { suivi_refs: ["EVE05189"] }, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "En cours de réalisation" }, tags: [] };
  historiques["c1"] = [];
  reponsesMiddleware = [{ reject: "boom" }];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT), faireRes());
  assert.strictEqual(journalEtape("scan_praxedo_terminee").length, 0);
  assert.strictEqual(journalEtape("scan_praxedo_en_cours").length, 1);
});

// ============================ REPRISE-DE-ZÉRO =================================
test("observation : dossier « Traitée » → purge JOURNALISÉE seulement (v2.20.64)", async () => {
  reinitialise();
  dbDossiers["c1"] = { contact_id: "c1", etat: { panne: "vieille panne" }, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "Traitée" }, tags: ["Prise de main"] };
  historiques["c1"] = [];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT), faireRes());
  assert.ok(r.corps.decisions.some((d) => d.decision === "reprise_de_zero"));
  assert.ok(journalEtape("scan_reprise_de_zero").length === 1);
  assert.strictEqual(ecrituresRespondio().length, 0, "observation : aucune écriture");
  assert.ok(dbDossiers["c1"].etat.panne === "vieille panne", "le dossier n'est PAS purgé en observation");
});

test("actif ARMÉ : dossier « Traitée » → dossier purgé + tag « Prise de main » retiré", async () => {
  reinitialise();
  process.env.MODE_AGENT = "actif";
  process.env.B42_EXECUTION = "1";
  dbDossiers["c1"] = { contact_id: "c1", etat: { panne: "vieille panne" }, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "Traitée" }, tags: ["Prise de main"] };
  historiques["c1"] = [];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT), faireRes());
  assert.deepStrictEqual(dbDossiers["c1"].etat, {}, "dossier purgé");
  const tags = appelsFetch.filter((a) => a.url.indexOf("/tag") !== -1 && a.method === "DELETE");
  assert.strictEqual(tags.length, 1);
  assert.deepStrictEqual(JSON.parse(tags[0].body), ["Prise de main"]);
});

// ============================ RETRAIT DU TAG ≥ 2 h ============================
test("actif ARMÉ : tag posé il y a ≥ 2 h sur état observé → tag retiré", async () => {
  reinitialise();
  process.env.MODE_AGENT = "actif";
  process.env.B42_EXECUTION = "1";
  dbDossiers["c1"] = { contact_id: "c1", etat: { tag_pdm_ts: MAINTENANT - 3 * 3600000 }, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "En cours de traitement" }, tags: ["Prise de main"] };
  historiques["c1"] = [];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT), faireRes());
  assert.ok(r.corps.decisions.some((d) => d.decision === "retrait_tag"));
  const tags = appelsFetch.filter((a) => a.url.indexOf("/tag") !== -1 && a.method === "DELETE");
  assert.strictEqual(tags.length, 1);
});

test("tag posé il y a < 2 h → conservé (journal scan_tag_conserve)", async () => {
  reinitialise();
  dbDossiers["c1"] = { contact_id: "c1", etat: { tag_pdm_ts: MAINTENANT - 30 * 60000 }, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "En cours de traitement" }, tags: ["Prise de main"] };
  historiques["c1"] = [];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT), faireRes());
  assert.strictEqual(journalEtape("scan_tag_conserve").length, 1);
  assert.strictEqual(ecrituresRespondio().length, 0);
});

// ============================ DIGEST ==========================================
test("B6.4.2 — observation : digest ENVOYÉ AUSSI (notification pure, AUCUNE écriture respond.io)", async () => {
  reinitialise();
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "sav@umob.fr";
  process.env.ALERT_EMAIL = "service.technique@umob.fr";
  dbDossiers["c1"] = { contact_id: "c1", etat: {}, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "A qualifier" }, tags: ["Prise de main"] };
  historiques["c1"] = [];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT + "&heure=10"), faireRes());
  assert.strictEqual(r.corps.mode, "observation", "le scan reste en observation");
  assert.strictEqual(r.corps.digest.prises, 1);
  assert.strictEqual(r.corps.digest.envoye, true);
  assert.strictEqual(appelsResend.length, 1);
  assert.strictEqual(appelsResend[0].to[0], "service.technique@umob.fr", "destinataire ALERT_EMAIL");
  assert.strictEqual(dbDossiers["c1"].etat.digest_consolide, true, "prise consolidée après envoi");
  assert.ok(journalEtape("digest_envoye").length === 1);
  assert.strictEqual(journalEtape("digest_prevu").length, 0, "plus de digest_prevu en B6.4.2");
  // INVARIANT inchangé : le digest en observation ne débloque AUCUNE écriture respond.io
  const ecritures = appelsFetch.filter(function (a) {
    return a.url.indexOf("api.respond.io") !== -1 && a.method !== "GET";
  });
  assert.strictEqual(ecritures.length, 0, "aucune écriture respond.io en observation");
});

test("B6.4.2 — digest sans RESEND_API_KEY (non configuré) → journal digest_non_envoye, dossiers NON consolidés", async () => {
  reinitialise();
  dbDossiers["c1"] = { contact_id: "c1", etat: {}, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "A qualifier" }, tags: ["Prise de main"] };
  historiques["c1"] = [];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT + "&heure=10"), faireRes());
  assert.strictEqual(r.corps.digest.envoye, false);
  assert.ok(r.corps.digest.raison.indexOf("RESEND_API_KEY") !== -1, "la raison cite la config manquante");
  assert.ok(journalEtape("digest_non_envoye").length === 1);
  assert.ok(!dbDossiers["c1"].etat.digest_consolide, "NON consolidé — repassera au prochain scan (jamais perdu)");
});

test("actif ARMÉ : digest ENVOYÉ via Resend + dossiers marqués digest_consolide", async () => {
  reinitialise();
  process.env.MODE_AGENT = "actif";
  process.env.B42_EXECUTION = "1";
  process.env.RESEND_API_KEY = "re_test";
  process.env.EMAIL_FROM = "sav@umob.fr";
  process.env.ALERT_EMAIL = "equipe@example.fr";
  dbDossiers["c1"] = { contact_id: "c1", etat: {}, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "A qualifier" }, tags: ["Prise de main"] };
  historiques["c1"] = [];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT + "&heure=10"), faireRes());
  assert.strictEqual(r.corps.digest.envoye, true);
  assert.strictEqual(appelsResend.length, 1);
  assert.ok(appelsResend[0].subject.indexOf("prises de main") !== -1);
  assert.ok(appelsResend[0].text.indexOf("Client Un (contact c1)") !== -1);
  assert.strictEqual(dbDossiers["c1"].etat.digest_consolide, true, "prise consolidée après envoi");
  assert.ok(journalEtape("digest_envoye").length === 1);
});

test("digest hors fenêtre 9h-18h → DIFFÉRÉ, jamais perdu (journal digest_differe)", async () => {
  reinitialise();
  dbDossiers["c1"] = { contact_id: "c1", etat: {}, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "A qualifier" }, tags: ["Prise de main"] };
  historiques["c1"] = [];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT + "&heure=20"), faireRes());
  assert.strictEqual(r.corps.digest.envoye, false);
  assert.ok(journalEtape("digest_differe").length === 1);
  assert.strictEqual(appelsResend.length, 0);
  assert.ok(!dbDossiers["c1"].etat.digest_consolide, "la prise reste non consolidée (repasse au prochain scan)");
});

test("dernier digest < 45 min → rien à envoyer (journal digest_attente)", async () => {
  reinitialise();
  dbJournal.push({ etape: "digest_envoye", horodatage: new Date(MAINTENANT - 10 * 60000).toISOString() });
  dbDossiers["c1"] = { contact_id: "c1", etat: {}, maj_a: "2026-10-22T10:00:00Z" };
  fiches["c1"] = { fullName: "Client Un", lifecycle: { name: "A qualifier" }, tags: ["Prise de main"] };
  historiques["c1"] = [];
  const r = await apiScan(requete("secret=secret-de-test-scan&maintenant=" + MAINTENANT + "&heure=10"), faireRes());
  assert.strictEqual(r.corps.digest.envoye, false);
  assert.ok(journalEtape("digest_attente").length === 1);
  assert.strictEqual(appelsResend.length, 0);
});

test("?contact= filtre le scan sur UN dossier", async () => {
  reinitialise();
  dbDossiers["c1"] = { contact_id: "c1", etat: {}, maj_a: "2026-10-22T10:00:00Z" };
  dbDossiers["c2"] = { contact_id: "c2", etat: {}, maj_a: "2026-10-22T11:00:00Z" };
  fiches["c1"] = fiches["c2"] = { fullName: "X", lifecycle: { name: "A qualifier" }, tags: [] };
  historiques["c1"] = historiques["c2"] = [];
  const r = await apiScan(requete("secret=secret-de-test-scan&contact=c1&maintenant=" + MAINTENANT), faireRes());
  assert.strictEqual(r.corps.dossiers, 1);
});

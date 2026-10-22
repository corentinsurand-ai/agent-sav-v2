// ============================================================================
// Agent SAV U'mob v2 — B5 : tests de l'écran de comparaison (node --test)
// Exécution : node --test tests/test-observations.js
// (~15 tests — aucune dépendance : Supabase et respond.io SIMULÉS)
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

// --- Environnement de test AVANT tout require --------------------------------
process.env.WEBHOOK_SECRET = "secret-de-test-b5";
process.env.SUPABASE_URL = "https://umob-crm.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "cle-service-test";
process.env.RESPONDIO_TOKEN = "respondio-token-test";

const comparaison = require("../lib/comparaison.js");

// ============================================================================
// SIMULATIONS — fetch global : Supabase (journal) + respond.io (lecture)
// ============================================================================
let appelsFetch = [];
let dbJournal = [];
let panneRespondio = null;

// 2026-10-22T15:40:00Z = 1792683600000 ms — repère des scénarios
const T_CLIENT = 1792683600000;

function itemRespondio(o) {
  return {
    messageId: o.ts * 1000 + 519,
    traffic: o.sortant ? "outgoing" : "incoming",
    message: { text: o.texte || "" },
    sender: { source: o.humain ? "user" : (o.sortant ? "api" : "contact") },
    status: o.sortant ? [{ timestamp: o.ts, value: "sent" }] : []
  };
}

const fiches = {
  "547249072": { fullName: "PIZZA SERVICES ETAMPES", lifecycle: {}, tags: [] }
};

const historiques = {
  "547249072": [
    itemRespondio({ ts: 1792683590000, texte: "Bonjour, mon scooter GG-798-NL ne démarre pas" }),
    itemRespondio({ ts: 1792683595000, texte: "Merci, nous prenons en charge votre demande.", sortant: true }),
    itemRespondio({ ts: T_CLIENT, texte: "Finalement il ne démarre plus du tout" }),
    itemRespondio({ ts: 1792683605000, texte: "C est noté, un technicien regarde votre dossier.", sortant: true }),
    itemRespondio({ ts: 1792683610000, texte: "Encore une info : le voyant est rouge" }) // APRÈS l'observation
  ]
};

function observation(contactId, reponse, horodatage, extra) {
  return {
    contact_id: contactId,
    horodatage: horodatage || "2026-10-22T15:40:01.000Z",
    etape: "observation",
    detail: Object.assign({ reponse: reponse, envoyee: false, escalade: false, raison_escalade: "", appels_mistral: 1 }, extra || {})
  };
}

function json(status, corps) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(corps) };
}

globalThis.fetch = async function (url, options) {
  url = String(url);
  options = options || {};
  appelsFetch.push({ url, method: options.method || "GET" });

  if (url.indexOf("api.respond.io") !== -1) {
    const m = url.match(/\/contact\/id:([^/?]+)(\/message\/list|\/comment)?/);
    const idContact = m ? m[1] : "";
    if (m && m[2] === "/message/list") {
      if (panneRespondio) return { status: 500, ok: false, text: async () => "boom" };
      return json(200, { items: (historiques[idContact] || []).slice() });
    }
    if (m && m[2] === "/comment") return { status: 404, ok: false, text: async () => "not found" };
    return json(200, fiches[idContact] || { fullName: "Contact " + idContact, lifecycle: {}, tags: [] });
  }

  if (url.indexOf("umob-crm.supabase.co") !== -1) {
    const u = new URL(url);
    const table = u.pathname.split("/rest/v1/")[1];
    const limit = parseInt(u.searchParams.get("limit") || "15", 10);
    if (table === "journal") {
      assert.ok(u.search.indexOf("etape=eq.observation") !== -1, "le filtre observation doit être présent");
      const desc = (u.searchParams.get("order") || "").indexOf("desc") !== -1;
      let rows = dbJournal.filter((r) => r.etape === "observation");
      rows = rows.slice().sort((a, b) => (a.horodatage < b.horodatage ? 1 : a.horodatage > b.horodatage ? -1 : 0));
      if (!desc) rows = rows.reverse();
      return json(200, rows.slice(0, limit));
    }
    return json(404, { error: "table inconnue" });
  }

  throw new Error("URL non simulée : " + url);
};

function faireRes() {
  return {
    statusCode: null,
    corps: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.corps = obj; return this; },
    send(c) { this.corps = c; return this; },
    end() { return this; }
  };
}

function requete(query) {
  return {
    method: "GET",
    url: "/api/observations" + (query ? "?" + query : ""),
    query: query ? Object.fromEntries(new URLSearchParams(query)) : {},
    headers: {}
  };
}

const apiObservations = require("../api/observations.js");

function reinitialise() {
  appelsFetch = [];
  dbJournal = [];
  panneRespondio = null;
}

// ============================================================================
// 1. lib/comparaison.js — LE MOTEUR (pur)
// ============================================================================

function msgN(o) {
  return { id: "x", ts: o.ts, emis_a: new Date(o.ts).toISOString(), texte: o.texte || "", media: o.media || "", type_media: o.type_media || null, sortant: !!o.sortant, humain: !!o.humain };
}

function contexteDe(messages) {
  return { contact: { nom: "PIZZA SERVICES ETAMPES", cycle: "", tags: [] }, messages: messages, commentaires: [], avertissements: [] };
}

const filReel = [
  msgN({ ts: 1792683590000, texte: "Bonjour, mon scooter GG-798-NL ne démarre pas" }),
  msgN({ ts: 1792683595000, texte: "Merci, nous prenons en charge.", sortant: true }),
  msgN({ ts: T_CLIENT, texte: "Finalement il ne démarre plus du tout" }),
  msgN({ ts: 1792683605000, texte: "C est noté, un technicien regarde votre dossier.", sortant: true }),
  msgN({ ts: 1792683610000, texte: "Encore une info : le voyant est rouge" })
];

test("moteur : message client = dernier entrant AVANT l'observation, ancien = 1er sortant APRÈS lui", () => {
  const lignes = comparaison.lignesComparaison(
    [observation("547249072", "Merci pour ce détail. La panne du GG-798-NL est notée.\n-Agent IA U'mob-")],
    { "547249072": contexteDe(filReel) }
  );
  assert.strictEqual(lignes.length, 1);
  const l = lignes[0];
  assert.strictEqual(l.message_client, "Finalement il ne démarre plus du tout");
  assert.strictEqual(l.reponse_ancien, "C est noté, un technicien regarde votre dossier.");
  assert.ok(l.reponse_nouveau.indexOf("Agent IA U'mob") !== -1);
  assert.strictEqual(l.nom, "PIZZA SERVICES ETAMPES");
});

test("moteur : la réponse de l'ancien agent au message PRÉCÉDENT n'est jamais confondue", () => {
  const lignes = comparaison.lignesComparaison(
    [observation("547249072", "ok")],
    { "547249072": contexteDe(filReel) }
  );
  assert.notStrictEqual(lignes[0].reponse_ancien, "Merci, nous prenons en charge.");
});

test("moteur : un message client arrivé APRÈS l'observation est EXCLU", () => {
  const lignes = comparaison.lignesComparaison(
    [observation("547249072", "ok", "2026-10-22T15:40:01.000Z")],
    { "547249072": contexteDe(filReel) }
  );
  assert.notStrictEqual(lignes[0].message_client, "Encore une info : le voyant est rouge");
});

test("moteur : ancien agent pas encore répondu → champ vide (l'écran affichera le placeholder)", () => {
  const fil = [
    msgN({ ts: T_CLIENT, texte: "Finalement il ne démarre plus du tout" })
  ];
  const lignes = comparaison.lignesComparaison(
    [observation("547249072", "simulée")],
    { "547249072": contexteDe(fil) }
  );
  assert.strictEqual(lignes[0].reponse_ancien, "");
});

test("moteur : repli anti-dérive d'horloge (horodatages décalés → dernier entrant quand même)", () => {
  const fil = [
    msgN({ ts: T_CLIENT + 60000, texte: "message dont l'horloge est en avance" })
  ];
  const lignes = comparaison.lignesComparaison(
    [observation("547249072", "simulée", "2026-10-22T15:40:01.000Z")],
    { "547249072": contexteDe(fil) }
  );
  assert.strictEqual(lignes[0].message_client, "message dont l'horloge est en avance");
});

test("moteur : média seul → « (média reçu) »", () => {
  const fil = [
    msgN({ ts: T_CLIENT, texte: "", media: "https://cdn.example/photo.jpg", type_media: "image" })
  ];
  const lignes = comparaison.lignesComparaison(
    [observation("547249072", "simulée")],
    { "547249072": contexteDe(fil) }
  );
  assert.strictEqual(lignes[0].message_client, "(média reçu)");
  assert.ok(lignes[0].media_client.indexOf("photo.jpg") !== -1);
});

test("moteur : contexte indisponible → ligne avec avertissement, jamais de crash", () => {
  const lignes = comparaison.lignesComparaison(
    [observation("547249072", "simulée")],
    {}
  );
  assert.strictEqual(lignes.length, 1);
  assert.ok(lignes[0].avertissement.indexOf("indisponible") !== -1);
});

test("moteur : plusieurs observations → tri chronologique (la plus ancienne d'abord)", () => {
  const lignes = comparaison.lignesComparaison(
    [
      observation("547249072", "réponse B", "2026-10-22T16:00:00.000Z"),
      observation("547249072", "réponse A", "2026-10-22T15:40:01.000Z")
    ],
    { "547249072": contexteDe(filReel) }
  );
  assert.strictEqual(lignes[0].reponse_nouveau, "réponse A");
  assert.strictEqual(lignes[1].reponse_nouveau, "réponse B");
});

// ============================================================================
// 2. api/observations.js — L'ÉCRAN (HTML, lecture seule, secret)
// ============================================================================

test("401 sans secret, 405 non GET", async () => {
  reinitialise();
  let r = await apiObservations(requete(""), faireRes());
  assert.strictEqual(r.statusCode, 401);
  r = await apiObservations({ method: "POST", url: "/api/observations", query: { secret: "secret-de-test-b5" }, headers: {} }, faireRes());
  assert.strictEqual(r.statusCode, 405);
});

test("journal vide → page « Aucune observation »", async () => {
  reinitialise();
  const r = await apiObservations(requete("secret=secret-de-test-b5"), faireRes());
  assert.strictEqual(r.statusCode, 200);
  assert.ok(r.corps.indexOf("Aucune observation") !== -1);
});

test("page de comparaison : les DEUX réponses + le message client + le nom du contact", async () => {
  reinitialise();
  dbJournal = [
    observation("547249072", "Merci pour ce détail. La panne du GG-798-NL est notée, un technicien regarde.\n-Agent IA U'mob-")
  ];
  const r = await apiObservations(requete("secret=secret-de-test-b5"), faireRes());
  assert.strictEqual(r.statusCode, 200);
  assert.ok(r.corps.indexOf("Finalement il ne démarre plus du tout") !== -1, "message client");
  assert.ok(r.corps.indexOf("C est noté, un technicien regarde votre dossier.") !== -1, "réponse ANCIEN");
  assert.ok(r.corps.indexOf("La panne du GG-798-NL est notée") !== -1, "réponse NOUVEAU");
  assert.ok(r.corps.indexOf("PIZZA SERVICES ETAMPES") !== -1);
  assert.ok(r.corps.indexOf("NON envoyée") !== -1);
  assert.ok(r.corps.indexOf("réellement envoyée") !== -1);
});

test("page 100 % LECTURE : aucun appel POST/PATCH, aucun appel Mistral", async () => {
  reinitialise();
  dbJournal = [observation("547249072", "simulée")];
  await apiObservations(requete("secret=secret-de-test-b5"), faireRes());
  const ecritures = appelsFetch.filter((a) => a.method !== "GET");
  assert.strictEqual(ecritures.length, 0);
  assert.ok(appelsFetch.every((a) => a.url.indexOf("mistral") === -1));
});

test("respond.io en panne → ligne avec avertissement, page 200 quand même", async () => {
  reinitialise();
  panneRespondio = true;
  dbJournal = [observation("547249072", "simulée")];
  const r = await apiObservations(requete("secret=secret-de-test-b5"), faireRes());
  panneRespondio = null;
  assert.strictEqual(r.statusCode, 200);
  assert.ok(r.corps.indexOf("indisponible") !== -1);
  assert.ok(r.corps.indexOf("simulée") !== -1, "la réponse du nouveau cerveau reste affichée");
});

test("limit transmis au journal et borné : limit=1 → UNE seule carte", async () => {
  reinitialise();
  dbJournal = [
    observation("547249072", "première", "2026-10-22T15:40:01.000Z"),
    observation("547249072", "seconde", "2026-10-22T15:45:00.000Z")
  ];
  const r = await apiObservations(requete("secret=secret-de-test-b5&limit=1"), faireRes());
  assert.strictEqual(r.statusCode, 200);
  // le journal est lu order=desc : limit=1 garde la PLUS RÉCENTE (« seconde »)
  assert.ok(r.corps.indexOf("seconde") !== -1);
  assert.ok(r.corps.indexOf("première") === -1);
  assert.ok(r.corps.indexOf("limit 1") !== -1);
});

test("observations de PLUSIEURS contacts : chaque ligne garde son contact", async () => {
  reinitialise();
  historiques["777"] = [
    itemRespondio({ ts: T_CLIENT, texte: "Mon scooter est en panne" }),
    itemRespondio({ ts: 1792683605000, texte: "Bonjour, on regarde ça.", sortant: true })
  ];
  dbJournal = [
    observation("547249072", "réponse pour pizza"),
    observation("777", "réponse pour 777", "2026-10-22T15:40:02.000Z")
  ];
  const r = await apiObservations(requete("secret=secret-de-test-b5"), faireRes());
  delete historiques["777"];
  assert.strictEqual(r.statusCode, 200);
  assert.ok(r.corps.indexOf("réponse pour pizza") !== -1);
  assert.ok(r.corps.indexOf("réponse pour 777") !== -1);
  assert.ok(r.corps.indexOf("Mon scooter est en panne") !== -1);
});

test("escalade affichée avec sa raison (l'orphelin est visible dans l'écran)", async () => {
  reinitialise();
  dbJournal = [
    observation("547249072", "", "2026-10-22T15:40:01.000Z", { escalade: true, raison_escalade: "réponse orpheline sans question en attente", appels_mistral: 1 })
  ];
  const r = await apiObservations(requete("secret=secret-de-test-b5"), faireRes());
  assert.strictEqual(r.statusCode, 200);
  assert.ok(r.corps.indexOf("Escalade demandée") !== -1);
  assert.ok(r.corps.indexOf("réponse orpheline sans question en attente") !== -1);
});

test("date affichée en HEURE DE PARIS (l'horodatage Supabase est UTC, Paris est à +2 en été / +1 en hiver)", async () => {
  reinitialise();
  dbJournal = [
    observation("547249072", "été", "2026-10-22T15:40:01.000Z"),
    observation("547249072", "hiver", "2026-12-01T23:40:01.000Z")
  ];
  const r = await apiObservations(requete("secret=secret-de-test-b5"), faireRes());
  assert.strictEqual(r.statusCode, 200);
  // 22/10 15:40:01 UTC = 17:40:01 à Paris (heure d'été) ; 01/12 23:40:01 UTC = 00:40:01 du 02/12 à Paris (heure d'hiver)
  assert.ok(r.corps.indexOf("17:40:01") !== -1, "heure d'été convertie");
  assert.ok(r.corps.indexOf("00:40:01") !== -1, "heure d'hiver convertie (changement d'heure géré)");
  assert.ok(r.corps.indexOf("(Paris)") !== -1, "le fuseau est affiché");
  assert.ok(r.corps.indexOf("15:40:01") === -1, "l'heure UTC brute ne doit plus être affichée");
});

// ============================================================================
// B5.3 — CYCLES & TRANSFERTS VISIBLES (divergence n°3) — carte enrichie :
// cycle + tags ACTUELS du contact, actions SIMULÉES du mode actif B4.2.
// ============================================================================

function contexteEnrichi(messages, cycle, tags) {
  return { contact: { nom: "PIZZA SERVICES ETAMPES", cycle: cycle || "", tags: tags || [] }, messages: messages, commentaires: [], avertissements: [] };
}

test("B5.3 moteur : cycle et tags ACTUELS du contact remontent dans la ligne", () => {
  const lignes = comparaison.lignesComparaison(
    [observation("547249072", "simulée")],
    { "547249072": contexteEnrichi(filReel, "A qualifier", ["Prise de main"]) }
  );
  assert.strictEqual(lignes[0].cycle_ancien, "A qualifier");
  assert.deepStrictEqual(lignes[0].tags_ancien, ["Prise de main"]);
});

test("B5.3 moteur : escalade → actions simulées = transfert complet de l'ancien (cycle A qualifier + tag Prise de main + commentaire TRANSFERT SAV + motif)", () => {
  const lignes = comparaison.lignesComparaison(
    [observation("547249072", "repli neutre", "2026-10-22T15:40:01.000Z", { escalade: true, raison_escalade: "récidive des gardes après régénération" })],
    { "547249072": contexteDe(filReel) }
  );
  const actions = lignes[0].actions_simulees.join(" | ");
  assert.ok(actions.indexOf("« A qualifier »") !== -1);
  assert.ok(actions.indexOf("« Prise de main »") !== -1);
  assert.ok(actions.indexOf("TRANSFERT SAV") !== -1);
  assert.ok(actions.indexOf("motif du transfert : récidive des gardes après régénération") !== -1);
});

test("B5.3 moteur : sans escalade → aucun transfert, l'agent IA poursuit (cycle inchangé)", () => {
  const lignes = comparaison.lignesComparaison(
    [observation("547249072", "Merci pour ce détail.\n-Agent IA U'mob-")],
    { "547249072": contexteDe(filReel) }
  );
  assert.strictEqual(lignes[0].actions_simulees.length, 1);
  assert.ok(lignes[0].actions_simulees[0].indexOf("aucun transfert") !== -1);
});

test("B5.3 moteur : RESET → actions canoniques (0 Mistral, retrait du tag, mémoire purgée)", () => {
  const lignes = comparaison.lignesComparaison(
    [observation("547249072", "Mémoire de la conversation réinitialisée.", "2026-10-22T15:40:01.000Z", { type: "reset", appels_mistral: 0 })],
    { "547249072": contexteDe(filReel) }
  );
  assert.strictEqual(lignes[0].type_observation, "reset");
  const actions = lignes[0].actions_simulees.join(" | ");
  assert.ok(actions.indexOf("canonique RESET") !== -1);
  assert.ok(actions.indexOf("Prise de main") !== -1);
});

test("B5.3 moteur : rejet plaque → actions garde cas A, cycle inchangé, poursuite au 2e échec", () => {
  const lignes = comparaison.lignesComparaison(
    [observation("547249072", "Cette plaque ne correspond pas à notre parc. Quelle est la saisie exacte de la plaque ?", "2026-10-22T15:40:01.000Z", { type: "plaque", appels_mistral: 0 })],
    { "547249072": contexteDe(filReel) }
  );
  assert.strictEqual(lignes[0].type_observation, "plaque");
  const actions = lignes[0].actions_simulees.join(" | ");
  assert.ok(actions.indexOf("garde cas A") !== -1);
  assert.ok(actions.indexOf("cycle inchangé") !== -1);
});

test("B5.3 écran : cycle, tags et bloc « B4.2 (mode actif) ferait » rendus avec le transfert simulé complet", async () => {
  reinitialise();
  fiches["547249072"] = { fullName: "PIZZA SERVICES ETAMPES", lifecycle: "A qualifier", tags: ["Prise de main"] };
  dbJournal.push(observation("547249072", "repli neutre", "2026-10-22T15:40:01.000Z", { escalade: true, raison_escalade: "Il manque : le numéro de téléphone de la personne à contacter sur place (nom + numéro)" }));
  const r = await apiObservations(requete("?secret=secret-de-test-b5"), faireRes());
  assert.strictEqual(r.statusCode, 200);
  const html = r.corps;
  assert.ok(html.indexOf("Cycle : A qualifier") !== -1);
  assert.ok(html.indexOf("Tags : Prise de main") !== -1);
  assert.ok(html.indexOf("B4.2 (mode actif) ferait") !== -1);
  assert.ok(html.indexOf("TRANSFERT SAV") !== -1);
  assert.ok(html.indexOf("motif du transfert : Il manque : le numéro de téléphone") !== -1);
  fiches["547249072"] = { fullName: "PIZZA SERVICES ETAMPES", lifecycle: {}, tags: [] };
});

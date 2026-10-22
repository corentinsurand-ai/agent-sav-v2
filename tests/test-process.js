// ============================================================================
// Agent SAV U'mob v2 — B4.1 : tests du processeur OBSERVATION (node --test)
// Exécution : node --test tests/test-process.js
// (~26 tests — aucune dépendance : Supabase, respond.io et Mistral SIMULÉS)
//
// Deux étages :
//   1. lib/process.js — la chaîne complète (silence, cerveau, gardes,
//      régénération, repli, fusion, leçons) avec un Mistral injecté fictif.
//   2. api/process.js  — l'endpoint : secret, claim atomique anti-double-
//      traitement, supersede, filet anti-blocage 30 min, mode observation,
//      JAMAIS d'écriture chez respond.io.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

// --- Environnement de test AVANT tout require --------------------------------
process.env.WEBHOOK_SECRET = "secret-de-test-b4";
process.env.CRON_SECRET = "cron-de-test-b4";
process.env.SUPABASE_URL = "https://umob-crm.supabase.co";
process.env.SUPABASE_SERVICE_KEY = "cle-service-test";
process.env.RESPONDIO_TOKEN = "respondio-token-test";
process.env.MISTRAL_API_KEY = "mistral-cle-test";

const processLib = require("../lib/process.js");
const gardes = require("../lib/gardes.js");

// ============================================================================
// SIMULATIONS — fetch global : mini-PostgREST Supabase + respond.io + Mistral
// ============================================================================
const db = {
  messages: [],
  journal: [],
  dossiers: {},
  clients: [
    { telephone: "33620203963", plaque: "GG798NL", enseigne: "PIZZA SERVICES ETAMPES", statut_risque: null }
  ],
  lecons: []
};
let compteur = 0;
let appelsFetch = [];        // tous les appels réseau simulés
let appelsMistral = [];       // chaque appel = le tableau messages reçu
let reponsesMistral = [];     // file de réponses scriptées du modèle
let panneRespondio = null;    // "messages" → historique en erreur 500

function enfileMessage(contactId, texte, opts) {
  opts = opts || {};
  const ligne = {
    id: "m" + (++compteur),
    event_id: "evt" + compteur,
    contact_id: String(contactId),
    texte: texte,
    recu_a: opts.recuA || "2026-10-22T18:30:00.000Z",
    statut: opts.statut || "en_file"
  };
  db.messages.push(ligne);
  return ligne;
}

function reinitialiseDb() {
  db.messages = [];
  db.journal = [];
  db.dossiers = {};
  db.lecons = [];
  appelsFetch = [];
  appelsMistral = [];
  reponsesMistral = [];
  panneRespondio = null;
}

function paramsDe(url) {
  const u = new URL(url);
  const p = {};
  u.searchParams.forEach((v, k) => { p[k] = v; });
  return { chemin: u.pathname, params: p };
}

// Mini-PostgREST : filtres eq./in./lt. + order + limit, appliqués aux messages
function filtreMessages(params) {
  let out = db.messages.slice();
  if (params["statut"]) out = out.filter((r) => r.statut === params["statut"].slice(3));
  if (params["id"]) {
    const c = params["id"];
    if (c.indexOf("in.(") === 0) {
      const ids = c.slice(4, -1).split(",");
      out = out.filter((r) => ids.indexOf(r.id) !== -1);
    } else if (c.indexOf("eq.") === 0) {
      out = out.filter((r) => r.id === c.slice(3));
    }
  }
  if (params["contact_id"]) out = out.filter((r) => r.contact_id === params["contact_id"].slice(3));
  if (params["recu_a"] && params["recu_a"].indexOf("lt.") === 0) {
    const v = params["recu_a"].slice(3);
    out = out.filter((r) => String(r.recu_a) < v);
  }
  if (params["order"]) {
    const c = params["order"].split(".");
    out.sort((a, b) => {
      const x = String(a[c[0]]);
      const y = String(b[c[0]]);
      return (x < y ? -1 : x > y ? 1 : 0) * (c[1] === "desc" ? -1 : 1);
    });
  }
  if (params["limit"]) out = out.slice(0, parseInt(params["limit"], 10));
  return out;
}

function json(status, corps) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(corps) };
}

// Items respond.io aux formes RÉELLES (messageId µs pour les entrants,
// status[] pour les sortants — B2.1.3)
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
  "547249072": {
    phone: "+33620203963",
    fullName: "PIZZA SERVICES ETAMPES",
    lifecycle: { name: "En cours de réalisation" },
    tags: []
  }
};

const historiques = {
  "547249072": [
    itemRespondio({ ts: 1792683528000, texte: "Bonjour mon scooter GG-798-NL ne démarre pas" }),
    itemRespondio({ ts: 1792683529000, texte: "Bonjour ! Merci pour votre message, nous prenons en charge votre demande.", sortant: true }),
    itemRespondio({ ts: 1792683530000, texte: "C est complètement silencieux quand je tourne la clé" })
  ]
};

// La réponse CONFORME du modèle (passe toutes les gardes)
const reponseConformeDefaut = JSON.stringify({
  reponse: "Merci pour ce détail. La panne de démarrage du GG-798-NL est bien notée, un technicien va regarder votre scooter dès que possible.\n-Agent IA U'mob-",
  formulaire: { panne: "scooter silencieux, ne démarre pas", etape: 3 },
  escalade: false,
  raison_escalade: ""
});

globalThis.fetch = async function (url, options) {
  url = String(url);
  options = options || {};
  appelsFetch.push({ url, method: options.method || "GET" });

  // ---- Mistral --------------------------------------------------------------
  if (url.indexOf("api.mistral.ai") !== -1) {
    const contenu = reponsesMistral.length ? reponsesMistral.shift() : reponseConformeDefaut;
    appelsMistral.push(JSON.parse(options.body).messages);
    return json(200, { choices: [{ message: { content: contenu } }], model: "mistral-large-latest" });
  }

  // ---- respond.io (LECTURE SEULE dans ces tests) -----------------------------
  if (url.indexOf("api.respond.io") !== -1) {
    const m = url.match(/\/contact\/id:([^/?]+)(\/message\/list|\/comment)?/);
    const idContact = m ? m[1] : "";
    if (m && m[2] === "/message/list") {
      if (panneRespondio === "messages") return { status: 500, ok: false, text: async () => "boom" };
      return json(200, { items: (historiques[idContact] || []).slice() });
    }
    if (m && m[2] === "/comment") {
      return { status: 404, ok: false, text: async () => "not found" }; // comportement réel constaté B2.1
    }
    return json(200, fiches[idContact] || { fullName: "Contact " + idContact, lifecycle: {}, tags: [] });
  }

  // ---- Supabase ---------------------------------------------------------------
  if (url.indexOf("umob-crm.supabase.co") !== -1) {
    const { chemin, params } = paramsDe(url);
    const table = chemin.split("/rest/v1/")[1];
    const corps = options.body ? JSON.parse(options.body) : null;

    if (table === "messages" && options.method === "PATCH") {
      const cible = filtreMessages(params); // filtre statut=eq.en_file = claim atomique
      for (const r of cible) Object.assign(r, corps);
      if ((options.headers["Prefer"] || "").indexOf("representation") !== -1) return json(200, cible);
      return json(200, []);
    }
    if (table === "messages") return json(200, filtreMessages(params));
    if (table === "journal" && options.method === "POST") {
      db.journal.push(corps);
      return { status: 201, ok: true, text: async () => "" };
    }
    if (table === "dossiers" && options.method === "POST") {
      db.dossiers[corps.contact_id] = Object.assign(
        db.dossiers[corps.contact_id] || { contact_id: corps.contact_id, cycle_actuel: "Nouvelle Demande" },
        corps
      );
      return { status: 201, ok: true, text: async () => "" };
    }
    if (table === "clients") {
      let out = db.clients.slice();
      if (params["telephone"]) out = out.filter((r) => r.telephone === params["telephone"].slice(3));
      // B4.2-PREP.2 — filtre plaque=ilike.*AA123BB* (recherche pleine colonne)
      if (params["plaque"] && params["plaque"].slice(0, 6) === "ilike.") {
        const motif = params["plaque"].slice(6).replace(/^\*/, "").replace(/\*$/, "");
        out = out.filter((r) => String(r.plaque || "").toUpperCase().indexOf(motif.toUpperCase()) !== -1);
      }
      if (params["limit"]) out = out.slice(0, parseInt(params["limit"], 10));
      return json(200, out);
    }
    if (table === "lecons") {
      let out = db.lecons.filter((r) => r.statut === "active");
      const ou = params["or"];
      if (ou) {
        const conds = ou.slice(1, -1).split(",");
        out = out.filter((r) => conds.some((c) => {
          if (c.indexOf(".is.null") !== -1) return r[c.split(".")[0]] === null || r[c.split(".")[0]] === undefined;
          if (c.indexOf(".eq.") !== -1) {
            const morceaux = c.split(".eq.");
            return r[morceaux[0]] === morceaux[1];
          }
          return true;
        }));
      }
      return json(200, out.slice(0, parseInt(params["limit"] || "5", 10)));
    }
    return json(404, { error: "table inconnue " + table });
  }

  throw new Error("URL non simulée : " + url);
};

// --- Simulation de res (Vercel) -----------------------------------------------
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
    url: "/api/process" + (query ? "?" + query : ""),
    query: query ? Object.fromEntries(new URLSearchParams(query)) : {},
    headers: headers || {}
  };
}

const apiProcess = require("../api/process.js");

// ============================================================================
// 1. lib/process.js — LA CHAÎNE COMPLÈTE (Mistral fictif injecté)
// ============================================================================

function msgNormalise(o) {
  o = o || {};
  const ts = o.ts || 1792683530000;
  return {
    id: o.id || "x" + ts,
    ts: ts,
    emis_a: new Date(ts).toISOString(),
    texte: o.texte || "",
    media: o.media || "",
    type_media: o.type_media || null,
    sortant: !!o.sortant,
    humain: !!o.humain
  };
}

function ctxStandard(messages, contact) {
  return {
    contact: contact || { nom: "PIZZA SERVICES ETAMPES", cycle: "", tags: [] },
    messages: messages,
    commentaires: [],
    avertissements: []
  };
}

const filGG798NL = [
  msgNormalise({ ts: 1792683528000, texte: "Bonjour mon scooter GG-798-NL ne démarre pas" }),
  msgNormalise({ ts: 1792683529000, texte: "Bonjour ! Merci pour votre message.", sortant: true }),
  msgNormalise({ ts: 1792683530000, texte: "C est complètement silencieux quand je tourne la clé" })
];

const clientStandard = { enseigne: "PIZZA SERVICES ETAMPES", plaque: "GG798NL", statut_risque: null };

test("silence : prise de main — le modèle n'est MÊME PAS appelé", async () => {
  let appels = 0;
  const res = await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard([msgNormalise({ texte: "Bonjour" })], { nom: "X", cycle: "", tags: ["Prise de main"] }),
    mistral: async () => { appels++; return "{}"; }
  });
  assert.strictEqual(res.statut, "silence");
  assert.strictEqual(appels, 0);
  assert.strictEqual(res.appels, 0);
  assert.ok(res.journal.some((j) => j.etape === "process_silence"));
});

test("silence : aucun message entrant à traiter", async () => {
  const res = await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard([msgNormalise({ texte: "Notre réponse", sortant: true })]),
    mistral: async () => { throw new Error("ne doit pas être appelé"); }
  });
  assert.strictEqual(res.statut, "silence");
  assert.strictEqual(res.appels, 0);
});

test("chaîne complète : réponse conforme → statut traite, 1 seul appel, observation journalisée", async () => {
  const appels = [];
  const res = await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard(filGG798NL),
    client: clientStandard,
    lecons: [],
    mistral: async (m) => {
      appels.push(m);
      return JSON.stringify({
        reponse: "Merci pour ce détail. La panne de démarrage du GG-798-NL est bien notée, un technicien va regarder votre scooter dès que possible.\n-Agent IA U'mob-",
        formulaire: { panne: "silencieux", etape: 3 },
        escalade: false,
        raison_escalade: ""
      });
    }
  });
  assert.strictEqual(res.statut, "traite");
  assert.strictEqual(res.appels, 1);
  assert.strictEqual(appels.length, 1);
  assert.ok(res.reponse.indexOf("GG-798-NL") !== -1);
  const obs = res.journal.find((j) => j.etape === "observation");
  assert.ok(obs, "entrée observation attendue");
  assert.strictEqual(obs.detail.envoyee, false);
  assert.strictEqual(obs.detail.appels_mistral, 1);
});

test("escalade orphelin : aucune régénération, raison journalisée pour le collègue", async () => {
  const res = await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard(filGG798NL),
    mistral: async () => JSON.stringify({
      reponse: "",
      formulaire: null,
      escalade: true,
      raison_escalade: "réponse orpheline : « oui c est fait » sans question en attente"
    })
  });
  assert.strictEqual(res.statut, "traite");
  assert.strictEqual(res.escalade, true);
  assert.strictEqual(res.appels, 1);
  assert.ok(res.journal.some((j) => j.etape === "process_escalade" && j.texte.indexOf("orpheline") !== -1));
  // B5.4.2 — l'observation porte le cycle que le mode actif poserait (§5) :
  // escalade sans dossier complet → « A qualifier »
  const obs = res.journal.find((j) => j.etape === "observation");
  assert.ok(obs && obs.detail.cycle_prevu, "cycle_prevu présent dans le journal d observation");
  assert.strictEqual(obs.detail.cycle_prevu.cycle, "A qualifier");
});

test("garde fautive → UNE régénération AVEC rappels → réponse corrigée retenue", async () => {
  const appels = [];
  let n = 0;
  const res = await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard(filGG798NL),
    client: clientStandard,
    mistral: async (m) => {
      appels.push(m);
      n++;
      if (n === 1) {
        return JSON.stringify({ reponse: "Merci. Quelle est la plaque du scooter concerné ?\n-Agent IA U'mob-", formulaire: {}, escalade: false, raison_escalade: "" });
      }
      return JSON.stringify({ reponse: "Merci pour ce détail, la panne du GG-798-NL est notée, un technicien regarde votre scooter.\n-Agent IA U'mob-", formulaire: { panne: "silencieux" }, escalade: false, raison_escalade: "" });
    }
  });
  assert.strictEqual(res.statut, "traite");
  assert.strictEqual(res.appels, 2);
  const dernier = appels[1][appels[1].length - 1];
  assert.strictEqual(dernier.role, "user");
  assert.ok(dernier.content.indexOf("ne la redemande jamais") !== -1, "le rappel de la garde doit être réinjecté");
  const g = res.journal.find((j) => j.etape === "process_gardes");
  assert.ok(g && g.detail.fautes.indexOf("plaque_redemandee") !== -1);
  assert.ok(res.reponse.indexOf("GG-798-NL") !== -1);
});

test("récidive des gardes → repli neutre + prise de main, jamais de 3e appel", async () => {
  const res = await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard(filGG798NL),
    client: clientStandard,
    mistral: async () => JSON.stringify({ reponse: "Merci. Quelle est la plaque du scooter concerné ?\n-Agent IA U'mob-", formulaire: {}, escalade: false, raison_escalade: "" })
  });
  assert.strictEqual(res.statut, "repli");
  assert.strictEqual(res.reponse, gardes.messageRepliNeutre());
  assert.strictEqual(res.appels, 2);
  assert.strictEqual(res.escalade, true);
  assert.ok(res.journal.some((j) => j.etape === "process_repli"));
  assert.ok(res.journal.some((j) => j.etape === "process_prise_de_main"));
});

test("réponse illisible → régénération format → réponse valide retenue", async () => {
  let n = 0;
  const res = await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard(filGG798NL),
    mistral: async () => {
      n++;
      if (n === 1) return "Désolé, je ne comprends pas la question.";
      return reponseConformeDefaut;
    }
  });
  assert.strictEqual(res.statut, "traite");
  assert.strictEqual(res.appels, 2);
  assert.ok(res.journal.some((j) => j.etape === "process_reponse_illisible"));
});

test("illisible ×2 → repli neutre", async () => {
  const res = await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard(filGG798NL),
    mistral: async () => "nimporte quoi"
  });
  assert.strictEqual(res.statut, "repli");
  assert.strictEqual(res.appels, 2);
  assert.strictEqual(res.reponse, gardes.messageRepliNeutre());
});

test("budget borné : illisible puis garde fautive → repli, MAXIMUM 2 appels", async () => {
  let n = 0;
  const res = await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard(filGG798NL),
    client: clientStandard,
    mistral: async () => {
      n++;
      if (n === 1) return "pas de json du tout";
      return JSON.stringify({ reponse: "Merci. Quelle est la plaque du scooter concerné ?\n-Agent IA U'mob-", formulaire: {}, escalade: false, raison_escalade: "" });
    }
  });
  assert.strictEqual(res.statut, "repli");
  assert.strictEqual(res.appels, 2);
  assert.strictEqual(n, 2, "jamais de 3e appel Mistral");
});

test("fusion : le formulaire du modèle met à jour l'état, SANS écraser le téléphone du client", async () => {
  // B3.1 : telephone_contact n'est rempli que si l'agent l'a DEMANDÉ puis le
  // client l'a fourni — le scénario respecte l'étape 3 du cahier des charges.
  const filAvecTel = filGG798NL.concat([
    msgNormalise({ ts: 1792683535000, texte: "Pour planifier l intervention : quel est le numéro de la personne à contacter le jour de l intervention ?", sortant: true }),
    msgNormalise({ ts: 1792683540000, texte: "Mon numéro sur place : 06 20 20 39 63" })
  ]);
  const res = await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard(filAvecTel),
    client: clientStandard,
    mistral: async () => JSON.stringify({
      reponse: "C est bien noté, nous avons votre numéro. Un technicien vous appelle.\n-Agent IA U'mob-",
      formulaire: { plaque: "AA-123-BB", etape: 4, telephone_contact: "0611223344" },
      escalade: false,
      raison_escalade: ""
    })
  });
  assert.strictEqual(res.statut, "traite");
  assert.ok(res.etat.plaques.indexOf("AA123BB") !== -1, "plaque du modèle ajoutée");
  assert.strictEqual(res.etat.etape, 4);
  assert.strictEqual(res.etat.telephone_contact, "33620203963", "le téléphone fourni PAR LE CLIENT ne doit jamais être écrasé");
});

test("leçons ciblées : injectées dans le prompt du modèle", async () => {
  let recu = null;
  await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard(filGG798NL),
    lecons: ["Toujours proposer un diagnostic photo pour une panne de démarrage"],
    mistral: async (m) => { recu = m; return reponseConformeDefaut; }
  });
  assert.ok(recu && recu[1].content.indexOf("Toujours proposer un diagnostic photo") !== -1);
});

test("client à risque : le statut est dans le prompt → réponse neutre exigée", async () => {
  let recu = null;
  await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard(filGG798NL),
    client: { enseigne: "GRILL CHICKEN TULLES", plaque: "GH111KL", statut_risque: "Impaye" },
    mistral: async (m) => { recu = m; return reponseConformeDefaut; }
  });
  assert.ok(recu && recu[1].content.indexOf("Statut risque : Impaye") !== -1);
});

test("mode actif demandé → rétrogradé en observation avec avertissement (B4.2 fera l'envoi)", async () => {
  const res = await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard(filGG798NL),
    mode: "actif",
    mistral: async () => reponseConformeDefaut
  });
  assert.strictEqual(res.mode, "observation");
  assert.ok(res.journal.some((j) => j.etape === "process_avertissement"));
});

test("adaptateur Mistral absent → repli, on ne devine JAMAIS une réponse", async () => {
  const res = await processLib.traiterMessage({
    contactId: "547249072",
    ctx: ctxStandard(filGG798NL)
  });
  assert.strictEqual(res.statut, "repli");
  assert.strictEqual(res.appels, 0);
  assert.strictEqual(res.reponse, gardes.messageRepliNeutre());
});

// ============================================================================
// 2. api/process.js — ENDPOINT : secret, claim atomique, observation
// ============================================================================

test("401 sans secret, 401 avec un Bearer faux", async () => {
  reinitialiseDb();
  let r = await apiProcess(requete(""), faireRes());
  assert.strictEqual(r.statusCode, 401);
  r = await apiProcess(requete("", { authorization: "Bearer mauvais" }), faireRes());
  assert.strictEqual(r.statusCode, 401);
});

test("405 méthode non GET/POST", async () => {
  reinitialiseDb();
  const r = await apiProcess(requete("?secret=secret-de-test-b4", {}, "PUT"), faireRes());
  assert.strictEqual(r.statusCode, 405);
});

test("Bearer CRON_SECRET accepté (déclenchement cron Vercel)", async () => {
  reinitialiseDb();
  const r = await apiProcess(requete("", { authorization: "Bearer cron-de-test-b4" }), faireRes());
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.corps.contacts, 0);
});

test("configuration manquante → 500 et AUCUNE ligne réclamée (message intact en_file)", async () => {
  reinitialiseDb();
  enfileMessage("547249072", "Bonjour");
  const sauve = process.env.MISTRAL_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  process.env.MISTRAL_API_KEY = sauve;
  assert.strictEqual(r.statusCode, 500);
  assert.ok(r.corps.erreur.indexOf("MISTRAL_API_KEY") !== -1);
  assert.strictEqual(db.messages.filter((m) => m.statut === "en_file").length, 1);
});

test("file vide → 200, contacts: 0", async () => {
  reinitialiseDb();
  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.corps.version, "B4.1");
  assert.strictEqual(r.corps.mode, "observation");
  assert.strictEqual(r.corps.contacts, 0);
});

test("BOUT EN BOUT observation : réponse rédigée, journalisée NON ENVOYÉE, message traite, dossier sauvé, AUCUNE écriture respond.io", async () => {
  reinitialiseDb();
  enfileMessage("547249072", "C est complètement silencieux quand je tourne la clé");
  db.dossiers["547249072"] = { contact_id: "547249072", cycle_actuel: "A qualifier", etat: {} };

  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());

  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.corps.ok, true);
  assert.strictEqual(r.corps.contacts, 1);
  const resultat = r.corps.resultats[0];
  assert.strictEqual(resultat.statut, "traite");
  assert.strictEqual(resultat.envoyee, false);
  assert.strictEqual(resultat.appels_mistral, 1);
  assert.ok(resultat.reponse.indexOf("Agent IA U'mob") !== -1);

  // message consommé
  assert.strictEqual(db.messages[0].statut, "traite");

  // journal : l'entrée observation explicite « non envoyée »
  const obs = db.journal.find((j) => j.etape === "observation");
  assert.ok(obs, "entrée observation dans le journal");
  assert.strictEqual(obs.detail.envoyee, false);
  assert.strictEqual(obs.contact_id, "547249072");

  // dossier persisté, cycle CONSERVÉ (jamais posé par le cerveau)
  const dossier = db.dossiers["547249072"];
  assert.ok(dossier.etat && dossier.etat.etape === 3);
  assert.strictEqual(dossier.cycle_actuel, "A qualifier");

  // la fiche client a été trouvée par téléphone (B2.2) et injectée
  assert.ok(appelsMistral.length === 1);
  assert.ok(appelsMistral[0][1].content.indexOf("PIZZA SERVICES ETAMPES") !== -1);

  // JAMAIS d'écriture chez respond.io : que des GET
  const ecritures = appelsFetch.filter((a) => a.url.indexOf("api.respond.io") !== -1 && a.method !== "GET");
  assert.strictEqual(ecritures.length, 0);
});

test("anti-double-traitement : un 2e passage ne reprend RIEN (file vidée)", async () => {
  reinitialiseDb();
  enfileMessage("547249072", "C est complètement silencieux quand je tourne la clé");
  await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  const r2 = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  assert.strictEqual(r2.corps.contacts, 0);
  assert.strictEqual(appelsMistral.length, 1, "Mistral n est appelé qu UNE fois pour ce message");
});

test("claim atomique : un message déjà en en_cours (concurrent) n est JAMAIS retraité", async () => {
  reinitialiseDb();
  // réclamé par un autre worker — recu_a RÉCENT (sinon le filet anti-blocage
  // des 30 min le réenfilerait et le test casserait selon l'heure d'exécution)
  enfileMessage("547249072", "Bonjour", { statut: "en_cours", recuA: new Date(Date.now() - 60 * 1000).toISOString() });
  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  assert.strictEqual(r.corps.contacts, 0);
  assert.strictEqual(appelsMistral.length, 0);
});

test("supersede : 2 messages du même contact → SEUL le plus récent est traité, l ancien est couvert", async () => {
  reinitialiseDb();
  enfileMessage("547249072", "premier message", { recuA: "2026-10-22T18:20:00.000Z" });
  enfileMessage("547249072", "second message", { recuA: "2026-10-22T18:25:00.000Z" });
  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  assert.strictEqual(r.corps.contacts, 1);
  assert.strictEqual(appelsMistral.length, 1);
  assert.ok(db.messages.every((m) => m.statut === "traite"));
  assert.ok(db.journal.some((j) => j.etape === "process_supersede"));
});

test("paramètre contact : traite UNIQUEMENT le contact demandé", async () => {
  reinitialiseDb();
  enfileMessage("547249072", "message A");
  enfileMessage("999999", "message B");
  const r = await apiProcess(requete("?secret=secret-de-test-b4&contact=547249072"), faireRes());
  assert.strictEqual(r.corps.contacts, 1);
  assert.strictEqual(r.corps.resultats[0].contact, "547249072");
  const b = db.messages.find((m) => m.contact_id === "999999");
  assert.strictEqual(b.statut, "en_file");
});

test("contexte respond.io illisible → statut erreur (JAMAIS une réponse sur un extrait), run 200", async () => {
  reinitialiseDb();
  panneRespondio = "messages";
  enfileMessage("547249072", "C est complètement silencieux");
  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.corps.resultats[0].statut, "erreur");
  assert.strictEqual(db.messages[0].statut, "erreur");
  assert.ok(db.journal.some((j) => j.etape === "process_erreur"));
  assert.strictEqual(appelsMistral.length, 0, "pas d appel modèle sans contexte complet");
  panneRespondio = null;
});

test("filet anti-blocage : un en_cours abandonné (>30 min) est réenfilé puis traité", async () => {
  reinitialiseDb();
  const vieux = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // il y a 2 h
  enfileMessage("547249072", "message coincé", { recuA: vieux, statut: "en_cours" });
  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  assert.strictEqual(r.corps.contacts, 1);
  assert.strictEqual(r.corps.resultats[0].statut, "traite");
  assert.strictEqual(db.messages[0].statut, "traite");
});

test("erreur Mistral persistante → statut erreur + journal, jamais de boucle infinie", async () => {
  reinitialiseDb();
  // Mistral en panne : toutes les réponses 503 (retry borné B3.2 puis throw)
  const vraiFetch = globalThis.fetch;
  globalThis.fetch = async function (url, options) {
    if (String(url).indexOf("api.mistral.ai") !== -1) {
      appelsMistral.push(JSON.parse(options.body).messages);
      return { status: 503, ok: false, text: async () => "upstream error" };
    }
    return vraiFetch(url, options);
  };
  enfileMessage("547249072", "C est complètement silencieux");
  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  globalThis.fetch = vraiFetch;
  assert.strictEqual(r.corps.resultats[0].statut, "erreur");
  assert.strictEqual(db.messages[0].statut, "erreur");
  assert.ok(db.journal.some((j) => j.etape === "process_erreur" && j.texte.indexOf("Mistral") !== -1));
  assert.strictEqual(appelsMistral.length, 3, "1 appel + 2 retries bornés, pas plus");
});

test("POST avec secret : accepté (même logique)", async () => {
  reinitialiseDb();
  const r = await apiProcess(requete("?secret=secret-de-test-b4", {}, "POST"), faireRes());
  assert.strictEqual(r.statusCode, 200);
});

// ============================================================================
// B4.2-PREP.1 — RESET / RAZ (purge mémoire déterministe, 0 appel Mistral)
// Contact dédié 444444 (même téléphone que la fiche client → flotte GG798NL)
// ============================================================================

function ficheResetTest(tags) {
  fiches["444444"] = { phone: "+33620203963", fullName: "RESET TEST", lifecycle: { name: "Nouvelle Demande" }, tags: tags || [] };
}

test("RESET : réponse canonique identique à l ancien, 0 appel Mistral, dossier purgé (fiche flotte conservée)", async () => {
  reinitialiseDb();
  ficheResetTest();
  historiques["444444"] = [
    itemRespondio({ ts: 1792683540000, texte: "Mon scooter AB-123-CD ne démarre pas, mon téléphone est le 06 11 22 33 44" }),
    itemRespondio({ ts: 1792683541000, texte: "Merci, nous prenons en charge votre demande.", sortant: true }),
    itemRespondio({ ts: 1792683550000, texte: "RESET" })
  ];
  enfileMessage("444444", "RESET");
  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  assert.strictEqual(r.corps.contacts, 1);
  const res = r.corps.resultats[0];
  assert.strictEqual(res.statut, "reset");
  assert.strictEqual(res.appels_mistral, 0);
  assert.ok(res.reponse.indexOf("Mémoire de la conversation réinitialisée") !== -1);
  assert.ok(res.reponse.indexOf("Agent IA U'mob") !== -1);
  assert.strictEqual(appelsMistral.length, 0);
  // journal : étape dédiée + observation NON envoyée (visible sur l'écran B5 → parité ANCIEN = NOUVEAU)
  assert.ok(db.journal.some((j) => j.etape === "process_reset" && j.contact_id === "444444"));
  const obs = db.journal.find((j) => j.etape === "observation" && j.contact_id === "444444");
  assert.ok(obs && obs.detail.envoyee === false);
  assert.strictEqual(obs.detail.type, "reset");
  assert.ok(obs.detail.reponse.indexOf("Mémoire de la conversation réinitialisée") !== -1);
  // dossier PURGÉ : état vierge + fiche client réappliquée
  const d = db.dossiers["444444"];
  assert.ok(d.etat);
  assert.strictEqual(d.etat.panne, "");
  assert.strictEqual(d.etat.telephone_contact, "");
  assert.strictEqual(d.etat.etape, 1);
  assert.ok((d.etat.plaques || []).indexOf("AB123CD") === -1, "plaque DITE EN CONVERSATION purgée");
  assert.ok((d.etat.plaques || []).indexOf("GG798NL") !== -1, "plaque FLOTTE (fiche client B2.2) conservée");
  assert.strictEqual(d.etat.enseigne, "PIZZA SERVICES ETAMPES");
  // message consommé
  assert.strictEqual(db.messages[0].statut, "traite");
});

test("RESET insensible à la casse/espaces, et RAZ aussi reconnu", async () => {
  reinitialiseDb();
  ficheResetTest();
  historiques["444444"] = [
    itemRespondio({ ts: 1792683540000, texte: "mon scooter ne démarre pas" }),
    itemRespondio({ ts: 1792683550000, texte: "  reset  " })
  ];
  enfileMessage("444444", "reset");
  let r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  assert.strictEqual(r.corps.resultats[0].statut, "reset");
  assert.strictEqual(appelsMistral.length, 0);
  reinitialiseDb();
  historiques["444444"][1] = itemRespondio({ ts: 1792683550000, texte: "Raz" });
  enfileMessage("444444", "Raz");
  r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  assert.strictEqual(r.corps.resultats[0].statut, "reset");
  assert.strictEqual(appelsMistral.length, 0);
});

test("RESET prioritaire sur le silence « Prise de main » (l ancien retire toujours le tag au RESET)", async () => {
  reinitialiseDb();
  ficheResetTest(["Prise de main"]);
  historiques["444444"] = [
    itemRespondio({ ts: 1792683540000, texte: "mon scooter ne démarre pas" }),
    itemRespondio({ ts: 1792683550000, texte: "RESET" })
  ];
  enfileMessage("444444", "RESET");
  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  assert.strictEqual(r.corps.resultats[0].statut, "reset");
  assert.strictEqual(appelsMistral.length, 0);
});

test("« veuillez reset le gps » n est PAS un RESET (traitement normal, 1 appel Mistral)", async () => {
  reinitialiseDb();
  ficheResetTest();
  historiques["444444"] = [
    itemRespondio({ ts: 1792683540000, texte: "Bonjour" }),
    itemRespondio({ ts: 1792683550000, texte: "veuillez reset le gps svp" })
  ];
  enfileMessage("444444", "veuillez reset le gps svp");
  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  assert.strictEqual(r.corps.resultats[0].statut, "traite");
  assert.strictEqual(appelsMistral.length, 1);
});

test("estResetRaz : texte SEUL exact — jamais média, jamais sortant, jamais une phrase contenant reset", () => {
  assert.ok(processLib.estResetRaz({ sortant: false, texte: "RESET" }));
  assert.ok(processLib.estResetRaz({ sortant: false, texte: "  reset " }));
  assert.ok(processLib.estResetRaz({ sortant: false, texte: "Raz" }));
  assert.ok(!processLib.estResetRaz({ sortant: false, texte: "veuillez reset le gps" }));
  assert.ok(!processLib.estResetRaz({ sortant: false, texte: "RESET", media: "https://cdn.example/photo.jpg" }));
  assert.ok(!processLib.estResetRaz({ sortant: true, texte: "RESET" }));
});


// ============================================================================
// B4.2-PREP.2 — GARDE PLAQUE PARC (divergence n°2, garde cas A de l'ancien)
// Contact dédié 444445 (même téléphone que la fiche client → flotte GG798NL).
// Parc de test = db.clients : GG798NL (flotte du contact) + AB123CD (autre client).
// ============================================================================

if (!db.clients.some((c) => c.plaque === "AB123CD")) {
  db.clients.push({ telephone: "33699999999", plaque: "AB123CD", enseigne: "AUTRE CLIENT TEST", statut_risque: null });
}

function fichePlaqueTest(tags) {
  fiches["444445"] = { phone: "+33620203963", fullName: "PLAQUE TEST", lifecycle: { name: "Nouvelle Demande" }, tags: tags || [] };
}

test("PLAQUE hors parc : rejet canonique identique à l ancien, 0 appel Mistral (bout en bout)", async () => {
  reinitialiseDb();
  fichePlaqueTest();
  historiques["444445"] = [
    itemRespondio({ ts: 1792683540000, texte: "mon scooter GN-223-DD ne démarre pas" })
  ];
  enfileMessage("444445", "mon scooter GN-223-DD ne démarre pas");
  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  assert.strictEqual(r.corps.contacts, 1);
  const res = r.corps.resultats[0];
  assert.strictEqual(res.statut, "traite");
  assert.strictEqual(res.appels_mistral, 0);
  assert.strictEqual(res.reponse, processLib.REPONSE_PLAQUE);
  assert.strictEqual(appelsMistral.length, 0);
  // la vérification parc a bien eu lieu (like pleine colonne sur agent_sav.clients)
  assert.ok(appelsFetch.some((f) => f.url.indexOf("plaque=ilike.") !== -1 && f.url.indexOf("GN223DD") !== -1));
  // journal : étape dédiée + observation NON envoyée (visible sur l'écran B5 → parité ANCIEN = NOUVEAU)
  assert.ok(db.journal.some((j) => j.etape === "process_plaque" && j.contact_id === "444445" && j.texte.indexOf("GN223DD") !== -1));
  const obs = db.journal.find((j) => j.etape === "observation" && j.contact_id === "444445");
  assert.ok(obs && obs.detail.envoyee === false);
  assert.strictEqual(obs.detail.type, "plaque");
  assert.strictEqual(obs.detail.reponse, processLib.REPONSE_PLAQUE);
  assert.strictEqual(obs.detail.appels_mistral, 0);
  // dossier : la plaque dite RESTE dans l'état (comportement cas A : au 2e échec on poursuit)
  const d = db.dossiers["444445"];
  assert.ok(d.etat && d.etat.plaques.indexOf("GN223DD") !== -1);
  // message consommé
  assert.strictEqual(db.messages[0].statut, "traite");
});

test("PLAQUE présente dans le parc (autre ligne du miroir) : pas de rejet, traitement normal (1 appel Mistral)", async () => {
  reinitialiseDb();
  fichePlaqueTest();
  historiques["444445"] = [
    itemRespondio({ ts: 1792683540000, texte: "mon scooter AB-123-CD ne démarre pas" })
  ];
  enfileMessage("444445", "mon scooter AB-123-CD ne démarre pas");
  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  const res = r.corps.resultats[0];
  assert.strictEqual(res.statut, "traite");
  assert.strictEqual(res.appels_mistral, 1);
  assert.notStrictEqual(res.reponse, processLib.REPONSE_PLAQUE);
  assert.ok(!db.journal.some((j) => j.etape === "process_plaque"));
  assert.ok(appelsFetch.some((f) => f.url.indexOf("plaque=ilike.") !== -1 && f.url.indexOf("AB123CD") !== -1));
});

test("PLAQUE de la flotte du client (B2.2) : jamais revérifiée — traitement normal sans requête parc", async () => {
  reinitialiseDb();
  fichePlaqueTest();
  historiques["444445"] = [
    itemRespondio({ ts: 1792683540000, texte: "mon scooter GG-798-NL ne démarre pas" })
  ];
  enfileMessage("444445", "mon scooter GG-798-NL ne démarre pas");
  const r = await apiProcess(requete("?secret=secret-de-test-b4"), faireRes());
  const res = r.corps.resultats[0];
  assert.strictEqual(res.statut, "traite");
  assert.strictEqual(res.appels_mistral, 1);
  assert.notStrictEqual(res.reponse, processLib.REPONSE_PLAQUE);
  assert.ok(!appelsFetch.some((f) => f.url.indexOf("plaque=ilike.") !== -1));
});

test("CAS A : la plaque RÉPÉTÉE n est plus nouvelle — la qualification poursuit (2e échec, 1 appel Mistral, jamais de blocage)", async () => {
  // GN-223-DD a déjà été rejetée au tour précédent (canonique sortant dans
  // l'historique) : le client redit « GN-223-DD c est bien ça ». La plaque
  // est désormais dans etat.plaques → plus NOUVELLE → jamais revérifiée :
  // le cerveau prend le relais (1 appel Mistral). Comportement VALIDÉ par
  // Corentin (B5.4.2) : la plaque n'est PAS bloquante, la qualification
  // poursuit — le transfert reste la décision du cerveau, pas de la garde.
  reinitialiseDb();
  const res = await processLib.traiterMessage({
    contactId: "444445",
    ctx: ctxStandard([
      msgNormalise({ ts: 1792683540000, texte: "mon scooter GN-223-DD ne démarre pas" }),
      msgNormalise({ ts: 1792683541000, texte: processLib.REPONSE_PLAQUE, sortant: true }),
      msgNormalise({ ts: 1792683542000, texte: "GN-223-DD c est bien ça" })
    ]),
    client: clientStandard,
    lecons: [],
    parc: async () => false,
    mistral: async () => reponseConformeDefaut
  });
  assert.strictEqual(res.statut, "traite");
  assert.strictEqual(res.appels, 1);
  assert.strictEqual(res.escalade, false);
  assert.ok(!res.journal.some((j) => j.etape === "process_plaque"), "une plaque répétée n est JAMAIS revérifiée");
  assert.ok(!res.journal.some((j) => j.etape === "process_transfert_cas_a"), "B5.4.1 annulé : plus de transfert auto cas A");
});

test("PLAQUE : vérification parc en ERREUR → jamais de rejet (best effort, la plaque n est pas bloquante)", async () => {
  reinitialiseDb();
  const res = await processLib.traiterMessage({
    contactId: "444445",
    ctx: ctxStandard([msgNormalise({ texte: "mon scooter ZZ-421-WW ne démarre pas" })]),
    client: clientStandard,
    lecons: [],
    parc: async () => { throw new Error("Supabase indisponible"); },
    mistral: async () => reponseConformeDefaut
  });
  assert.strictEqual(res.statut, "traite");
  assert.strictEqual(res.appels, 1);
  assert.notStrictEqual(res.reponse, processLib.REPONSE_PLAQUE);
});

test("PLAQUE : sans vérificateur parc injecté, aucun rejet (rétrocompatibilité — traitement normal)", async () => {
  reinitialiseDb();
  const res = await processLib.traiterMessage({
    contactId: "444445",
    ctx: ctxStandard([msgNormalise({ texte: "mon scooter ZZ-421-WW ne démarre pas" })]),
    client: clientStandard,
    lecons: [],
    mistral: async () => reponseConformeDefaut
  });
  assert.strictEqual(res.statut, "traite");
  assert.strictEqual(res.appels, 1);
  assert.notStrictEqual(res.reponse, processLib.REPONSE_PLAQUE);
});


// ============================================================================
// Agent SAV U'mob v2 — B4.1 : /api/process — le processeur, MODE OBSERVATION
//
// RÔLE : vider la file agent_sav.messages en traitant chaque contact à travers
// la chaîne complète (contexte → état → cerveau → gardes → fusion), SANS
// JAMAIS envoyer la réponse au client : elle est journalisée « non envoyée »
// (mode OBSERVATION, cahier des charges §9 — l'ancien agent continue de
// répondre en réel). Aucune écriture chez respond.io (B2 : lecture seule),
// aucun cycle n'est posé.
//
//   GET|POST /api/process?secret=<WEBHOOK_SECRET>&max=<1-20>&contact=<id>
//   — ou Authorization: Bearer <CRON_SECRET> (déclenchement cron Vercel)
//
//   - secret : WEBHOOK_SECRET (?secret=... ou header x-webhook-secret, mêmes
//     règles que webhook/contexte) OU Bearer CRON_SECRET (Vercel ajoute le
//     header automatiquement à ses déclenchements cron).
//   - max      : messages réclamés par run (défaut 5, borné 20) — borne le
//     nombre d'appels Mistral par exécution (1 à 2 par contact).
//   - contact  : OPTIONNEL — traite UNIQUEMENT ce contact (tests ciblés).
//
// ANTI-DOUBLE-TRACEMENT (architecture v1.1) : le claim est ATOMIQUE côté
// Supabase — PATCH filtré sur statut=en_file : seule l'exécution qui fait
// basculer la ligne vers en_cours la traite ; une exécution parallèle voit
// un tableau vide et passe son tour. Un en_cours abandonné (crash) est
// réenfilé après 30 min. Un message du contact couvert par le traitement
// d'un message PLUS RÉCENT est marqué traite (supersede) : la chaîne relit
// de toute façon TOUT l'historique du contact.
//
// Réponses : 200 {ok, resultats…} ; 401 secret invalide ; 405 méthode ;
// 500 configuration manquante (RIEN n'est réclamé dans ce cas).
// ============================================================================

var VERSION = "B4.1";
var SCHEMA = "agent_sav";

var contexte = require("../lib/contexte.js");
var respondio = require("../lib/respondio.js");
var etatLib = require("../lib/etat.js");
var mistral = require("../lib/mistral.js");
var processLib = require("../lib/process.js");

function env(nom) { return process.env[nom] || ""; }

// --- Supabase (REST PostgREST) — mêmes conventions que api/webhook.js -----
function urlSupabase(table, params) {
  var base = env("SUPABASE_URL").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  return base + "/rest/v1/" + table + (params ? "?" + params : "");
}

function entetesSupabase(extra) {
  var cle = env("SUPABASE_SERVICE_KEY");
  var h = {
    "apikey": cle,
    "Authorization": "Bearer " + cle,
    "Content-Type": "application/json",
    "Content-Profile": SCHEMA
  };
  for (var k in (extra || {})) h[k] = extra[k];
  return h;
}

async function supabaseGet(table, params) {
  var res = await fetch(urlSupabase(table, params), { method: "GET", headers: entetesSupabase({ "Accept-Profile": SCHEMA }) });
  var corps = "";
  try { corps = await res.text(); } catch (e) { corps = ""; }
  if (!res.ok) throw new Error("Supabase " + res.status + " — " + corps.substring(0, 300));
  return corps ? JSON.parse(corps) : [];
}

async function supabasePatch(table, params, corps, prefer) {
  var res = await fetch(urlSupabase(table, params), {
    method: "PATCH",
    headers: entetesSupabase({ "Prefer": prefer || "return=minimal" }),
    body: JSON.stringify(corps)
  });
  if (!res.ok) {
    var texte = "";
    try { texte = await res.text(); } catch (e) { texte = ""; }
    throw new Error("Supabase " + res.status + " — " + texte.substring(0, 300));
  }
  if ((prefer || "").indexOf("representation") !== -1) {
    var c = "";
    try { c = await res.text(); } catch (e) { c = ""; }
    return c ? JSON.parse(c) : [];
  }
  return [];
}

// Upsert idempotent (même Patron que la synchro clients B2.2)
async function supabaseUpsert(table, ligne, conflit) {
  var res = await fetch(urlSupabase(table, "on_conflict=" + conflit), {
    method: "POST",
    headers: entetesSupabase({ "Prefer": "resolution=merge-duplicates" }),
    body: JSON.stringify(ligne)
  });
  if (!res.ok) {
    var texte = "";
    try { texte = await res.text(); } catch (e) { texte = ""; }
    throw new Error("Supabase " + res.status + " — " + texte.substring(0, 300));
  }
}

// Journal d'étape — best effort : une erreur de journal n'échoue JAMAIS un
// traitement (même contrat que api/webhook.js B1).
async function journaliser(contactId, etape, texte, detail) {
  try {
    var res = await fetch(urlSupabase("journal", ""), {
      method: "POST",
      headers: entetesSupabase({ "Prefer": "return=minimal" }),
      body: JSON.stringify({
        contact_id: contactId || null,
        etape: etape,
        texte: String(texte || "").substring(0, 500),
        detail: detail || null
      })
    });
    if (!res.ok) { /* silencieux */ }
  } catch (e) { /* silencieux : jamais d'erreur à cause du journal */ }
}

// ----------------------------------------------------------------------------
// Secret : ?secret=... (query) ou header x-webhook-secret — même logique que
// api/webhook.js et api/contexte.js. Le cron Vercel envoie Bearer CRON_SECRET.
// ----------------------------------------------------------------------------
function secretDe(req) {
  var secret = "";
  try {
    if (req.query && req.query.secret) secret = String(req.query.secret);
  } catch (e) {}
  if (!secret) {
    var u = (req.url || "").indexOf("?") !== -1 ? req.url.slice(req.url.indexOf("?") + 1) : "";
    var m = u.match(/(?:^|&)secret=([^&]*)/);
    if (m) secret = decodeURIComponent(m[1]);
  }
  if (!secret && req.headers && req.headers["x-webhook-secret"]) secret = String(req.headers["x-webhook-secret"]);
  return secret;
}

function paramDe(req, nom) {
  try {
    if (req.query && req.query[nom]) return String(req.query[nom]);
  } catch (e) {}
  var u = (req.url || "").indexOf("?") !== -1 ? req.url.slice(req.url.indexOf("?") + 1) : "";
  var m = u.match(new RegExp("(?:^|&)" + nom + "=([^&]*)"));
  if (m) return decodeURIComponent(m[1]);
  return "";
}

function autorise(req) {
  var secret = secretDe(req);
  if (env("WEBHOOK_SECRET") && secret === env("WEBHOOK_SECRET")) return true;
  var auth = (req.headers && req.headers.authorization) || "";
  var bearer = auth.indexOf("Bearer ") === 0 ? auth.slice(7) : "";
  if (env("CRON_SECRET") && bearer && bearer === env("CRON_SECRET")) return true;
  return false;
}

// Téléphone de la fiche brute respond.io (champ phone observé en prod
// B2.1.2 : "+33620203963") — formes tolérantes (chaîne, objet, tableau).
function extraireTelephoneFiche(fiche) {
  var v = fiche && fiche.phone;
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (var i = 0; i < v.length; i++) {
      var x = v[i];
      if (typeof x === "string" && x) return x;
      if (x && typeof x === "object") {
        if (x.value) return String(x.value);
        if (x.number) return String(x.number);
      }
    }
  }
  if (typeof v === "object") {
    if (v.value) return String(v.value);
    if (v.number) return String(v.number);
  }
  return "";
}

// La ligne agent_sav.clients du contact (miroir Sheet B2.2), par téléphone.
async function chercherClient(contactId) {
  try {
    var fiche = await respondio.lireContact(contactId);
    var tel = extraireTelephoneFiche(fiche);
    if (!tel) return null;
    var telN = etatLib.normaliserTelephone(tel);
    if (!telN) return null;
    var lignes = await supabaseGet("clients", "select=telephone,plaque,enseigne,statut_risque&telephone=eq." + encodeURIComponent(telN));
    return lignes[0] || null;
  } catch (e) {
    return null; // best-effort : pas de fiche client ≠ traitement bloqué
  }
}

// Leçons actives pour ce dossier (cahier des charges §6.3) : ciblées client
// OU générales, jamais empilées (max 5).
async function chercherLecons(contactId) {
  try {
    var params = "select=regle&statut=eq.active&or=(contact_id.eq." + encodeURIComponent(contactId) +
      ",contact_id.is.null)&order=maj_a.desc&limit=5";
    var lignes = await supabaseGet("lecons", params);
    return lignes.map(function (l) { return String(l.regle || ""); }).filter(Boolean);
  } catch (e) {
    return []; // best-effort
  }
}

// ----------------------------------------------------------------------------
// Le traitement d'UN contact : contexte complet → client → leçons → chaîne
// B4.1 → journal → dossier → statut. Retourne le résumé pour la réponse HTTP.
// ----------------------------------------------------------------------------
async function traiterContact(contactId, idMessage, mode) {
  var ctx = await contexte.assemblerContexte(contactId, 60, false);

  // Cahier des charges §7 : l'agent ne répond JAMAIS sur un extrait. Si
  // l'historique respond.io est illisible, on ne devine pas → erreur
  // journalisée (le message repassera par un ?contact= manuel si besoin).
  if (!ctx.messages.length && ctx.avertissements.length) {
    throw new Error("contexte illisible — historique respond.io indisponible : " +
      ctx.avertissements.join(" ; ").substring(0, 200));
  }

  var client = await chercherClient(contactId);
  var lecons = await chercherLecons(contactId);

  var resultat = await processLib.traiterMessage({
    contactId: contactId,
    ctx: ctx,
    client: client,
    lecons: lecons,
    mode: mode,
    mistral: async function (messages) {
      var r = await mistral.appelMistral(messages);
      return r.texte;
    }
  });

  // Journal — chaque étape, best effort (jamais bloquant)
  for (var i = 0; i < resultat.journal.length; i++) {
    var j = resultat.journal[i];
    await journaliser(contactId, j.etape, j.texte, j.detail);
  }

  // Dossier — le formulaire persiste (source de l'écran de comparaison B5).
  // cycle_actuel n'est PAS fourni : l'upsert conserve la valeur existante
  // (les cycles sont posés par l'adaptateur, en B4.2, jamais par le cerveau).
  try {
    await supabaseUpsert("dossiers", { contact_id: contactId, etat: resultat.etat, maj_a: new Date().toISOString() }, "contact_id");
  } catch (e) {
    await journaliser(contactId, "process_erreur", "dossier non sauvegardé : " + String((e && e.message) || e));
  }

  await supabasePatch("messages", "id=eq." + encodeURIComponent(idMessage), { statut: "traite" });

  return {
    contact: contactId,
    statut: resultat.statut,
    appels_mistral: resultat.appels,
    escalade: resultat.escalade,
    raison_escalade: resultat.raison_escalade || "",
    reponse: String(resultat.reponse || "").substring(0, 200),
    envoyee: false
  };
}

// ----------------------------------------------------------------------------
// Handler Vercel
// ----------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, erreur: "methode non autorisee" });
  }

  if (!autorise(req)) {
    return res.status(401).json({ ok: false, erreur: "secret invalide" });
  }

  // Configuration complète AVANT tout claim — un message en_file ne doit
  // jamais partir en « erreur » à cause d'une variable d'environnement.
  var manquantes = [];
  if (!env("SUPABASE_URL")) manquantes.push("SUPABASE_URL");
  if (!env("SUPABASE_SERVICE_KEY")) manquantes.push("SUPABASE_SERVICE_KEY");
  if (!env("RESPONDIO_TOKEN")) manquantes.push("RESPONDIO_TOKEN");
  if (!env("MISTRAL_API_KEY")) manquantes.push("MISTRAL_API_KEY");
  if (manquantes.length) {
    return res.status(500).json({
      ok: false,
      erreur: "configuration manquante : " + manquantes.join(", ") +
        " — ajoutez-les dans Vercel (Settings → Environment Variables) puis Redeploy. " +
        "MISTRAL_API_KEY : la même clé que l'ancien système (jamais dans le chat)."
    });
  }

  var mode = env("MODE_AGENT") === "actif" ? "actif" : "observation";
  var max = parseInt(paramDe(req, "max"), 10);
  if (!isFinite(max) || max < 1) max = 5;
  if (max > 20) max = 20;
  var contactSeul = paramDe(req, "contact");

  try {
    // Filet anti-blocage : un en_cours abandonné (crash Vercel entre claim et
    // fin) serait à jamais invisible du claim. Après 30 min, on réenfile.
    try {
      var limite = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      await supabasePatch("messages", "statut=eq.en_cours&recu_a=lt." + encodeURIComponent(limite), { statut: "en_file" });
    } catch (e) { /* best effort */ }

    // 1) LES CANDIDATS — messages en_file (les plus anciens d'abord)
    var filtre = "select=id,contact_id,recu_a&statut=eq.en_file&order=recu_a.asc&limit=" + max;
    if (contactSeul) filtre = "select=id,contact_id,recu_a&statut=eq.en_file&contact_id=eq." + encodeURIComponent(contactSeul) + "&order=recu_a.asc&limit=" + max;
    var candidats = await supabaseGet("messages", filtre);
    if (!candidats.length) {
      return res.status(200).json({ ok: true, brique: "B4", version: VERSION, mode: mode, contacts: 0, resultats: [] });
    }

    // 2) LE CLAIM ATOMIQUE — PATCH filtré sur statut=en_file : seules les
    // lignes pas encore réclamées basculent en en_cours. Une exécution
    // parallèle obtient un tableau vide et ne double-traite JAMAIS.
    var ids = candidats.map(function (c) { return c.id; });
    var reclames = await supabasePatch(
      "messages",
      "id=in.(" + ids.map(encodeURIComponent).join(",") + ")&statut=eq.en_file",
      { statut: "en_cours" },
      "return=representation"
    );
    if (!reclames.length) {
      return res.status(200).json({ ok: true, brique: "B4", version: VERSION, mode: mode, contacts: 0, resultats: [], note: "concurrent a déjà réclamé les messages" });
    }

    // 3) GROUPEMENT PAR CONTACT — la chaîne relit TOUT l'historique : si
    // plusieurs messages du même contact sont en file, seul le PLUS RÉCENT
    // est traité, les autres sont couverts (supersede) → traite.
    var parContact = {};
    var ordre = [];
    for (var i = 0; i < reclames.length; i++) {
      var r = reclames[i];
      if (!parContact[r.contact_id]) {
        parContact[r.contact_id] = [];
        ordre.push(r.contact_id);
      }
      parContact[r.contact_id].push(r);
    }

    var resultats = [];
    for (var c = 0; c < ordre.length; c++) {
      var contactId = ordre[c];
      var groupe = parContact[contactId].slice().sort(function (a, b) {
        return String(a.recu_a || "").localeCompare(String(b.recu_a || ""));
      });
      var aTraiter = groupe[groupe.length - 1];
      var couverts = groupe.slice(0, -1);

      for (var k = 0; k < couverts.length; k++) {
        await supabasePatch("messages", "id=eq." + encodeURIComponent(couverts[k].id), { statut: "traite" });
        await journaliser(contactId, "process_supersede", "message couvert par le traitement du message plus récent du contact");
      }

      try {
        resultats.push(await traiterContact(contactId, aTraiter.id, mode));
      } catch (e) {
        // Erreur de traitement (respond.io injoignable, Mistral épuisé…) :
        // le message passe en erreur — JAMAIS rebouclé en en_file (un message
        // empoisonné ne doit pas consommer Mistral indéfiniment).
        await journaliser(contactId, "process_erreur", "erreur de traitement : " + String((e && e.message) || e));
        try {
          await supabasePatch("messages", "id=eq." + encodeURIComponent(aTraiter.id), { statut: "erreur" });
        } catch (e2) { /* déjà journalisé */ }
        resultats.push({ contact: contactId, statut: "erreur", envoyee: false });
      }
    }

    return res.status(200).json({
      ok: true,
      brique: "B4",
      version: VERSION,
      mode: mode,
      contacts: resultats.length,
      resultats: resultats
    });
  } catch (e) {
    return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
  }
};

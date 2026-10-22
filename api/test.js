// ============================================================================
// Agent SAV U'mob v2 — B5.4 : /api/test — LA CONSOLE DE TEST DU NOUVEL AGENT
//
// RÔLE : un bac à sable pour Corentin — tester le NOUVEL agent SANS toucher
// au réel :
//   - la chaîne est RÉELLE jusqu'au bout : fiche client lue dans le miroir
//     agent_sav.clients (B2.2, par téléphone), parc vérifié (MÊME requête
//     que api/process.js — B4.2-PREP.2), Mistral RÉEL (lib/mistral.js),
//     gardes, fusion, RESET/RAZ (B4.2-PREP.1) ;
//   - ZÉRO écriture nulle part : aucun message, aucun journal, aucun dossier
//     Supabase (100 % GET), aucun accès respond.io (RESPONDIO_TOKEN n'est
//     même pas requis — le fil de test n'existe PAS dans respond.io) ;
//   - la MÉMOIRE de conversation vit CÔTÉ NAVIGATEUR (renvoyée à chaque
//     échange) : deux onglets = deux fils indépendants ; RESET la purge.
//
//   GET  /api/test?secret=<WEBHOOK_SECRET>          → la page (HTML sobre)
//   GET  /api/test?secret=…&telephone=0612345678     → fiche client (JSON)
//   POST /api/test?secret=…  body {telephone, message, memoire}
//        → {ok, statut, reponse, escalade, raison_escalade, appels_mistral,
//           type (cerveau|reset|plaque), cycle_prevu {cycle, raison},
//           actions_b42 (B6.1 : écritures B4.2 STRUCTURÉES — envoyer, cycle,
//           tags, commentaire TRANSFERT SAV), actions_simulees,
//           plaques_verifiees, client, etat, journal}
//
// Réponses : 200 HTML/JSON ; 400 corps invalide ; 401 secret invalide ;
// 405 méthode ; 500 configuration manquante (SUPABASE_URL,
// SUPABASE_SERVICE_KEY, MISTRAL_API_KEY) ou erreur de traitement.
// ============================================================================

var VERSION = "B6.3";
var SCHEMA = "agent_sav";

var etatLib = require("../lib/etat.js");
var mistral = require("../lib/mistral.js");
var processLib = require("../lib/process.js");
var comparaison = require("../lib/comparaison.js");

function env(nom) { return process.env[nom] || ""; }

// --- Supabase (REST PostgREST) — style api/observations.js, GET uniquement --
function urlSupabase(table, params) {
  var base = env("SUPABASE_URL").replace(/\/+$/, "").replace(/\/rest\/v1$/, "");
  return base + "/rest/v1/" + table + (params ? "?" + params : "");
}

async function supabaseGet(table, params) {
  var res = await fetch(urlSupabase(table, params), {
    method: "GET",
    headers: {
      "apikey": env("SUPABASE_SERVICE_KEY"),
      "Authorization": "Bearer " + env("SUPABASE_SERVICE_KEY"),
      "Accept-Profile": SCHEMA
    }
  });
  var corps = "";
  try { corps = await res.text(); } catch (e) { corps = ""; }
  if (!res.ok) throw new Error("Supabase " + res.status + " — " + corps.substring(0, 300));
  return corps ? JSON.parse(corps) : [];
}

// --- Secret : ?secret=... (query) ou header x-webhook-secret ----------------
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
  return !!(env("WEBHOOK_SECRET") && secretDe(req) === env("WEBHOOK_SECRET"));
}

// La ligne agent_sav.clients du numéro (miroir Sheet B2.2) — MÊME requête que
// api/process.js, mais SANS passer par respond.io (le bac à sable fournit le
// téléphone lui-même). Best effort : pas de fiche ≠ traitement bloqué.
async function chercherClientTelephone(telN) {
  try {
    var lignes = await supabaseGet("clients",
      "select=telephone,plaque,enseigne,statut_risque&telephone=eq." + encodeURIComponent(telN));
    return lignes[0] || null;
  } catch (e) {
    return null;
  }
}

// B4.2-PREP.2 — la plaque existe-t-elle dans le PARC ? Copie EXACTE de
// api/process.js (même comportement que la prod, y compris le best effort :
// en cas d'erreur on ne rejette JAMAIS — la garde rejetante vit dans
// lib/process.js).
async function plaqueDansParc(plaque) {
  try {
    var lignes = await supabaseGet("clients", "select=plaque&plaque=ilike." +
      encodeURIComponent("*" + String(plaque || "").toUpperCase() + "*") + "&limit=1");
    return lignes.length > 0;
  } catch (e) {
    return true; // dans le doute : la qualification poursuit
  }
}

// ----------------------------------------------------------------------------
// Normalisation de la mémoire du navigateur → messages normalisés B2.1
// ({id, ts, emis_a, texte, media, type_media, sortant, humain}). ts strictement
// croissants (un ts manquant ou dépassé est réassigné) ; 60 messages max.
// ----------------------------------------------------------------------------
function normaliserMemoire(memoire) {
  var msgs = [];
  var dernierTs = 0;
  for (var i = 0; i < memoire.length && msgs.length < 60; i++) {
    var it = memoire[i] || {};
    var texte = String(it.texte || "");
    if (!texte.trim()) continue;
    var ts = Number(it.ts);
    if (!isFinite(ts) || ts <= 0 || ts <= dernierTs) ts = dernierTs + 1000;
    dernierTs = ts;
    msgs.push({
      id: "test-" + ts,
      ts: ts,
      emis_a: new Date(ts).toISOString(),
      texte: texte.substring(0, 2000),
      media: "",
      type_media: null,
      sortant: !!it.sortant,
      humain: false
    });
  }
  return msgs;
}

// Le formulaire du dossier, version COMPACTE (lisible dans la console).
function etatCompact(etat) {
  var e = etat || {};
  return {
    etape: e.etape || 1,
    plaques: e.plaques || [],
    panne: e.panne || "",
    telephone_contact: e.telephone_contact || "",
    jours_fermeture: e.jours_fermeture || "",
    demande_commerciale: !!e.demande_commerciale,
    prise_de_main: !!e.prise_de_main,
    enseigne: e.enseigne || "",
    statut_risque: e.statut_risque || ""
  };
}

// La fiche client, version COMPACTE (les plaques « / »-séparées du miroir
// deviennent une liste lisible).
function clientCompact(ligne) {
  if (!ligne) return null;
  return {
    enseigne: String(ligne.enseigne || ""),
    plaques: String(ligne.plaque || "").split("/").map(function (s) { return s.trim(); }).filter(Boolean),
    statut_risque: ligne.statut_risque || null
  };
}

// ----------------------------------------------------------------------------
// Le traitement d'UN échange de test : contexte FICTIF (le fil du navigateur
// + le nouveau message entrant), client par téléphone, parc réel, Mistral
// réel, chaîne lib/process.js complète. Zéro écriture.
// ----------------------------------------------------------------------------
async function traiterEchange(corps) {
  var telephone = String(corps.telephone || "").trim();
  var message = String(corps.message || "").trim().substring(0, 2000);

  var client = null;
  if (telephone) {
    var telN = etatLib.normaliserTelephone(telephone);
    if (telN) client = await chercherClientTelephone(telN);
  }

  var messages = normaliserMemoire(Array.isArray(corps.memoire) ? corps.memoire : []);
  var tsNouveau = Date.now();
  if (messages.length && tsNouveau <= messages[messages.length - 1].ts) {
    tsNouveau = messages[messages.length - 1].ts + 1000;
  }
  messages.push({
    id: "test-" + tsNouveau,
    ts: tsNouveau,
    emis_a: new Date(tsNouveau).toISOString(),
    texte: message,
    media: "",
    type_media: null,
    sortant: false,
    humain: false
  });

  var ctx = {
    contact: { nom: (client && client.enseigne) ? client.enseigne : "Contact de test", cycle: "", tags: [] },
    messages: messages,
    commentaires: [],
    avertissements: []
  };

  var resultat = await processLib.traiterMessage({
    contactId: "test",
    ctx: ctx,
    client: client,
    lecons: [],           // bac à sable : aucune leçon active
    mode: "observation",  // même en B4.2, le bac à sable n'enverra jamais
    parc: plaqueDansParc,
    mistral: async function (m) {
      var r = await mistral.appelMistral(m);
      return r.texte;
    }
  });

  // Type + cycle prévu de l'échange — extraits du journal d'observation,
  // comme le fait l'écran B5. cycle_prevu est le mapping §5 (lib/cycles.js) :
  // le cycle que le mode ACTIF B4.2 poserait sur la fiche respond.io.
  var type = "cerveau";
  var cyclePrevu = null;
  for (var i = 0; i < resultat.journal.length; i++) {
    var j = resultat.journal[i];
    if (j.etape === "observation" && j.detail) {
      if (j.detail.type) type = String(j.detail.type);
      if (j.detail.cycle_prevu) {
        cyclePrevu = {
          cycle: j.detail.cycle_prevu.cycle || null,
          raison: String(j.detail.cycle_prevu.raison || "")
        };
      }
      break;
    }
  }

  // Vérification INFORMELLE des plaques du message (pour l'AFFICHAGE seul —
  // l'autorité reste traiterMessage, qui rejette lui-même en garde cas A).
  var plaquesVerifiees = [];
  var plaques = etatLib.extrairePlaques(message);
  for (var p = 0; p < plaques.length; p++) {
    plaquesVerifiees.push({ plaque: plaques[p], dans_parc: await plaqueDansParc(plaques[p]) });
  }

  return {
    ok: true,
    brique: "B5.4",
    version: VERSION,
    statut: resultat.statut,
    reponse: String(resultat.reponse || ""),
    escalade: resultat.escalade === true,
    raison_escalade: String(resultat.raison_escalade || ""),
    appels_mistral: resultat.appels,
    type: type,
    cycle_prevu: cyclePrevu,
    actions_b42: (resultat.actions_b42 || []).map(function (a) {
      return { action: a.action, cycle: a.cycle || null, tag: a.tag || null, texte: String(a.texte || "").substring(0, 600) };
    }),
    actions_simulees: comparaison.actionsSimulees(
      type,
      resultat.escalade === true,
      String(resultat.raison_escalade || ""),
      cyclePrevu ? cyclePrevu.cycle : null
    ),
    plaques_verifiees: plaquesVerifiees,
    client: clientCompact(client),
    etat: etatCompact(resultat.etat),
    journal: resultat.journal.map(function (j) { return { etape: j.etape, texte: j.texte }; })
  };
}

// ----------------------------------------------------------------------------
// La page — sobre, aucun framework, même esprit que l'écran B5. La mémoire
// vit dans le navigateur : elle est renvoyée à CHAQUE échange, et RESET la
// purge (comme en prod, où le tag part et le dossier repart à zéro).
// ----------------------------------------------------------------------------
var PAGE_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent SAV v2 — Console de test (bac à sable)</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#f4f5f7;margin:0;padding:24px;color:#1a1a1a}
h1{font-size:20px;margin:0 0 4px}
.sous{color:#666;font-size:13px;margin-bottom:20px}
.carte{background:#fff;border:1px solid #e2e2e6;border-radius:12px;padding:16px;margin-bottom:16px}
.entete{display:flex;justify-content:space-between;margin-bottom:12px}
.nom{font-weight:700}.date{color:#888;font-size:12px}
.meta{color:#555;font-size:12px;margin:-2px 0 10px}
.bloc{border-radius:8px;padding:10px;margin-bottom:10px;font-size:14px;white-space:pre-wrap}
.client{background:#eef4ff;border:1px solid #cfe0ff}
.nouveau{background:#eefaf0;border:1px solid #cdeccd}
.plaques{background:#f9f4ff;border:1px solid #e4d5f7}
.etiquette{display:block;font-size:11px;font-weight:700;color:#777;margin-bottom:6px;text-transform:uppercase}
.actions{background:#fff;border:1px dashed #b7d9c0;border-radius:8px;padding:8px;margin-top:8px;font-size:13px;color:#356;white-space:pre-wrap}
.journal{background:#fff;border:1px dashed #d9c9b7;border-radius:8px;padding:8px;margin-top:8px;font-size:12px;color:#655;white-space:pre-wrap}
.pied{color:#999;font-size:11px;margin-top:8px}
.vide{background:#fff;border:1px dashed #ccc;border-radius:12px;padding:32px;text-align:center;color:#888;margin-bottom:16px}
.rang{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
input{flex:1;min-width:200px;padding:10px;border:1px solid #ccc;border-radius:8px;font-size:14px}
button{padding:10px 16px;border:none;border-radius:8px;background:#1a73e8;color:#fff;font-weight:700;cursor:pointer}
button:hover{background:#1558b0}
button.reset{background:#c5221f}
.resetok{background:#fff6e5;border:1px solid #ffe1a6;border-radius:8px;padding:8px;margin-top:10px;font-size:13px}
.erreur{background:#fdecea;border:1px solid #f5c6c0;border-radius:8px;padding:8px;margin-top:10px;font-size:13px}
</style>
</head>
<body>
<h1>Agent SAV v2 — Console de test</h1>
<div class="sous">Bac à sable : chaîne RÉELLE (fiche client miroir, vérification parc, Mistral, gardes, RESET) mais ZÉRO écriture — rien n'est envoyé au client, rien n'est journalisé, aucun accès respond.io. La mémoire de la conversation vit dans CETTE page ; « RESET » la purge.</div>

<div class="carte">
<span class="etiquette">Fiche client (miroir agent_sav.clients — par téléphone)</span>
<div class="rang">
<input id="tel" placeholder="06 20 20 39 63 (facultatif)">
<button id="btn-fiche">Charger la fiche</button>
</div>
<div id="fiche" class="meta">Renseignez un numéro pour injecter la fiche client (enseigne, plaques flotte, statut risque) dans le test.</div>
</div>

<div id="conversation"></div>
<div class="vide" id="vide">Écrivez un message client ci-dessous — la réponse du NOUVEL agent s'affichera ici, avec son statut, ses appels Mistral, la vérification du parc et ce que B4.2 (mode actif) ferait.</div>

<div class="carte">
<div class="rang">
<input id="msg" placeholder="Message client…" autocomplete="off">
<button id="btn-envoyer">Envoyer</button>
<button id="btn-reset" class="reset">RESET</button>
</div>
</div>

<script>
var SECRET = "";
try { SECRET = new URLSearchParams(window.location.search).get("secret") || ""; } catch (e) {}
var memoire = [];   // [{sortant, texte, ts}] — renvoyée à CHAQUE échange

function $(id) { return document.getElementById(id); }
function ech(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function rendreFiche(c) {
  if (!c) { $("fiche").innerHTML = "<em>Aucun client trouvé à ce numéro dans le miroir clients.</em>"; return; }
  var plaques = (c.plaques || []).join(", ") || "aucune";
  $("fiche").innerHTML = "&#127970; " + ech(c.enseigne || "(enseigne inconnue)") +
    " &middot; plaques : " + ech(plaques) +
    " &middot; risque : " + ech(c.statut_risque || "aucun");
}

async function chargerFiche() {
  var tel = $("tel").value.trim();
  if (!tel) return;
  $("fiche").innerHTML = "chargement…";
  try {
    var r = await fetch("/api/test?secret=" + encodeURIComponent(SECRET) + "&telephone=" + encodeURIComponent(tel));
    var j = await r.json();
    if (!j.ok) { $("fiche").innerHTML = "erreur " + r.status; return; }
    rendreFiche(j.client);
  } catch (e) { $("fiche").innerHTML = "erreur : " + ech(e); }
}

function carteEchange(entree, reponse) {
  var plaques = (reponse.plaques_verifiees || []).map(function (p) {
    return "&bull; " + ech(p.plaque) + " &rarr; " + (p.dans_parc ? "dans le parc" : "ABSENTE du parc");
  }).join("<br>") || "aucune plaque dans ce message";
  var journal = (reponse.journal || []).map(function (j) {
    return "&bull; [" + ech(j.etape) + "] " + ech(j.texte);
  }).join("<br>") || "(vide)";
  var actions = (reponse.actions_b42 && reponse.actions_b42.length)
    ? reponse.actions_b42.map(function (a) {
        var libelles = {
          envoyer_message: "envoyer la réponse au client",
          poser_cycle: "poser le cycle",
          ajouter_tag: "poser le tag",
          retirer_tag: "retirer le tag",
          commentaire: "commentaire interne (jamais visible du client)"
        };
        var t = libelles[a.action] || String(a.action || "?");
        if (a.action === "poser_cycle") t += " « " + (a.cycle || "?") + " »";
        if (a.action === "ajouter_tag" || a.action === "retirer_tag") t += " « " + (a.tag || "?") + " »";
        if (a.action === "commentaire") t += " — aperçu : « " + String(a.texte || "").replace(/\n+/g, " / ").substring(0, 260) + "… »";
        return "&bull; " + ech(t);
      }).join("<br>")
    : (reponse.actions_simulees || []).map(function (a) { return "&bull; " + ech(a); }).join("<br>") || "(vide)";
  var cp = reponse.cycle_prevu || {};
  var cycleTxt = cp.cycle
    ? "<b>" + ech(cp.cycle) + "</b> &mdash; " + ech(cp.raison || "")
    : "(inchangé)" + (cp.raison ? " &mdash; " + ech(cp.raison) : "");
  var e = reponse.etat || {};
  var etatTxt = "etape " + e.etape +
    " &middot; plaque : " + ech((e.plaques || []).join(", ") || "aucune") +
    " &middot; panne : " + ech(e.panne || "—") +
    (e.prise_de_main ? " &middot; PRISE DE MAIN" : "") +
    (e.demande_commerciale ? " &middot; demande commerciale" : "");
  var resetNote = reponse.statut === "reset"
    ? '<div class="resetok">Mémoire purgée — le prochain message repart de zéro (comme en prod, le tag partirait).</div>'
    : "";
  var escalade = reponse.escalade
    ? '<div class="resetok">Escalade demandée : ' + ech(reponse.raison_escalade) + "</div>"
    : "";
  var client = reponse.client
    ? " &middot; client : " + ech(reponse.client.enseigne || "?") + " (plaques : " + ech((reponse.client.plaques || []).join(", ") || "aucune") + ")"
    : "";
  return '<div class="carte">' +
    '<div class="bloc client"><span class="etiquette">CLIENT</span><div>' + ech(entree) + "</div></div>" +
    '<div class="bloc nouveau"><span class="etiquette">NOUVEL AGENT — simulé, NON envoyé</span><div>' +
    ech(reponse.reponse || "(aucune réponse — statut " + ech(reponse.statut) + ")") + "</div></div>" +
    '<div class="meta">statut : <b>' + ech(reponse.statut) + "</b> &middot; type : " + ech(reponse.type) +
    " &middot; appels Mistral : " + ech(reponse.appels_mistral) + client + "</div>" +
    '<div class="meta">📍 Cycle que B4.2 poserait : ' + cycleTxt + "</div>" +
    '<div class="bloc plaques"><span class="etiquette">Vérification parc (affichage)</span><div>' + plaques + "</div></div>" +
    '<div class="actions"><span class="etiquette">B4.2 (mode actif) ferait</span><div>' + actions + "</div></div>" +
    '<div class="journal"><span class="etiquette">Journal</span><div>' + journal + "</div></div>" +
    escalade + resetNote +
    '<div class="pied">etat : ' + etatTxt + "</div>" +
    "</div>";
}

async function envoyer(texte) {
  $("msg").value = "";
  $("btn-envoyer").disabled = true;
  $("btn-reset").disabled = true;
  $("vide").style.display = "none";
  $("conversation").insertAdjacentHTML("beforeend",
    '<div class="carte" id="en-cours">le nouvel agent réfléchit…</div>');
  var avant = memoire.slice();
  memoire.push({ sortant: false, texte: texte, ts: Date.now() });
  try {
    var r = await fetch("/api/test?secret=" + encodeURIComponent(SECRET), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telephone: $("tel").value.trim(), message: texte, memoire: avant })
    });
    var j = await r.json();
    var encours = $("en-cours");
    if (encours) encours.remove();
    if (!j.ok) {
      memoire.pop();
      $("conversation").insertAdjacentHTML("beforeend",
        '<div class="erreur">erreur ' + r.status + " : " + ech(j.erreur || "?") + " — l'échange n'a pas été mémorisé.</div>");
      return;
    }
    $("conversation").insertAdjacentHTML("beforeend", carteEchange(texte, j));
    if (j.statut === "reset") {
      memoire = [];   // purge — même comportement que la prod
    } else if (j.reponse) {
      memoire.push({ sortant: true, texte: j.reponse, ts: Date.now() });
    }
  } catch (e) {
    var encours2 = $("en-cours");
    if (encours2) encours2.remove();
    memoire.pop();
    $("conversation").insertAdjacentHTML("beforeend", '<div class="erreur">erreur : ' + ech(e) + "</div>");
  } finally {
    $("btn-envoyer").disabled = false;
    $("btn-reset").disabled = false;
  }
}

$("btn-fiche").onclick = chargerFiche;
$("btn-envoyer").onclick = function () {
  var t = $("msg").value.trim();
  if (!t) return;
  envoyer(t);
};
$("btn-reset").onclick = function () { envoyer("RESET"); };
$("msg").addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    var t = $("msg").value.trim();
    if (!t) return;
    envoyer(t);
  }
});
</script>
</body>
</html>`;

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

  var manquantes = [];
  if (!env("SUPABASE_URL")) manquantes.push("SUPABASE_URL");
  if (!env("SUPABASE_SERVICE_KEY")) manquantes.push("SUPABASE_SERVICE_KEY");
  if (!env("MISTRAL_API_KEY")) manquantes.push("MISTRAL_API_KEY");
  if (manquantes.length) {
    return res.status(500).json({
      ok: false,
      erreur: "configuration manquante : " + manquantes.join(", ") +
        " — ajoutez-les dans Vercel (Settings → Environment Variables) puis Redeploy."
    });
  }

  try {
    if (req.method === "GET") {
      var tel = paramDe(req, "telephone");
      if (tel) {
        var telN = etatLib.normaliserTelephone(tel);
        var client = telN ? await chercherClientTelephone(telN) : null;
        return res.status(200).json({ ok: true, brique: "B5.4", version: VERSION, telephone: telN || tel, client: clientCompact(client) });
      }
      return res.status(200).send(PAGE_HTML);
    }

    var corps = req.body;
    if (typeof corps === "string") {
      try { corps = JSON.parse(corps); } catch (e) { corps = null; }
    }
    if (!corps || typeof corps !== "object") {
      return res.status(400).json({ ok: false, erreur: "corps JSON attendu : {telephone, message, memoire}" });
    }
    if (!String(corps.message || "").trim()) {
      return res.status(400).json({ ok: false, erreur: "message vide" });
    }

    var resultat = await traiterEchange(corps);
    return res.status(200).json(resultat);
  } catch (e) {
    return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
  }
};

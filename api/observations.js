// ============================================================================
// Agent SAV U'mob v2 — B5 : /api/observations — L'ÉCRAN DE COMPARAISON §9
//
// RÔLE : rendre la comparaison côte à côte LISIBLE — pour chaque observation
// du mode B4.1 : le message client, la réponse RÉELLE de l'ancien agent
// (celle que le client a reçue), et la réponse SIMULÉE du nouveau cerveau
// (jamais envoyée). Corentin compare et décide de la bascule (§9 : la
// conviction, pas la précipitation).
//
//   GET /api/observations?secret=<WEBHOOK_SECRET>&limit=<1-30>
//
//   - secret : OBLIGATOIRE (mêmes règles que webhook/contexte/process).
//   - limit  : nombre d'observations affichées (défaut 15, borné 30).
//
// 100 % LECTURE : journal Supabase + contexte respond.io en lecture. Aucune
// écriture nulle part (ni Supabase, ni respond.io).
// Réponses : 200 HTML ; 401 secret invalide ; 405 non GET ; 500 config.
// ============================================================================

var VERSION = "B5.3";
var SCHEMA = "agent_sav";

var contexte = require("../lib/contexte.js");
var comparaison = require("../lib/comparaison.js");

function env(nom) { return process.env[nom] || ""; }

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

// ----------------------------------------------------------------------------
// Rendu HTML — sobre, lisible, aucun framework (le même esprit que les
// consoles précédentes : un fichier, rien à installer).
// ----------------------------------------------------------------------------
function echapper(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Horodatage du journal = UTC (Supabase) — or Corentin est à Paris : l'écran
// affiche l'heure LOCALE de Paris. Intl + Europe/Paris gère seul le passage
// heure d'été/hiver (UTC+2 / UTC+1). Repli : UTC brut si Intl indisponible.
function dateParis(iso) {
  var t = Date.parse(iso);
  if (isNaN(t) || !t) return String(iso || "");
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(new Date(t)) + " (Paris)";
  } catch (e) {
    return String(iso).replace("T", " ").slice(0, 19) + " (UTC)";
  }
}

function carte(ligne) {
  var ancien = ligne.reponse_ancien || "<em>(aucune réponse réelle — l'ancien agent n'a pas encore répondu, ou un collègue l'a prise)</em>";
  var alerte = ligne.avertissement
    ? '<div class="avert">⚠ ' + echapper(ligne.avertissement) + "</div>"
    : "";
  var escalade = ligne.escalade
    ? '<div class="avert">🚨 Escalade demandée par le nouveau cerveau : ' + echapper(ligne.raison_escalade) + "</div>"
    : "";
  var client = echapper(ligne.message_client) +
    (ligne.media_client ? '<br><a href="' + echapper(ligne.media_client) + '" target="_blank">📎 média</a>' : "");
  // B5.3 (divergence n°3) — cycle et tags ACTUELS de la fiche respond.io :
  // l'API ne permet pas de relire leur HISTORIQUE, seule la valeur du moment
  // est lisible (c'est la capture que Corentin voit dans respond.io).
  var meta = '<div class="meta">📍 Cycle : ' + echapper(ligne.cycle_ancien || "(inconnu)") +
    " · 🏷️ Tags : " + (ligne.tags_ancien && ligne.tags_ancien.length
      ? ligne.tags_ancien.map(echapper).join(", ")
      : "aucun") +
    // B5.4.2 — le cycle que le mode actif poserait (mapping §5, lib/cycles.js)
    " · ⚙️ B4.2 poserait : " + echapper(ligne.cycle_prevu || "(inchangé)") + "</div>";
  // B5.3 — ce que le mode ACTIF B4.2 ferait (SIMULATION, jamais exécuté).
  var actions = (ligne.actions_simulees || [])
    .map(function (a) { return "• " + echapper(a); })
    .join("<br>");
  var blocActions = '<div class="actions"><span class="etiquette">⚙️ B4.2 (mode actif) ferait :</span><div>' + actions + "</div></div>";
  return (
    '<div class="carte">' +
    '<div class="entete">' +
    '<span class="nom">' + echapper(ligne.nom || ligne.contact_id) + "</span>" +
    '<span class="date">' + echapper(dateParis(ligne.date)) + "</span>" +
    "</div>" +
    meta +
    '<div class="bloc client"><span class="etiquette">👤 CLIENT</span><div>' + client + "</div></div>" +
    '<div class="deux">' +
    '<div class="bloc ancien"><span class="etiquette">🤖 ANCIEN — réellement envoyée</span><div>' + echapper(ancien).replace(/\n/g, "<br>") + "</div></div>" +
    '<div class="bloc nouveau"><span class="etiquette">🧠 NOUVEAU — simulée, NON envoyée</span><div>' + echapper(ligne.reponse_nouveau).replace(/\n/g, "<br>") + "</div>" + blocActions + "</div>" +
    "</div>" +
    alerte + escalade +
    '<div class="pied">appels Mistral : ' + ligne.appels_mistral +
    (ligne.type_observation && ligne.type_observation !== "cerveau" ? " · type : " + echapper(ligne.type_observation) : "") +
    "</div>" +
    "</div>"
  );
}

function page(lignes, total, limite) {
  var corps = lignes.length
    ? lignes.map(carte).join("\n")
    : '<div class="vide">Aucune observation pour l\'instant. Elles arrivent dès qu\'un client écrit et que /api/process tourne.</div>';
  return "<!DOCTYPE html><html lang=\"fr\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<title>Agent SAV v2 — Observations (mode observation)</title>" +
    "<style>" +
    "body{font-family:system-ui,-apple-system,sans-serif;background:#f4f5f7;margin:0;padding:24px;color:#1a1a1a}" +
    "h1{font-size:20px;margin:0 0 4px}" +
    ".sous{color:#666;font-size:13px;margin-bottom:20px}" +
    ".carte{background:#fff;border:1px solid #e2e2e6;border-radius:12px;padding:16px;margin-bottom:16px}" +
    ".entete{display:flex;justify-content:space-between;margin-bottom:12px}" +
    ".nom{font-weight:700}.date{color:#888;font-size:12px}" +
    ".meta{color:#555;font-size:12px;margin:-6px 0 12px}" +
    ".actions{background:#fff;border:1px dashed #b7d9c0;border-radius:8px;padding:8px;margin-top:8px;font-size:13px;color:#356}" +
    ".bloc{border-radius:8px;padding:10px;margin-bottom:10px;font-size:14px;white-space:pre-wrap}" +
    ".client{background:#eef4ff;border:1px solid #cfe0ff}" +
    ".deux{display:flex;gap:10px;flex-wrap:wrap}" +
    ".deux .bloc{flex:1;min-width:260px;margin-bottom:0}" +
    ".ancien{background:#f6f6f6;border:1px solid #e2e2e6}" +
    ".nouveau{background:#eefaf0;border:1px solid #cdeccd}" +
    ".etiquette{display:block;font-size:11px;font-weight:700;color:#777;margin-bottom:6px;text-transform:uppercase}" +
    ".avert{background:#fff6e5;border:1px solid #ffe1a6;border-radius:8px;padding:8px;margin-top:10px;font-size:13px}" +
    ".pied{color:#999;font-size:11px;margin-top:8px}" +
    ".vide{background:#fff;border:1px dashed #ccc;border-radius:12px;padding:32px;text-align:center;color:#888}" +
    "</style></head><body>" +
    "<h1>Agent SAV v2 — Observations</h1>" +
    '<div class="sous">' + total + " observation(s) au total — " + lignes.length + " affichée(s) (limit " + limite + ") — heures affichées : Paris. Mode observation : aucune réponse du nouveau cerveau n'a été envoyée aux clients. Cycle et tags = valeurs ACTUELLES de la fiche respond.io (l'API ne permet pas de relire leur historique) ; le bloc « B4.2 ferait » est une simulation, jamais exécutée.</div>" +
    corps +
    "</body></html>";
}

// ----------------------------------------------------------------------------
// Handler Vercel
// ----------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, erreur: "methode non autorisee" });
  }
  if (!env("WEBHOOK_SECRET") || secretDe(req) !== env("WEBHOOK_SECRET")) {
    return res.status(401).json({ ok: false, erreur: "secret invalide" });
  }
  var manquantes = [];
  if (!env("SUPABASE_URL")) manquantes.push("SUPABASE_URL");
  if (!env("SUPABASE_SERVICE_KEY")) manquantes.push("SUPABASE_SERVICE_KEY");
  if (!env("RESPONDIO_TOKEN")) manquantes.push("RESPONDIO_TOKEN");
  if (manquantes.length) {
    return res.status(500).json({ ok: false, erreur: "configuration manquante : " + manquantes.join(", ") });
  }

  var limite = parseInt(paramDe(req, "limit"), 10);
  if (!isFinite(limite) || limite < 1) limite = 15;
  if (limite > 30) limite = 30;

  try {
    // 1) Les observations du journal — les plus récentes d'abord, puis la
    //    table est re-triée chronologiquement par le moteur de comparaison.
    var entrees = await supabaseGet("journal",
      "select=contact_id,horodatage,etape,detail&etape=eq.observation&order=horodatage.desc&limit=" + limite);
    if (!entrees.length) {
      return res.status(200).send(page([], 0, limite));
    }

    // 2) Le contexte respond.io par contact UNIQUE (borne d'appels API : 10
    //    contacts max par page — best-effort, un échec n'affiche pas tout).
    var uniques = [];
    for (var i = 0; i < entrees.length && uniques.length < 10; i++) {
      var cid = String(entrees[i].contact_id || "");
      if (cid && uniques.indexOf(cid) === -1) uniques.push(cid);
    }
    var contextes = {};
    for (var c = 0; c < uniques.length; c++) {
      try {
        contextes[uniques[c]] = await contexte.assemblerContexte(uniques[c], 60, false);
      } catch (e) {
        contextes[uniques[c]] = null; // la ligne aura un avertissement, pas de crash
      }
    }

    // 3) La table de comparaison §9
    var lignes = comparaison.lignesComparaison(entrees, contextes);
    return res.status(200).send(page(lignes, entrees.length, limite));
  } catch (e) {
    return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
  }
};


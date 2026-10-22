// ============================================================================
// Agent SAV U'mob v2 — B6.4 : /api/scan — la maintenance horaire
//
// RÔLE : le passage horaire DÉTERMINISTE (jamais le LLM) sur les dossiers
// récents, en branchant les briques B6.2/B6.3 en exécution (mode actif
// ARMÉ) ou en observation (journal seul) :
//
//   1. REPRISE-DE-ZÉRO (lib/scan.js) : dossier « Traitée »/fermé → purge du
//      dossier + retrait du tag « Prise de main » (plus jamais de message
//      client ignoré à cause d'un tag fantôme — v2.20.64/117).
//   2. SUIVI PRAXEDO (lib/praxedo.js scanSuivis) : refs armées (etat.
//      suivi_refs) vérifiées via le middleware (PRAXEDO_INTERVENTIONS_URL),
//      throttle 2 h par dossier. TOUTES réalisées → cycle « Traitée » +
//      fermeture de la conversation + purge du dossier (v2.20.66). Sans
//      middleware : JAMAIS purgée (une absence de statut n'est pas un état).
//   3. ATTENTE CLIENT (lib/scan.js scanAttenteClient) : dernier sortant
//      qui attend une réponse, silence ≥ 2 h → cycle « Attente client »
//      (v2.20.88).
//   4. RETRAIT DU TAG ≥ 2 h (lib/praxedo.js retirerTagDecision) : UNIQUEMENT
//      sur état observé (« Traitée »/fermé — v2.20.117), ts = etat.tag_pdm_ts.
//   5. DIGEST (lib/digest.js + lib/email.js) : prises de main NON
//      consolidées (tag « Prise de main » posé && !etat.digest_consolide),
//      fenêtre 9h-18h, ≥ 45 min depuis le dernier digest (journal
//      etape='digest_envoye') → UN email consolidé (Resend).
//
// MODE OBSERVATION (défaut) : chaque décision est JOURNALISÉE (scan_* /
// digest_*), AUCUNE écriture respond.io, aucun email. Mode actif ARMÉ
// (MODE_AGENT=actif + B42_EXECUTION=1 — feu vert de Corentin) : exécution
// via l'adaptateur respond.io.
//
//   GET|POST /api/scan?secret=<WEBHOOK_SECRET>  (ou Bearer CRON_SECRET)
//   - contact : OPTIONNEL — scanne UNIQUEMENT ce contact (tests ciblés)
//   - limit   : dossiers récents scannés (défaut 15, borné 50)
//
// NB CRON : plan Hobby Vercel = 1 cron/jour MAXIMUM (README-B4) → le cron
// horaire est EXTERNE (cron-job.org) : chaque minute /api/process, chaque
// heure /api/scan. AUCUN cron ajouté dans vercel.json.
// ============================================================================

var VERSION = "B6.4";
var SCHEMA = "agent_sav";

var contexte = require("../lib/contexte.js");
var respondio = require("../lib/respondio.js");
var scanLib = require("../lib/scan.js");
var praxedoLib = require("../lib/praxedo.js");
var digestLib = require("../lib/digest.js");
var emailLib = require("../lib/email.js");

function env(nom) { return process.env[nom] || ""; }

// --- Supabase (REST PostgREST) — mêmes conventions que api/process.js -----
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

// Journal d'étape — best effort : jamais d'échec du scan à cause du journal.
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
  } catch (e) { /* silencieux */ }
}

// --- Secret : mêmes règles que api/process.js ------------------------------
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

// Heure locale Paris (fenêtre 9h-18h du digest) ; ?heure= enOverride de test.
function heureLocale(maintenant, forcee) {
  var h = parseInt(forcee, 10);
  if (!isNaN(h) && h >= 0 && h <= 23) return h;
  try {
    return parseInt(new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "numeric", hour12: false }).format(new Date(maintenant)), 10);
  } catch (e) {
    return new Date(maintenant).getUTCHours();
  }
}

// ----------------------------------------------------------------------------
// Statuts Praxedo via le middleware (PRAXEDO_INTERVENTIONS_URL — web app
// Apps Script v5.7.4 : GET ?reference=REF → {found, interventions:[…]}).
// Sans middleware : {} → une ref sans statut n'est JAMAIS réalisée (le
// dossier n'est jamais purgé sur une indisponibilité — v2.20.103).
// ----------------------------------------------------------------------------
async function statutsPraxedo(reference) {
  var url = env("PRAXEDO_INTERVENTIONS_URL");
  if (!url) return null;
  try {
    var res = await fetch(url + "?reference=" + encodeURIComponent(reference), { method: "GET" });
    var corps = "";
    try { corps = await res.text(); } catch (e) { corps = ""; }
    if (!res.ok) return null; // indispo ≠ introuvable
    var d;
    try { d = JSON.parse(corps); } catch (e) { return null; }
    if (!d || typeof d !== "object" || d.found === false) return null;
    var liste = Array.isArray(d.interventions) ? d.interventions
      : Array.isArray(d.resultats) ? d.resultats
      : Array.isArray(d.data) ? d.data : [];
    if (!liste.length) return null;
    // statut_code → la forme lue par lib/praxedo.statutRealisee
    var it = liste[0] || {};
    var statut = it.statut_code !== undefined ? it.statut_code
      : (it.status !== undefined ? it.status
      : (it.statut !== undefined ? it.statut
      : (it.etat !== undefined ? it.etat : "")));
    return { status: String(statut) };
  } catch (e) {
    return null;
  }
}

// Dernier digest envoyé (journal etape='digest_envoye') → epoch ms (0 = jamais)
async function dernierDigestMs() {
  try {
    var lignes = await supabaseGet("journal", "select=horodatage&etape=eq.digest_envoye&order=horodatage.desc&limit=1");
    if (lignes.length && lignes[0].horodatage) {
      var t = Date.parse(lignes[0].horodatage);
      if (!isNaN(t)) return t;
    }
  } catch (e) { /* best effort */ }
  return 0;
}

// ----------------------------------------------------------------------------
// Le scan d'UN dossier (une ligne agent_sav.dossiers) :
//   retour = { decisions: [strings lisible], prise: bool (digest ?) }
// arme : exécution respond.io autorisée (MODE_AGENT=actif + B42_EXECUTION=1).
// ----------------------------------------------------------------------------
async function scannerDossier(ligne, maintenant, arme) {
  var contactId = String(ligne.contact_id || "");
  var etatP = (ligne.etat && typeof ligne.etat === "object") ? ligne.etat : {};
  var decisions = [];

  // Contexte respond.io (fiche + historique) — best effort.
  var ctx;
  try {
    ctx = await contexte.assemblerContexte(contactId, 30, false);
  } catch (e) {
    await journaliser(contactId, "scan_erreur", "contexte illisible : " + String((e && e.message) || e));
    return { decisions: decisions, prise: false };
  }
  var cycle = String((ctx.contact && ctx.contact.cycle) || "");
  var tags = (ctx.contact && ctx.contact.tags) || [];
  var tagPdm = tags.some(function (t) { return String(t || "").trim().toLowerCase() === "prise de main"; });

  // 1) REPRISE-DE-ZÉRO (v2.20.64/117) : dossier terminé → purge + retrait du
  // tag fantôme. Les autres décisions sont sans objet sur un dossier purgé.
  if (scanLib.repriseDeZeroNecessaire(cycle, false)) {
    decisions.push("reprise_de_zero");
    await journaliser(contactId, "scan_reprise_de_zero",
      "dossier terminé (« " + cycle + " ») — purge du dossier" + (tagPdm ? " + retrait du tag « Prise de main »" : ""));
    if (arme) {
      try {
        await supabaseUpsert("dossiers", { contact_id: contactId, etat: {}, maj_a: new Date().toISOString() }, "contact_id");
      } catch (e) {
        await journaliser(contactId, "scan_erreur", "purge dossier échouée : " + String((e && e.message) || e));
      }
      if (tagPdm) {
        try { await respondio.retirerTag(contactId, "Prise de main"); }
        catch (e) { await journaliser(contactId, "scan_erreur", "retrait tag échoué : " + String((e && e.message) || e)); }
      }
    }
    return { decisions: decisions, prise: false };
  }

  // 2) SUIVI PRAXEDO (throttle 2 h, purge si TOUTES réalisées — v2.20.66).
  // Le throttle est vérifié AVANT tout appel middleware : un dossier déjà
  // contrôlé il y a moins de 2 h ne consomme AUCUN appel réseau.
  var refs = Array.isArray(etatP.suivi_refs) ? etatP.suivi_refs : [];
  if (refs.length && maintenant - (Number(etatP.ts_check_praxedo) || 0) >= praxedoLib.THROTTLE_SCAN_MS) {
    var statuts = {};
    for (var r = 0; r < refs.length; r++) {
      var ev = await statutsPraxedo(refs[r]);
      if (ev) statuts[refs[r]] = ev;
    }
    var scanP = praxedoLib.scanSuivis(maintenant, [{
      contactId: contactId,
      suiviRefs: refs,
      tsCheck: Number(etatP.ts_check_praxedo) || 0,
      statuts: statuts
    }])[0];
    if (scanP.a_traiter) {
      // Le passage compte : le throttle est consommé (etat.ts_check_praxedo)
      var etatMaj = Object.assign({}, etatP, { ts_check_praxedo: maintenant });
      try {
        await supabaseUpsert("dossiers", { contact_id: contactId, etat: etatMaj, maj_a: new Date().toISOString() }, "contact_id");
      } catch (e) { /* best effort */ }
      if (scanP.purger) {
        decisions.push("praxedo_terminee");
        await journaliser(contactId, "scan_praxedo_terminee", scanP.raison, { references: refs });
        if (arme) {
          var ecritures = [];
          try { await respondio.poserCycle(contactId, praxedoLib.CYCLE_TRAITEE); ecritures.push("cycle « Traitée »"); }
          catch (e) { await journaliser(contactId, "scan_erreur", "cycle « Traitée » échoué : " + String((e && e.message) || e)); }
          try { await respondio.fermerConversation(contactId); ecritures.push("conversation fermée"); }
          catch (e) { await journaliser(contactId, "scan_erreur", "fermeture conversation échouée : " + String((e && e.message) || e)); }
          try {
            await supabaseUpsert("dossiers", { contact_id: contactId, etat: {}, maj_a: new Date().toISOString() }, "contact_id");
            ecritures.push("dossier purgé");
          } catch (e) { await journaliser(contactId, "scan_erreur", "purge dossier échouée : " + String((e && e.message) || e)); }
          if (tagPdm) {
            try { await respondio.retirerTag(contactId, "Prise de main"); ecritures.push("tag retiré"); }
            catch (e) { await journaliser(contactId, "scan_erreur", "retrait tag échoué : " + String((e && e.message) || e)); }
          }
          await journaliser(contactId, "scan_execute", "B4.2 scan exécuté : " + ecritures.join(", "));
        }
        return { decisions: decisions, prise: false };
      }
      await journaliser(contactId, "scan_praxedo_en_cours", scanP.raison, { references: refs, statuts_vus: scanP.statuts_vus });
    }
  }

  // 3) ATTENTE CLIENT (v2.20.88) : question sans réponse depuis ≥ 2 h.
  var attente = scanLib.scanAttenteClient(maintenant, [{
    contactId: contactId,
    cycleActuel: cycle,
    conversationFermee: false,
    messages: ctx.messages || []
  }]);
  if (attente.length) {
    decisions.push("attente_client");
    await journaliser(contactId, "scan_attente_client", attente[0].raison, { silence_ms: attente[0].silence_ms });
    if (arme) {
      try {
        await respondio.poserCycle(contactId, attente[0].cycle);
        await journaliser(contactId, "scan_execute", "B4.2 scan exécuté : cycle « " + attente[0].cycle + " »");
      } catch (e) {
        await journaliser(contactId, "scan_erreur", "cycle « Attente client » échoué : " + String((e && e.message) || e));
      }
    }
  }

  // 4) RETRAIT DU TAG ≥ 2 h SUR ÉTAT OBSERVÉ (v2.20.117)
  if (tagPdm) {
    var retrait = praxedoLib.retirerTagDecision(maintenant, Number(etatP.tag_pdm_ts) || 0, cycle, false);
    if (retrait.retirer) {
      decisions.push("retrait_tag");
      await journaliser(contactId, "scan_retrait_tag", retrait.raison);
      if (arme) {
        try {
          await respondio.retirerTag(contactId, "Prise de main");
          await journaliser(contactId, "scan_execute", "B4.2 scan exécuté : retrait du tag « Prise de main »");
        } catch (e) {
          await journaliser(contactId, "scan_erreur", "retrait tag échoué : " + String((e && e.message) || e));
        }
      }
    } else if (Number(etatP.tag_pdm_ts)) {
      await journaliser(contactId, "scan_tag_conserve", retrait.raison, { tag_pdm_ts: etatP.tag_pdm_ts });
    }
  }

  // 5) DIGEST — cette prise de main est-elle non consolidée ?
  var prise = tagPdm && !etatP.digest_consolide;
  return { decisions: decisions, prise: prise, nom: (ctx.contact && ctx.contact.nom) || "" };
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

  var manquantes = [];
  if (!env("SUPABASE_URL")) manquantes.push("SUPABASE_URL");
  if (!env("SUPABASE_SERVICE_KEY")) manquantes.push("SUPABASE_SERVICE_KEY");
  if (!env("RESPONDIO_TOKEN")) manquantes.push("RESPONDIO_TOKEN");
  if (manquantes.length) {
    return res.status(500).json({
      ok: false,
      erreur: "configuration manquante : " + manquantes.join(", ") + " — ajoutez-les dans Vercel (Settings → Environment Variables) puis Redeploy."
    });
  }

  var mode = env("MODE_AGENT") === "actif" ? "actif" : "observation";
  var arme = mode === "actif" && env("B42_EXECUTION") === "1";
  var maintenant = parseInt(paramDe(req, "maintenant"), 10);
  if (!isFinite(maintenant) || maintenant <= 0) maintenant = Date.now();
  var heure = heureLocale(maintenant, paramDe(req, "heure"));
  var limite = parseInt(paramDe(req, "limit"), 10);
  if (!isFinite(limite) || limite < 1) limite = 15;
  if (limite > 50) limite = 50;
  var contactSeul = paramDe(req, "contact");

  try {
    // Candidats : les dossiers les plus récemment mis à jour.
    var filtreD = "select=contact_id,etat&order=maj_a.desc&limit=" + limite;
    if (contactSeul) filtreD = "select=contact_id,etat&contact_id=eq." + encodeURIComponent(contactSeul) + "&order=maj_a.desc&limit=" + limite;
    var dossiers = await supabaseGet("dossiers", filtreD);

    var prises = [];
    var decisions = [];
    for (var d = 0; d < dossiers.length; d++) {
      var r = await scannerDossier(dossiers[d], maintenant, arme);
      if (r.prise) {
        prises.push({ contactId: String(dossiers[d].contact_id), nom: r.nom || "Contact" });
      }
      for (var k = 0; k < r.decisions.length; k++) {
        decisions.push({ contact: String(dossiers[d].contact_id), decision: r.decisions[k] });
      }
    }

    // LE DIGEST : UN email consolidé pour TOUTES les prises non consolidées.
    var digest = { prises: prises.length, envoye: false, raison: "aucune prise de main non consolidée" };
    if (prises.length) {
      var dernier = await dernierDigestMs();
      var decDig = digestLib.digestNecessaire({ maintenant: maintenant, dernier_digest_ts: dernier, trigger: "scan", heure: heure });
      if (decDig.necessaire) {
        var corps = digestLib.corpsDigest(prises.map(function (p) {
          return { contactId: p.contactId, nom: p.nom, raison: "" };
        }));
        if (arme) {
          var envoi = await emailLib.envoyerEmail("Agent SAV U'mob — prises de main en cours (" + prises.length + ")", corps);
          digest.envoye = envoi.envoye;
          digest.raison = envoi.envoye ? "digest envoyé" : ("digest NON envoyé : " + envoi.raison);
          if (envoi.envoye) {
            await journaliser(null, "digest_envoye", "digest des prises de main envoyé (" + prises.length + " dossier(s))", { prises: prises });
            for (var p = 0; p < prises.length; p++) {
              try {
                var lignesD2 = await supabaseGet("dossiers", "select=etat&contact_id=eq." + encodeURIComponent(prises[p].contactId) + "&limit=1");
                if (lignesD2.length) {
                  var e2 = (lignesD2[0].etat && typeof lignesD2[0].etat === "object") ? lignesD2[0].etat : {};
                  e2.digest_consolide = true;
                  await supabaseUpsert("dossiers", { contact_id: prises[p].contactId, etat: e2, maj_a: new Date().toISOString() }, "contact_id");
                }
              } catch (e) { /* best effort */ }
            }
          } else {
            await journaliser(null, "digest_non_envoye", digest.raison, { prises: prises.length });
          }
        } else {
          digest.raison = "digest prêt (" + prises.length + " prise(s)) — NON envoyé (mode observation)";
          await journaliser(null, "digest_prevu", digest.raison, { prises: prises });
        }
      } else {
        digest.raison = decDig.differe ? ("digest différé : " + decDig.raison) : ("digest inutile : " + decDig.raison);
        await journaliser(null, decDig.differe ? "digest_differe" : "digest_attente", digest.raison, { prises: prises });
      }
    }

    return res.status(200).json({
      ok: true,
      brique: "B6",
      version: VERSION,
      mode: mode,
      arme: arme,
      dossiers: dossiers.length,
      decisions: decisions,
      digest: digest
    });
  } catch (e) {
    return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
  }
};

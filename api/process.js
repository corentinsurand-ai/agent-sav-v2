// ============================================================================
// Agent SAV U'mob v2 — B4.1/B6.1 : /api/process — le processeur
//
// RÔLE : vider la file agent_sav.messages en traitant chaque contact à travers
// la chaîne complète (contexte → état → cerveau → gardes → fusion → actions
// B4.2). MODE OBSERVATION par défaut : la réponse est journalisée « non
// envoyée » avec la liste EXACTE des écritures que le mode actif ferait
// (detail.actions_b42) — aucune écriture chez respond.io, aucun cycle posé.
//
// B6.1 — MODE ACTIF ARMÉ (bascule B4.2) : UNIQUEMENT si les DEUX variables
// d'environnement sont posées dans Vercel (MODE_AGENT=actif ET
// B42_EXECUTION=1 — le feu vert de Corentin), les actions B4.2 sont
// EXÉCUTÉES via l'adaptateur (lib/respondio.js) : envoi de la réponse, cycle
// casse exacte, tags, commentaire TRANSFERT SAV. Chaque écriture est
// journalisée (b42_envoyer_message, b42_poser_cycle, …) ; une écriture en
// échec n'interrompt JAMAIS les suivantes (une demande ne doit jamais être
// perdue). Tant que B42_EXECUTION n'existe pas, ce code est INATTEIGNABLE.
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

var VERSION = "B6.4";
var SCHEMA = "agent_sav";

var contexte = require("../lib/contexte.js");
var respondio = require("../lib/respondio.js");
var etatLib = require("../lib/etat.js");
var mistral = require("../lib/mistral.js");
var processLib = require("../lib/process.js");
var actionsLib = require("../lib/actions.js"); // B6.1 — exécution B4.2 (armée)
var praxedoLib = require("../lib/praxedo.js"); // B6.4 — vérification des refs
var renommageLib = require("../lib/renommage.js"); // B6.4 — renommage (OFF par défaut)
var leconsLib = require("../lib/lecons.js");   // B6.7 — leçons de terrain (ciblage déclencheurs)

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

// B6.3 — IDENTIFICATION PAR LA PLAQUE (repli, audit §1 🟡) : si le contact
// n'est pas trouvé par téléphone (fiche sans numéro, numéro absent du miroir
// clients…), on cherche la ligne clients PAR LA PLAQUE citée dans le
// dernier message entrant. Best effort : en cas d'erreur, null (le dossier
// suit sans fiche client, comme avant).
async function chercherClientParPlaque(ctx) {
  try {
    var messages = (ctx && ctx.messages) || [];
    var entrant = null;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (!messages[i].sortant) { entrant = messages[i]; break; }
    }
    if (!entrant) return null;
    var plaques = etatLib.extrairePlaques(String(entrant.texte || ""));
    for (var p = 0; p < plaques.length; p++) {
      var lignes = await supabaseGet("clients", "select=telephone,plaque,enseigne,statut_risque&plaque=ilike." +
        encodeURIComponent("*" + plaques[p] + "*") + "&limit=1");
      if (lignes.length) {
        return { client: lignes[0], plaque: plaques[p] };
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// B6.3 — RÉSOLUTION DU CANAL (ton par canal, portage v2.10) : le channelId
// respond.io devient un NOM de canal lisible par le cerveau. D'abord la
// correspondance explicite (env CANAUX : {"1234":"whatsapp", "5678":"mail"}),
// sinon heuristique sur l'identifiant ; '' = non résolu → ton simple.
function nomCanal(channelId) {
  var id = String(channelId || "");
  if (!id) return "";
  var map = {};
  try { map = JSON.parse(env("CANAUX")) || {}; } catch (e) { map = {}; }
  if (map[id]) return String(map[id]);
  var bas = id.toLowerCase();
  if (/whatsapp|\bwa\b/.test(bas)) return "whatsapp";
  if (/mail|smtp|courriel/.test(bas)) return "mail";
  return "";
}

// B6.7 — Leçons applicables à CE dossier (cahier des charges §6) : ciblées client
// OU générales, actives OU validées, et surtout INJECTION CIBLÉE par déclencheurs
// (une leçon n'entre dans le prompt QUE si son sujet est dans la conversation —
// « crevaison » citée → la leçon crevaison entre) ; jamais empilées (max 3,
// par occurrences décroissantes). Best effort : en cas d'erreur → aucune leçon,
// le traitement poursuit.
async function chercherLecons(contactId, ctx) {
  try {
    var params = "select=regle,declencheurs,portee,contact_id,statut,occurrences&statut=in.(active,validee)" +
      "&or=(contact_id.eq." + encodeURIComponent(contactId) + ",contact_id.is.null)&order=maj_a.desc&limit=50";
    var lignes = await supabaseGet("lecons", params);
    var texte = leconsLib.texteDeConversation((ctx && ctx.messages) || []);
    return leconsLib.leconsApplicables(lignes, texte, contactId);
  } catch (e) {
    return []; // best-effort
  }
}

// B4.2-PREP.2 — la plaque citée pour la 1re fois par le client existe-t-elle
// dans le PARC ? Le miroir agent_sav.clients (B2.2) contient TOUTES les
// plaques du parc (colonne plaque, « / »-séparées) : like *AA123BB* = recherche
// pleine colonne, insensible à la casse (ilike). Best effort : en cas d'erreur
// on ne rejette JAMAIS (la plaque n'est pas bloquante, règle 6) — la garde
// rejetante vit dans lib/process.js, ce fichier ne fait que RÉPONDRE à la
// question « cette plaque est-elle dans le parc ? ».
async function plaqueDansParc(plaque) {
  try {
    var lignes = await supabaseGet("clients", "select=plaque&plaque=ilike." +
      encodeURIComponent("*" + String(plaque || "").toUpperCase() + "*") + "&limit=1");
    return lignes.length > 0;
  } catch (e) {
    return true; // dans le doute : la qualification poursuit
  }
}

// B6.4 — VÉRIFICATEUR PRAXEDO (injecté dans lib/process pour l'armement) :
// une référence citée par un collègue est contrôlée contre le middleware
// « Praxedo Interventions » (web app Apps Script v5.7.4 — GET ?reference=REF
// → {found, interventions:[… statut_code]}). Les 3 états vivent dans
// lib/praxedo.js verifierReference (erreur ≠ introuvable). Sans
// PRAXEDO_INTERVENTIONS_URL : null (compte-rendu « indisponible »).
async function verifierPraxedo(reference) {
  if (!env("PRAXEDO_INTERVENTIONS_URL")) return null;
  try {
    var res = await fetch(env("PRAXEDO_INTERVENTIONS_URL") + "?reference=" + encodeURIComponent(reference), {
      method: "GET"
    });
    var corps = "";
    try { corps = await res.text(); } catch (e) { corps = ""; }
    return praxedoLib.verifierReference({ code: reference, statutHttp: res.status, corps: corps });
  } catch (e) {
    return "erreur"; // indispo réseau ≠ référence introuvable
  }
}

// ----------------------------------------------------------------------------
// Le traitement d'UN contact : contexte complet → client → leçons → chaîne
// B4.1 → journal → dossier → statut. Retourne le résumé pour la réponse HTTP.
// B6.4 — declencheur : 'message' (défaut) | 'consigne' (la ligne claimée est
// un commentaire @Agent IA) ; consigneTexte : le texte de la consigne enfilée.
// ----------------------------------------------------------------------------
async function traiterContact(contactId, idMessage, mode, declencheur, consigneTexte) {
  var ctx = await contexte.assemblerContexte(contactId, 60, false);

  // Cahier des charges §7 : l'agent ne répond JAMAIS sur un extrait. Si
  // l'historique respond.io est illisible, on ne devine pas → erreur
  // journalisée (le message repassera par un ?contact= manuel si besoin).
  if (!ctx.messages.length && ctx.avertissements.length) {
    throw new Error("contexte illisible — historique respond.io indisponible : " +
      ctx.avertissements.join(" ; ").substring(0, 200));
  }

  var client = await chercherClient(contactId);
  var lecons = await chercherLecons(contactId, ctx); // B6.7 — ciblage par déclencheurs

  // B6.3 — repli PAR LA PLAQUE : pas trouvé par téléphone → la plaque citée
  // dans le dernier message entrant identifie la fiche (journalisée).
  if (!client) {
    var parPlaque = await chercherClientParPlaque(ctx);
    if (parPlaque) {
      client = parPlaque.client;
      await journaliser(contactId, "identification_par_plaque",
        "fiche client retrouvée par la plaque citée : " + parPlaque.plaque);
    }
  }

  // B6.3 — canal résolu (ton par canal, portage v2.10) : '' si inconnu.
  var canal = nomCanal(ctx.contact && ctx.contact.channelId);

  // B6.4 — champs PERSISTANTS du dossier (survivent aux reconstructions) :
  // suivi_refs (armement Praxedo), consigne_vue (dédup 15 min), tag_pdm_ts
  // (scan de retrait ≥ 2 h), digest_consolide, ts_check_praxedo (throttle).
  var etatPersistant = {};
  try {
    var lignesD = await supabaseGet("dossiers", "select=etat&contact_id=eq." + encodeURIComponent(contactId) + "&limit=1");
    if (lignesD.length && lignesD[0].etat && typeof lignesD[0].etat === "object") {
      etatPersistant = lignesD[0].etat;
    }
  } catch (e) { /* best effort : un dossier neuf part vierge */ }

  var resultat = await processLib.traiterMessage({
    contactId: contactId,
    ctx: ctx,
    client: client,
    lecons: lecons,
    mode: mode,
    canal: canal,
    execution_armee: mode === "actif" && env("B42_EXECUTION") === "1", // B6.1
    parc: plaqueDansParc, // B4.2-PREP.2 — vérification plaque contre le parc (garde cas A)
    declencheur: declencheur === "consigne" ? "consigne" : "message", // B6.4
    consigne: declencheur === "consigne" ? { texte: String(consigneTexte || "") } : null, // B6.4
    suiviRefsPrecedents: etatPersistant.suivi_refs || [], // B6.4
    consigneVue: etatPersistant.consigne_vue || null, // B6.4
    praxedo: verifierPraxedo, // B6.4 — vérification des refs à l'armement
    mistral: async function (messages, options) {
      var r = await mistral.appelMistral(messages, options || {});
      return r.texte;
    }
  });

  // B6.1 — EXÉCUTION B4.2 : UNIQUEMENT en mode actif ARMÉ (MODE_AGENT=actif
  // + B42_EXECUTION=1). En observation ce bloc est INATTEIGNABLE — aucune
  // écriture respond.io, exactement comme avant. L'adaptateur est la seule
  // couche autorisée à écrire ; une action en échec n'arrête jamais les
  // suivantes ; chaque résultat est journalisé (b42_*).
  var actionsExecutees = [];
  if (mode === "actif" && env("B42_EXECUTION") === "1" &&
      resultat.actions_b42 && resultat.actions_b42.length) {
    actionsExecutees = await actionsLib.executerActions(resultat.actions_b42, {
      envoyerMessage: function (texte, canal) { return respondio.envoyerMessage(contactId, texte, canal); },
      poserCycle: function (cycle) { return respondio.poserCycle(contactId, cycle); },
      ajouterTag: function (tag) { return respondio.ajouterTag(contactId, tag); },
      retirerTag: function (tag) { return respondio.retirerTag(contactId, tag); },
      ecrireCommentaire: function (texte) { return respondio.ecrireCommentaire(contactId, texte); },
      renommerContact: function (nom) { return respondio.renommerContact(contactId, nom); } // B6.4
    });
    for (var a = 0; a < actionsExecutees.length; a++) {
      var ac = actionsExecutees[a] || {};
      await journaliser(contactId, "b42_" + String(ac.action || "?"),
        (ac.ok ? "B4.2 exécutée : " : "B4.2 ÉCHEC : ") + String(ac.action || "?") + (ac.erreur ? " — " + ac.erreur : ""), ac);
    }
    // B6.4 — horodatage de la POSE du tag « Prise de main » (pour le scan de
    // retrait ≥ 2 h — lib/praxedo.retirerTagDecision).
    var tagPdmPose = (resultat.actions_b42 || []).some(function (aPdm, iPdm) {
      return aPdm.action === "ajouter_tag" && aPdm.tag === actionsLib.TAG_PRISE_DE_MAIN &&
        (actionsExecutees[iPdm] || {}).ok === true;
    });
    if (tagPdmPose && resultat.etat) {
      resultat.etat.tag_pdm_ts = Date.now();
      await journaliser(contactId, "tag_pdm_pose", "tag « Prise de main » posé — horodatage enregistré pour le scan de retrait (≥ 2 h)");
    }
  }

  // B6.4 — RENOMMAGE de la fiche (désactivé par défaut — RENOMMAGE_ACTIF=1,
  // parité v2.20.136). La décision est DÉTERMINISTE (lib/renommage.js) ;
  // l'écriture (PATCH respond.io) n'existe qu'en mode actif ARMÉ.
  var decisionRenommage = renommageLib.decisionRenommage({
    actif: env("RENOMMAGE_ACTIF") === "1",
    nom: (ctx.contact && ctx.contact.nom) || "",
    client: client
  });
  if (decisionRenommage.renommer) {
    if (mode === "actif" && env("B42_EXECUTION") === "1") {
      try {
        await respondio.renommerContact(contactId, decisionRenommage.nouveau_nom);
        await journaliser(contactId, "b42_renommer", "B4.2 exécutée : renommage — " + decisionRenommage.nouveau_nom);
      } catch (e) {
        await journaliser(contactId, "b42_renommer", "B4.2 ÉCHEC : renommage — " + String((e && e.message) || e));
      }
    } else {
      await journaliser(contactId, "renommage_prevu",
        "renommage prévu — NON EXÉCUTÉ (mode observation) : " + decisionRenommage.raison,
        { nouveau_nom: decisionRenommage.nouveau_nom });
    }
  }

  // Journal — chaque étape, best effort (jamais bloquant)
  for (var i = 0; i < resultat.journal.length; i++) {
    var j = resultat.journal[i];
    await journaliser(contactId, j.etape, j.texte, j.detail);
  }

  // B6.4 — champs PERSISTANTS jamais perdus par une reconstruction de
  // l'état : ce que le tour n'a pas recalculé est RÉAPPLIQUÉ depuis le
  // dossier existant avant l'upsert.
  if (resultat.etat) {
    var champsPersistants = ["suivi_refs", "consigne_vue", "tag_pdm_ts", "digest_consolide", "ts_check_praxedo"];
    for (var cp = 0; cp < champsPersistants.length; cp++) {
      var cle = champsPersistants[cp];
      if (resultat.etat[cle] === undefined && etatPersistant[cle] !== undefined) {
        resultat.etat[cle] = etatPersistant[cle];
      }
    }
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

  // B6.1 — le résumé porte le compte-rendu d'exécution en mode armé ; en
  // observation, envoyee reste false et actions_executees vide (comme avant).
  var envoyeeReelle = actionsExecutees.some(function (ac) {
    return ac.action === "envoyer_message" && ac.ok === true;
  });

  return {
    contact: contactId,
    statut: resultat.statut,
    appels_mistral: resultat.appels,
    escalade: resultat.escalade,
    raison_escalade: resultat.raison_escalade || "",
    reponse: String(resultat.reponse || "").substring(0, 200),
    envoyee: envoyeeReelle,
    actions_executees: actionsExecutees
  };
}

// ----------------------------------------------------------------------------
// Handler Vercel
// ----------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ ok: false, erreur: "methode non autorisee" });
  }

  // FUSION (30/10, limite Hobby : 12 fonctions/déploiement) : le scan horaire
  // B6.4 vit désormais ICI — /api/process?secret=...&scan=1 délègue au module
  // du scan (qui fait SA PROPRE auth : ?secret= / x-webhook-secret / Bearer).
  if (/(?:^|[?&])scan=1(?:&|$)/.test(req.url || "")) {
    return require("../lib/scan-route.js")(req, res);
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

    // 1) LES CANDIDATS — messages en_file (les plus anciens d'abord).
    // B6.4 — canal_nom + texte lus : canal_nom='consigne' (commentaire
    // @Agent IA, webhook B1.2) déclenche le TOUR CONSIGNE dans lib/process.
    var filtre = "select=id,contact_id,recu_a,canal_nom,texte&statut=eq.en_file&order=recu_a.asc&limit=" + max;
    if (contactSeul) filtre = "select=id,contact_id,recu_a,canal_nom,texte&statut=eq.en_file&contact_id=eq." + encodeURIComponent(contactSeul) + "&order=recu_a.asc&limit=" + max;
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
        var declencheur = String(aTraiter.canal_nom || "") === "consigne" ? "consigne" : "message";
        resultats.push(await traiterContact(contactId, aTraiter.id, mode, declencheur, aTraiter.texte));
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

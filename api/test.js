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
//   - B6.6 — SEULE écriture : les NOTATIONS de Corentin (table
//     agent_sav.notations — un message client + une réponse d'agent notés
//     1-5 avec un type de règle et un commentaire), pour que l'agent
//     PROGRESSE à partir des retours terrain ;
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
//   GET  /api/test?secret=…&notations=1 — B6.6 : les notations déposées
//        (JSON : liste + résumé par type de règle) — LA BOUCLE D'AMÉLIORATION.
//   POST /api/test?secret=…  body {noter: {conversation_id, note (1-5),
//        type_regle, commentaire, tour, type_tour, message_client,
//        reponse_agent}} — B6.6 : dépose UNE notation dans
//        agent_sav.notations (SEULE écriture du bac à sable).
//   POST /api/test?secret=…  body {telephone, commentaire, memoire,
//        commentaires, persistant} — B6.5 : COMMENTAIRE INTERNE @Agent IA,
//   exactement comme un collègue l'écrirait dans respond.io :
//   - sans mention @Agent IA → IGNORÉ (filtre webhook fidèle) ;
//   - question (« ? … » / « Question : … ») → réponse au collègue EN
//     COMMENTAIRE (Mistral réel, texte libre) — affichée, jamais postée ;
//   - référence Praxedo citée → ARMEMENT (cycle « En cours de réalisation »
//     + compte-rendu de vérification) ;
//   - reprise → l'agent reprend sur le dernier message client (réponse au
//     CLIENT simulée) ;
//   - attente client → silence ; info → journalisée ; dédup 15 min active.
//   Les champs {commentaires, persistant} (renvoyés à chaque échange) portent
//   la mémoire des consignes côté navigateur : plaque du collègue VALIDÉE,
//   suivi_refs armé, dédup — comme le dossier Supabase le fait en prod.
//
// Réponses : 200 HTML/JSON ; 400 corps invalide ; 401 secret invalide ;
// 405 méthode ; 500 configuration manquante (SUPABASE_URL,
// SUPABASE_SERVICE_KEY, MISTRAL_API_KEY) ou erreur de traitement.
// ============================================================================

var VERSION = "B6.6";
var SCHEMA = "agent_sav";

var etatLib = require("../lib/etat.js");
var mistral = require("../lib/mistral.js");
var processLib = require("../lib/process.js");
var comparaison = require("../lib/comparaison.js");
var consignesLib = require("../lib/consignes.js"); // B6.5 — filtre mention + analyse
var praxedoLib = require("../lib/praxedo.js");     // B6.5 — vérification des refs (middleware)

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

// B6.6 — SEULE écriture du bac à sable : une notation. Style api/webhook.js
// (Content-Profile agent_sav sur l'insert, Prefer return=minimal).
async function supabaseInsert(table, ligne) {
  var res = await fetch(urlSupabase(table), {
    method: "POST",
    headers: {
      "apikey": env("SUPABASE_SERVICE_KEY"),
      "Authorization": "Bearer " + env("SUPABASE_SERVICE_KEY"),
      "Content-Type": "application/json",
      "Content-Profile": SCHEMA,
      "Prefer": "return=minimal"
    },
    body: JSON.stringify(ligne)
  });
  if (!res.ok) {
    var corps = "";
    try { corps = await res.text(); } catch (e) {}
    throw new Error("Supabase " + res.status + " — " + corps.substring(0, 300));
  }
}

// B6.6 — LES TYPES DE RÈGLE (les gardes B3.3 + les familles de comportement
// du cahier des charges) : la différenciation demandée par Corentin — chaque
// note dit à QUELLE règle elle s'adresse, la boucle d'amélioration peut
// agréger par règle.
var TYPES_REGLES = [
  { id: "ton", libelle: "Ton / politesse" },
  { id: "question_fermee", libelle: "Question fermée" },
  { id: "invention", libelle: "Info inventée (prix, délai, date)" },
  { id: "plaque_redemandee", libelle: "Plaque redemandée" },
  { id: "telephone_redemande", libelle: "Téléphone redemandé" },
  { id: "recap_incomplet", libelle: "Récapitulatif incomplet" },
  { id: "relance_client_cherche", libelle: "Relance pendant la recherche client" },
  { id: "vocabulaire_voiture", libelle: "Vocabulaire voiture / scooter" },
  { id: "signature", libelle: "Signature manquante" },
  { id: "qualification", libelle: "Qualification / étape de conversation" },
  { id: "transfert_escalade", libelle: "Transfert / escalade SAV" },
  { id: "cycle_vie", libelle: "Cycle de vie" },
  { id: "consigne", libelle: "Consignes (question interne, relais, armement)" },
  { id: "reponse_pertinence", libelle: "Réponse hors sujet / pertinence" },
  { id: "autre", libelle: "Autre" }
];
function typeRegleValide(id) {
  for (var i = 0; i < TYPES_REGLES.length; i++) if (TYPES_REGLES[i].id === id) return true;
  return false;
}

// B6.6 — déposer une notation (validation stricte : la donnée doit être
// PROPRE pour agréger par règle). Retour : {ok, notation} | lève une erreur
// explicite si la table agent_sav.notations n'existe pas encore.
async function deposerNotation(n) {
  var o = n || {};
  var note = Number(o.note);
  if (!(note >= 1 && note <= 5) || Math.round(note) !== note) {
    return { ok: false, erreur: "note invalide : un entier de 1 à 5" };
  }
  var conversationId = String(o.conversation_id || "").trim().substring(0, 100);
  if (!conversationId) return { ok: false, erreur: "conversation_id manquant" };
  var typeRegle = String(o.type_regle || "").trim();
  if (!typeRegleValide(typeRegle)) {
    return { ok: false, erreur: "type_regle inconnu : " + typeRegle };
  }
  var ligne = {
    conversation_id: conversationId,
    note: note,
    type_regle: typeRegle,
    commentaire: String(o.commentaire || "").trim().substring(0, 2000),
    tour: String(o.tour || "").trim().substring(0, 20),
    type_tour: String(o.type_tour || "").trim().substring(0, 40),
    message_client: String(o.message_client || "").substring(0, 4000),
    reponse_agent: String(o.reponse_agent || "").substring(0, 4000)
  };
  try {
    await supabaseInsert("notations", ligne);
  } catch (e) {
    var msg = String(e.message || e);
    throw new Error(msg + " — table agent_sav.notations absente ? exécute la section 7 de supabase/schema.sql (cf. README-B6-6.md)");
  }
  ligne.note = note;
  return { ok: true, notation: ligne };
}

// B6.6 — lire les notations (LA BOUCLE D'AMÉLIORATION : liste + résumé par
// règle). Les 200 plus récentes.
async function lireNotations() {
  var lignes = await supabaseGet("notations",
    "select=conversation_id,note,type_regle,commentaire,tour,type_tour,message_client,reponse_agent,cree_a&order=cree_a.desc&limit=200");
  var parRegle = {};
  var total = 0;
  var somme = 0;
  for (var i = 0; i < lignes.length; i++) {
    var l = lignes[i] || {};
    var n = Number(l.note) || 0;
    total++;
    somme += n;
    var cle = String(l.type_regle || "?");
    if (!parRegle[cle]) parRegle[cle] = { nb: 0, somme: 0, libelle: "" };
    parRegle[cle].nb++;
    parRegle[cle].somme += n;
    parRegle[cle].libelle = libelleDeRegle(cle);
  }
  var resume = { total: total, moyenne: total ? Math.round((somme / total) * 100) / 100 : 0, par_regle: {} };
  for (var k in parRegle) {
    resume.par_regle[k] = {
      nb: parRegle[k].nb,
      moyenne: parRegle[k].nb ? Math.round((parRegle[k].somme / parRegle[k].nb) * 100) / 100 : 0,
      libelle: parRegle[k].libelle
    };
  }
  return { notations: lignes, resume: resume };
}

function libelleDeRegle(id) {
  for (var i = 0; i < TYPES_REGLES.length; i++) if (TYPES_REGLES[i].id === id) return TYPES_REGLES[i].libelle;
  return id;
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

// B6.5 — VÉRIFICATEUR PRAXEDO : copie EXACTE de api/process.js. Contrôle une
// référence citée par un collègue contre le middleware « Praxedo
// Interventions » (GET ?reference=REF). Sans PRAXEDO_INTERVENTIONS_URL :
// null → le compte-rendu dira « indisponible » (jamais une absence).
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

// B6.5 — mémoire des COMMENTAIRES du navigateur : une liste de textes (les
// commentaires précédents du collègue, comme l'historique respond.io les
// porterait) — la plaque citée par un collègue y est VALIDÉE à chaque tour
// (lib/process.js 1bis, v2.20.58). 30 commentaires max, 500 car. chacun.
function normaliserCommentaires(liste) {
  var out = [];
  if (!Array.isArray(liste)) return out;
  for (var i = 0; i < liste.length && out.length < 30; i++) {
    var t = String((liste[i] || {}).texte || liste[i] || "").trim().substring(0, 500);
    if (t) out.push({ texte: t }); // objet normalisé B2.1 — lib/process.js 1bis lit {texte}
  }
  return out;
}

// B6.5 — champs persistants du dossier, version bac à sable : renvoyés par
// la réponse à CHAQUE échange, le navigateur les renvoie au suivant (même
// rôle que agent_sav.dossiers en prod : suivi_refs, consigne_vue).
function persistantDe(corps) {
  var p = (corps && corps.persistant && typeof corps.persistant === "object") ? corps.persistant : {};
  return {
    suivi_refs: Array.isArray(p.suivi_refs) ? p.suivi_refs.map(String).slice(0, 20) : [],
    consigne_vue: (p.consigne_vue && p.consigne_vue.cle) ? { cle: String(p.consigne_vue.cle), ts: Number(p.consigne_vue.ts) || 0 } : null
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
    commentaires: normaliserCommentaires(corps.commentaires), // B6.5 — consignes passées : plaque du collègue VALIDÉE (1bis)
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
    persistant: persistantDe(corps), // B6.5 — echo : le navigateur les renvoie au tour suivant
    journal: resultat.journal.map(function (j) { return { etape: j.etape, texte: j.texte }; })
  };
}

// ----------------------------------------------------------------------------
// B6.5 — Le traitement d'UN COMMENTAIRE INTERNE de test : « comme un collègue
// dans respond.io ». Le filtre mention du webhook (sans @Agent IA → IGNORÉ),
// puis le VRAI tour consigne de lib/process.js (declencheur='consigne') :
// question → réponse au collègue (Mistral réel, texte libre) ; référence
// Praxedo → armement + compte-rendu ; reprise → réponse au client simulée ;
// attente client → silence ; info → journalisée ; dédup 15 min (persistant).
// Zéro écriture, aucun POST Supabase/respond.io.
// ----------------------------------------------------------------------------
async function traiterCommentaire(corps) {
  var telephone = String(corps.telephone || "").trim();
  var commentaire = String(corps.commentaire || "").trim().substring(0, 2000);
  var persistant = persistantDe(corps);

  // Filtre FIDÈLE au webhook (api/webhook.js) : un commentaire SANS mention
  // @Agent IA n'est même pas enfilé en prod — ici il est ignoré pareil.
  if (!consignesLib.mentionneAgent(commentaire)) {
    return {
      ok: true,
      brique: "B5.4",
      version: VERSION,
      tour: "commentaire",
      statut: "ignore",
      type: "commentaire_ignore",
      reponse: "",
      reponse_commentaire: "",
      escalade: false,
      raison_escalade: "",
      appels_mistral: 0,
      analyse: null,
      actions_b42: [],
      client: null,
      etat: null,
      persistant: persistant,
      journal: [
        { etape: "webhook_commentaire_ignore", texte: "Commentaire SANS mention @Agent IA — ignoré (filtre webhook, jamais enfilé)" }
      ]
    };
  }

  var analyse = consignesLib.analyser({ texte: commentaire });

  var client = null;
  if (telephone) {
    var telN = etatLib.normaliserTelephone(telephone);
    if (telN) client = await chercherClientTelephone(telN);
  }

  // Le contexte : le fil du navigateur, SANS nouveau message client (fidèle à
  // la prod : la consigne est enfilée par le webhook, elle ne fait PAS partie
  // de l'historique respond.io) + les commentaires précédents (plaque du
  // collègue validée en 1bis).
  var messages = normaliserMemoire(Array.isArray(corps.memoire) ? corps.memoire : []);
  var ctx = {
    contact: { nom: (client && client.enseigne) ? client.enseigne : "Contact de test", cycle: "", tags: [] },
    messages: messages,
    commentaires: normaliserCommentaires(corps.commentaires),
    avertissements: []
  };

  var resultat = await processLib.traiterMessage({
    contactId: "test",
    ctx: ctx,
    client: client,
    lecons: [],
    mode: "observation",
    parc: plaqueDansParc,
    declencheur: "consigne",
    consigne: { texte: commentaire },
    suiviRefsPrecedents: persistant.suivi_refs,
    consigneVue: persistant.consigne_vue,
    praxedo: verifierPraxedo,
    mistral: async function (m, options) {
      var r = await mistral.appelMistral(m, options || {});
      return r.texte;
    }
  });

  // Le type du tour : lu dans le journal (mêmes étapes que la prod).
  var etapesConsigne = ["consigne_dedup", "consigne_question", "consigne_armement",
    "consigne_attente_client", "consigne_relais_client", "consigne_reprise", "consigne_info"];
  var type = "info";
  for (var i = 0; i < resultat.journal.length; i++) {
    if (etapesConsigne.indexOf(resultat.journal[i].etape) !== -1) {
      type = {
        consigne_dedup: "dedup",
        consigne_question: "question_interne",
        consigne_armement: "armement",
        consigne_attente_client: "attente_client",
        consigne_relais_client: "relais_client",
        consigne_reprise: "reprise",
        consigne_info: "info"
      }[resultat.journal[i].etape];
      break;
    }
  }

  // La réponse au collègue (question) ou le compte-rendu (armement) : le
  // COMMENTAIRE que le mode actif ARMÉ posterait dans respond.io.
  var reponseCommentaire = "";
  var actionsB42 = resultat.actions_b42 || [];
  for (var a = 0; a < actionsB42.length; a++) {
    if (actionsB42[a].action === "commentaire" && actionsB42[a].texte) {
      reponseCommentaire = String(actionsB42[a].texte).substring(0, 2000);
      break;
    }
  }

  var etatFinal = resultat.etat || {};
  return {
    ok: true,
    brique: "B5.4",
    version: VERSION,
    tour: "consigne",
    statut: resultat.statut,
    type: type,
    reponse: String(resultat.reponse || ""), // reprise : réponse au CLIENT simulée
    reponse_commentaire: reponseCommentaire, // question/armement : commentaire à TOI
    escalade: resultat.escalade === true,
    raison_escalade: String(resultat.raison_escalade || ""),
    appels_mistral: resultat.appels,
    analyse: {
      pour_agent: analyse.pour_agent,
      question_interne: analyse.question_interne,
      consigne: analyse.consigne,
      references: analyse.references,
      plaques: analyse.plaques,
      reprise: analyse.reprise,
      attend_reponse: analyse.attend_reponse,
      relais_client: analyse.relais_client === true
    },
    actions_b42: actionsB42.map(function (ac) {
      return { action: ac.action, cycle: ac.cycle || null, tag: ac.tag || null, texte: String(ac.texte || "").substring(0, 600) };
    }),
    client: clientCompact(client),
    etat: etatCompact(etatFinal),
    persistant: {
      suivi_refs: Array.isArray(etatFinal.suivi_refs) ? etatFinal.suivi_refs.map(String).slice(0, 20) : persistant.suivi_refs,
      consigne_vue: (etatFinal.consigne_vue && etatFinal.consigne_vue.cle) ? etatFinal.consigne_vue : persistant.consigne_vue
    },
    journal: resultat.journal.map(function (j) { return { etape: j.etape, texte: j.texte }; })
  };
}

// ----------------------------------------------------------------------------
// La page — sobre, aucun framework, même esprit que l'écran B5. La mémoire
// vit dans le navigateur : elle est renvoyée à CHAQUE échange, et RESET
// ferme la conversation et en ouvre une NOUVELLE (B6.6).
// ----------------------------------------------------------------------------
var LIBELLES_REGLES_JSON = JSON.stringify((function () {
  var m = {};
  for (var i = 0; i < TYPES_REGLES.length; i++) m[TYPES_REGLES[i].id] = TYPES_REGLES[i].libelle;
  return m;
})());

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
.commentaire{background:#fff8e6;border:1px solid #f0dfa8}
.reponsecoll{background:#eefaf0;border:1px solid #cdeccd}
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
.noter{background:#f7f9ff;border:1px dashed #b9c8ee;border-radius:8px;padding:10px;margin-top:10px;font-size:13px}
.etoile{background:#eef0f4;color:#333;border:none;border-radius:6px;padding:6px 12px;margin-right:2px;cursor:pointer;font-size:14px}
select{padding:8px;border:1px solid #ccc;border-radius:8px;font-size:13px;flex:1;min-width:160px}
.note-ok{background:#eefaf0;border:1px solid #cdeccd;border-radius:8px;padding:8px;font-size:13px}
</style>
</head>
<body>
<h1>Agent SAV v2 — Console de test</h1>
<div class="sous">Bac à sable : chaîne RÉELLE (fiche client miroir, vérification parc, Mistral, gardes, RESET, commentaires internes @Agent IA) mais ZÉRO écriture — rien n'est envoyé au client, rien n'est journalisé, aucun accès respond.io. La mémoire de la conversation vit dans CETTE page ; « RESET » la purge.</div>

<div class="carte">
<span class="etiquette">Fiche client (miroir agent_sav.clients — par téléphone)</span>
<div class="rang">
<input id="tel" placeholder="06 20 20 39 63 (facultatif)">
<button id="btn-fiche">Charger la fiche</button>
</div>
<div id="fiche" class="meta">Renseignez un numéro pour injecter la fiche client (enseigne, plaques flotte, statut risque) dans le test.</div>
</div>

<div class="carte">
<span class="etiquette">Conversations de test (B6.6)</span>
<div class="rang">
<select id="menu-conv"></select>
<button id="btn-conv-new">Nouvelle conversation</button>
</div>
<div class="meta">Chaque conversation est un fil indépendant (mémoire, commentaires, dossier persistant). « RESET » ferme la conversation en cours et en ouvre une nouvelle ; les conversations fermées restent consultables ici.</div>
</div>

<div id="conversation"></div>
<div class="vide" id="vide">Écrivez un message client ci-dessous — la réponse du NOUVEL agent s'affichera ici, avec son statut, ses appels Mistral, la vérification du parc et ce que B4.2 (mode actif) ferait.</div>

<div class="carte">
<span class="etiquette">Message client (simulé)</span>
<div class="rang">
<input id="msg" placeholder="Message client…" autocomplete="off">
<button id="btn-envoyer">Envoyer</button>
<button id="btn-reset" class="reset">RESET</button>
</div>
</div>

<div class="carte">
<span class="etiquette">Commentaire interne — comme un collègue dans respond.io</span>
<div class="rang">
<input id="com" placeholder="@Agent IA question : où en est ce dossier ?" autocomplete="off">
<button id="btn-commenter">Commenter</button>
</div>
<div class="meta">« ? … » ou « Question : … » → l'agent répond À TOI en commentaire ; référence Praxedo (EVE…) → armement du suivi ; « demande au client… / dis-lui… » → il transmet la demande AU CLIENT ; « poursuis / reprends » → il répond au dernier message client ; sans mention @Agent IA → ignoré (filtre webhook).</div>
</div>

<script>
var SECRET = "";
try { SECRET = new URLSearchParams(window.location.search).get("secret") || ""; } catch (e) {}

// B6.6 — LES TYPES DE RÈGLE (injectés par le serveur, source unique) :
// chaque note dit à QUELLE règle elle s'adresse.
var REGLES = ${LIBELLES_REGLES_JSON};
function optionsRegles() {
  var o = '<option value="">— type de règle —</option>';
  for (var k in REGLES) o += '<option value="' + k + '">' + REGLES[k] + "</option>";
  return o;
}
function libelleRegle(id) { return REGLES[id] || id; }

// B6.6 — LES CONVERSATIONS : chaque conversation est un fil indépendant
// (mémoire, commentaires, persistant). RESET ferme la conversation en cours
// et en ouvre une nouvelle. Toutes restent consultables dans le menu.
var conversations = [];
var conv = null;
var compteurConv = 0;
var compteurWidgets = 0;

function $(id) { return document.getElementById(id); }

function nouvelleConversation(messageVide) {
  compteurConv++;
  conv = {
    id: "conv-" + compteurConv + "-" + Date.now(),
    titre: "Conversation " + compteurConv,
    fermee: false,
    cartes: [],
    widgets: {},
    memoire: [],
    commentaires: [],
    persistant: { suivi_refs: [], consigne_vue: null },
    messageVide: messageVide || ""
  };
  conversations.push(conv);
  majMenu();
  afficherConversation();
}

function majMenu() {
  var html = "";
  for (var i = conversations.length - 1; i >= 0; i--) {
    var c = conversations[i];
    html += '<option value="' + ech(c.id) + '"' + (c === conv ? " selected" : "") + ">" +
      ech(c.titre) + (c.fermee ? " — fermée" : "") + " · " + c.cartes.length + " échange(s)</option>";
  }
  $("menu-conv").innerHTML = html;
}

function afficherConversation() {
  var contenu = "";
  for (var i = 0; i < conv.cartes.length; i++) contenu += conv.cartes[i];
  if (conv.fermee && conv.cartes.length) {
    contenu += '<div class="resetok">Conversation fermée (RESET) — historique conservé en lecture.</div>';
  }
  $("conversation").innerHTML = contenu;
  if (conv.cartes.length) {
    $("vide").style.display = "none";
  } else {
    $("vide").innerHTML = conv.messageVide ||
      "Écrivez un message client ci-dessous — la réponse du NOUVEL agent s'affichera ici, avec son statut, ses appels Mistral, la vérification du parc et ce que B4.2 (mode actif) ferait.";
    $("vide").style.display = "block";
  }
  for (var w in conv.widgets) brancherNoter(w);
}

function fermerEtNouvelle() {
  conv.fermee = true;
  conv.titre = conv.titre + " (fermée)";
  nouvelleConversation("RESET reçu : la conversation précédente est fermée (retrouve-la dans le menu ci-dessus). Tu es dans une NOUVELLE conversation — écris un message client pour commencer.");
}
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
        if (a.action === "commentaire") t += " — aperçu : « " + String(a.texte || "").replace(/\\n+/g, " / ").substring(0, 260) + "… »";
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
  var avant = conv.memoire.slice();
  conv.memoire.push({ sortant: false, texte: texte, ts: Date.now() });
  try {
    var r = await fetch("/api/test?secret=" + encodeURIComponent(SECRET), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telephone: $("tel").value.trim(), message: texte, memoire: avant, commentaires: conv.commentaires, persistant: conv.persistant })
    });
    var j = await r.json();
    if (!j.ok) {
      conv.memoire.pop();
      conv.cartes.push('<div class="erreur">erreur ' + r.status + " : " + ech(j.erreur || "?") + " — l'échange n'a pas été mémorisé.</div>");
      afficherConversation();
      return;
    }
    if (conv.titre.indexOf("Conversation ") === 0) conv.titre = texte.substring(0, 60);
    compteurWidgets++;
    var idw = "noter-" + compteurWidgets;
    conv.widgets[idw] = {
      payload: {
        tour: "message",
        type_tour: String(j.type || ""),
        message_client: texte,
        reponse_agent: String(j.reponse || "(silence — statut " + j.statut + ")")
      },
      etat: null
    };
    conv.cartes.push(carteEchange(texte, j) + '<div class="noter" id="' + idw + '"></div>');
    if (j.persistant) conv.persistant = j.persistant;
    if (j.statut === "reset") {
      fermerEtNouvelle();   // B6.6 : RESET ferme la conversation, en ouvre une nouvelle
      return;
    }
    if (j.reponse) conv.memoire.push({ sortant: true, texte: j.reponse, ts: Date.now() });
    afficherConversation();
    majMenu();
  } catch (e) {
    conv.memoire.pop();
    conv.cartes.push('<div class="erreur">erreur : ' + ech(e) + "</div>");
    afficherConversation();
  } finally {
    $("btn-envoyer").disabled = false;
    $("btn-reset").disabled = false;
  }
}

function carteCommentaire(entree, j) {
  var analyse = j.analyse || {};
  var journal = (j.journal || []).map(function (x) {
    return "&bull; [" + ech(x.etape) + "] " + ech(x.texte);
  }).join("<br>") || "(vide)";
  var analyseTxt = "consigne : « " + ech(analyse.consigne || "(vide)") + " »" +
    (analyse.question_interne ? " &middot; question interne" : "") +
    (analyse.reprise ? " &middot; reprise" : "") +
    (analyse.attend_reponse ? " &middot; attente client" : "") +
    (analyse.relais_client ? " &middot; relais client" : "") +
    ((analyse.references || []).length ? " &middot; refs : " + ech(analyse.references.join(", ")) : "") +
    ((analyse.plaques || []).length ? " &middot; plaques : " + ech(analyse.plaques.join(", ")) : "");
  var actions = (j.actions_b42 || []).map(function (a) {
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
    if (a.action === "commentaire") t += " — aperçu : « " + String(a.texte || "").replace(/\\n+/g, " / ").substring(0, 260) + "… »";
    return "&bull; " + ech(t);
  }).join("<br>") || "(aucune)";
  var tete = '<div class="bloc commentaire"><span class="etiquette">TOI — commentaire interne</span><div>' + ech(entree) + "</div></div>";
  var corps = "";
  if (j.type === "commentaire_ignore") {
    corps = '<div class="erreur">IGNORÉ — sans mention @Agent IA : en prod, le webhook n\\'enfilerait même pas ce commentaire.</div>';
  } else if (j.type === "question_interne") {
    corps = '<div class="bloc reponsecoll"><span class="etiquette">AGENT IA — réponse à TOI (commentaire interne — jamais au client)</span><div>' +
      ech(j.reponse_commentaire || "(aucune réponse)") + "</div></div>" +
      '<div class="meta">En mode actif ARMÉ, ce commentaire serait POSTÉ dans respond.io ; en observation (comme ici), il est journalisé seulement.</div>';
  } else if (j.type === "armement") {
    corps = '<div class="bloc reponsecoll"><span class="etiquette">AGENT IA — compte-rendu interne (armement Praxedo)</span><div>' +
      ech(j.reponse_commentaire || "(compte-rendu absent)") + "</div></div>" +
      '<div class="meta">En mode actif ARMÉ : cycle « En cours de réalisation » posé + ce commentaire posté.</div>';
  } else if (j.type === "attente_client") {
    corps = '<div class="resetok">Silence — l\\'agent attend la réponse du client, il ne relance jamais (v2.20.119).</div>';
  } else if (j.type === "relais_client") {
    corps = '<div class="bloc nouveau"><span class="etiquette">AGENT IA — message AU CLIENT (relais de ta demande, simulé, NON envoyé)</span><div>' +
      ech(j.reponse || "(aucun message)") + "</div></div>" +
      '<div class="meta">Relais B6.5.1 : en mode actif ARMÉ, ce message serait ENVOYÉ au client ; le scan posera « Attente client » après 2 h si le client ne répond pas.</div>';
  } else if (j.type === "reprise") {
    corps = j.reponse
      ? '<div class="bloc nouveau"><span class="etiquette">AGENT IA — réponse au CLIENT (reprise, simulée, NON envoyée)</span><div>' + ech(j.reponse) + "</div></div>" +
        '<div class="meta">Reprise : le silence de prise de main est BYPASSÉ, l\\'agent répond au dernier message client.</div>'
      : '<div class="resetok">Reprise demandée, mais aucun message client en attente — silence.</div>';
  } else if (j.type === "dedup") {
    corps = '<div class="resetok">Consigne répétée à moins de 15 min — IGNORÉE (dédup v2.20.99).</div>';
  } else {
    corps = '<div class="resetok">Consigne journalisée — aucune action automatique associée (info pure).</div>';
  }
  var e = j.etat || {};
  var etatTxt = e.etape
    ? "etape " + e.etape + " &middot; plaque : " + ech((e.plaques || []).join(", ") || "aucune") +
      " &middot; panne : " + ech(e.panne || "—")
    : "";
  return '<div class="carte">' + tete +
    '<div class="meta">' + analyseTxt + "</div>" + corps +
    '<div class="meta">statut : <b>' + ech(j.statut) + "</b> &middot; type : " + ech(j.type) +
    " &middot; appels Mistral : " + ech(j.appels_mistral) + "</div>" +
    '<div class="actions"><span class="etiquette">B4.2 (mode actif) ferait</span><div>' + actions + "</div></div>" +
    '<div class="journal"><span class="etiquette">Journal</span><div>' + journal + "</div></div>" +
    (etatTxt ? '<div class="pied">etat : ' + etatTxt + "</div>" : "") +
    "</div>";
}

async function envoyerCommentaire(texte) {
  $("com").value = "";
  $("btn-commenter").disabled = true;
  $("vide").style.display = "none";
  $("conversation").insertAdjacentHTML("beforeend",
    '<div class="carte" id="en-cours-com">l\\'agent lit ton commentaire…</div>');
  try {
    var r = await fetch("/api/test?secret=" + encodeURIComponent(SECRET), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ telephone: $("tel").value.trim(), commentaire: texte, memoire: conv.memoire.slice(), commentaires: conv.commentaires.slice(), persistant: conv.persistant })
    });
    var j = await r.json();
    if (!j.ok) {
      conv.cartes.push('<div class="erreur">erreur ' + r.status + " : " + ech(j.erreur || "?") + "</div>");
      afficherConversation();
      return;
    }
    conv.commentaires.push(texte);
    if (j.persistant) conv.persistant = j.persistant;
    if (j.type === "reprise" && j.reponse) {
      conv.memoire.push({ sortant: true, texte: j.reponse, ts: Date.now() });
    }
    compteurWidgets++;
    var idw = "noter-" + compteurWidgets;
    conv.widgets[idw] = {
      payload: {
        tour: "consigne",
        type_tour: String(j.type || ""),
        message_client: texte,
        reponse_agent: String(j.reponse_commentaire || j.reponse || "(comportement : " + j.type + ")")
      },
      etat: null
    };
    conv.cartes.push(carteCommentaire(texte, j) + '<div class="noter" id="' + idw + '"></div>');
    afficherConversation();
    majMenu();
  } catch (e) {
    conv.cartes.push('<div class="erreur">erreur : ' + ech(e) + "</div>");
    afficherConversation();
  } finally {
    $("btn-commenter").disabled = false;
  }
}

// ----------------------------------------------------------------------------
// B6.6 — LA NOTATION : 1-5 étoiles + type de règle + commentaire → table
// agent_sav.notations (SEULE écriture) → la boucle d'amélioration de l'agent.
// ----------------------------------------------------------------------------
function brancherNoter(idw) {
  var el = $(idw);
  if (!el) return;
  var w = conv.widgets[idw];
  if (!w) return;
  if (w.etat) {
    el.innerHTML = '<div class="note-ok">&#9989; notée ' + w.etat.note + "/5 · règle : " +
      ech(w.etat.libelle) +
      (w.etat.commentaire ? " · « " + ech(w.etat.commentaire) + " »" : "") +
      " — enregistrée (agent_sav.notations) pour faire progresser l'agent.</div>";
    return;
  }
  var etoiles = "";
  for (var n = 1; n <= 5; n++) {
    etoiles += '<button type="button" class="etoile" id="' + idw + "-n" + n + '">' + n + "</button> ";
  }
  el.innerHTML =
    '<span class="etiquette">Ta note (1-5) — pour faire progresser l\\'agent</span>' +
    '<div class="rang">' + etoiles +
    '<select id="' + idw + '-regle">' + optionsRegles() + "</select>" +
    '<input id="' + idw + '-com" placeholder="Commentaire (facultatif)" autocomplete="off">' +
    '<button type="button" id="' + idw + '-btn">Noter</button></div>' +
    '<div class="meta" id="' + idw + '-err"></div>';
  var note = 0;
  for (var n2 = 1; n2 <= 5; n2++) {
    (function (val) {
      $(idw + "-n" + val).onclick = function () {
        note = val;
        for (var k = 1; k <= 5; k++) {
          $(idw + "-n" + k).style.background = k <= val ? "#f5a623" : "#eef0f4";
        }
      };
    })(n2);
  }
  $(idw + "-btn").onclick = async function () {
    if (!note) { $(idw + "-err").textContent = "choisis d'abord une note de 1 à 5."; return; }
    var regle = $(idw + "-regle").value;
    if (!regle) { $(idw + "-err").textContent = "choisis le type de règle concerné."; return; }
    var comm = $(idw + "-com").value.trim();
    $(idw + "-btn").disabled = true;
    $(idw + "-err").textContent = "envoi…";
    try {
      var corps = { conversation_id: conv.id, note: note, type_regle: regle, commentaire: comm };
      for (var ch in w.payload) corps[ch] = w.payload[ch];
      var r = await fetch("/api/test?secret=" + encodeURIComponent(SECRET), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noter: corps })
      });
      var j = await r.json();
      if (!j.ok) {
        $(idw + "-err").textContent = "erreur " + r.status + " : " + (j.erreur || "?") + " (ta note n'est PAS perdue : réessaie)";
        $(idw + "-btn").disabled = false;
        return;
      }
      w.etat = { note: note, libelle: libelleRegle(regle), commentaire: comm };
      brancherNoter(idw);
    } catch (e2) {
      $(idw + "-err").textContent = "erreur : " + e2 + " — réessaie";
      $(idw + "-btn").disabled = false;
    }
  };
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
$("btn-commenter").onclick = function () {
  var t = $("com").value.trim();
  if (!t) return;
  envoyerCommentaire(t);
};
$("menu-conv").onchange = function () {
  var id = this.value;
  for (var i = 0; i < conversations.length; i++) {
    if (conversations[i].id === id) { conv = conversations[i]; break; }
  }
  afficherConversation();
  majMenu();
};
$("btn-conv-new").onclick = function () { nouvelleConversation(); };
nouvelleConversation();   // B6.6 — la première conversation
$("com").addEventListener("keydown", function (e) {
  if (e.key === "Enter") {
    var t = $("com").value.trim();
    if (!t) return;
    envoyerCommentaire(t);
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
      if (paramDe(req, "notations")) {
        var nots = await lireNotations();
        return res.status(200).json({
          ok: true,
          brique: "B5.4",
          version: VERSION,
          notations: nots.notations,
          resume: nots.resume
        });
      }
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
      return res.status(400).json({ ok: false, erreur: "corps JSON attendu : {telephone, message | commentaire, memoire}" });
    }
    // B6.6 — NOTATION : la seule écriture du bac à sable (validée AVANT le
    // reste : un POST {noter} n'a ni message ni commentaire).
    if (corps.noter && typeof corps.noter === "object") {
      var dep = await deposerNotation(corps.noter);
      if (!dep.ok) return res.status(400).json({ ok: false, erreur: dep.erreur });
      return res.status(201).json({ ok: true, brique: "B5.4", version: VERSION, notation: dep.notation });
    }

    var messageT = String(corps.message || "").trim();
    var commentaireT = String(corps.commentaire || "").trim();
    if (!messageT && !commentaireT) {
      return res.status(400).json({ ok: false, erreur: "message (ou commentaire) vide" });
    }

    // B6.5 — commentaire interne @Agent IA : le tour consigne du bac à sable
    if (commentaireT && !messageT) {
      var resultatCommentaire = await traiterCommentaire(corps);
      return res.status(200).json(resultatCommentaire);
    }

    var resultat = await traiterEchange(corps);
    return res.status(200).json(resultat);
  } catch (e) {
    return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
  }
};

// B6.6 — la page ÉVALUÉE, exposée pour les tests (tests/test-page-servie.js
// lit la chaîne RÉELLEMENT servie au lieu de re-évaluer la template à la
// main : l'interpolation ${LIBELLES_REGLES_JSON} vit DANS le module).
module.exports.PAGE_HTML = PAGE_HTML;

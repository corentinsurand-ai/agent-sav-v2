// ============================================================================
// Agent SAV U'mob v2 — B6.3 : les consignes internes @Agent IA (Node PUR)
//
// RÔLE (portage v2.20.47-119 de l'ancien système, décision Corentin 23/10
// « tout sauf l'assignation ») : les collègues pilotent l'agent PAR COMMENTAIRE
// respond.io. B2.1 lit DÉJÀ les commentaires (GET, best-effort) ; ce module
// est la part DÉTERMINISTE de leur interprétation :
//
//   - mentionneAgent : le commentaire s'adresse-t-il à l'agent ?
//     « @Agent IA … » / « @Agent U'mob … » (casse/espacements tolérés) ou
//     mention template respond.io « {{@user.ID}} » (v2.20.47).
//   - nettoyerConsigne : retire la mention + les « : ;- » de tête → la
//     consigne NUE (v2.20.119).
//   - estQuestionInterne : MODE QUESTION (« ? … » ou « Question : … » en
//     tête — v2.20.76) : le collègue pose une question à l'agent, l'agent
//     RÉPOND EN COMMENTAIRE, il ne parle JAMAIS au client.
//   - cleDedup / dedup15min : le MÊME collègue reposte la même consigne
//     (casse/ponctuation près) dans les 15 min → ignorée (v2.20.99).
//   - consigneReprise : « poursuis la qualification / continue / reprends »
//     → l'agent reprend la main après une prise de main (v2.20.54).
//   - consigneRelaisClient (B6.5.1) : « demande au client l'adresse » /
//     « dis au client que… » / « demande-lui… » → le collègue demande à
//     l'agent de TRANSMETTRE une demande au client : l'agent rédige le
//     message AU CLIENT (jamais un simple commentaire journalisé).
//   - consigneAttendReponseClient : « dès que le client répond … » /
//     « en attendant sa réponse » → l'agent attend, ne relance pas
//     (v2.20.119 — PAS de faux positif sur « le client a répondu »).
//   - plaquesCitees : une plaque citée par un COLLÈGUE dans une consigne est
//     VALIDÉE (regex plus tolérante que la conversation : 1-2 lettres,
//     2-3 chiffres, ≥6 caractères canoniques — v2.20.58).
//   - extraireRefsInterventions : références Praxedo citées (EVE prioritaire,
//     sinon groupes de 4-8 chiffres — les téléphones à 10 chiffres ne
//     matchent PAS — v2.20.65).
//   - analyser(commentaire) : LA lecture complète d'un commentaire.
//   - etatDossier4Points : l'état du dossier en UNE ligne, pour répondre au
//     collègue qui demande « où on en est » (v2.20.74-79) :
//     « Cycle : X — Plaque : Y — Intervention Praxedo : Z — Attente client : W »
//
// IMPORTANT (v2.20.106) : une consigne NE RETIRE JAMAIS un tag — le retrait
// de « Prise de main » est une décision DÉTERMINISTE séparée (lib/scan.js /
// lib/praxedo.js), jamais l'effet direct d'un commentaire.
//
// AUCUNE assignation, AUCUNE mention @user ÉMISE : décision Corentin 23/10,
// le routage Marine/Nicolas est EXCLU du périmètre.
//
// ZÉRO réseau : ce module ne fait que LIRE et DÉCIDER. L'exécution (répondre
// au collègue, armer Praxedo…) est branchée en B4.2 derrière le feu vert.
// ============================================================================

var RE_MENTION = /@\s*agent\s*(?:ia|umob|u'?mob)\b/i;
var RE_MENTION_TEMPLATE = /\{\{@user\.[^}]+\}\}/i;
var RE_QUESTION_INTERNE = /^(?:\?+\s*|questions?\s*[:：\-]\s*)(.+)$/is;
var DEDUP_MS = 15 * 60 * 1000; // 15 min (v2.20.99)

// Apostrophes typographiques → ASCII
function ascii(s) { return String(s || "").replace(/[\u2018\u2019]/g, "'"); }

// Le commentaire s'adresse-t-il à l'agent ? (mention directe ou template)
function mentionneAgent(texte) {
  var t = ascii(texte);
  return RE_MENTION.test(t) || RE_MENTION_TEMPLATE.test(t);
}

// La consigne NUE : sans la mention, sans les « : ;- » de tête (v2.20.119)
function nettoyerConsigne(texte) {
  var t = ascii(texte);
  t = t.replace(RE_MENTION, " ").replace(RE_MENTION_TEMPLATE, " ");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/^[:;\-–—\s]+/, "").trim();
  return t;
}

// MODE QUESTION (v2.20.76) : « ? … » ou « Question : … » EN TÊTE — le
// collègue interroge l'agent, l'agent répond EN COMMENTAIRE au collègue.
// « Bonjour, ça va ? » en milieu de texte n'est PAS une question interne.
function questionInterne(texte) {
  var m = ascii(texte).match(RE_QUESTION_INTERNE);
  if (!m) return "";
  var q = String(m[1] || "").trim();
  return q ? q : "";
}

function estQuestionInterne(texte) { return questionInterne(texte) !== ""; }

// Clé de dédup (v2.20.99) : contactId + consigne minuscule SANS ponctuation,
// bornée 200 caractères — « Arme Praxedo. » et « arme praxedo » = même clé.
function cleDedup(contactId, consigne) {
  var c = ascii(consigne).toLowerCase()
    .replace(/[.!?,;:`'"()\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return String(contactId || "") + "|" + c;
}

// Dédup 15 min : la consigne est-elle NOUVELLE pour ce contact ?
//   vues = [{ cle, ts }] — consignes déjà vues (journal / mémoire)
//   retour = { cle, nouvelle } — nouvelle=false si la MÊME clé a été vue
//   il y a moins de 15 min.
function dedup15min(maintenant, contactId, consigne, vues) {
  var cle = cleDedup(contactId, consigne);
  var liste = vues || [];
  var maintenant = Number(maintenant) || 0;
  for (var i = 0; i < liste.length; i++) {
    var v = liste[i] || {};
    if (v.cle !== cle) continue;
    if (maintenant - (Number(v.ts) || 0) < DEDUP_MS) {
      return { cle: cle, nouvelle: false }; // repost < 15 min → ignoré
    }
  }
  return { cle: cle, nouvelle: true };
}

// Consigne de REPRISE (v2.20.54) : l'agent reprend la main après une prise
// de main humaine (le tag « Prise de main » sera retiré par B4.2).
function consigneReprise(texte) {
  return /qualif|poursui|reprend|continu/i.test(ascii(texte));
}

// Clause d'ATTENTE CLIENT (v2.20.119) : « dès que le client répond, … »,
// « en attendant sa réponse » → l'agent attend, il ne relance jamais.
// PAS de faux positif : « le client a répondu » (constat, pas attente)
// et « j'ai répondu au client » ne matchent PAS.
function consigneAttendReponseClient(texte) {
  var t = ascii(texte);
  if (/en attendant (?:de )?sa r[ée]ponse/i.test(t)) return true;
  return /(?:d[èe]s que|quand|une fois(?: que)?|apr[èe]s)\s+(?:que\s+)?(?:le\s+|la\s+)?(?:client[ea]?\s+)?(?:aura\s+|auront\s+|a\s+)?r[ée]pond/i.test(t);
}

// Consigne de RELAIS CLIENT (B6.5.1) : le collègue demande à l'agent de
// TRANSMETTRE une demande au client — « demande au client l'adresse pour
// l'intervention », « dis au client que le technicien passe », « informe le
// client du retard », « demande-lui ses photos ». L'agent rédige le message
// AU CLIENT. PAS de faux positif : « le client a demandé » (participe passé),
// « la demande au client » (nom, précédé d'un article), « dis au
// technicien », les reprises (« poursuis ») restent hors champ ; les refs
// Praxedo citées gardent LA PRIORITÉ (armement, B6.4) et l'attente
// (« dès que le client répond… ») est traitée AVANT le relais.
function consigneRelaisClient(texte) {
  var t = ascii(texte);
  var RE_VERBE = /\b(?:re)?demand(?:e|es|ez)(?![ée])|\bdis(?:es)?\b|\bpr[ée]cise?\b|\btransmets?\b|\binform(?:e|es|ez)\b|\bconfirm(?:e|es|ez)(?![ée])|\bannonc(?:e|s|ez)(?![ée])|\bpropos(?:e|es|ez)(?![ée])/gi;
  var m;
  while ((m = RE_VERBE.exec(t)) !== null) {
    // Un nom (« la demande au client », « une annonce au client ») n'est pas
    // un ordre, et un PARTICIPE PASSÉ (« on a proposé au client », « j'ai
    // demandé au client ») est un constat, pas une consigne : un verbe
    // précédé d'un article OU d'un auxiliaire est IGNORÉ.
    var avant = t.slice(Math.max(0, m.index - 16), m.index);
    if (/(?:\b(?:la|une|un|sa|ma|ta|cette|quelle)s?\s+|\b(?:a|ai|as|ont|avons|avez|est|sont|etait|était|ete|été)\s+)$/i.test(avant)) continue;
    // Après le verbe, le CLIENT est désigné à ≤ 60 caractères :
    // « demande au client… », « informe le client… », « demande son adresse
    // au client ».
    var apres = t.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (/\b(?:au|aux|à|a|le|la)\s+(?:client[es]?\b|personne\b)/i.test(apres)) return true;
    // « demande-lui / dis-lui / précise-leur… » — client implicite
    if (/^\s*[-–]?\s*(?:lui|leur)\b/i.test(t.slice(m.index + m[0].length, m.index + m[0].length + 12))) return true;
  }
  return false;
}

// Plaques citées PAR UN COLLÈGUE dans une consigne (v2.20.58) : regex plus
// tolérante que la conversation (1-2 lettres / 2-3 chiffres / 1-2 lettres,
// sur TEXTE EN MAJUSCULES), canonique ≥6 caractères — la plaque citée par
// un collègue est VALIDÉE, elle ne sera JAMAIS redemandée au client.
function plaquesCitees(texte) {
  var t = ascii(texte).toUpperCase();
  var trouvailles = [];
  var re = /([A-Z]{1,2})[-\s ]?(\d{2,3})[-\s ]?([A-Z]{1,2})\b/g;
  var m;
  while ((m = re.exec(t)) !== null) {
    var c = (m[1] + m[2] + m[3]).replace(/[^A-Z0-9]/g, "");
    if (c.length < 6) continue;
    if (trouvailles.indexOf(c) === -1) trouvailles.push(c);
  }
  return trouvailles;
}

// Références d'interventions Praxedo citées (v2.20.65) : refs EVE
// PRIORITAIRES ; sinon groupes de 4-8 chiffres À BORDS DE MOT — un
// téléphone (10 chiffres) ou une plaque ne matchent PAS.
function extraireRefsInterventions(texte) {
  var t = ascii(texte);
  var refs = [];
  var re = /EVE[0-9]{2,12}/gi;
  var m;
  while ((m = re.exec(t)) !== null) {
    var e = m[0].toUpperCase();
    if (refs.indexOf(e) === -1) refs.push(e);
  }
  if (refs.length) return refs;
  re = /(?<![0-9])([0-9]{4,8})(?![0-9])/g;
  while ((m = re.exec(t)) !== null) {
    if (refs.indexOf(m[1]) === -1) refs.push(m[1]);
  }
  return refs;
}

// ----------------------------------------------------------------------------
// analyser(commentaire) — LA lecture complète d'un commentaire normalisé B2.1
// ({ texte, auteur, ts }).
//
//   retour = {
//     pour_agent      : bool — le commentaire s'adresse-t-il à l'agent ?
//     question_interne: bool — MODE QUESTION (l'agent répond au collègue,
//                              JAMAIS au client),
//     consigne        : la consigne NUE ('' si pas pour l'agent),
//     references      : refs Praxedo citées,
//     plaques         : plaques VALIDÉES citées,
//     reprise         : bool — reprise de la main demandée,
//     attend_reponse  : bool — attendre la réponse du client
//     relais_client   : bool — B6.5.1 : transmission d'une demande AU CLIENT
//   }
// ----------------------------------------------------------------------------
function analyser(commentaire) {
  var c = commentaire || {};
  var texte = String(c.texte || "");
  var pourAgent = mentionneAgent(texte);
  var consigne = pourAgent ? nettoyerConsigne(texte) : "";
  return {
    pour_agent: pourAgent,
    question_interne: pourAgent && estQuestionInterne(consigne),
    consigne: consigne,
    references: pourAgent ? extraireRefsInterventions(consigne) : [],
    plaques: pourAgent ? plaquesCitees(consigne) : [],
    reprise: pourAgent && consigneReprise(consigne),
    attend_reponse: pourAgent && consigneAttendReponseClient(consigne),
    relais_client: pourAgent && consigneRelaisClient(consigne)
  };
}

// ----------------------------------------------------------------------------
// etatDossier4Points — l'état du dossier EN UNE LIGNE (v2.20.74-79), pour
// répondre au collègue qui demande où on en est :
//   « Cycle : X — Plaque : Y — Intervention Praxedo : Z — Attente client : W »
//   entree = { cycle (cycle respond.io actuel), etat (formulaire B3.1),
//              suiviRefs ([refs Praxedo suivies]) }
//   « Attente client » = le 1er manquant du dossier (la plaque est signalée
//   NON BLOQUANTE, le téléphone à contacter est le SEUL bloquant — règle 6).
// ----------------------------------------------------------------------------
function etatDossier4Points(entree) {
  var e = entree || {};
  var etat = e.etat || {};
  var plaques = (etat.plaques || []).join(", ");
  var refs = (e.suiviRefs || []).join(", ");

  var attente = "rien en attente";
  if (!etat.telephone_contact) attente = "téléphone à contacter (bloquant)";
  else if (!etat.panne) attente = "description de la panne";
  else if (!plaques) attente = "plaque (non bloquante)";
  else if (!etat.photos) attente = "photos";

  return "Cycle : " + (e.cycle || "—") +
    " — Plaque : " + (plaques || "—") +
    " — Intervention Praxedo : " + (refs || "—") +
    " — Attente client : " + attente;
}

module.exports = {
  DEDUP_MS: DEDUP_MS,
  mentionneAgent: mentionneAgent,
  nettoyerConsigne: nettoyerConsigne,
  questionInterne: questionInterne,
  estQuestionInterne: estQuestionInterne,
  cleDedup: cleDedup,
  dedup15min: dedup15min,
  consigneReprise: consigneReprise,
  consigneRelaisClient: consigneRelaisClient,
  consigneAttendReponseClient: consigneAttendReponseClient,
  plaquesCitees: plaquesCitees,
  extraireRefsInterventions: extraireRefsInterventions,
  analyser: analyser,
  etatDossier4Points: etatDossier4Points
};

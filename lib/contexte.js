// ============================================================================
// Agent SAV U'mob v2 — B2.1 : assemblage du contexte complet d'un contact
//
// RÔLE : assembler, pour un contact, TOUT ce que le cerveau (B3+) devra voir :
//   - fiche   : nom, cycle de vie, tags (dont « Prise de main »)
//   - messages : historique complet normalisé (texte, média, sens entrant/
//                sortant, distinction agent IA / collègue humain), trié du
//                PLUS ANCIEN au plus récent
//   - commentaires : consignes internes des collègues
// Chaque section est BEST-EFFORT : une erreur respond.io n'enlève jamais les
// autres sections (fidèle au prod v136 l. 1544-1551).
//
// Portage fidèle des extracteurs prod :
//   - extraireIdMessage     (v2.20.135 : clés connues puis repli par scan)
//   - messageEnvoyeParHumain (v136 : sender.source/type === 'user')
//   - extraireTsMessage / normaliserTs : déjà portés dans lib/normaliser.js
//   - extraireTexteMessage / extraireMediaUrlMessage / extraireTypeMediaMessage :
//     déjà portés dans lib/normaliser.js (B1), réutilisés tels quels
//
// Aucune écriture, aucun envoi : B2.1 est 100 % LECTURE SEULE.
// ============================================================================

var respondio = require('./respondio.js');
var normaliser = require('./normaliser.js');

// ----------------------------------------------------------------------------
// Extracteurs (portage v2.20.135 / v136)
// ----------------------------------------------------------------------------

// ID d'un message d'historique : clés connues puis repli par scan des clés
// contenant « id », hors identifiants étrangers (contact/channel/user/sender/
// conversation/team). Jamais d'exception.
function extraireIdMessage(m) {
  if (!m || typeof m !== 'object') return '';
  var pref = ['id', 'messageId', 'message_id', 'uuid', 'rowId', 'channelMessageId', 'eventId'];
  for (var i = 0; i < pref.length; i++) {
    var v = m[pref[i]];
    if (v !== undefined && v !== null && String(v) !== '') return String(v);
  }
  for (var k in m) {
    if (/id/i.test(k) && !/contact|channel|user|sender|assign|conversation|team/i.test(k)) {
      var v2 = m[k];
      if (v2 !== undefined && v2 !== null && typeof v2 !== 'object' && String(v2) !== '') return String(v2);
    }
  }
  return '';
}

// Un message sortant a-t-il été envoyé par un HUMAIN (collègue) et non par
// l'agent IA ? Portage exact de messageEnvoyeParHumain (v136 l. 3695).
function messageEnvoyeParHumain(m) {
  try {
    var source = '';
    if (m && m.sender && m.sender.source) source = String(m.sender.source).toLowerCase();
    else if (m && m.sender && m.sender.type) source = String(m.sender.type).toLowerCase();
    else if (m && m.source && m.source.type) source = String(m.source.type).toLowerCase();
    return source === 'user';
  } catch (e) {
    return false;
  }
}

// Fiche contact → { nom, cycle, tags }. Tolérant : fullName OU prénom+nom,
// lifecycle.name, tags en tableau de chaînes (ou d'objets {name}).
function extraireContact(fiche) {
  fiche = fiche || {};
  var nom = String(fiche.fullName || ((fiche.firstName || '') + ' ' + (fiche.lastName || '')).trim() || '');
  // v2.1.2 (constat fiche brute prod réelle 22/10) : l'API actuelle renvoie
  // lifecycle en CHAÎNE à la racine (« En cours de réalisation ») — l'ancienne
  // forme lifecycle.name (prod v136) reste acceptée.
  var lc = fiche.lifecycle;
  var cycle = (typeof lc === 'string') ? lc.trim() : String((lc && lc.name) || '');
  var tags = [];
  if (fiche.tags && typeof fiche.tags.length === 'number') {
    for (var i = 0; i < fiche.tags.length; i++) {
      var t = fiche.tags[i];
      if (t === undefined || t === null) continue;
      if (typeof t === 'object') tags.push(String(t.name || t.slug || t.id || ''));
      else tags.push(String(t));
    }
  }
  return { nom: nom, cycle: cycle, tags: tags, channelId: String(fiche.channelId || '') };
}

// Item d'historique → message normalisé pour le cerveau / la validation.
// Le ts vient de extraireTsMessage (status[] puis replis, v136) puis
// normaliserTs (secondes → ms, v135).
// B2.1.3 (constat brut=1 prod réelle 22/10) : les messages ENTRANTS WhatsApp
// arrivent avec status[] VIDE → ts=0 → relégués en fin de fil (même défaut
// que le prod v136). Repli validé : messageId est un horodatage en
// MICROSECONDES (messageId/1000 = ms, vérifié sur le fil réel GG-798-NL à
// ±1 s des status[] des sortants). Garde : la valeur doit être un entier
// strictement dans ]1e15, 1e16[ pour être un µs plausible (rejette UUID,
// ids courts, décimaux) — sinon ts reste 0, on n'invente JAMAIS un ts.
function normaliserMessageItem(m) {
  m = m || {};
  var tsMs = normaliser.normaliserTs(normaliser.extraireTsMessage(m));
  if (!tsMs) {
    var brut = (m.messageId !== undefined && m.messageId !== null) ? m.messageId : m.id;
    var n = parseInt(brut, 10);
    if (!isNaN(n) && n > 1e15 && n < 1e16) tsMs = Math.round(n / 1000);
  }
  var sortant = /out/i.test(String(m.traffic || ''));
  return {
    id: extraireIdMessage(m),
    ts: tsMs,
    emis_a: tsMs > 0 ? new Date(tsMs).toISOString() : null,
    texte: String(normaliser.extraireTexteMessage(m) || ''),
    media: String(normaliser.extraireMediaUrlMessage(m) || ''),
    type_media: normaliser.extraireTypeMediaMessage(m),
    sortant: sortant,
    humain: sortant && messageEnvoyeParHumain(m)
  };
}

// Item de commentaire → { texte, auteur, ts }. Extraction tolérante (les
// commentaires respond.io n'ont pas de structure stable prouvée en prod).
function normaliserCommentaire(c) {
  c = c || {};
  var texte = '';
  var tCands = [c.text, c.body, c.comment, c.message,
    (c.comment && c.comment.text), (c.comment && c.comment.body)];
  for (var i = 0; i < tCands.length; i++) {
    var v = tCands[i];
    if (typeof v === 'string' && v) { texte = v; break; }
  }
  var auteur = '';
  var aCands = [c.userId, c.createdBy, (c.author && (c.author.name || c.author.id)),
    (c.actor && (c.actor.name || c.actor.id)), (c.user && (c.user.name || c.user.id))];
  for (var j = 0; j < aCands.length; j++) {
    var a = aCands[j];
    if (a !== undefined && a !== null && String(a) !== '') { auteur = String(a); break; }
  }
  var tsMs = normaliser.normaliserTs(normaliser.extraireTsMessage(c));
  return {
    texte: texte,
    auteur: auteur,
    ts: tsMs,
    emis_a: tsMs > 0 ? new Date(tsMs).toISOString() : null
  };
}

// Tri chronologique : du PLUS ANCIEN au plus récent (le cerveau lit le fil
// dans l'ordre). L'API renvoie l'inverse. Portage de ordonnerHistoriqueChronologique
// (v2.20.98) : tri par ts croissant si ≥ 2 horodatages lisibles, sinon
// reverse de l'ordre brut ; les messages sans horodatage lisible partent en fin.
function trierMessages(liste) {
  var lisibles = 0;
  for (var i = 0; i < liste.length; i++) if (liste[i].ts > 0) lisibles++;
  if (lisibles >= 2) {
    var avec = [], sans = [];
    for (var j = 0; j < liste.length; j++) (liste[j].ts > 0 ? avec : sans).push(liste[j]);
    avec.sort(function (a, b) { return a.ts - b.ts; });
    return avec.concat(sans);
  }
  return liste.slice().reverse();
}

// ----------------------------------------------------------------------------
// Assemblage complet (best-effort par section)
// ----------------------------------------------------------------------------

function messageErreur(e) {
  return String((e && e.message) || e || 'erreur inconnue');
}

// Assemble fiche + historique + commentaires d'un contact. SÉQUENTIEL
// (3 appels API dans un ordre déterminé, lisible dans les logs). Une section
// en échec ne casse JAMAIS les autres : l'erreur est renvoyée dans
// avertissements[] et la section reste vide.
//
// 3e paramètre BRUT (diagnostic, méthode prod v135/v136) : true → la réponse
// embarque les réponses BRUTES de respond.io (fiche entière, 2 premiers
// messages bruts, 3 premiers commentaires bruts) pour diagnostiquer sur la
// prod réelle où vit le cycle de vie / pourquoi un endpoint 404. Zéro appel
// supplémentaire : ce sont les MÊMES appels, simplement non normalisés.
async function assemblerContexte(contactId, limite, brut) {
  var out = {
    contact: { nom: '', cycle: '', tags: [], channelId: '', erreur: null },
    messages: [],
    commentaires: [],
    avertissements: [],
    brut: brut ? { fiche: null, messages: [], commentaires: null } : null
  };

  // 1) Fiche contact
  try {
    var fiche = await respondio.lireContact(contactId);
    var c = extraireContact(fiche);
    out.contact.nom = c.nom;
    out.contact.cycle = c.cycle;
    out.contact.tags = c.tags;
    out.contact.channelId = c.channelId;
    if (brut) out.brut.fiche = fiche;
  } catch (e) {
    out.contact.erreur = messageErreur(e);
    out.avertissements.push('contact : ' + messageErreur(e));
  }

  // 2) Historique
  try {
    var items = await respondio.lireHistorique(contactId, limite);
    var msgs = [];
    for (var i = 0; i < items.length; i++) {
      try { msgs.push(normaliserMessageItem(items[i])); } catch (e) { /* item illisible : sauté, jamais de crash */ }
    }
    out.messages = trierMessages(msgs);
    if (brut) out.brut.messages = items.slice(0, 2);
  } catch (e) {
    out.avertissements.push('messages : ' + messageErreur(e));
  }

  // 3) Commentaires internes
  try {
    var itemsC = await respondio.lireCommentaires(contactId);
    for (var k = 0; k < itemsC.length; k++) {
      try { out.commentaires.push(normaliserCommentaire(itemsC[k])); } catch (e) { /* sauté */ }
    }
    if (brut) out.brut.commentaires = itemsC.slice(0, 3);
  } catch (e) {
    // API v2 vérifiée 22/10 (doc officielle) : AUCUN endpoint GET pour LIRE
    // les commentaires — seul POST /contact/{id}/comment (création) existe.
    // → 404 = comportement ATTENDU de respond.io, pas une anomalie de notre
    // côté ; la section reste best-effort si un GET apparaît un jour.
    var msgC = messageErreur(e);
    if (msgC.indexOf('404') !== -1) {
      msgC = '404 — non lisibles via l\'API respond.io (aucun endpoint GET, seule la création existe)';
    }
    out.avertissements.push('commentaires : ' + msgC);
  }

  return out;
}

module.exports = {
  extraireIdMessage: extraireIdMessage,
  messageEnvoyeParHumain: messageEnvoyeParHumain,
  extraireContact: extraireContact,
  normaliserMessageItem: normaliserMessageItem,
  normaliserCommentaire: normaliserCommentaire,
  trierMessages: trierMessages,
  assemblerContexte: assemblerContexte
};

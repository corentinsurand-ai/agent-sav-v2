// ============================================================================
// Agent SAV U'mob v2 — B1 : normalisation d'un payload webhook respond.io
// Portage FIDÈLE du backend prod v2.20.136 (Apps Script) — mêmes règles :
//   - extraction texte (texte / email / média / vocal) — extraireTexteMessage
//   - extraction URL média (images en priorité)       — extraireMediaUrlMessage
//   - détection vocal vs photo                        — extraireTypeMediaMessage112
//   - horodatage via status[].timestamp (ms)          — extraireTsMessage135
//   - filtre emails internes/automatiques (16 motifs EN DUR, garde v2.18.2 + v2.20.118)
// Aucune dépendance, aucun appel réseau : 100 % testable.
// ============================================================================

function extraireTexteMessage(m) {
  m = m || {};
  var im = m.message || {};
  if (typeof im.text === 'string') return String(im.text);
  if (im.text && typeof im.text.body === 'string') return String(im.text.body);
  if (typeof m.text === 'string') return String(m.text);
  if (m.text && typeof m.text.body === 'string') return String(m.text.body);
  if (typeof m.body === 'string') return String(m.body);
  if (im.type === 'email') {
    var corps = String(im.message || '');
    return (im.subject ? 'Objet : ' + im.subject + '\n\n' : '') + corps;
  }
  if (im.type && im.type !== 'text') return '[média reçu]';
  if (m.media || m.attachment) return '[média reçu]';
  return '';
}

function extraireMediaUrlMessage(m) {
  m = m || {};
  var im = m.message || {};
  var candidats = [];
  function pousser(x) { if (x) candidats.push(String(x)); }

  // Formes directes
  if (im.url) pousser(im.url);
  if (im.mediaUrl) pousser(im.mediaUrl);
  if (im.attachment) {
    if (typeof im.attachment === 'string') pousser(im.attachment);
    else if (im.attachment.url) pousser(im.attachment.url);
    else if (im.attachment.mediaUrl) pousser(im.attachment.mediaUrl);
  }
  if (m.media) {
    if (typeof m.media === 'string') pousser(m.media);
    else if (m.media.url) pousser(m.media.url);
    else if (m.media.mediaUrl) pousser(m.media.mediaUrl);
  }
  if (m.attachment) {
    if (typeof m.attachment === 'string') pousser(m.attachment);
    else if (m.attachment.url) pousser(m.attachment.url);
    else if (m.attachment.mediaUrl) pousser(m.attachment.mediaUrl);
  }

  // Listes d'attachments (im.attachments / m.attachments)
  var listes = [im.attachments, m.attachments];
  for (var l = 0; l < listes.length; l++) {
    if (!listes[l] || !listes[l].length) continue;
    for (var i = 0; i < listes[l].length; i++) {
      var a = listes[l][i];
      if (!a) continue;
      var desc = String((a.type || '') + ' ' + (a.attachmentType || '') + ' ' + (a.mime || '') + ' ' + (a.mimeType || '')).toLowerCase();
      var url = a.url || a.mediaUrl || (a.payload && (a.payload.url || a.payload.mediaUrl)) || '';
      if (!url) continue;
      // On ne retient que les images/photos ; sans type identifiable on garde
      // quand même (respond.io liste parfois juste l'URL) mais en dernier recours.
      if (desc.indexOf('image') !== -1 || desc.indexOf('photo') !== -1) {
        candidats.unshift(String(url)); // priorité aux images explicites
      } else if (desc.indexOf('video') === -1 && desc.indexOf('audio') === -1 && desc.indexOf('document') === -1) {
        pousser(url);
      }
    }
  }

  // Première URL http(s) valide
  for (var c = 0; c < candidats.length; c++) {
    if (/^https?:\/\//i.test(candidats[c])) return candidats[c];
  }
  return '';
}

function extraireTypeMediaMessage(m) {
  try {
    m = m || {};
    var im = m.message || {};
    var desc = String((im.type || '') + ' ' + (m.type || '') + ' ' + (im.mediaType || '') + ' ' + (m.mediaType || '') + ' ' +
      (im.mimeType || '') + (im.mime || '') + ' ' + (m.mimeType || '') + ' ' + (im.attachmentType || '')).toLowerCase();
    if (/\baudio\b|voice note|\.opus\b|\.ogg\b|mpeg/.test(desc)) return 'audio';
    if (/\bimage\b|\bphoto\b|\.jpg|\.jpeg|\.png|\.webp/.test(desc)) return 'image';
    // fallback : scan du JSON brut (formats non prévus du payload)
    var brut = '';
    try { brut = JSON.stringify(m); } catch (eB) { brut = ''; }
    if (brut && /"(?:type|mimeType|mediaType)"\s*:\s*"[^"]*audio/.test(brut)) return 'audio';
    return '';
  } catch (e) { return ''; }
}

// v2.20.136 : structure RÉELLE prouvée en prod (brut=1, 22/10) — les messages
// respond.io n'ont AUCUNE date au premier niveau : l'horodatage (ms) vit dans
// status[] : [{timestamp, value:'pending'|'sent'|'delivered'|'read'}, ...].
// On prend le PLUS ANCIEN status = instant d'émission du message.
function extraireTsMessage(m) {
  if (!m || typeof m !== 'object') return 0;
  if (m.status && typeof m.status === 'object' && typeof m.status.length === 'number') {
    var min = 0;
    for (var s = 0; s < m.status.length; s++) {
      var st = m.status[s] || {};
      if (typeof st.timestamp === 'number' && st.timestamp > 1e12 && (!min || st.timestamp < min)) min = st.timestamp;
    }
    if (min) return min;
  }
  var prefT = ['createdAt', 'created_at', 'datetime', 'dateTime', 'timestamp', 'createdDateTime', 'dateCreated', 'sentAt', 'date', 'time'];
  for (var j = 0; j < prefT.length; j++) {
    var t = m[prefT[j]];
    if (typeof t === 'number' && t > 1e9) return t;
    if (typeof t === 'string' && t) { var d = new Date(t).getTime(); if (!isNaN(d) && d > 1e9) return d; }
  }
  for (var kT in m) { // repli 1 : clé évocatrice de date
    if (/date|time|creat|sent/i.test(kT)) {
      var tR = m[kT];
      if (typeof tR === 'number' && tR > 1e9 && tR < 4e12) return tR;
      if (typeof tR === 'string' && tR) { var dR = new Date(tR).getTime(); if (!isNaN(dR) && dR > 1e9) return dR; }
    }
  }
  for (var kN in m) { // repli 2 : n'importe quel nombre plausiblement epoch au premier niveau
    var n = m[kN];
    if (typeof n === 'number' && n > 1e9 && n < 4e12) return n;
  }
  return 0;
}

function normaliserTs(t) { // secondes → millisecondes
  var v = Number(t) || 0;
  if (v > 1e9 && v < 1e12) v = v * 1000;
  return v;
}

// ============================================================================
// FILTRE EMAILS INTERNES / AUTOMATIQUES (garde v2.18.2 + v2.20.118)
// Sur le canal EMAIL, on ignore les messages dont l'expéditeur/objet correspond
// à un motif interne ou automatique. Liste de base EN DUR, résiliente.
// ============================================================================
var MOTIFS_EMAILS_INTERNES = [
  'no-reply', 'noreply', 'donotreply', 'do-not-reply',
  'notification', 'automatique', 'automatic',
  'praxedo', 'creation intervention', 'création intervention',
  'intervention par un technicien', 'information concernant votre demande',
  'postmaster', 'mailer-daemon',
  // v2.20.118 : expéditeur interne Exchange des boîtes mail connectées
  'microsoftexchange', 'indiv3'
];

function estCanalEmail(payload) {
  var canal = payload && payload.channel ? payload.channel : '';
  var nomComplet = '';
  if (typeof canal === 'string') nomComplet = canal;
  else nomComplet = String((canal.name || '') + String(canal.source || ''));
  return /mail|smtp|courriel|email/i.test(nomComplet);
}

// Retourne le motif interne détecté, ou '' si le message vient du client.
function motifEmailInterne(payload) {
  if (!estCanalEmail(payload)) return '';
  var cible = '';
  try { cible = JSON.stringify(payload).toLowerCase(); } catch (e) { cible = ''; }
  if (!cible) return '';
  for (var f = 0; f < MOTIFS_EMAILS_INTERNES.length; f++) {
    var mot = String(MOTIFS_EMAILS_INTERNES[f] || '').trim().toLowerCase();
    if (mot && cible.indexOf(mot) !== -1) return mot;
  }
  return '';
}

// ============================================================================
// NORMALISATION D'UN ÉVÉNEMENT WEBHOOK → ligne de agent_sav.messages
// ============================================================================
function normaliserEvenement(payload) {
  payload = payload || {};
  var contact = payload.contact || {};
  var contactId = String(contact.id || '');

  // Canal : payload.channel = {id, name} — secours : message.channelId
  var canalNom = '', canalId = '';
  var c = payload.channel || '';
  if (typeof c === 'string') {
    canalNom = c;
  } else {
    canalNom = String(c.name || c.type || '');
    canalId = String(c.id || '');
  }
  if (!canalId && payload.message && payload.message.channelId) {
    canalId = String(payload.message.channelId);
    if (!canalNom) canalNom = 'WhatsApp';
  }

  // Message : structure réelle = payload.message.message = {type:"text", text:"..."}
  var m = payload.message || {};
  var texte = extraireTexteMessage(m);
  if (!texte && payload.text) texte = String(payload.text);
  var mediaUrl = extraireMediaUrlMessage(m);
  if (!texte && mediaUrl) texte = '[média reçu]'; // photo sans légende
  // MESSAGE VOCAL — étiqueté EXPLICITEMENT (indistinguable d'une photo sinon) ;
  // l'URL n'est PAS conservée (un audio n'est pas une image : pas de multimodal).
  var typeMedia = extraireTypeMediaMessage(m);
  if (typeMedia === 'audio') { texte = '[message vocal reçu]'; mediaUrl = ''; }
  if (!texte) texte = '(message sans texte extrait — voir colonne brut)';

  // Identifiant de dédup : event_id (retries respond.io rejoués), sinon
  // messageId stable, sinon repli horodaté.
  var eventId = String(payload.event_id ||
    (m && m.messageId) ||
    ('msg-' + Date.now()));

  var motifInterne = motifEmailInterne(payload);

  var tsMs = normaliserTs(extraireTsMessage(m));

  return {
    contactId: contactId,
    conversationId: String(payload.conversation_id || payload.conversationId || ''),
    canalNom: canalNom,
    canalId: canalId,
    texte: texte,
    mediaUrl: mediaUrl || null,
    typeMedia: (typeMedia === 'audio') ? 'audio' : (typeMedia === 'image' || mediaUrl ? 'image' : null),
    emisMs: tsMs > 0 ? tsMs : null,
    eventId: eventId,
    emailInterne: motifInterne !== '',
    motifInterne: motifInterne
  };
}

module.exports = {
  extraireTexteMessage: extraireTexteMessage,
  extraireMediaUrlMessage: extraireMediaUrlMessage,
  extraireTypeMediaMessage: extraireTypeMediaMessage,
  extraireTsMessage: extraireTsMessage,
  normaliserTs: normaliserTs,
  estCanalEmail: estCanalEmail,
  motifEmailInterne: motifEmailInterne,
  MOTIFS_EMAILS_INTERNES: MOTIFS_EMAILS_INTERNES,
  normaliserEvenement: normaliserEvenement
};

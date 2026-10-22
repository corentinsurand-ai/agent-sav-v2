// ============================================================================
// Agent SAV U'mob v2 — B1.1 : webhook respond.io → Supabase (schéma agent_sav)
//
// RÔLE (et SEUL rôle) : enregistrer le message reçu et répondre 200 à
// respond.io en < 1 s. Aucune intelligence ici — le traitement se fera dans
// /api/process (brique B3+), les tables vivent dans le schéma dédié
// agent_sav du projet Supabase EXISTANT (umob-crm) : compartiment étanche,
// zéro collision avec les tables actuelles.
//
// - GET  : santé (aucun secret requis)
// - POST : message respond.io — secret requis (?secret=... ou header
//          x-webhook-secret) ; l'evenement est normalise (portage v136),
//          insere dans agent_sav.messages (dédup par event_id unique),
//          journalise, et renvoie TOUJOURS 200 si le secret est bon
//          (respond.io desactive son webhook sur les echecs).
// ============================================================================

var VERSION = 'B1.2';
var SCHEMA = 'agent_sav';

var normaliser = require('../lib/normaliser.js');
var consignesLib = require('../lib/consignes.js'); // B6.4 — consignes @Agent IA via comment.created

function env(nom) { return process.env[nom] || ''; }

// ----------------------------------------------------------------------------
// Supabase (REST PostgREST). La clé service_role : LECTURE-ÉCRITURE totale —
// elle ne vit QUE dans les variables d'environnement Vercel, jamais dans le
// code ni sur GitHub.
// ----------------------------------------------------------------------------
async function supabaseInsert(table, ligne) {
  // Tolérant au copier-coller : SUPABASE_URL finissant par « /rest/v1 »
  // (piège PGRST125 « Invalid path » constaté en prod réelle B2.2)
  var url = env('SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, '') +
    '/rest/v1/' + table;
  var cle = env('SUPABASE_SERVICE_KEY');
  var res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': cle,
      'Authorization': 'Bearer ' + cle,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
      'Content-Profile': SCHEMA
    },
    body: JSON.stringify(ligne)
  });
  if (res.status === 409) return { doublon: true };   // event_id déjà vu (retry respond.io)
  if (!res.ok) {
    var corps = '';
    try { corps = (await res.text()).substring(0, 300); } catch (e) { corps = ''; }
    throw new Error('Supabase ' + res.status + ' — ' + corps);
  }
  return { doublon: false };
}

// Journal d'étape — best effort : une erreur de journal NE DOIT JAMAIS faire
// échouer l'accusé 200 (le message est déjà enregistré, c'est l'essentiel).
async function journaliser(contactId, etape, texte, detail) {
  try {
    await supabaseInsert('journal', {
      contact_id: contactId || null,
      etape: etape,
      texte: (texte || '').substring(0, 500),
      detail: detail || null
    });
  } catch (e) { /* silencieux : jamais de 500 à cause du journal */ }
}

// ----------------------------------------------------------------------------
// Handler Vercel
// ----------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  // GET santé — publique, sans secret : vérifier que le déploiement est vivant
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, brique: 'B1', version: VERSION, schema: SCHEMA });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });
  }

  // Secret : ?secret=... (URL du webhook respond.io) ou header x-webhook-secret
  var secret = '';
  try {
    if (req.query && req.query.secret) secret = String(req.query.secret);
  } catch (e) {}
  if (!secret) {
    var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice(req.url.indexOf('?') + 1) : '';
    var m = u.match(/(?:^|&)secret=([^&]*)/);
    if (m) secret = decodeURIComponent(m[1]);
  }
  if (!secret && req.headers && req.headers['x-webhook-secret']) secret = String(req.headers['x-webhook-secret']);

  if (!env('WEBHOOK_SECRET') || secret !== env('WEBHOOK_SECRET')) {
    return res.status(401).json({ ok: false, erreur: 'secret invalide' });
  }

  // Type d'événement (format RÉEL respond.io, prouvé en prod : "message.received"
  // avec un point ; tolère l'écriture underscore). B1 ne traite QUE les messages
  // clients — sauf B6.4 : un COMMENTAIRE qui s'adresse à l'agent (« @Agent IA … »)
  // est ENFILÉ avec canal_nom='consigne' (les commentaires ne sont PAS lisibles
  // par GET respond.io, B2.1 : le webhook est le SEUL canal d'entrée des
  // consignes). Les autres événements : 200 + journal, JAMAIS d'erreur
  // (respond.io ne doit pas compter d'échec).
  var typeEvt = String((req.body && req.body.event_type) || '').replace('_', '.');
  var estMessage = typeEvt === 'message.received';
  if (!estMessage && !typeEvt && req.body && req.body.message && req.body.contact) {
    estMessage = true; // repli défensif : structure message complète sans étiquette
  }

  // --------------------------------------------------------------------------
  // B6.4 — COMMENTAIRE @Agent IA (event_type comment.created) : ENFILER en
  // tant que declencheur='consigne'. Le texte est extrait de façon tolérante
  // (payload réel respond.io : formes body.text / body.comment.text /
  // body.data.text observées). Un commentaire SANS mention reste IGNORÉ.
  // --------------------------------------------------------------------------
  if (typeEvt.indexOf('comment') !== -1) {
    var texteCommentaire = '';
    var candsTexte = [
      req.body && req.body.text,
      req.body && req.body.comment && req.body.comment.text,
      req.body && req.body.data && req.body.data.text,
      req.body && req.body.body
    ];
    for (var ct = 0; ct < candsTexte.length; ct++) {
      if (typeof candsTexte[ct] === 'string' && candsTexte[ct]) { texteCommentaire = candsTexte[ct]; break; }
    }
    var idContactCommentaire = (req.body && req.body.contact && req.body.contact.id) || null;

    if (texteCommentaire && consignesLib.mentionneAgent(texteCommentaire)) {
      // event_id : dédup respond.io (retries rejoués) — event_id du payload,
      // sinon id du commentaire, sinon repli horodaté (rare).
      var eventC = (req.body && req.body.event_id) ||
        (req.body && req.body.comment && req.body.comment.id) ||
        (req.body && req.body.data && req.body.data.id) ||
        ('comment-' + idContactCommentaire + '-' + Date.now());
      var tsC = (req.body && req.body.createdAt) ||
        (req.body && req.body.comment && req.body.comment.createdAt) || null;
      var emisC = null;
      if (typeof tsC === 'number' && tsC > 0) emisC = new Date(tsC).toISOString();
      else if (typeof tsC === 'string' && tsC) {
        var dC = new Date(tsC);
        if (!isNaN(dC.getTime())) emisC = dC.toISOString();
      }
      try {
        var insertionC = await supabaseInsert('messages', {
          event_id: String(eventC),
          contact_id: idContactCommentaire,
          conversation_id: (req.body && req.body.conversation_id) || null,
          canal_nom: 'consigne',
          canal_id: null,
          texte: texteCommentaire,
          media_url: null,
          type_media: null,
          emis_a: emisC,
          statut: 'en_file',
          brut: req.body
        });
      } catch (e) {
        await journaliser(idContactCommentaire, 'webhook_erreur_supabase', String(e && e.message || e), { event_id: String(eventC) });
        return res.status(200).json({ ok: true, enregistre: false, erreur: 'supabase indisponible' });
      }
      if (insertionC.doublon) {
        return res.status(200).json({ ok: true, enregistre: true, doublon: true, consigne: true });
      }
      await journaliser(idContactCommentaire, 'webhook_consigne_enfile',
        'CONSIGNE @Agent IA enfilée (comment.created) — pilotage interne', { event_id: String(eventC) });
      return res.status(200).json({ ok: true, enregistre: true, consigne: true });
    }

    await journaliser(idContactCommentaire, 'webhook_commentaire_ignore',
      'Commentaire SANS mention @Agent IA — ignoré', { event_type: typeEvt || null });
    return res.status(200).json({ ok: true, enregistre: false, raison: 'commentaire sans mention agent' });
  }

  if (!estMessage) {
    var idIgnore = (req.body && req.body.contact && req.body.contact.id) || null;
    await journaliser(idIgnore,
      typeEvt.indexOf('comment') !== -1 ? 'webhook_commentaire_ignore' : 'webhook_ignore',
      'Événement hors périmètre B1 : event_type=[' + (typeEvt || 'ABSENT') + ']',
      { event_type: typeEvt || null });
    return res.status(200).json({ ok: true, enregistre: false, raison: 'evenement hors perimetre B1' });
  }

  // Normalisation (portage fidèle du prod v2.20.136)
  var ev;
  try {
    ev = normaliser.normaliserEvenement(req.body);
  } catch (e) {
    // Payload illisible : journal de diagnostic + 200 quand même (respond.io
    // ne doit pas désactiver son webhook sur un événement imprévu)
    await journaliser(null, 'webhook_payload_illisible', String(e && e.message || e));
    return res.status(200).json({ ok: true, enregistre: false, raison: 'payload illisible' });
  }

  // Email interne/automatique (no-reply, Praxedo, Exchange interne…) :
  // enregistré pour DIAGNOSTIC avec statut 'ignore' — JAMAIS transmis à l'agent.
  var statut = ev.emailInterne ? 'ignore' : 'en_file';

  var ligne = {
    event_id: ev.eventId,
    contact_id: ev.contactId,
    conversation_id: ev.conversationId || null,
    canal_nom: ev.canalNom || null,
    canal_id: ev.canalId || null,
    texte: ev.texte,
    media_url: ev.mediaUrl,
    type_media: ev.typeMedia,
    emis_a: ev.emisMs ? new Date(ev.emisMs).toISOString() : null,
    statut: statut,
    brut: req.body
  };

  try {
    var insertion = await supabaseInsert('messages', ligne);
  } catch (e) {
    // Supabase indisponible : on répond 200 quand même — respond.io ne doit
    // pas compter d'échec et désactiver le webhook ; l'incident est visible
    // dans les logs Vercel. (Une perte rare est couverte par les retries
    // respond.io + le journal ci-dessous.)
    await journaliser(ev.contactId, 'webhook_erreur_supabase', String(e && e.message || e), { event_id: ev.eventId });
    return res.status(200).json({ ok: true, enregistre: false, erreur: 'supabase indisponible' });
  }

  if (insertion.doublon) {
    return res.status(200).json({ ok: true, enregistre: true, doublon: true });
  }

  if (ev.emailInterne) {
    await journaliser(ev.contactId, 'webhook_email_interne',
      'EMAIL INTERNE FILTRÉ — motif=[' + ev.motifInterne + '] — message NON transmis à l\'agent',
      { event_id: ev.eventId, motif: ev.motifInterne });
  } else {
    await journaliser(ev.contactId, 'webhook_enfile', 'Message enfilé (' + statut + ')', { event_id: ev.eventId });
  }

  return res.status(200).json({ ok: true, enregistre: true, doublon: false });
};

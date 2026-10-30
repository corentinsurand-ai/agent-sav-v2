// ============================================================================
// Agent SAV U'mob v2 — C2 : /api/whatsapp-send — envoi RÉEL de messages
// WhatsApp Cloud API (Meta)
//
// RÔLE : la plateforme maison (C2 mode écriture) envoie un vrai message
// WhatsApp à un client. L'ADAPTATEUR CANAL est le SEUL à parler à Meta
// (principe cerveau ≠ canal) : cette route n'appelle JAMAIS de LLM — le
// texte vient de l'agent (ou d'un humain via le canvas).
//
//   POST /api/whatsapp-send
//   { secret, tel, texte }        (secret accepté : query, header, body)
//   → { ok:true, wamid, statut:'envoye' }
//
// APRÈS l'envoi réussi : le message est enregistré dans agent_sav.wa_messages
// avec sens='sortant' et statut_reception='sent' — les accusés Meta
// (delivered / read) remontent ensuite par /api/whatsapp-webhook (payload
// statuses → mise à jour de statut_reception) et s'affichent ✓✓ dans le
// canvas au rechargement 🔌.
//
// Config Vercel : WA_TOKEN (token d'accès Meta — temporaire 24 h en test,
// à remplacer par un token système permanent à la bascule),
// WA_PHONE_NUMBER_ID (ID du numéro émetteur, page API Setup Meta),
// WA_API_VERSION optionnel (défaut v26.0). Aucun secret dans le code.
//
// Réponses : 200 ; 400 paramètres ; 401 secret ; 405 méthode ;
// 500 config manquante ; 502 erreur Meta.
// ============================================================================

var VERSION = 'C4-ENV-1';
var SCHEMA = 'agent_sav';

function env(nom) { return process.env[nom] || ''; }

function secretDe(req, corps) {
  var secret = '';
  try {
    if (req.query && req.query.secret) secret = String(req.query.secret);
  } catch (e) {}
  if (!secret) {
    var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice((req.url || '').indexOf('?') + 1) : '';
    var m = u.match(/(?:^|&)secret=([^&]*)/);
    if (m) secret = decodeURIComponent(m[1]);
  }
  if (!secret && req.headers && req.headers['x-webhook-secret']) {
    secret = String(req.headers['x-webhook-secret']);
  }
  if (!secret && corps && corps.secret) secret = String(corps.secret);
  return secret;
}

function urlSupabase(table, params) {
  var base = env('SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  return base + '/rest/v1/' + table + (params ? '?' + params : '');
}

async function journaliser(texte, detail) {
  try {
    var res = await fetch(urlSupabase('journal', ''), {
      method: 'POST',
      headers: {
        'apikey': env('SUPABASE_SERVICE_KEY'),
        'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
        'Content-Profile': SCHEMA
      },
      body: JSON.stringify({ etape: 'wa_send', texte: texte, detail: detail })
    });
    return res.ok;
  } catch (e) { return false; }
}

module.exports = async function handler(req, res) {
  // CORS — le canvas (navigateur) appelle cette route en direct.
  try { res.setHeader('Access-Control-Allow-Origin', '*'); } catch (e) {}
  if (req.method === 'OPTIONS') {
    try {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret');
    } catch (e) {}
    return res.status(204).end();
  }

  var corps = req.body;
  if (!corps || typeof corps !== 'object') {
    try { corps = JSON.parse(String(req.body || '{}')); } catch (e) { corps = {}; }
  }

  if (secretDe(req, corps) !== env('WEBHOOK_SECRET') || !env('WEBHOOK_SECRET')) {
    return res.status(401).json({ ok: false, erreur: 'secret invalide' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });
  }

  var tel = String((corps && corps.tel) || '');
  var texte = String((corps && corps.texte) || '').trim();
  var d = tel.replace(/\D/g, '');
  if (!d) {
    return res.status(400).json({ ok: false, erreur: 'tel requis (chiffres seuls, ex 33620476040)' });
  }
  if (!texte) {
    return res.status(400).json({ ok: false, erreur: 'texte requis' });
  }
  if (texte.length > 4096) {
    return res.status(400).json({ ok: false, erreur: 'texte trop long (max 4096 caracteres)' });
  }

  if (!env('WA_TOKEN') || !env('WA_PHONE_NUMBER_ID')) {
    return res.status(500).json({
      ok: false,
      erreur: 'configuration Meta manquante (WA_TOKEN, WA_PHONE_NUMBER_ID) — definis les variables dans Vercel puis Redeploy'
    });
  }

  var version = env('WA_API_VERSION') || 'v26.0';
  var url = 'https://graph.facebook.com/' + version + '/' + env('WA_PHONE_NUMBER_ID') + '/messages';

  var rep, corpsRep = '';
  try {
    rep = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env('WA_TOKEN'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: d,
        type: 'text',
        text: { body: texte, preview_url: false }
      })
    });
  } catch (e) {
    await journaliser('wa_send ERREUR reseau Meta', { tel: d, erreur: String((e && e.message) || e) });
    return res.status(502).json({ ok: false, erreur: 'Meta inaccessible' });
  }
  try { corpsRep = await rep.text(); } catch (e) { corpsRep = ''; }

  if (!rep.ok) {
    await journaliser('wa_send ERREUR Meta ' + rep.status, { tel: d, detail: corpsRep.substring(0, 300) });
    return res.status(502).json({ ok: false, erreur: 'Meta ' + rep.status, detail: corpsRep.substring(0, 300) });
  }

  var j = {};
  try { j = JSON.parse(corpsRep) || {}; } catch (e) { j = {}; }
  var wamid = j.messages && j.messages[0] && j.messages[0].id ? String(j.messages[0].id) : '';
  if (!wamid) {
    await journaliser('wa_send ERREUR reponse Meta sans wamid', { tel: d, detail: corpsRep.substring(0, 300) });
    return res.status(502).json({ ok: false, erreur: 'reponse Meta sans wamid', detail: corpsRep.substring(0, 300) });
  }

  // Enregistrement côté wa_messages (sens sortant) — best effort : l'envoi a
  // RÉUSSI, une panne Supabase ne doit pas faire échouer la réponse.
  try {
    await fetch(urlSupabase('wa_messages', 'on_conflict=wamid'), {
      method: 'POST',
      headers: {
        'apikey': env('SUPABASE_SERVICE_KEY'),
        'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
        'Content-Type': 'application/json',
        'Prefer': 'resolution=ignore-duplicates,return=minimal',
        'Content-Profile': SCHEMA
      },
      body: JSON.stringify([{
        wa_id: d,
        nom_profil: null,
        texte: texte,
        type: 'text',
        wamid: wamid,
        brut: { envoye_par: 'plateforme-c2', meta: j },
        recu_a: new Date().toISOString(),
        sens: 'sortant',
        statut_reception: 'sent'
      }])
    });
  } catch (e) {
    await journaliser('wa_send : envoi OK mais enregistrement echoue', { tel: d, wamid: wamid });
  }

  await journaliser('wa_send : message envoye a ' + d, { wamid: wamid, tel: d });
  return res.status(200).json({ ok: true, brique: 'C2', version: VERSION, wamid: wamid, statut: 'envoye' });
};

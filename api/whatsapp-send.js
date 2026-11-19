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
//   MODE MODÈLE (C7-PROP-1, message proactif hors fenêtre 24 h — modèle
//   APPROUVÉ WhatsApp obligatoire) :
//   { secret, tel, template: { nom, langue: 'fr', params: ['…', '…'] } }
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

var VERSION = 'C43-PJ-WA-1';
var SCHEMA = 'agent_sav';
var mediaLib = require('../lib/media');   // C43-PJ-WA : bucket public wa-media (upload des PJ)

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

function jetonDe(req, corps) {
  var j = '';
  try { if (req.query && req.query.jeton) j = String(req.query.jeton); } catch (e) {}
  if (!j) {
    var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice((req.url || '').indexOf('?') + 1) : '';
    var m = u.match(/(?:^|&)jeton=([^&]*)/);
    if (m) j = decodeURIComponent(m[1]);
  }
  if (!j && req.headers && req.headers['x-jeton']) j = String(req.headers['x-jeton']);
  if (!j && corps && corps.jeton) j = String(corps.jeton);
  return j;
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

function baseStorage() {
  return env('SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
}

// C43-PJ-WA : type de message média selon le mime.
function kindDeMime(mime) {
  var m = String(mime || '').toLowerCase();
  if (m.indexOf('image/') === 0) return 'image';
  if (m.indexOf('video/') === 0) return 'video';
  if (m.indexOf('audio/') === 0) return 'audio';
  return 'document';
}

// C43-PJ-WA : upload d'une PJ (base64) dans le bucket public wa-media → URL publique.
async function uploaderPj(p, i) {
  try {
    var buf = Buffer.from(String(p.donnees || ''), 'base64');
    if (!buf.length) return null;
    if (!(await mediaLib.assurerBucketMedia())) return null;
    var nomF = String(p.nom || 'fichier').replace(/[^\w.\-]+/g, '_').slice(-80);
    var chemin = 'wa-out/' + Date.now() + '-' + i + '-' + nomF + '.' + mediaLib.mediaExt(p.type);
    var r = await fetch(baseStorage() + '/storage/v1/object/' + mediaLib.BUCKET_MEDIA + '/' + chemin, {
      method: 'POST',
      headers: {
        'apikey': env('SUPABASE_SERVICE_KEY'),
        'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
        'Content-Type': String(p.type || 'application/octet-stream'),
        'x-upsert': 'true'
      },
      body: buf
    });
    if (!r.ok) return null;
    return baseStorage() + '/storage/v1/object/public/' + mediaLib.BUCKET_MEDIA + '/' + chemin;
  } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  // CORS — le canvas (navigateur) appelle cette route en direct.
  try { res.setHeader('Access-Control-Allow-Origin', '*'); } catch (e) {}
  if (req.method === 'OPTIONS') {
    try {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret, x-jeton');
    } catch (e) {}
    return res.status(204).end();
  }

  var corps = req.body;
  if (!corps || typeof corps !== 'object') {
    try { corps = JSON.parse(String(req.body || '{}')); } catch (e) { corps = {}; }
  }

  var authA = require('../lib/auth');
  var authR = authA.authentifierRequete(secretDe(req, corps), jetonDe(req, corps));
  if (!authR.ok) {
    return res.status(401).json({ ok: false, erreur: 'secret invalide' });
  }
  // C42-AUTEUR-WA-1 : prenom de l'expediteur (lu dans le jeton de session)
  // pour enregistrer le VRAI auteur du message envoye depuis la plateforme.
  var prenomEnvoi = '';
  try {
    if (authR.utilisateur && authR.utilisateur.nom) {
      prenomEnvoi = String(authR.utilisateur.nom).trim().split(/\s+/)[0];
    }
  } catch (e) {}


  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });
  }

  var tel = String((corps && corps.tel) || '');
  var texte = String((corps && corps.texte) || '').trim();
  var d = tel.replace(/\D/g, '');
  if (!d) {
    return res.status(400).json({ ok: false, erreur: 'tel requis (chiffres seuls, ex 33620476040)' });
  }

  // ---- C43-PJ-WA : PIÈCES JOINTES (même principe que /api/email-send C5-ENV-4)
  // pj = [{nom, type, donnees(base64)}] → upload bucket public wa-media puis
  // envoi WhatsApp par LIEN (link) — 1 message média par PJ (max 5, ~2,2 Mo).
  var pjBrut = (corps && corps.pj) || [];
  var pj = [];
  if (Array.isArray(pjBrut)) {
    var totalB64 = 0;
    for (var i = 0; i < pjBrut.length; i++) {
      var p = pjBrut[i];
      if (!p || typeof p !== 'object') continue;
      var nom = String(p.nom || '').replace(/[\r\n"\\/]/g, '_').trim().slice(0, 200);
      var donnees = String(p.donnees || '').replace(/\s+/g, '');
      if (!nom || !donnees) continue;
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(donnees)) {
        return res.status(400).json({ ok: false, erreur: 'pj[' + i + '].donnees doit etre du base64 valide' });
      }
      totalB64 += donnees.length;
      pj.push({ nom: nom, type: String(p.type || 'application/octet-stream').slice(0, 120), donnees: donnees });
    }
    if (pj.length > 5) return res.status(400).json({ ok: false, erreur: 'trop de pieces jointes (max 5)' });
    if (totalB64 > 3000000) return res.status(400).json({ ok: false, erreur: 'pieces jointes trop volumineuses (max ~2,2 Mo au total, limite corps Vercel 4,5 Mo)' });
  }

  // ---- C7-PROP-1 : MODE MODÈLE WHATSAPP (template approuvé) -----------------
  // Un message PROACTIF (hors fenêtre de 24 h après un message du client) doit
  // impérativement partir d'un MODÈLE APPROUVÉ par WhatsApp (règle Meta).
  //   { tel, template: { nom: 'passage_secteur', langue: 'fr', params: ['Marine', '2 passages'] } }
  // → Meta : type='template', components[body] avec les paramètres en texte.
  var tpl = (corps && corps.template && typeof corps.template === 'object') ? corps.template : null;
  if (tpl && pj.length) {
    return res.status(400).json({ ok: false, erreur: 'pj non supporte avec un modele (template WhatsApp)' });
  }
  var params = [];
  var message = null;
  if (tpl) {
    var nomTpl = String(tpl.nom || '').trim();
    if (!nomTpl) {
      return res.status(400).json({ ok: false, erreur: 'template.nom requis (nom EXACT du modèle approuvé WhatsApp)' });
    }
    if (Array.isArray(tpl.params)) {
      params = tpl.params.map(function (p) { return String(p === undefined || p === null ? '' : p); });
    }
    if (params.length > 10) {
      return res.status(400).json({ ok: false, erreur: 'trop de parametres de modele (max 10)' });
    }
    for (var ip = 0; ip < params.length; ip++) {
      if (params[ip].length > 1024) {
        return res.status(400).json({ ok: false, erreur: 'parametre ' + (ip + 1) + ' trop long (max 1024 caracteres)' });
      }
    }
    message = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: d,
      type: 'template',
      template: {
        name: nomTpl,
        language: { code: String(tpl.langue || 'fr').trim() || 'fr' },
        components: params.length ? [{ type: 'body', parameters: params.map(function (p) { return { type: 'text', text: p }; }) }] : []
      }
    };
    // aperçu lisible côté historique (wa_messages) — le corps réel vit chez Meta
    texte = '[modèle ' + nomTpl + '] ' + params.join(' | ');
  } else {
    if (!texte && !pj.length) {   /* C43-PJ-WA : un envoi peut ne contenir que des PJ */
      return res.status(400).json({ ok: false, erreur: 'texte requis (ou au moins une piece jointe)' });
    }
    if (texte.length > 4096) {
      return res.status(400).json({ ok: false, erreur: 'texte trop long (max 4096 caracteres)' });
    }
    message = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: d,
      type: 'text',
      text: { body: texte, preview_url: false }
    };
  }

  if (!env('WA_TOKEN') || !env('WA_PHONE_NUMBER_ID')) {
    return res.status(500).json({
      ok: false,
      erreur: 'configuration Meta manquante (WA_TOKEN, WA_PHONE_NUMBER_ID) — definis les variables dans Vercel puis Redeploy'
    });
  }

  var version = env('WA_API_VERSION') || 'v26.0';
  var url = 'https://graph.facebook.com/' + version + '/' + env('WA_PHONE_NUMBER_ID') + '/messages';

  // C43-PJ-WA : liste des envois — le texte (ou modèle) d'abord, puis 1 message
  // média par pièce jointe (lien vers le bucket public wa-media).
  var envois = [{ message: message, texte: texte, type: 'text', media: null }];
  if (!tpl) {
    for (var ipj = 0; ipj < pj.length; ipj++) {
      var urlPj = await uploaderPj(pj[ipj], ipj);
      if (!urlPj) {
        await journaliser('wa_send PJ upload echoue (PJ ignoree)', { tel: d, nom: pj[ipj].nom });
        continue;   // la PJ est sautée, le reste part quand même
      }
      var kind = kindDeMime(pj[ipj].type);
      var bloc = { link: urlPj };
      if (kind === 'document') bloc.filename = pj[ipj].nom;
      else if (!texte && ipj === 0) bloc.caption = pj[ipj].nom;
      var msgM = { messaging_product: 'whatsapp', recipient_type: 'individual', to: d, type: kind };
      msgM[kind] = bloc;
      var ph = { image: '🖼 Photo', video: '🎬 Vidéo', audio: '🔊 Audio', document: '📄 Document' }[kind] || '📎 Fichier';
      envois.push({
        message: msgM, type: kind,
        texte: ph + ' ' + pj[ipj].nom,
        media: { kind: kind, mime: pj[ipj].type, nom: pj[ipj].nom, url: urlPj, caption: '' }
      });
    }
  }

  var wamids = [];
  var echecs = 0;
  for (var ie = 0; ie < envois.length; ie++) {
    var ev = envois[ie];
    var rep, corpsRep = '';
    try {
      rep = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env('WA_TOKEN'),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(ev.message)
      });
    } catch (e) {
      echecs++;
      await journaliser('wa_send ERREUR reseau Meta', { tel: d, erreur: String((e && e.message) || e) });
      continue;
    }
    try { corpsRep = await rep.text(); } catch (e) { corpsRep = ''; }
    if (!rep.ok) {
      echecs++;
      await journaliser('wa_send ERREUR Meta ' + rep.status, { tel: d, detail: corpsRep.substring(0, 300) });
      if (!wamids.length) {
        return res.status(502).json({ ok: false, erreur: 'Meta ' + rep.status, detail: corpsRep.substring(0, 300) });
      }
      continue;   // envois précédents déjà partis → partiel
    }
    var j = {};
    try { j = JSON.parse(corpsRep) || {}; } catch (e) { j = {}; }
    var wamid = j.messages && j.messages[0] && j.messages[0].id ? String(j.messages[0].id) : '';
    if (!wamid) {
      echecs++;
      await journaliser('wa_send ERREUR reponse Meta sans wamid', { tel: d, detail: corpsRep.substring(0, 300) });
      continue;
    }
    wamids.push(wamid);
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
          texte: ev.texte,
          type: ev.type,
          wamid: wamid,
          brut: { envoye_par: 'plateforme-c2', sender_nom: prenomEnvoi || null, _media: ev.media || undefined, meta: j },
          recu_a: new Date().toISOString(),
          sens: 'sortant',
          statut_reception: 'sent'
        }])
      });
    } catch (e) {
      await journaliser('wa_send : envoi OK mais enregistrement echoue', { tel: d, wamid: wamid });
    }
  }

  if (!wamids.length) {
    return res.status(502).json({ ok: false, erreur: 'Meta inaccessible ou tous les envois ont echoue' });
  }
  await journaliser('wa_send : message(s) envoye(s) a ' + d, { wamids: wamids, tel: d, pj: pj.length });
  return res.status(200).json({ ok: true, brique: 'C2', version: VERSION, wamid: wamids[0], wamids: wamids, medias: pj.length, echecs: echecs, statut: 'envoye' });
};

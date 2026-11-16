// ============================================================================
// Agent SAV U'mob v2 — C4 : /api/whatsapp-webhook — réception des messages
// WhatsApp Cloud API (Meta) + statuts de distribution (C2)
//
// RÔLE : recevoir les vrais messages WhatsApp des clients et les stocker
// dans agent_sav.wa_messages — la plateforme maison C1/C4 (prototype
// navigateur) les lit ensuite via /api/whatsapp-messages (lecture seule).
// L'ADAPTATEUR CANAL EST LE SEUL À PARLER À WHATSAPP (principe d'architecture
// cerveau ≠ canal) : ce webhook n'appelle JAMAIS de LLM, ne répond JAMAIS au
// client, il ne fait qu'ENREGISTRER (mode lecture C1).
//
//   GET  /api/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=<token>
//                     &hub.challenge=<n>   → vérification Meta (echo challenge)
//   POST /api/whatsapp-webhook  body = payload Meta Cloud API → 200 TOUJOURS
//        (Meta retente en cas d'erreur — un 500 provoquerait des rejeus en
//         rafale ; les échecs Supabase sont journalisés mais retournent 200)
//
// Payload géré (forme officielle Cloud API) :
//   { object: "whatsapp_business_account",
//     entry: [ { id, changes: [ { field: "messages", value: {
//       messages: [ { from, id, timestamp, type, text: { body } … } ],
//       statuses:  [ { id, status, timestamp, recipient_id } ],
//       contacts: [ { profile: { name }, wa_id } ] } ] } ] }
//   - messages sans texte (image/audio…) → type + placeholder, jamais d'appel
//     multimodal (même discipline que l'ancien système v136)
//   - statuses (C2, 30/10) → mise à jour de statut_reception du wamid
//     (sent | delivered | read | failed) pour les ✓✓ du canvas
//
// C4-MEDIA-1 (16/11) : les MÉDIAS REÇUS (photo/vidéo/audio/document) sont
//   téléchargés depuis l'API Meta (media id → URL signée → binaire, avec
//   WA_TOKEN) puis stockés dans le bucket public Supabase Storage « wa-media ».
//   L'URL publique est conservée dans brut._media = { kind, id, mime, url,
//   caption } → /api/whatsapp-messages la renvoie (select brut->_media) et la
//   plateforme affiche la photo directement dans le fil. Aucun ALTER SQL
//   nécessaire (brut est déjà jsonb). Le bucket est créé à la volée (service
//   key) s'il n'existe pas. Échec de téléchargement = message quand même
//   enregistré (brut._media renseigné sans url) — jamais de 500.
//
// DÉDUP : wamid unique (contrainte) + Prefer resolution=ignore-duplicates —
// les rejeus Meta sont absorbés sans doublon (même parade que la dédup
// event_id du webhook respond.io en B1).
//
// Config : WA_VERIFY_TOKEN (token de vérification Meta, à définir dans
// Vercel) ; repli sur WEBHOOK_SECRET si absent. WA_TOKEN = token Meta Cloud
// API (lecture des médias). Aucun secret dans le code.
// ============================================================================

var SCHEMA = 'agent_sav';
var BUCKET_MEDIA = 'wa-media';
var GRAPH_VERSION = 'v21.0';
var bucketMediaOk = false;   // mémo : le bucket existe (évite un appel à chaque message)

function env(nom) { return process.env[nom] || ''; }

function paramDe(req, nom) {
  try {
    if (req.query && req.query[nom] !== undefined) return String(req.query[nom]);
  } catch (e) {}
  var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice((req.url || '').indexOf('?') + 1) : '';
  var m = u.match(new RegExp('(?:^|&)' + nom + '=([^&]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

function urlSupabase(table, params) {
  var base = env('SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  return base + '/rest/v1/' + table + (params ? '?' + params : '');
}

function baseSupabase() {
  return env('SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
}

// Extension de fichier depuis le mime — pour nommer l'objet stocké.
function mediaExt(mime) {
  var m = String(mime || '').toLowerCase();
  if (m.indexOf('jpeg') !== -1 || m.indexOf('jpg') !== -1) return 'jpg';
  if (m.indexOf('png') !== -1) return 'png';
  if (m.indexOf('webp') !== -1) return 'webp';
  if (m.indexOf('gif') !== -1) return 'gif';
  if (m.indexOf('mp4') !== -1) return 'mp4';
  if (m.indexOf('mpeg') !== -1) return 'mp3';
  if (m.indexOf('ogg') !== -1) return 'ogg';
  if (m.indexOf('pdf') !== -1) return 'pdf';
  if (m.indexOf('quicktime') !== -1) return 'mov';
  return 'bin';
}

// Extrait les messages utiles d'un payload Meta → [{wa_id, nom, texte, type,
// wamid, timestamp, media?}] ; statuses et événements vides → []
function extraireMessages(corps) {
  var sortie = [];
  var contacts = {};
  if (!corps || corps.object !== 'whatsapp_business_account' || !Array.isArray(corps.entry)) return sortie;
  var TYPES_MEDIA = { image: 1, audio: 1, video: 1, document: 1, sticker: 1 };
  var PLACEHOLDER = { image: '🖼 Photo', video: '🎬 Vidéo', audio: '🔊 Audio', document: '📄 Document', sticker: 'Sticker' };
  corps.entry.forEach(function(ent) {
    if (!ent || !Array.isArray(ent.changes)) return;
    ent.changes.forEach(function(ch) {
      var v = ch && ch.value;
      if (!v) return;
      (v.contacts || []).forEach(function(ct) {
        if (ct && ct.wa_id) contacts[String(ct.wa_id)] =
          String((ct.profile && ct.profile.name) || '');
      });
      (v.messages || []).forEach(function(msg) {
        if (!msg || !msg.id || !msg.from) return;
        var texte = '';
        var type = String(msg.type || 'text');
        var media = null;
        if (msg.text && msg.text.body) texte = String(msg.text.body);
        else if (msg.button && msg.button.text) texte = String(msg.button.text);
        else if (msg.interactive && msg.interactive.button_reply) {
          texte = String((msg.interactive.button_reply.title || msg.interactive.button_reply.id || ''));
          type = 'interactive';
        } else if (msg.interactive && msg.interactive.list_reply) {
          texte = String((msg.interactive.list_reply.title || ''));
          type = 'interactive';
        } else if (TYPES_MEDIA[type] && msg[type]) {
          // C4-MEDIA-1 : média reçu → on garde l'id Meta + le mime + la légende
          var bloc = msg[type];
          media = {
            kind: type,
            id: String(bloc.id || ''),
            mime: String(bloc.mime_type || ''),
            caption: bloc.caption ? String(bloc.caption) : ''
          };
          // la légende du média devient le texte du message (fil + extrait)
          texte = media.caption || PLACEHOLDER[type] || '[média reçu]';
        } else if (type === 'location') {
          texte = '[position partagée]';
        } else if (msg.contacts_) { /* liste de contacts partagée */ }
        if (type === 'contacts') texte = '[contacts partagés]';
        sortie.push({
          wa_id: String(msg.from),
          nom: contacts[msg.from] || '',
          texte: texte,
          type: type,
          wamid: String(msg.id),
          timestamp: String(msg.timestamp || ''),
          media: media,
          brut: msg
        });
      });
    });
  });
  return sortie;
}

// Extrait les statuts de distribution d'un payload Meta (C2) →
// [{wamid, statut: sent|delivered|read|failed, timestamp, recipient_id}]
function extraireStatuses(corps) {
  var sortie = [];
  if (!corps || corps.object !== 'whatsapp_business_account' || !Array.isArray(corps.entry)) return sortie;
  corps.entry.forEach(function(ent) {
    if (!ent || !Array.isArray(ent.changes)) return;
    ent.changes.forEach(function(ch) {
      var v = ch && ch.value;
      if (!v || !Array.isArray(v.statuses)) return;
      v.statuses.forEach(function(st) {
        if (!st || !st.id || !st.status) return;
        sortie.push({
          wamid: String(st.id),
          statut: String(st.status),
          timestamp: String(st.timestamp || ''),
          recipient_id: String(st.recipient_id || '')
        });
      });
    });
  });
  return sortie;
}

// ---- C4-MEDIA-1 : téléchargement + stockage des médias reçus --------------

function fetchAvecTimeout(url, opts, ms) {
  var ctrl = new AbortController();
  var t = setTimeout(function() { try { ctrl.abort(); } catch (e) {} }, ms || 8000);
  return fetch(url, Object.assign({}, opts, { signal: ctrl.signal }))
    .finally(function() { clearTimeout(t); });
}

// Crée le bucket public « wa-media » s'il n'existe pas (service key suffit).
async function assurerBucketMedia() {
  if (bucketMediaOk) return true;
  try {
    var res = await fetchAvecTimeout(baseSupabase() + '/storage/v1/bucket', {
      method: 'POST',
      headers: {
        'apikey': env('SUPABASE_SERVICE_KEY'),
        'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: BUCKET_MEDIA, public: true })
    }, 6000);
    // 200/201 = créé ; 400/409 = existe déjà → OK dans les deux cas
    if (res.ok || res.status === 400 || res.status === 409) {
      bucketMediaOk = true;
      return true;
    }
    return false;
  } catch (e) { return false; }
}

// Télécharge un média Meta (media id) et le pousse dans le bucket Storage.
// Renvoie l'URL publique, ou null en cas d'échec (jamais d'exception).
async function stockerMedia(media, wamid) {
  var token = env('WA_TOKEN');
  if (!media || !media.id || !token) return null;
  try {
    // 1) media id → URL signée Meta (valable 7 jours, mais on télécharge tout de suite)
    var r1 = await fetchAvecTimeout(
      'https://graph.facebook.com/' + GRAPH_VERSION + '/' + encodeURIComponent(media.id),
      { headers: { 'Authorization': 'Bearer ' + token } }, 8000);
    if (!r1.ok) return null;
    var info = await r1.json();
    if (!info || !info.url) return null;
    var mime = String(info.mime_type || media.mime || 'application/octet-stream');
    // 2) URL signée → binaire
    var r2 = await fetchAvecTimeout(info.url, {
      headers: { 'Authorization': 'Bearer ' + token }
    }, 8000);
    if (!r2.ok) return null;
    var buf = Buffer.from(await r2.arrayBuffer());
    if (!buf.length) return null;
    // 3) upload dans le bucket (idempotent : upsert sur le nom = wamid)
    if (!(await assurerBucketMedia())) return null;
    var chemin = 'wa/' + encodeURIComponent(wamid) + '.' + mediaExt(mime);
    var r3 = await fetchAvecTimeout(
      baseSupabase() + '/storage/v1/object/' + BUCKET_MEDIA + '/' + chemin,
      {
        method: 'POST',
        headers: {
          'apikey': env('SUPABASE_SERVICE_KEY'),
          'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
          'Content-Type': mime,
          'x-upsert': 'true'
        },
        body: buf
      }, 8000);
    if (!r3.ok) return null;
    return baseSupabase() + '/storage/v1/object/public/' + BUCKET_MEDIA + '/' + chemin;
  } catch (e) {
    return null;
  }
}

// Prépare le média d'un message : renseigne brut._media (avec url si OK).
// Ne lève JAMAIS d'exception — le message doit être enregistré quoi qu'il arrive.
async function preparerMedia(m) {
  if (!m.media || !m.media.id) return;
  var url = await stockerMedia(m.media, m.wamid);
  m.brut._media = {
    kind: m.media.kind,
    id: m.media.id,
    mime: m.media.mime || '',
    caption: m.media.caption || '',
    url: url || null
  };
}

async function enregistrerMessages(messages) {
  var cle = env('SUPABASE_SERVICE_KEY');
  var url = urlSupabase('wa_messages', 'on_conflict=wamid');
  var lot = messages.map(function(m) {
    return {
      wa_id: m.wa_id,
      nom_profil: m.nom || null,
      texte: m.texte,
      type: m.type,
      wamid: m.wamid,
      brut: m.brut,
      recu_a: m.timestamp
        ? new Date(parseInt(m.timestamp, 10) * 1000).toISOString()
        : new Date().toISOString()
    };
  });
  var res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': cle,
      'Authorization': 'Bearer ' + cle,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=ignore-duplicates,return=minimal',
      'Content-Profile': SCHEMA
    },
    body: JSON.stringify(lot)
  });
  if (res.status >= 400) {
    var corps = '';
    try { corps = (await res.text()).substring(0, 300); } catch (e) { corps = ''; }
    throw new Error('Supabase wa_messages ' + res.status + ' — ' + corps);
  }
  return lot.length;
}

// Met à jour statut_reception (sent|delivered|read|failed) des wamid —
// les échecs individuels sont ignorés (best effort, 200 quand même),
// la fonction renvoie le nombre de mises à jour réussies.
async function majStatuts(statuts) {
  var cle = env('SUPABASE_SERVICE_KEY');
  var faits = 0;
  for (var i = 0; i < statuts.length; i++) {
    try {
      var res = await fetch(
        urlSupabase('wa_messages', 'wamid=eq.' + encodeURIComponent(statuts[i].wamid)),
        {
          method: 'PATCH',
          headers: {
            'apikey': cle,
            'Authorization': 'Bearer ' + cle,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
            'Content-Profile': SCHEMA
          },
          body: JSON.stringify({ statut_reception: statuts[i].statut })
        }
      );
      if (res.ok) faits++;
    } catch (e) { /* best effort */ }
  }
  return faits;
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
      body: JSON.stringify({ etape: 'wa_webhook', texte: texte, detail: detail })
    });
    return res.ok;
  } catch (e) { return false; }
}

module.exports = async function handler(req, res) {
  // Vérification du webhook Meta (à l'ajout de l'URL dans le Business Manager)
  if (req.method === 'GET') {
    var mode = paramDe(req, 'hub.mode');
    var token = paramDe(req, 'hub.verify_token');
    var challenge = paramDe(req, 'hub.challenge');
    var attendu = env('WA_VERIFY_TOKEN') || env('WEBHOOK_SECRET');
    if (mode === 'subscribe' && token && token === attendu && challenge) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('verification echouee');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });
  }

  // POST : enregistrer les messages + statuts — 200 TOUJOURS (même si
  // Supabase tombe : Meta retenterait en rafale, on journalise et on avoue ok)
  var corps = req.body;
  if (!corps && typeof req.body !== 'object') {
    try { corps = JSON.parse(String(req.body || '{}')); } catch (e) { corps = null; }
  }
  var messages = corps ? extraireMessages(corps) : [];
  var statuts = corps ? extraireStatuses(corps) : [];
  if (!messages.length && !statuts.length) {
    // heartbeats ou payload inconnu → 200
    return res.status(200).json({ ok: true, enregistres: 0, statuts_maj: 0 });
  }
  if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_KEY')) {
    await journaliser('wa_webhook sans config Supabase', {
      messages: messages.length, statuts: statuts.length
    });
    return res.status(200).json({ ok: true, enregistres: 0, statuts_maj: 0, erreur_interne: 'config manquante' });
  }
  try {
    // C4-MEDIA-1 : médias d'abord (best effort, en parallèle) pour que
    // brut._media.url soit présent DANS l'insert (pas de PATCH après coup).
    var medias = messages.filter(function(m) { return m.media && m.media.id; });
    if (medias.length) {
      await Promise.all(medias.map(function(m) { return preparerMedia(m); }));
    }
    var ecrits = messages.length ? await enregistrerMessages(messages) : 0;
    var maj = statuts.length ? await majStatuts(statuts) : 0;
    if (messages.length || statuts.length) {
      await journaliser('wa_webhook : ' + ecrits + ' message(s) + ' + maj + ' statut(s)' +
        (medias.length ? ' + ' + medias.length + ' média(s)' : ''), {
        wa_ids: messages.map(function(m) { return m.wa_id; }),
        medias: medias.map(function(m) { return { wamid: m.wamid, kind: m.media.kind, url: !!(m.brut._media && m.brut._media.url) }; }),
        statuts: statuts.map(function(s) { return s.statut; })
      });
    }
    return res.status(200).json({
      ok: true, enregistres: ecrits, statuts_maj: maj,
      medias: medias.length,
      medias_stockes: medias.filter(function(m) { return m.brut._media && m.brut._media.url; }).length
    });
  } catch (e) {
    // Échec d'écriture : 200 quand même (Meta ne doit pas rejuger en rafale),
    // l'échec est journalisé pour diagnostic.
    await journaliser('wa_webhook ERREUR écriture', { erreur: String((e && e.message) || e) });
    return res.status(200).json({ ok: true, enregistres: 0, statuts_maj: 0, erreur_interne: true });
  }
};

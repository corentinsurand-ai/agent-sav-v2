// ============================================================================
// Agent SAV U'mob v2 — lib/media.js — médias WhatsApp (C4-MEDIA-1, 16/11)
//
// Code mutualisé entre /api/whatsapp-webhook (stockage à la réception) et
// /api/whatsapp-messages (rattrapage backfill des médias déjà reçus).
//
// Pipeline : media id Meta → GET graph.facebook.com/v21.0/{id} (Bearer
// WA_TOKEN) → URL signée → binaire → upload bucket public Supabase Storage
// « wa-media » (créé à la volée, service key) → URL publique renvoyée.
// Best effort : toute erreur → null, jamais d'exception.
// ============================================================================

var BUCKET_MEDIA = 'wa-media';
var GRAPH_VERSION = 'v21.0';
var bucketMediaOk = false;   // mémo module : le bucket existe

function env(nom) { return process.env[nom] || ''; }

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
    // 1) media id → URL signée Meta
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

var TYPES_MEDIA = { image: 1, audio: 1, video: 1, document: 1, sticker: 1 };
var PLACEHOLDER = { image: '🖼 Photo', video: '🎬 Vidéo', audio: '🔊 Audio', document: '📄 Document', sticker: 'Sticker' };

// Extrait les infos média d'un brut Meta (message brut) → {kind,id,mime,caption} ou null.
function mediaDeBrut(brut) {
  if (!brut || typeof brut !== 'object') return null;
  var type = String(brut.type || '');
  if (!TYPES_MEDIA[type] || !brut[type]) return null;
  var bloc = brut[type];
  if (!bloc.id) return null;
  return {
    kind: type,
    id: String(bloc.id),
    mime: String(bloc.mime_type || ''),
    caption: bloc.caption ? String(bloc.caption) : ''
  };
}

// Construit l'objet brut._media une fois le média stocké (url ou null).
function mediaStockee(media, url) {
  return {
    kind: media.kind,
    id: media.id,
    mime: media.mime || '',
    caption: media.caption || '',
    url: url || null
  };
}

// Placeholder texte pour un média sans légende (affiché dans le fil/extrait).
function placeholderDe(kind) {
  return PLACEHOLDER[kind] || '[média reçu]';
}

module.exports = {
  BUCKET_MEDIA: BUCKET_MEDIA,
  TYPES_MEDIA: TYPES_MEDIA,
  mediaExt: mediaExt,
  assurerBucketMedia: assurerBucketMedia,
  stockerMedia: stockerMedia,
  mediaDeBrut: mediaDeBrut,
  mediaStockee: mediaStockee,
  placeholderDe: placeholderDe
};

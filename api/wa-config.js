// ============================================================================
// Agent SAV U'mob v2 — /api/wa-config — config publique Supabase Realtime
// RÔLE : renvoyer au navigateur l'URL Supabase + la clé ANON (publique) pour
//   ouvrir une souscription Realtime (websocket) sur agent_sav.wa_messages
//   et recevoir les nouveaux messages WhatsApp en temps réel.
//   Protégé par le même secret/jeton que les autres routes (la clé anon est
//   publique par design, mais on ne la sert qu'aux sessions authentifiées).
//   GET ?jeton=<session>  → { ok, url, anon, schema }
// ============================================================================

function env(nom) { return process.env[nom] || ''; }

function secretDe(req) {
  var secret = '';
  try { if (req.query && req.query.secret) secret = String(req.query.secret); } catch (e) {}
  if (!secret) {
    var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice((req.url || '').indexOf('?') + 1) : '';
    var m = u.match(/(?:^|&)secret=([^&]*)/);
    if (m) secret = m[1];
  }
  if (!secret && req.headers && req.headers['x-webhook-secret']) secret = String(req.headers['x-webhook-secret']);
  return secret;
}

function jetonDe(req) {
  var j = '';
  try { if (req.query && req.query.jeton) j = String(req.query.jeton); } catch (e) {}
  if (!j) {
    var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice((req.url || '').indexOf('?') + 1) : '';
    var m = u.match(/(?:^|&)jeton=([^&]*)/);
    if (m) j = decodeURIComponent(m[1]);
  }
  if (!j && req.headers && req.headers['x-jeton']) j = String(req.headers['x-jeton']);
  return j;
}

module.exports = async function handler(req, res) {
  try { res.setHeader('Access-Control-Allow-Origin', '*'); } catch (e) {}
  if (req.method === 'OPTIONS') {
    try {
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret, x-jeton');
    } catch (e) {}
    return res.status(204).end();
  }
  if (req.method !== 'GET') return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });

  var authA = require('../lib/auth');
  if (!authA.authentifierRequete(secretDe(req), jetonDe(req)).ok) {
    return res.status(401).json({ ok: false, erreur: 'secret invalide' });
  }
  var url = env('SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  var anon = env('SUPABASE_ANON_KEY') || '';
  if (!url) return res.status(500).json({ ok: false, erreur: 'SUPABASE_URL manquante' });
  // anon vide → le front retombe sur le polling 60 s (pas de Realtime)
  return res.status(200).json({ ok: true, url: url, anon: anon, schema: 'agent_sav', table: 'wa_messages' });
};

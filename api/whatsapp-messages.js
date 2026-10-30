// ============================================================================
// Agent SAV U'mob v2 — C4 : /api/whatsapp-messages — lecture des messages
// WhatsApp enregistrés (plateforme maison C1/C4)
//
// RÔLE : donner au canvas de la plateforme les VRAIS messages reçus par
// /api/whatsapp-webhook, pour construire les conversations (historique +
// nouveaux messages au rechargement 🔌 — choix Corentin 30/10).
//
//   GET ?secret=<WEBHOOK_SECRET>                  → info
//   GET ?secret=…&liste=1&limite=1000             → les derniers messages
//        (toutes les conversations confondues, ordre chronologique croissant,
//         limité aux plus récents : le canvas groupe par téléphone)
//   GET ?secret=…&tel=33620476040                  → l'historique d'un numéro
//
// CORS : Allow-Origin:* comme /api/clients-import (prototype navigateur,
// authentification par secret jamais présent dans le code).
//
// Réponses : 200 ; 401 secret ; 405 méthode ; 500 config/Supabase.
// ============================================================================

var VERSION = 'C4-LEC-1';
var SCHEMA = 'agent_sav';

function env(nom) { return process.env[nom] || ''; }

function secretDe(req) {
  var secret = '';
  try {
    if (req.query && req.query.secret) secret = String(req.query.secret);
  } catch (e) {}
  if (!secret) {
    var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice((req.url || '').indexOf('?') + 1) : '';
    var m = u.match(/(?:^|&)secret=([^&]*)/);
    if (m) secret = m[1];
  }
  if (!secret && req.headers && req.headers['x-webhook-secret']) {
    secret = String(req.headers['x-webhook-secret']);
  }
  return secret;
}

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

async function supabaseGet(params) {
  var res = await fetch(urlSupabase('wa_messages', params), {
    method: 'GET',
    headers: {
      'apikey': env('SUPABASE_SERVICE_KEY'),
      'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
      'Accept-Profile': SCHEMA
    }
  });
  var corps = '';
  try { corps = await res.text(); } catch (e) { corps = ''; }
  if (!res.ok) throw new Error('Supabase wa_messages ' + res.status + ' — ' + corps.substring(0, 300));
  return corps ? JSON.parse(corps) : [];
}

module.exports = async function handler(req, res) {
  // CORS — la plateforme (navigateur) lit cette route en direct.
  try { res.setHeader('Access-Control-Allow-Origin', '*'); } catch (e) {}
  if (req.method === 'OPTIONS') {
    try {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret');
    } catch (e) {}
    return res.status(204).end();
  }

  if (secretDe(req) !== env('WEBHOOK_SECRET') || !env('WEBHOOK_SECRET')) {
    return res.status(401).json({ ok: false, erreur: 'secret invalide' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });
  }

  if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_KEY')) {
    return res.status(500).json({ ok: false, erreur: 'configuration Supabase manquante (SUPABASE_URL, SUPABASE_SERVICE_KEY)' });
  }

  // Historique d'un numéro précis
  var tel = paramDe(req, 'tel');
  if (tel) {
    var d = tel.replace(/\D/g, '');
    try {
      var fil = await supabaseGet(
        'select=wa_id,nom_profil,texte,type,wamid,recu_a&wa_id=eq.' + encodeURIComponent(d) +
        '&order=recu_a.asc&limit=1000');
      return res.status(200).json({
        ok: true, brique: 'C4', version: VERSION, tel: d, trouves: fil.length, messages: fil
      });
    } catch (e) {
      return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
    }
  }

  // Derniers messages (toutes conversations) — le canvas regroupe par wa_id
  if (paramDe(req, 'liste') === '1') {
    var limite = parseInt(paramDe(req, 'limite'), 10) || 1000;
    if (limite < 1) limite = 1;
    if (limite > 5000) limite = 5000;
    try {
      // fenêtre des N plus récents, renvoyés en ordre chronologique croissant
      var derniers = await supabaseGet(
        'select=wa_id,nom_profil,texte,type,wamid,recu_a&order=recu_a.desc&limit=' + limite);
      derniers.reverse();
      var parTel = {};
      derniers.forEach(function(m) { parTel[m.wa_id] = (parTel[m.wa_id] || 0) + 1; });
      return res.status(200).json({
        ok: true, brique: 'C4', version: VERSION, limite: limite,
        messages: derniers, conversations: Object.keys(parTel).length,
        total: derniers.length
      });
    } catch (e) {
      return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
    }
  }

  return res.status(200).json({
    ok: true, brique: 'C4', version: VERSION,
    role: 'lecture des messages WhatsApp recus par /api/whatsapp-webhook',
    liste: 'GET ?liste=1&limite=1000 — derniers messages (canvas : regroupe par telephone)',
    tel: 'GET ?tel=33620476040 — historique chronologique d un numero'
  });
};

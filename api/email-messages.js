// ============================================================================
// Agent SAV U'mob v2 — C5.2 : api/email-messages.js — lecture des emails
//
// RÔLE : la plateforme lit les emails (entrants + sortants) de Supabase.
//   GET ?secret=...&liste=1&limite=50        -> fenêtre récente (desc puis asc)
//   GET ?secret=...&email=x@y.fr&limite=100  -> historique du contact (asc)
// ============================================================================

var VERSION = 'C5.2-LEC-1';

function repondre(res, code, corps) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-webhook-secret',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  });
  res.end(JSON.stringify(corps));
}

module.exports = async function (req, res) {
  if (req.method === 'OPTIONS') return repondre(res, 204, {});
  if (req.method !== 'GET') return repondre(res, 405, { ok: false, erreur: 'GET requis' });

  try {
    var u = new URL(req.url, 'http://localhost');
    var secret = req.headers['x-webhook-secret'] || u.searchParams.get('secret') || '';
    if (String(secret) !== String(process.env.WEBHOOK_SECRET || '')) {
      return repondre(res, 401, { ok: false, erreur: 'secret invalide' });
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return repondre(res, 500, { ok: false, erreur: 'config Supabase absente' });
    }

    var url = process.env.SUPABASE_URL.replace(/\/$/, '');
    var tete = {
      'apikey': process.env.SUPABASE_SERVICE_KEY,
      'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_KEY,
      'Accept-Profile': 'agent_sav'
    };
    var limite = Math.min(parseInt(u.searchParams.get('limite') || '50', 10) || 50, 500);
    var email = (u.searchParams.get('email') || '').trim();

    var chemin;
    if (email) {
      chemin = '/rest/v1/emails?select=message_id,sens,from_addr,from_nom,to_addr,sujet,texte,recu_a,lu'
        + '&or=(from_addr.eq.' + encodeURIComponent(email) + ',to_addr.eq.' + encodeURIComponent(email) + ')'
        + '&order=id.asc&limit=' + limite;
    } else {
      chemin = '/rest/v1/emails?select=message_id,sens,from_addr,from_nom,to_addr,sujet,texte,recu_a,lu'
        + '&order=id.desc&limit=' + limite;
    }

    var r = await fetch(url + chemin, { headers: tete });
    if (!r.ok) return repondre(res, 502, { ok: false, erreur: 'Supabase ' + r.status });

    var messages = await r.json();
    if (!email && Array.isArray(messages)) messages = messages.reverse(); // liste -> plus récents en bas

    return repondre(res, 200, {
      ok: true, brique: 'C5.2', version: VERSION,
      email: email || null,
      total: Array.isArray(messages) ? messages.length : 0,
      messages: Array.isArray(messages) ? messages : []
    });
  } catch (err) {
    return repondre(res, 500, { ok: false, erreur: String(err && err.message || err).substring(0, 300) });
  }
};

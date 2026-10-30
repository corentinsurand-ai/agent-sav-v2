// api/emails.js — version C5.2-FUS-2 : ajoute ?debug=1 TEMPORAIRE (diagnostic 404)
var VERSION = 'C5.2-FUS-2';
var url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
var tete = {
  'apikey': process.env.SUPABASE_SERVICE_KEY || '',
  'Authorization': 'Bearer ' + (process.env.SUPABASE_SERVICE_KEY || ''),
  'Content-Type': 'application/json',
  'Accept-Profile': 'agent_sav'
};
function repondre(res, code, corps) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(corps));
}
module.exports = async function (req, res) {
  if (req.method === 'OPTIONS') return repondre(res, 204, {});
  try {
    var u = new URL(req.url, 'http://localhost');
    var secretFourni = req.headers['x-webhook-secret'] || u.searchParams.get('secret') || '';
    if (String(secretFourni) !== String(process.env.WEBHOOK_SECRET || '')) {
      return repondre(res, 401, { ok: false, erreur: 'secret invalide' });
    }
    if (u.searchParams.get('debug') === '1') {
      var out = { version: VERSION, supabase_url: url, host: (url || '').replace(/^https:\/\//, '').split('.')[0] };
      var r1 = await fetch(url + '/rest/v1/emails?select=id&limit=1', { headers: tete });
      out.emails_status = r1.status;
      out.emails_body = (await r1.text()).substring(0, 300);
      var r2 = await fetch(url + '/rest/v1/', { headers: tete });
      out.openapi_status = r2.status;
      if (r2.ok) {
        var spec = await r2.json();
        var rels = Object.keys((spec && spec.paths) || {});
        out.relations = rels.map(function (p) { return p.replace(/^\//, ''); });
        out.expose_emails = rels.indexOf('/emails') !== -1;
        out.expose_wa_messages = rels.indexOf('/wa_messages') !== -1;
      } else {
        out.openapi_body = (await r2.text()).substring(0, 200);
      }
      return repondre(res, 200, out);
    }
    return repondre(res, 200, { ok: true, version: VERSION, note: 'route de debug temporaire, polling/lecture desactives' });
  } catch (err) {
    return repondre(res, 500, { ok: false, erreur: String(err && err.message || err).substring(0, 300) });
  }
};

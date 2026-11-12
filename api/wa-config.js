// ============================================================================
// Agent SAV U'mob v2 — /api/wa-config — DIAGNOSTIC de configuration WhatsApp
//
// RÔLE : vérifier quelle configuration Meta la production utilise réellement,
// sans jamais divulguer de secret. Protégé par le secret machine + jeton.
//   GET /api/wa-config?secret=…&jeton=…
//   → { ok:true, token_len, token_fin (10 derniers caractères),
//      token_debut (6 premiers), phone_id: WA_PHONE_NUMBER_ID }
// ============================================================================
function env(nom) { return process.env[nom] || ''; }

function secretDe(req, corps) {
  var secret = '';
  try { if (req.query && req.query.secret) secret = String(req.query.secret); } catch (e) {}
  if (!secret && req.headers && req.headers['x-webhook-secret']) secret = String(req.headers['x-webhook-secret']);
  if (!secret && corps && corps.secret) secret = String(corps.secret);
  return secret;
}
function jetonDe(req, corps) {
  var j = '';
  try { if (req.query && req.query.jeton) j = String(req.query.jeton); } catch (e) {}
  if (!j && req.headers && req.headers['x-jeton']) j = String(req.headers['x-jeton']);
  if (!j && corps && corps.jeton) j = String(corps.jeton);
  return j;
}

module.exports = async function handler(req, res) {
  try { res.setHeader('Access-Control-Allow-Origin', '*'); } catch (e) {}
  var corps = {};
  try { corps = (typeof req.body === 'object' && req.body) || JSON.parse(String(req.body || '{}')); } catch (e) {}
  var authA = require('../lib/auth');
  if (!authA.authentifierRequete(secretDe(req, corps), jetonDe(req, corps)).ok) {
    return res.status(401).json({ ok: false, erreur: 'secret invalide' });
  }
  var tok = env('WA_TOKEN');
  return res.status(200).json({
    ok: true,
    token_defini: !!tok,
    token_len: tok.length,
    token_debut: tok.slice(0, 6),
    token_fin: tok.slice(-10),
    phone_id: env('WA_PHONE_NUMBER_ID'),
    api_version: env('WA_API_VERSION') || 'v26.0'
  });
};

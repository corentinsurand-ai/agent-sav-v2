// ============================================================================
// Agent SAV U'mob v2 — C5 : /api/email-send — envoi RÉEL d'emails via SMTP OVH
//
// RÔLE : la plateforme maison (mode écriture, canal Email) envoie un vrai
// email au client depuis l'adresse SAV OVH. L'ADAPTATEUR CANAL est le SEUL
// à parler au serveur SMTP (principe cerveau ≠ canal) : aucun LLM ici.
//
//   POST /api/email-send
//   { secret, a, sujet, texte }     (secret accepté : query, header, body)
//   → { ok:true, brique:'C5', message_id }
//
// APRÈS l'envoi réussi : enregistré dans agent_sav.emails avec sens='sortant'
// (best effort — une panne Supabase ne fait pas échouer l'envoi).
//
// Config Vercel : SMTP_HOST (ex ssl0.ovh.net), SMTP_PORT (défaut 465 ;
// 587 = STARTTLS), SMTP_USER, SMTP_PASS, EMAIL_FROM optionnel (défaut
// SMTP_USER). Aucun secret dans le code.
//
// Réponses : 200 ; 400 paramètres ; 401 secret ; 405 méthode ;
// 500 config manquante ; 502 erreur SMTP.
// ============================================================================

var VERSION = 'C5-ENV-1';
var SCHEMA = 'agent_sav';
var smtp = require('../lib/smtp');

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

function emailValide(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());
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
      body: JSON.stringify({ etape: 'email_send', texte: texte, detail: detail })
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

  var a = String((corps && corps.a) || '').trim();
  var sujet = String((corps && corps.sujet) || '').trim();
  var texte = String((corps && corps.texte) || '').trim();

  if (!a) return res.status(400).json({ ok: false, erreur: 'a requis (adresse email du client)' });
  if (!emailValide(a)) return res.status(400).json({ ok: false, erreur: 'a doit etre une adresse email valide' });
  if (!texte) return res.status(400).json({ ok: false, erreur: 'texte requis' });
  if (!sujet) sujet = 'Message de votre service U\'mob';
  if (texte.length > 50000) return res.status(400).json({ ok: false, erreur: 'texte trop long (max 50000 caracteres)' });

  var host = env('SMTP_HOST'), user = env('SMTP_USER'), pass = env('SMTP_PASS');
  var de = env('EMAIL_FROM') || user;
  if (!host || !user || !pass || !de) {
    return res.status(500).json({
      ok: false,
      erreur: 'configuration SMTP manquante (SMTP_HOST, SMTP_USER, SMTP_PASS) — definis les variables dans Vercel puis Redeploy'
    });
  }

  var result;
  try {
    result = await smtp.envoyerSmtp({
      host: host, port: env('SMTP_PORT') || 465,
      user: user, pass: pass,
      de: de, a: a, sujet: sujet, texte: texte
    });
  } catch (e) {
    await journaliser('email_send ERREUR SMTP', { a: a, erreur: String((e && e.message) || e) });
    return res.status(502).json({ ok: false, erreur: 'envoi SMTP echoue', detail: String((e && e.message) || e).substring(0, 300) });
  }

  // Enregistrement côté emails (sens sortant) — best effort.
  try {
    await fetch(urlSupabase('emails', ''), {
      method: 'POST',
      headers: {
        'apikey': env('SUPABASE_SERVICE_KEY'),
        'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
        'Content-Profile': SCHEMA
      },
      body: JSON.stringify([{
        message_id: result.message_id,
        sens: 'sortant',
        from_addr: de,
        to_addr: a,
        sujet: sujet,
        texte: texte,
        brut: { envoye_par: 'plateforme-c5' },
        recu_a: new Date().toISOString(),
        statut_reception: 'sent',
        lu: true
      }])
    });
  } catch (e) {
    await journaliser('email_send : envoi OK mais enregistrement echoue', { a: a });
  }

  await journaliser('email_send : email envoye a ' + a, { message_id: result.message_id, sujet: sujet.substring(0, 120) });
  return res.status(200).json({ ok: true, brique: 'C5', version: VERSION, message_id: result.message_id, statut: 'envoye' });
};

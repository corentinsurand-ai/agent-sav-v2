// ============================================================================
// Agent SAV U'mob v2 — B6.4 : adaptateur email Resend (digest prise de main)
//
// RÔLE (portage v2.20.83 de l'ancien système) : envoyer le DIGEST des prises
// de main à l'équipe. C'est la seule couche qui parle à api.resend.com.
//
//   envoyerEmail(sujet, corps) → { envoye: true } | { envoye: false, raison }
//   - POST https://api.resend.com/emails, Authorization: Bearer RESEND_API_KEY
//   - from : env EMAIL_FROM (adresse vérifiée Resend — OBLIGATOIRE)
//   - to   : env ALERT_EMAIL (défaut corentin.surand@umob.fr, comme le v136)
//   - SANS RESEND_API_KEY : { envoye: false, raison } — JAMAIS de throw
//     (un digest indisponible ne doit jamais faire échouer un scan).
//   - Erreur réseau ou HTTP : { envoye: false, raison } — jamais de throw.
//
// La clé (RESEND_API_KEY) vit UNIQUEMENT dans les variables d'environnement
// Vercel — jamais dans le code, jamais sur GitHub.
// ============================================================================

var RESEND_API = 'https://api.resend.com/emails';
var DESTINATAIRE_DEFAUT = 'corentin.surand@umob.fr'; // parité v136

function env(nom) { return process.env[nom] || ''; }

async function envoyerEmail(sujet, corps) {
  if (!env('RESEND_API_KEY')) {
    return { envoye: false, raison: 'RESEND_API_KEY absente — à ajouter dans Vercel (Settings → Environment Variables)' };
  }
  var de = env('EMAIL_FROM');
  if (!de) {
    return { envoye: false, raison: 'EMAIL_FROM absente — adresse expéditrice vérifiée chez Resend (ex : onboarding@resend.dev pendant les tests)' };
  }
  var a = env('ALERT_EMAIL') || DESTINATAIRE_DEFAUT;
  try {
    var res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env('RESEND_API_KEY'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: de,
        to: [a],
        subject: String(sujet || ''),
        text: String(corps || '')
      })
    });
    var texte = '';
    try { texte = await res.text(); } catch (e) { texte = ''; }
    if (!res.ok) {
      return { envoye: false, raison: 'resend ' + res.status + ' : ' + texte.substring(0, 200) };
    }
    return { envoye: true };
  } catch (e) {
    return { envoye: false, raison: 'reseau : ' + String((e && e.message) || e).substring(0, 200) };
  }
}

module.exports = { envoyerEmail: envoyerEmail, DESTINATAIRE_DEFAUT: DESTINATAIRE_DEFAUT };

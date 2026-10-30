// ============================================================================
// Agent SAV U'mob v2 — C5.2 : /api/emails — Email entrant + lecture, UNE route
//
// FUSION (30/10, limite Hobby : 12 fonctions/déploiement) : les ex-routes
// /api/email-inbox (polling IMAP) et /api/email-messages (lecture) vivent
// désormais ICI dans une seule fonction.
//
//   POLLING (cron-job.org, toutes les ~2 min) :
//     GET  /api/emails?secret=...&poll=1
//     POST /api/emails            (corps {secret, poll:1} accepté aussi)
//     -> lit la boite OVH en IMAP (ex3.mail.ovh.net:993) et importe dans
//        agent_sav.emails les messages ENTRANTS nouveaux (sens='entrant').
//
//   LECTURE (plateforme) :
//     GET /api/emails?secret=...&liste=1&limite=50       -> fenetre recente (asc)
//     GET /api/emails?secret=...&email=x@y.fr&limite=100 -> historique du contact
//
// FIX C5.2-FUS-3 (30/10) : SUPABASE_URL sur Vercel CONTIENT deja '/rest/v1' ;
// on le retire comme le fait /api/whatsapp-messages (sinon /rest/v1/rest/v1
// -> PGRST125, la cause du 404 "table introuvable").
//
// Reutilise SMTP_HOST/SMTP_USER/SMTP_PASS comme identifiants IMAP (meme
// serveur OVH). Aucun secret dans le code.
// ============================================================================

var imap = require('../lib/imap');
var mail = require('../lib/mail');

var VERSION = 'C5.2-FUS-3';
var MAX_PAR_RUN = 8;          // Vercel Hobby : 10 s max, on borne le travail

function urlSupabase(chemin) {
  var base = (process.env.SUPABASE_URL || '')
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/, '');
  return base + '/rest/v1/' + chemin;
}

function teteSupa() {
  return {
    'apikey': process.env.SUPABASE_SERVICE_KEY || '',
    'Authorization': 'Bearer ' + (process.env.SUPABASE_SERVICE_KEY || ''),
    'Content-Type': 'application/json',
    'Accept-Profile': 'agent_sav'
  };
}

async function journaliser(etape, message) {
  try {
    await fetch(urlSupabase('journal'), {
      method: 'POST',
      headers: Object.assign(teteSupa(), { 'Content-Profile': 'agent_sav' }),
      body: JSON.stringify({ etape: etape, message: message })
    });
  } catch (e) {}
}

function lireCorps(req) {
  return new Promise(function (res) {
    var corps = '';
    req.on('data', function (c) { corps += c; });
    req.on('end', function () {
      try { res(corps ? JSON.parse(corps) : {}); } catch (e) { res({}); }
    });
  });
}

function repondre(res, code, corps) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-webhook-secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(corps));
}

// ----------------------------------------------------------------------------
// POLLING IMAP (ex /api/email-inbox)
// ----------------------------------------------------------------------------
async function poller(user, pass, host) {
  // ---- 1. Point de reprise : dernier uid importe -------------------------
  var colonneUid = true;
  var dernierUid = 0;
  var rMax = await fetch(urlSupabase('emails?select=uid_imap&order=uid_imap.desc&limit=1'), { headers: teteSupa() });
  if (rMax.ok) {
    var lignesMax = await rMax.json();
    if (Array.isArray(lignesMax) && lignesMax.length && lignesMax[0].uid_imap) dernierUid = Number(lignesMax[0].uid_imap);
  } else {
    colonneUid = false;   // PGRST204 : colonne absente -> repli via brut
    var rBrut = await fetch(urlSupabase('emails?select=brut&order=id.desc&limit=50'), { headers: teteSupa() });
    if (rBrut.ok) {
      var lignesBrut = await rBrut.json();
      (lignesBrut || []).forEach(function (l) {
        var u = l && l.brut && (typeof l.brut === 'object') && l.brut.uid_imap;
        if (u && Number(u) > dernierUid) dernierUid = Number(u);
      });
    }
  }

  // ---- 2. Lecture boite IMAP --------------------------------------------
  var boite = await imap.ouvrirBoite({ host: host, user: user, pass: pass });
  var resultat = { dernier_uid_avant: dernierUid, uids: [], importes: 0, ignores: 0, echecs: 0, colonne_uid: colonneUid };
  try {
    var uids;
    if (dernierUid === 0) {
      // Premier run : ne pas importer tout l'historique -> les 8 derniers seulement
      uids = await boite.chercherNouveaux(0, 500);
      uids = uids.slice(-MAX_PAR_RUN);
    } else {
      uids = await boite.chercherNouveaux(dernierUid, MAX_PAR_RUN);
    }
    resultat.uids = uids;

    for (var i = 0; i < uids.length; i++) {
      var uid = uids[i];
      try {
        var brutMsg = await boite.lireMessage(uid);
        if (!brutMsg) { resultat.echecs++; continue; }
        var m = mail.parseMessage(brutMsg);

        // Nos propres envois (SMTP sortant) ne sont pas des demandes clients
        if ((m.from_addr || '').toLowerCase() === String(user).toLowerCase()) { resultat.ignores++; continue; }

        var d = m.date ? new Date(m.date) : null;
        var recuIso = (d && !isNaN(d.getTime())) ? d.toISOString() : new Date().toISOString();

        var ligne = {
          message_id: m.message_id || ('imap-uid-' + uid + '@agent-sav'),
          sens: 'entrant',
          from_addr: m.from_addr,
          from_nom: m.from_nom || null,
          to_addr: user,
          sujet: m.sujet,
          texte: m.texte,
          brut: { uid_imap: uid, source: 'imap' },
          recu_a: recuIso,
          lu: false
        };
        if (colonneUid) ligne.uid_imap = uid;

        var rIns = await fetch(urlSupabase('emails?on_conflict=message_id'), {
          method: 'POST',
          headers: Object.assign(teteSupa(), {
            'Content-Profile': 'agent_sav',
            'Prefer': 'resolution=ignore-duplicates,return=minimal'
          }),
          body: JSON.stringify([ligne])
        });
        if (rIns.ok) resultat.importes++; else resultat.ignores++;
      } catch (eUn) { resultat.echecs++; }
    }
  } finally {
    try { await boite.finir(); } catch (e) {}
  }

  await journaliser('email_inbox', 'poll IMAP ok : ' + resultat.importes + ' importes, ' + resultat.ignores + ' ignores, ' + resultat.echecs + ' echecs (dernier uid ' + dernierUid + ')');
  return resultat;
}

// ----------------------------------------------------------------------------
// LECTURE (ex /api/email-messages)
// ----------------------------------------------------------------------------
async function lireEmails(u) {
  var limite = Math.min(parseInt(u.searchParams.get('limite') || '50', 10) || 50, 500);
  var email = (u.searchParams.get('email') || '').trim();

  var chemin;
  if (email) {
    chemin = 'emails?select=message_id,sens,from_addr,from_nom,to_addr,sujet,texte,recu_a,lu'
      + '&or=(from_addr.eq.' + encodeURIComponent(email) + ',to_addr.eq.' + encodeURIComponent(email) + ')'
      + '&order=id.asc&limit=' + limite;
  } else {
    chemin = 'emails?select=message_id,sens,from_addr,from_nom,to_addr,sujet,texte,recu_a,lu'
      + '&order=id.desc&limit=' + limite;
  }

  var r = await fetch(urlSupabase(chemin), { headers: teteSupa() });
  if (!r.ok) return { code: 502, corps: { ok: false, erreur: 'Supabase ' + r.status } };

  var messages = await r.json();
  if (!email && Array.isArray(messages)) messages = messages.reverse(); // liste -> plus recents en bas

  return {
    code: 200,
    corps: {
      ok: true, brique: 'C5.2', version: VERSION,
      email: email || null,
      total: Array.isArray(messages) ? messages.length : 0,
      messages: Array.isArray(messages) ? messages : []
    }
  };
}

// ----------------------------------------------------------------------------
// Handler unique
// ----------------------------------------------------------------------------
module.exports = async function (req, res) {
  if (req.method === 'OPTIONS') return repondre(res, 204, {});

  try {
    var u = new URL(req.url, 'http://localhost');
    var corps = req.method === 'POST' ? await lireCorps(req) : {};
    var secretFourni = req.headers['x-webhook-secret'] || u.searchParams.get('secret') || corps.secret || '';
    if (String(secretFourni) !== String(process.env.WEBHOOK_SECRET || '')) {
      return repondre(res, 401, { ok: false, erreur: 'secret invalide' });
    }

    var veutPoll = u.searchParams.get('poll') === '1' || corps.poll === 1 || corps.poll === '1';

    // ---- MODE POLLING IMAP -------------------------------------------------
    if (veutPoll) {
      var host = process.env.SMTP_HOST, user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
      if (!host || !user || !pass || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return repondre(res, 500, { ok: false, erreur: 'config incomplete (SMTP_HOST/SMTP_USER/SMTP_PASS ou Supabase absents)' });
      }
      try {
        var resultat = await poller(user, pass, host);
        return repondre(res, 200, Object.assign({ ok: true, brique: 'C5.2', mode: 'poll', version: VERSION }, resultat));
      } catch (err) {
        await journaliser('email_inbox', 'ERREUR : ' + String(err && err.message || err).substring(0, 400));
        return repondre(res, 502, { ok: false, brique: 'C5.2', mode: 'poll', erreur: String(err && err.message || err).substring(0, 400) });
      }
    }

    // ---- MODE LECTURE ------------------------------------------------------
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return repondre(res, 500, { ok: false, erreur: 'config Supabase absente' });
    }
    var lecture = await lireEmails(u);
    if (lecture.code !== 200) lecture.corps.version = VERSION;
    return repondre(res, lecture.code, lecture.corps);
  } catch (err) {
    return repondre(res, 500, { ok: false, erreur: String(err && err.message || err).substring(0, 300) });
  }
};

// ============================================================================
// Agent SAV U'mob v2 — C5.2 : api/email-inbox.js — réception des emails clients
//
// RÔLE : appelé par le cron (cron-job.org, GET toutes les ~2 min), cette route
// lit la boîte OVH en IMAP (ex3.mail.ovh.net:993) et importe dans
// agent_sav.emails les messages ENTRANTS nouveaux (sens='entrant').
//
// Point de reprise : emails.uid_imap (max). Premier run (rien importé) -> on
// n'importe que les MAX_PAR_RUN derniers (pas tout l'historique).
// Repli : si la colonne uid_imap n'existe pas encore (SQL pas rejoué), le
// dernier uid est cherché dans brut.uid_imap et l'insert se fait sans uid.
//
// Réutilise SMTP_HOST/SMTP_USER/SMTP_PASS comme env vars IMAP (même serveur
// OVH). GET et POST acceptés (cron-job.org fait du GET).
// ============================================================================

var imap = require('../lib/imap');
var mail = require('../lib/mail');

var VERSION = 'C5.2-REC-1';
var MAX_PAR_RUN = 8;          // Vercel Hobby : 10 s max, on borne le travail

function urlSupabase(chemin) {
  return (process.env.SUPABASE_URL || '').replace(/\/$/, '') + '/rest/v1/' + chemin;
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

function json(req) {
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

module.exports = async function (req, res) {
  if (req.method === 'OPTIONS') return repondre(res, 204, {});

  try {
    var corps = req.method === 'POST' ? await json(req) : {};
    var secretFourni = req.headers['x-webhook-secret'] || corps.secret || '';
    if (String(secretFourni) !== String(process.env.WEBHOOK_SECRET || '')) {
      return repondre(res, 401, { ok: false, erreur: 'secret invalide' });
    }

    var host = process.env.SMTP_HOST, user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
    if (!host || !user || !pass || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return repondre(res, 500, { ok: false, erreur: 'config incomplete (SMTP_HOST/SMTP_USER/SMTP_PASS ou Supabase absents)' });
    }

    var url = process.env.SUPABASE_URL.replace(/\/$/, '');

    // ---- 1. Point de reprise : dernier uid importé -------------------------
    var colonneUid = true;
    var dernierUid = 0;
    var rMax = await fetch(url + '/rest/v1/emails?select=uid_imap&order=uid_imap.desc&limit=1', { headers: teteSupa() });
    if (rMax.ok) {
      var lignesMax = await rMax.json();
      if (Array.isArray(lignesMax) && lignesMax.length && lignesMax[0].uid_imap) dernierUid = Number(lignesMax[0].uid_imap);
    } else {
      colonneUid = false;   // PGRST204 : colonne absente -> repli via brut
      var rBrut = await fetch(url + '/rest/v1/emails?select=brut&order=id.desc&limit=50', { headers: teteSupa() });
      if (rBrut.ok) {
        var lignesBrut = await rBrut.json();
        (lignesBrut || []).forEach(function (l) {
          var u = l && l.brut && (typeof l.brut === 'object') && l.brut.uid_imap;
          if (u && Number(u) > dernierUid) dernierUid = Number(u);
        });
      }
    }

    // ---- 2. Lecture boîte IMAP -------------------------------------------
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

          var rIns = await fetch(url + '/rest/v1/emails?on_conflict=message_id', {
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

    return repondre(res, 200, Object.assign({ ok: true, brique: 'C5.2', version: VERSION }, resultat));
  } catch (err) {
    await journaliser('email_inbox', 'ERREUR : ' + String(err && err.message || err).substring(0, 400));
    return repondre(res, 502, { ok: false, brique: 'C5.2', erreur: String(err && err.message || err).substring(0, 400) });
  }
};

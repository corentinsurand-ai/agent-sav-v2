// ============================================================================
// Agent SAV U'mob v2 — C5.2 : /api/emails — Email entrant + lecture, UNE route
//
//   POLLING (cron-job.org, ~2 min) : GET /api/emails?secret=...&poll=1
//     -> lit la boite OVH en IMAP (ex3.mail.ovh.net:993), importe dans
//        agent_sav.emails les messages ENTRANTS nouveaux (sens='entrant').
//   LECTURE (plateforme) :
//     GET ?secret&liste=1&limite=50   -> fenetre recente (asc)
//     GET ?secret&email=x@y.fr        -> historique du contact
//
// FIX C5.2-FUS-3 : SUPABASE_URL Vercel contient deja '/rest/v1' -> retire.
// FIX C5.2-FUS-5 : pas de contrainte unique message_id (42P10) -> doublon
// evite par pre-verification GET message_id avant insert.
// FIX C5.2-FUS-6 : (a) reprise uid : DESC met les NULL en premier -> on scanne
// toutes les lignes et ignore les NULL ; (b) PGRST102 (JSON rejete) -> on
// assainit les champs (controles, surrogats isoles) et on retente avec le
// texte tronque ; (c) message_id litteral 'null' -> repli imap-uid-<uid>.
// ============================================================================

var imap = require('../lib/imap');
var mail = require('../lib/mail');

var VERSION = 'C5.2-FUS-6';
var MAX_PAR_RUN = 8;

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

// Un message_id est-il deja en base ? (remplace on_conflict, absent de la table)
async function dejaEnBase(messageId) {
  var r = await fetch(urlSupabase('emails?select=id&message_id=eq.' + encodeURIComponent(messageId)), { headers: teteSupa() });
  if (!r.ok) return false; // en cas de doute on tente l'insert : la PK id protege
  var lignes = await r.json();
  return Array.isArray(lignes) && lignes.length > 0;
}

// Caracteres de controle et surrogats isoles -> certains serveurs rejettent le JSON
function nettoyer(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

async function poller(user, pass, host) {
  // ---- 1. Point de reprise : dernier uid importe -------------------------
  var colonneUid = true;
  var dernierUid = 0;
  var rMax = await fetch(urlSupabase('emails?select=uid_imap&order=uid_imap.desc&limit=5'), { headers: teteSupa() });
  if (rMax.ok) {
    var lignesMax = await rMax.json();
    if (Array.isArray(lignesMax)) {
      for (var k = 0; k < lignesMax.length; k++) {
        var um = lignesMax[k] && lignesMax[k].uid_imap;
        if (um && Number(um) > dernierUid) dernierUid = Number(um); // NULL exclus
      }
    }
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
  var resultat = { dernier_uid_avant: dernierUid, uids: [], importes: 0, doublons: 0, ignores: 0, echecs: 0, colonne_uid: colonneUid };
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

        var messageId = (m.message_id && m.message_id !== 'null') ? m.message_id : ('imap-uid-' + uid + '@agent-sav');
        if (await dejaEnBase(messageId)) { resultat.doublons++; continue; }

        var d = m.date ? new Date(m.date) : null;
        var recuIso = (d && !isNaN(d.getTime())) ? d.toISOString() : new Date().toISOString();

        var ligne = {
          message_id: messageId,
          sens: 'entrant',
          from_addr: m.from_addr,
          from_nom: nettoyer(m.from_nom) || null,
          to_addr: user,
          sujet: nettoyer(m.sujet),
          texte: nettoyer(m.texte),
          brut: { uid_imap: uid, source: 'imap' },
          recu_a: recuIso,
          lu: false
        };
        if (colonneUid) ligne.uid_imap = uid;

        var rIns = await fetch(urlSupabase('emails'), {
          method: 'POST',
          headers: Object.assign(teteSupa(), { 'Content-Profile': 'agent_sav', 'Prefer': 'return=minimal' }),
          body: JSON.stringify([ligne])
        });
        if (!rIns.ok) {
          // Repli : corps potentiellement volumineux/indigeste -> texte tronque
          ligne.texte = String(ligne.texte || '').substring(0, 4000);
          ligne.brut = { uid_imap: uid, source: 'imap' };
          try {
            rIns = await fetch(urlSupabase('emails'), {
              method: 'POST',
              headers: Object.assign(teteSupa(), { 'Content-Profile': 'agent_sav', 'Prefer': 'return=minimal' }),
              body: JSON.stringify([ligne])
            });
          } catch (eRe) { resultat.echecs++; continue; }
        }
        if (rIns.ok) resultat.importes++;
        else {
          resultat.echecs++;
          if (!resultat.erreur_insert) {
            try { resultat.erreur_insert = (await rIns.text()).substring(0, 300); } catch (e) {}
          }
        }
      } catch (eUn) { resultat.echecs++; }
    }
  } finally {
    try { await boite.finir(); } catch (e) {}
  }

  await journaliser('email_inbox', 'poll IMAP ok : ' + resultat.importes + ' importes, ' + resultat.doublons + ' doublons, ' + resultat.ignores + ' ignores, ' + resultat.echecs + ' echecs (dernier uid ' + dernierUid + ')');
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

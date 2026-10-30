// ============================================================================
// Agent SAV U'mob v2 — C5.2 : /api/emails — Email entrant + lecture, UNE route
// ============================================================================
var imap = require('../lib/imap');
var mail = require('../lib/mail');

var VERSION = 'C5.2-FUS-4d';
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

async function poller(user, pass, host) {
  var colonneUid = true;
  var dernierUid = 0;
  var rMax = await fetch(urlSupabase('emails?select=uid_imap&order=uid_imap.desc&limit=1'), { headers: teteSupa() });
  if (rMax.ok) {
    var lignesMax = await rMax.json();
    if (Array.isArray(lignesMax) && lignesMax.length && lignesMax[0].uid_imap) dernierUid = Number(lignesMax[0].uid_imap);
  } else {
    colonneUid = false;
  }

  var boite = await imap.ouvrirBoite({ host: host, user: user, pass: pass });
  var resultat = { dernier_uid_avant: dernierUid, uids: [], importes: 0, ignores: 0, ignores_propres: 0, ignores_insert: 0, echecs: 0, colonne_uid: colonneUid };
  try {
    var uids;
    if (dernierUid === 0) {
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

        resultat.detail = resultat.detail || [];
        if (resultat.detail.length < 4) resultat.detail.push({ uid: uid, from: m.from_addr || null, sujet: (m.sujet || '').substring(0, 50) });

        if ((m.from_addr || '').toLowerCase() === String(user).toLowerCase()) { resultat.ignores_propres++; continue; }

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
        if (rIns.ok) resultat.importes++;
        else {
          resultat.ignores_insert++;
          if (!resultat.erreur_insert) {
            try { resultat.erreur_insert = (await rIns.text()).substring(0, 300); } catch (e) {}
          }
        }
      } catch (eUn) {
        resultat.echecs++;
        if (!resultat.erreur_boucle) resultat.erreur_boucle = String(eUn && eUn.message || eUn).substring(0, 200);
      }
    }
  } finally {
    try { await boite.finir(); } catch (e) {}
  }

  return resultat;
}

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
  if (!email && Array.isArray(messages)) messages = messages.reverse();

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

    if (veutPoll) {
      var host = process.env.SMTP_HOST, user = process.env.SMTP_USER, pass = process.env.SMTP_PASS;
      if (!host || !user || !pass || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return repondre(res, 500, { ok: false, erreur: 'config incomplete' });
      }
      try {
        var resultat = await poller(user, pass, host);
        return repondre(res, 200, Object.assign({ ok: true, brique: 'C5.2', mode: 'poll', version: VERSION }, resultat));
      } catch (err) {
        return repondre(res, 502, { ok: false, brique: 'C5.2', mode: 'poll', erreur: String(err && err.message || err).substring(0, 400) });
      }
    }

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

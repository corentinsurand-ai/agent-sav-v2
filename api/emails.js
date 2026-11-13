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

var VERSION = 'C5.3-HTML-1';
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
    'Access-Control-Allow-Headers': 'Content-Type, x-webhook-secret, x-jeton',
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

  // ---- C5.3 : la colonne corps_html existe-t-elle deja ? -------------------
  var colonneHtml = true;
  var rHtml = await fetch(urlSupabase('emails?select=corps_html&limit=1'), { headers: teteSupa() });
  if (!rHtml.ok) colonneHtml = false;   // PGRST204 : colonne absente -> HTML non stocke

  // ---- 2. Lecture boite IMAP --------------------------------------------
  var boite = await imap.ouvrirBoite({ host: host, user: user, pass: pass });
  var resultat = { dernier_uid_avant: dernierUid, uids: [], importes: 0, doublons: 0, ignores: 0, echecs: 0, colonne_uid: colonneUid, colonne_html: colonneHtml };
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
        if (colonneHtml && m.html) ligne.corps_html = m.html;

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
        // C5.3 : deuxi eme repli — le HTML volumineux peut etre le coupable
        if (!rIns.ok && ligne.corps_html) {
          delete ligne.corps_html;
          try {
            rIns = await fetch(urlSupabase('emails'), {
              method: 'POST',
              headers: Object.assign(teteSupa(), { 'Content-Profile': 'agent_sav', 'Prefer': 'return=minimal' }),
              body: JSON.stringify([ligne])
            });
          } catch (eRe2) { resultat.echecs++; continue; }
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
  var limite = Math.min(parseInt(u.searchParams.get('limite') || '50', 10) || 50, 1000);  /* C26-MAIL-HIST : cap 500 -> 1000 (max lignes Supabase) */
  var email = (u.searchParams.get('email') || '').trim();

  var selBase = 'message_id,sens,from_addr,from_nom,to_addr,sujet,texte,recu_a,lu'
    + (u.searchParams.get('brut') ? ',brut' : '');  /* C27-DEBUG : &brut=1 pour inspecter le brut */
  function cheminAvec(sel) {
    if (email) {
      return 'emails?select=' + sel
        + '&or=(from_addr.eq.' + encodeURIComponent(email) + ',to_addr.eq.' + encodeURIComponent(email) + ')'
        + '&order=id.asc&limit=' + limite;
    }
    return 'emails?select=' + sel + '&order=id.desc&limit=' + limite;
  }

  // C5.3 : corps_html en premier ; si la colonne manque (PGRST204) -> sans
  var r = await fetch(urlSupabase(cheminAvec(selBase + ',corps_html')), { headers: teteSupa() });
  if (!r.ok) {
    r = await fetch(urlSupabase(cheminAvec(selBase)), { headers: teteSupa() });
  }
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
// MODE DEBUG TEMPORAIRE C5.3b : ?debugraw=<uid> -> MIME brut + inventaire parties
// (a retirer apres diagnostic)
// ----------------------------------------------------------------------------
async function debugRaw(uid, user, pass, host, opts) {
  var boite = await imap.ouvrirBoite({ host: host, user: user, pass: pass });
  var brut = '';
  try { brut = await boite.lireMessage(uid); } finally { try { await boite.finir(); } catch (e) {} }
  var parties = [];
  var boundaries = [];
  var re = /boundary="?([^";\r\n]+)"?/gi, mB;
  while ((mB = re.exec(brut)) !== null) if (boundaries.indexOf(mB[1]) === -1) boundaries.push(mB[1]);
  boundaries.forEach(function (b) {
    var morceaux = brut.split('--' + b);
    for (var i = 1; i < morceaux.length; i++) {
      var p = morceaux[i].replace(/^\r?\n/, '');
      if (!p || p.indexOf('--') === 0) continue;
      var finTete = p.indexOf('\r\n\r\n') !== -1 ? p.indexOf('\r\n\r\n') : p.indexOf('\n\n');
      var ptetes = p.slice(0, finTete).replace(/\r?\n[ \t]+/g, ' ');
      var pcorps = p.slice(finTete + (p.indexOf('\r\n\r\n') !== -1 ? 4 : 2));
      parties.push({
        boundary: b,
        tete: ptetes.substring(0, 400),
        taille_corps: pcorps.length,
        debut_corps: pcorps.substring(0, 60)
      });
    }
  });
  // Validation en prod : le parseur doit inliner les cid: (C5.3b)
  var pm = mail.parseMessage(brut);
  var hParse = pm.html || '';
  var parse = {
    sujet: pm.sujet,
    html_len: hParse.length,
    cid_residuels: (hParse.match(/cid:/g) || []).length,
    data_uris: (hParse.match(/data:image/g) || []).length
  };
  // maj=1 : met a jour corps_html de l'email DEJA en base (les imports passes
  // ne sont jamais re-parses -> cette option repare un email existant)
  var maj = null;
  if (opts && opts.maj && parse.data_uris > 0 && pm.message_id) {
    try {
      var rMaj = await fetch(urlSupabase('emails?message_id=eq.' + encodeURIComponent(pm.message_id)), {
        method: 'PATCH',
        headers: Object.assign(teteSupa(), { 'Content-Profile': 'agent_sav' }),
        body: JSON.stringify({ corps_html: hParse })
      });
      maj = { status: rMaj.status, ok: rMaj.ok, message_id: pm.message_id };
    } catch (eMaj) { maj = { ok: false, erreur: String(eMaj && eMaj.message || eMaj).substring(0, 200) }; }
  }
  // C5-ENV-3 FIX : la réponse non-maj doit TOUJOURS ramener le MIME brut
  return { uid: uid, taille: brut.length, boundaries: boundaries, parties: parties, parse: parse, maj: maj, brut: brut };
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
    var jetonFourni = req.headers['x-jeton'] || u.searchParams.get('jeton') || corps.jeton || '';
    var authE = require('../lib/auth');
    if (!authE.authentifierRequete(secretFourni, jetonFourni).ok) {
      return repondre(res, 401, { ok: false, erreur: 'secret invalide' });
    }

    // ---- C8-IMP-1 : POST {importer:[…]} → import des emails historiques
    // respond.io (pré-vérification message_id — pas de contrainte unique
    // en base ; max 200 par appel ; upsert non requis : insert sans doublon)
    if (Array.isArray(corps.importer)) {
      if (!corps.importer.length) return repondre(res, 400, { ok: false, erreur: 'importer vide' });
      if (corps.importer.length > 200) return repondre(res, 400, { ok: false, erreur: 'trop d emails (max 200 par appel)' });
      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
        return repondre(res, 500, { ok: false, erreur: 'config Supabase absente' });
      }
      var ecrits = 0, ignores = 0, erreurs = [];
      for (var iImp = 0; iImp < corps.importer.length; iImp++) {
        var em = corps.importer[iImp];
        if (!em || typeof em !== 'object' || !em.message_id) { continue; }
        var mid = String(em.message_id);
        try {
          var deja = await fetch(urlSupabase('emails?select=id&message_id=eq.' + encodeURIComponent(mid)), { headers: teteSupa() });
          if (deja.ok) {
            var dj = ''; try { dj = await deja.text(); } catch (e) { dj = ''; }
            if (dj && JSON.parse(dj).length) {
              // C8-IMP-2 : le message existe déjà → PATCH (from_nom, sujet,
              // texte, brut) au lieu d'ignorer : migration du VRAI expéditeur
              // (le 1er import ne stockait pas l'userId de l'expéditeur).
              var rPatch = await fetch(urlSupabase('emails?message_id=eq.' + encodeURIComponent(mid)), {
                method: 'PATCH',
                headers: Object.assign({}, teteSupa(), { 'Content-Profile': 'agent_sav' }),
                body: JSON.stringify({
                  from_nom: (em.from_nom == null) ? null : String(em.from_nom).substring(0, 300),
                  sujet: String(em.sujet || '').substring(0, 500),
                  texte: String(em.texte || '').substring(0, 100000),
                  brut: (em.brut && typeof em.brut === 'object') ? em.brut : { source: 'respond.io' }
                })
              });
              if (rPatch.ok) ecrits++;
              else erreurs.push(mid + ':patch' + rPatch.status);
              continue;
            }
          }
          var ligne = {
            message_id: mid,
            sens: em.sens === 'sortant' ? 'sortant' : 'entrant',
            from_addr: String(em.from_addr || ''),
            to_addr: String(em.to_addr || ''),
            sujet: String(em.sujet || '').substring(0, 500),
            texte: String(em.texte || '').substring(0, 100000),
            brut: (em.brut && typeof em.brut === 'object') ? em.brut : { source: 'respond.io' },
            recu_a: em.recu_a || new Date().toISOString(),
            lu: em.lu === true
          };
          var rIns2 = await fetch(urlSupabase('emails'), {
            method: 'POST',
            headers: Object.assign({}, teteSupa(), { 'Content-Profile': 'agent_sav', 'Prefer': 'return=minimal' }),
            body: JSON.stringify(ligne)
          });
          if (rIns2.ok) ecrits++;
          else erreurs.push(mid + ':' + rIns2.status);
        } catch (eImp) { erreurs.push(mid + ':' + String(eImp && eImp.message || eImp).substring(0, 100)); }
      }
      return repondre(res, 200, {
        ok: true, brique: 'C8-IMP', mode: 'import',
        recus: corps.importer.length, ecrits: ecrits, ignores: ignores, erreurs: erreurs.slice(0, 10)
      });
    }

    // ---- MODE DEBUG : lister les dossiers IMAP (verification folder envoyes)
    if (u.searchParams.get('dossiers') === '1') {
      var hL = process.env.SMTP_HOST, uL = process.env.SMTP_USER, pL = process.env.SMTP_PASS;
      if (!hL || !uL || !pL) return repondre(res, 500, { ok: false, erreur: 'config SMTP absente' });
      try {
        var imapL = require('../lib/imap');
        var boiteL = await imapL.ouvrirBoite({ host: hL, user: uL, pass: pL });
        var listeL = null;
        try { listeL = await boiteL.api.command('LIST "" "*"'); } finally { try { if (boiteL.api.detruire) boiteL.api.detruire(); } catch (eL) {} }
        return repondre(res, 200, { ok: true, user: uL, list: listeL });
      } catch (eLst) { return repondre(res, 502, { ok: false, erreur: String(eLst && eLst.message || eLst).substring(0, 300) }); }
    }

    // ---- MODE DEBUG C5-ENV-3 : essayer des variantes d'APPEND ------------
    if (u.searchParams.get('debugappend') === '1') {
      var hA = process.env.SMTP_HOST, uA = process.env.SMTP_USER, pA = process.env.SMTP_PASS;
      if (!hA || !uA || !pA) return repondre(res, 500, { ok: false, erreur: 'config SMTP absente' });
      var imapA = require('../lib/imap');
      var msgMini = 'From: test@umob.fr\r\nTo: test@umob.fr\r\nSubject: Test append\r\n\r\nCorps minimal.\r\n';
      var variantes = [
        { nom: 'Sent Items + flags \\Seen', dossier: 'Sent Items', flags: '(\\Seen)' },
        { nom: 'Sent Items sans flags', dossier: 'Sent Items', flags: '' },
        { nom: 'INBOX + flags (controle)', dossier: 'INBOX', flags: '(\\Seen)' },
        { nom: 'Sent Items + flags + date', dossier: 'Sent Items', flags: '(\\Seen) "02-Nov-2026 15:00:00 +0100"' }
      ];
      var resultats = [];
      for (var iv = 0; iv < variantes.length; iv++) {
        var va = variantes[iv];
        var uneLigne = { nom: va.nom, reponse: null };
        try {
          var boiteA = await imapA.ouvrirBoite({ host: hA, user: uA, pass: pA });
          try {
            var tag = 'A9' + iv;
            var nA = Buffer.byteLength(msgMini, 'utf8');
            boiteA.api.ecrireBrut(tag + ' APPEND "' + va.dossier + '" ' + (va.flags ? va.flags + ' ' : '') + '{' + nA + '}\r\n');
            await boiteA.api.attendreContinuation(3000);
            boiteA.api.ecrireBrut(msgMini);
            var rA = await boiteA.api.command('NOOP');
            var mA = new RegExp(tag + ' (OK|NO|BAD)[^\r\n]*').exec(rA);
            uneLigne.reponse = mA ? mA[0] : ('pas de reponse taggee : ' + rA.substring(0, 150));
          } catch (eV) { uneLigne.reponse = 'ERREUR : ' + String((eV && eV.message) || eV).substring(0, 200); }
          finally { try { if (boiteA.api.detruire) boiteA.api.detruire(); } catch (eD2) {} }
        } catch (eBx) { uneLigne.reponse = 'CONNEXION : ' + String((eBx && eBx.message) || eBx).substring(0, 150); }
        resultats.push(uneLigne);
      }
      return repondre(res, 200, { ok: true, variantes: resultats });
    }

    // ---- MODE DEBUG : test APPEND isole (iterations rapides sans envoi SMTP)
    if (u.searchParams.get('appendtest') === '1') {
      var hA = process.env.SMTP_HOST, uA = process.env.SMTP_USER, pA = process.env.SMTP_PASS;
      if (!hA || !uA || !pA) return repondre(res, 500, { ok: false, erreur: 'config SMTP absente' });
      try {
        var imapA = require('../lib/imap');
        var boiteA = await imapA.ouvrirBoite({ host: hA, user: uA, pass: pA });
        var variantes = [];
        var dossierA = u.searchParams.get('folder') || 'Sent Items';
        var msgA = 'From: <test@umob.fr>\r\nSubject: test append\r\n\r\ncorps test\r\n';
        var nA = Buffer.byteLength(msgA, 'utf8');
        try {
          // variante 1 : avec drapeaux (\Seen) ; variante 2 : sans drapeaux
          var cmd1 = 'B901 APPEND "' + dossierA.replace(/(["\\])/g, '\\$1') + '" (\\Seen) {' + nA + '}';
          var cmd2 = 'B902 APPEND "' + dossierA.replace(/(["\\])/g, '\\$1') + '" {' + nA + '}';
          var essais = [cmd1, cmd2];
          for (var iA = 0; iA < essais.length; iA++) {
            var cmd = essais[iA];
            boiteA.api.ecrireBrut(cmd + '\r\n');
            try {
              await boiteA.api.attendreContinuation(3000);
              boiteA.api.ecrireBrut(msgA);
              var rA = await boiteA.api.command('NOOP');
              variantes.push({ cmd: cmd.substring(0, 60), ok: rA.indexOf(cmd.slice(0, 4) + ' OK') !== -1, reponse: rA.substring(0, 250) });
            } catch (eEss) {
              variantes.push({ cmd: cmd.substring(0, 60), ok: false, erreur: String((eEss && eEss.message) || eEss).substring(0, 200), accu: boiteA.api.accu ? boiteA.api.accu() : '' });
            }
          }
        } finally { try { if (boiteA.api.detruire) boiteA.api.detruire(); } catch (eF) {} }
        return repondre(res, 200, { ok: true, dossier: dossierA, variantes: variantes });
      } catch (eAp) { return repondre(res, 502, { ok: false, erreur: String(eAp && eAp.message || eAp).substring(0, 300) }); }
    }

    // ---- MODE DEBUG TEMPORAIRE C5.3b (a retirer) ---------------------------
    var uidDebug = u.searchParams.get('debugraw');
    if (uidDebug) {
      var hD = process.env.SMTP_HOST, uD = process.env.SMTP_USER, pD = process.env.SMTP_PASS;
      if (!hD || !uD || !pD) return repondre(res, 500, { ok: false, erreur: 'config SMTP absente' });
      try { return repondre(res, 200, await debugRaw(uidDebug, uD, pD, hD, { maj: u.searchParams.get('maj') === '1' })); }
      catch (eD) { return repondre(res, 502, { ok: false, erreur: String(eD && eD.message || eD).substring(0, 300) }); }
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

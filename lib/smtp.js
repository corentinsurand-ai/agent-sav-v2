// ============================================================================
// Agent SAV U'mob v2 — C5 : lib/smtp.js — client SMTP minimal zéro dépendance
//
// RÔLE : l'adaptateur canal Email parle DIRECTEMENT au serveur SMTP OVH
// (principe cerveau ≠ canal — aucun LLM ici). Nécessaire car le repo est
// zéro dépendance (pas de nodemailer) : on pilote le protocole SMTP à la
// main sur un socket TLS.
//
// Dialogue implémenté (OVH ssl0.ovh.net) :
//   220 → EHLO → 250 → AUTH LOGIN (b64 user, b64 pass) → 235
//   → MAIL FROM → 250 → RCPT TO → 250 → DATA → 354
//   → message (corps en base64 = zéro dot-stuffing à gérer) → 250
//   → QUIT → 221
//
// Port 465 = TLS direct (défaut) ; port 587 = STARTTLS (EHLO, STARTTLS,
// puis EHLO de nouveau dans le tunnel TLS).
//
// INJECTABLE pour les tests : deps.connexion(opts) → objet
//   { ecrire(txt), lireCode() → {code, lignes[]}, fermer() }
// — les tests branchent un faux serveur, la prod branche tls.connect.
// ============================================================================

var tls = require('tls');
var net = require('net');
var Buffer = tls.Buffer || require('buffer').Buffer;

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

// Sujet encodé encoded-word UTF-8 (accents affichés partout)
function sujetEncode(s) {
  return '=?UTF-8?B?' + b64(s) + '?=';
}

// Corps en base64 découpé en lignes de 76 caractères
function corpsB64(texte) {
  var tout = Buffer.from(String(texte), 'utf8').toString('base64');
  var lignes = [];
  for (var i = 0; i < tout.length; i += 76) lignes.push(tout.slice(i, i + 76));
  return lignes.join('\r\n');
}

// Connexion réelle : TLS direct (465) ou STARTTLS (587)
function connexionReelle(opts) {
  var host = opts.host, port = Number(opts.port) || 465;
  return new Promise(function (res, rej) {
    if (port === 465) {
      var so = tls.connect({ host: host, port: port, rejectUnauthorized: true }, function () {
        res(fabriquerFlux(so));
      });
      so.once('error', rej);
      return;
    }
    // 587 : STARTTLS
    var brut = net.connect({ host: host, port: port }, function () {
      fabriquerFlux(brut).lireCode().then(function (r) {           // 220
        if (r.code !== 220) return rej(new Error('SMTP greeting ' + r.code));
        return fabriquerFlux(brut).ecrire('EHLO plateforme.umob');
      }).then(function () {
        return fabriquerFlux(brut).lireCode();                       // 250
      }).then(function (r) {
        if (r.code !== 250) return rej(new Error('EHLO ' + r.code));
        return fabriquerFlux(brut).ecrire('STARTTLS');
      }).then(function () {
        return fabriquerFlux(brut).lireCode();                       // 220
      }).then(function (r) {
        if (r.code !== 220) return rej(new Error('STARTTLS ' + r.code));
        var securise = tls.connect({ socket: brut, rejectUnauthorized: true }, function () {
          res(fabriquerFlux(securise));
        });
        securise.once('error', rej);
      }).catch(rej);
    });
    brut.once('error', rej);
  });
}

// Fabrique les primitives lireCode/ecrire sur un socket réel
function fabriquerFlux(so) {
  var accumulateur = '', attentes = [];
  so.setEncoding('utf8');
  so.on('data', function (chunk) {
    accumulateur += chunk;
    // une réponse SMTP est terminée par une ligne "NNN " (espace, pas tiret)
    var m = /(?:^|\r?\n)(\d{3}) .*(?:\r?\n)(?!$)/.exec(accumulateur);
    if (m && attentes.length) {
      var brute = accumulateur;
      accumulateur = '';
      var lignes = brute.split(/\r?\n/).filter(function (l) { return l !== ''; });
      var code = parseInt(lignes.length ? lignes[lignes.length - 1].slice(0, 3) : '0', 10);
      var att = attentes.shift();
      att.res({ code: code, lignes: lignes });
    }
  });
  return {
    ecrire: function (txt) {
      return new Promise(function (res) { so.write(txt + '\r\n', res); });
    },
    lireCode: function () {
      return new Promise(function (res, rej) {
        attentes.push({ res: res, rej: rej });
      });
    },
    fermer: function () { try { so.end(); } catch (e) {} }
  };
}

// Envoi complet. opts = {host, port, user, pass, de, a, sujet, texte}
// deps = { connexion } facultatif (tests).
async function envoyerSmtp(opts, deps) {
  var ouvrir = (deps && deps.connexion) || connexionReelle;
  var conn = await ouvrir(opts);
  var journal = [];

  async function attendre(codeAttendu, etape) {
    var r = await conn.lireCode();
    journal.push(etape + ' ' + r.code);
    if (r.code !== codeAttendu) {
      var detail = r.lignes.join(' | ').substring(0, 300);
      try { conn.fermer(); } catch (e) {}
      var err = new Error('SMTP ' + etape + ' a repondu ' + r.code + ' : ' + detail);
      err.codeSmtp = r.code;
      throw err;
    }
    return r;
  }

  await attendre(220, 'greeting');

  await conn.ecrire('EHLO plateforme.umob');
  await attendre(250, 'EHLO');

  if (opts.user && opts.pass) {
    await conn.ecrire('AUTH LOGIN');
    await attendre(334, 'AUTH');
    await conn.ecrire(b64(opts.user));
    await attendre(334, 'USER');
    await conn.ecrire(b64(opts.pass));
    await attendre(235, 'PASS');
  }

  await conn.ecrire('MAIL FROM:<' + opts.de + '>');
  await attendre(250, 'MAIL FROM');

  await conn.ecrire('RCPT TO:<' + opts.a + '>');
  await attendre(250, 'RCPT TO');

  await conn.ecrire('DATA');
  await attendre(354, 'DATA');

  var idMessage = Date.now() + '.' + Math.random().toString(36).slice(2, 10) + '@umob-plateforme';
  var message = [
    'From: <' + opts.de + '>',
    'To: <' + opts.a + '>',
    'Subject: ' + sujetEncode(opts.sujet || ''),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + idMessage + '>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    corpsB64(opts.texte)
  ].join('\r\n');
  await conn.ecrire(message + '\r\n.');
  await attendre(250, 'CORPS');

  await conn.ecrire('QUIT');
  try { await attendre(221, 'QUIT'); } catch (e) { /* certains serveurs coupent après QUIT */ }
  conn.fermer();

  return { ok: true, message_id: idMessage, journal: journal };
}

module.exports = { envoyerSmtp: envoyerSmtp, b64: b64, sujetEncode: sujetEncode, corpsB64: corpsB64 };

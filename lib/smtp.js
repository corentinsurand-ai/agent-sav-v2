// ============================================================================
// Agent SAV U'mob v2 — C5 : lib/smtp.js — client SMTP minimal zéro dépendance
//
// RÔLE : l'adaptateur canal Email parle DIRECTEMENT au serveur SMTP OVH
// (principe cerveau ≠ canal — aucun LLM ici). Nécessaire car le repo est
// zéro dépendance (pas de nodemailer) : on pilote le protocole SMTP à la
// main sur un socket TLS.
//
// Dialogue implémenté (OVH ex3.mail.ovh.net Email Pro) :
//   220 → EHLO → 250 → AUTH LOGIN (b64 user, b64 pass) → 235
//   → MAIL FROM → 250 → RCPT TO → 250 → DATA → 354
//   → message (corps en base64 = zéro dot-stuffing à gérer) → 250
//   → QUIT → 221
//
// Port 465 = TLS direct ; port 587 = STARTTLS (EHLO, STARTTLS, puis EHLO
// de nouveau dans le tunnel TLS).
//
// LEÇON V1 (incident réel 30/10, envoi qui pendait) : un vrai serveur SMTP
// livre la bannière EN UN SEUL CHUNK terminé par \r\n — le détecteur de fin
// ne doit PAS exiger un caractère après la ligne ; une ligne « NNN ␣ »
// suffira. Et UN SEUL écouteur data par socket (jamais de fabriquerFlux
// en cascade). Garde-fou : chaque lecture a un délai max (DELAI_MS).
//
// INJECTABLE pour les tests : deps.connexion(opts) → objet
//   { ecrire(txt), lireCode() → {code, lignes[]}, fermer() }
// ============================================================================

var tls = require('tls');
var net = require('net');
var Buffer = tls.Buffer || require('buffer').Buffer;

var DELAI_MS = 20000;   // une étape SMTP sans réponse sous 20 s → échec net

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

// Fabrique les primitives lireCode/ecrire sur UN socket (un seul écouteur).
// Une réponse SMTP est terminée par une ligne « NNN ␣... » (espace, pas
// tiret) — le chunk peut très bien s'arrêter juste après son \r\n.
function fluxDe(so) {
  var accumulateur = '', attente = null;

  function tenterLivraison() {
    if (!attente) return;
    // cherche la PREMIÈRE ligne finale « NNN espace » depuis le début
    var m = /(?:^|\r?\n)(\d{3}) [^\r\n]*\r?\n/.exec(accumulateur);
    if (!m) return;
    var consomme = m.index + m[0].length;
    var brute = accumulateur.slice(0, consomme);
    accumulateur = accumulateur.slice(consomme);
    var lignes = brute.split(/\r?\n/).filter(function (l) { return l !== ''; });
    var code = parseInt(lignes[lignes.length - 1].slice(0, 3), 10);
    var a = attente; attente = null;
    clearTimeout(a.minuteur);
    a.res({ code: code, lignes: lignes });
  }

  so.setEncoding('utf8');
  so.on('data', function (chunk) {
    accumulateur += chunk;
    tenterLivraison();
  });

  return {
    ecrire: function (txt) {
      return new Promise(function (res) { so.write(txt + '\r\n', res); });
    },
    lireCode: function () {
      if (attente) return Promise.reject(new Error('SMTP : lecture deja en cours'));
      return new Promise(function (res, rej) {
        attente = {
          res: res,
          rej: rej,
          minuteur: setTimeout(function () {
            var a = attente; attente = null;
            try { so.destroy(); } catch (e) {}
            a.rej(new Error('SMTP : pas de reponse sous ' + DELAI_MS + ' ms'));
          }, DELAI_MS)
        };
        tenterLivraison();   // la réponse est peut-être déjà arrivée
      });
    },
    detacher: function () { try { so.removeAllListeners('data'); } catch (e) {} },
    fermer: function () { try { so.end(); } catch (e) {} }
  };
}

function attendreSocket(creer) {
  return new Promise(function (res, rej) {
    var s = creer(function () { res(s); });
    s.once('error', rej);
  });
}

// Connexion réelle : TLS direct (465) ou STARTTLS (587)
async function connexionReelle(opts) {
  var host = opts.host, port = Number(opts.port) || 465;

  if (port === 465) {
    var securise = await attendreSocket(function (ok) {
      return tls.connect({ host: host, port: port, rejectUnauthorized: true }, ok);
    });
    return fluxDe(securise);
  }

  // 587 : STARTTLS — un SEUL flux sur le socket brut, détaché avant l'upgrade
  var brut = await attendreSocket(function (ok) {
    return net.connect({ host: host, port: port }, ok);
  });
  var f = fluxDe(brut);

  var salut = await f.lireCode();                       // 220
  if (salut.code !== 220) throw new Error('SMTP greeting ' + salut.code);
  await f.ecrire('EHLO plateforme.umob');
  var ehlo = await f.lireCode();                       // 250
  if (ehlo.code !== 250) throw new Error('EHLO ' + ehlo.code);
  await f.ecrire('STARTTLS');
  var st = await f.lireCode();                         // 220
  if (st.code !== 220) throw new Error('STARTTLS ' + st.code);
  f.detacher();

  var tunnel = await attendreSocket(function (ok) {
    return tls.connect({ socket: brut, rejectUnauthorized: true }, ok);
  });
  var fTls = fluxDe(tunnel);
  // EHLO de nouveau dans le tunnel TLS — la connexion rendue est PRÊTE pour AUTH
  await fTls.ecrire('EHLO plateforme.umob');
  var ehlo2 = await fTls.lireCode();
  if (ehlo2.code !== 250) throw new Error('EHLO (apres STARTTLS) ' + ehlo2.code);
  fTls.dejaSalue = true;
  return fTls;
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

  if (!conn.dejaSalue) {           // 587/STARTTLS : greeting + EHLO déjà faits
    await attendre(220, 'greeting');
    await conn.ecrire('EHLO plateforme.umob');
    await attendre(250, 'EHLO');
  }

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

module.exports = { envoyerSmtp: envoyerSmtp, b64: b64, sujetEncode: sujetEncode, corpsB64: corpsB64, fluxDe: fluxDe, DELAI_MS: DELAI_MS };

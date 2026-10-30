// ============================================================================
// Agent SAV U'mob v2 — C5.2 : lib/mail.js — parseur MIME minimal zéro dépendance
//
// RÔLE : transformer un message RFC822 brut (littéral IMAP) en champs métier
// {from_addr, from_nom, sujet, texte, message_id, date}. Gère : en-têtes
// repliés, encoded-words (=?UTF-8?B/Q?...?=), base64 (décodeur MAISON utf8,
// aucun atob/Buffer requis — marche partout), quoted-printable, multipart
// (text/plain prioritaire, repli html détagé).
// ============================================================================

function decoderB64(s) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  s = String(s).replace(/[^A-Za-z0-9+/=]/g, '').replace(/=+$/, '');
  var out = [], n = 0, bits = 0, i;
  for (i = 0; i < s.length; i++) {
    var v = chars.indexOf(s[i]);
    if (v === -1) continue;
    n = (n << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((n >> bits) & 0xFF); }
  }
  var bytes = new Uint8Array(out);
  var res = '', j = 0;
  while (j < bytes.length) {
    var b = bytes[j];
    if (b < 0x80) { res += String.fromCharCode(b); j += 1; }
    else if (b < 0xE0) { res += String.fromCharCode(((b & 0x1F) << 6) | (bytes[j + 1] & 0x3F)); j += 2; }
    else if (b < 0xF0) { res += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[j + 1] & 0x3F) << 6) | (bytes[j + 2] & 0x3F)); j += 3; }
    else {
      var cp = ((b & 0x07) << 18) | ((bytes[j + 1] & 0x3F) << 12) | ((bytes[j + 2] & 0x3F) << 6) | (bytes[j + 3] & 0x3F);
      cp -= 0x10000;
      res += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); j += 4;
    }
  }
  return res;
}

function decoderQ(v) {
  return String(v).replace(/=([0-9A-F]{2})/gi, function (_, h) {
    return String.fromCharCode(parseInt(h, 16));
  }).replace(/=\r?\n/g, '');
}

// Les octets Q (un code par char <= 0xFF) forment de l'UTF-8 : on le redécode.
function utf8DeOctets(s) {
  var octets = [];
  for (var i = 0; i < s.length; i++) octets.push(s.charCodeAt(i) & 0xFF);
  var bytes = new Uint8Array(octets), res = '', j = 0;
  while (j < bytes.length) {
    var b = bytes[j];
    if (b < 0x80) { res += String.fromCharCode(b); j += 1; }
    else if (b < 0xE0) { res += String.fromCharCode(((b & 0x1F) << 6) | (bytes[j + 1] & 0x3F)); j += 2; }
    else if (b < 0xF0) { res += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[j + 1] & 0x3F) << 6) | (bytes[j + 2] & 0x3F)); j += 3; }
    else {
      var cp = ((b & 0x07) << 18) | ((bytes[j + 1] & 0x3F) << 12) | ((bytes[j + 2] & 0x3F) << 6) | (bytes[j + 3] & 0x3F);
      cp -= 0x10000;
      res += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)); j += 4;
    }
  }
  return res;
}

function decoderMot(s) {
  return String(s).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, function (_, cs, mode, donnees) {
    if (mode.toUpperCase() === 'B') {
      try { return decoderB64(donnees); } catch (e) { return donnees; }
    }
    return utf8DeOctets(decoderQ(donnees.replace(/_/g, ' ')));
  });
}

function parseMessage(brut) {
  brut = String(brut || '');
  var idx = brut.indexOf('\r\n\r\n'), sep = '\r\n\r\n';
  if (idx === -1) { idx = brut.indexOf('\n\n'); sep = '\n\n'; }
  var tete = idx !== -1 ? brut.slice(0, idx) : brut;
  var corps = idx !== -1 ? brut.slice(idx + sep.length) : '';

  var d = {};
  tete.split(/\r?\n/).forEach(function (l) {
    if (/^\s/.test(l)) { var ks = Object.keys(d); if (ks.length) d[ks[ks.length - 1]] += ' ' + l.trim(); return; }
    var j = l.indexOf(':'); if (j === -1) return;
    d[l.slice(0, j).trim().toLowerCase()] = l.slice(j + 1).trim();
  });

  var from = d['from'] || '';
  var mFrom = /<([^>]+)>/.exec(from);
  var from_addr = (mFrom ? mFrom[1] : from).trim();
  var from_nom = decoderMot(mFrom ? from.slice(0, mFrom.index).trim().replace(/^"|"$/g, '') : '');
  var sujet = decoderMot(d['subject'] || '');
  var message_id = (d['message-id'] || '').replace(/[<>]/g, '').trim() || null;
  var date = d['date'] || null;

  function decoderPartie(contenu, encodage) {
    if (encodage === 'base64') {
      try { return decoderB64(contenu); } catch (e) { return contenu; }
    }
    if (encodage === 'quoted-printable') return utf8DeOctets(decoderQ(contenu));
    return contenu;
  }

  var texte = '';
  var mBord = /boundary="?([^";\r\n]+)"?/i.exec(d['content-type'] || '');
  var cte = (d['content-transfer-encoding'] || '').toLowerCase();
  if (mBord) {
    var bord = '--' + mBord[1];
    var parts = corps.split(bord);
    var texteHtml = '';
    parts.forEach(function (p) {
      p = p.replace(/^\r?\n/, '');
      if (!p || p.indexOf('--') === 0) return;
      var finTete = p.indexOf('\r\n\r\n');
      var cut = finTete !== -1 ? [finTete, 4] : [p.indexOf('\n\n'), 2];
      var ptete = cut[0] !== -1 ? p.slice(0, cut[0]) : '';
      var pcorps = cut[0] !== -1 ? p.slice(cut[0] + cut[1]) : p;
      var pct = /content-type:\s*([^;\r\n]+)/i.exec(ptete);
      var pcte = /content-transfer-encoding:\s*([^\r\n]+)/i.exec(ptete);
      var encodage = (pcte ? pcte[1] : '').trim().toLowerCase();
      var type = (pct ? pct[1] : 'text/plain').toLowerCase();
      if (type.indexOf('text/plain') !== -1 && !texte) texte = decoderPartie(pcorps, encodage).trim();
      if (type.indexOf('text/html') !== -1 && !texteHtml) texteHtml = decoderPartie(pcorps, encodage);
    });
    if (!texte && texteHtml) texte = texteHtml.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  } else {
    texte = decoderPartie(corps, cte).trim();
    if (((d['content-type'] || '').toLowerCase().indexOf('text/html') !== -1)) {
      texte = texte.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  return { from_addr: from_addr, from_nom: from_nom, sujet: sujet,
           texte: texte.substring(0, 20000), message_id: message_id, date: date };
}

module.exports = { parseMessage: parseMessage, decoderB64: decoderB64, decoderQ: decoderQ, decoderMot: decoderMot };

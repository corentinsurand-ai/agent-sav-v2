// ============================================================================
// Agent SAV U'mob v2 — C5.2 : lib/imap.js — client IMAP minimal zéro dépendance
//
// RÔLE : l'adaptateur canal Email LIT la boîte OVH (ex3.mail.ovh.net:993,
// TLS) pour ramener les nouveaux emails clients (polling cron ~2 min).
//
// Protocole (le strict minimum) :
//   LOGIN user pass -> SELECT INBOX -> UID SEARCH UID <dernier+1>:*
//   -> UID FETCH <uid> (BODY.PEEK[]) -> LOGOUT
//
// EXIGENCE D'EXACTITUDE : les littéraux IMAP comptent des OCTETS — on
// accumule donc des BUFFERS (pas de setEncoding utf8 : les accents
// décaleraient les longueurs). Chaque littéral est inliné dans la réponse
// texte sous un marqueur LIT ouvrant/fermant (contenu décodé utf8) : le test
// et le prod parlent le même format.
//
// INJECTABLE pour les tests : deps.connexion(opts) -> { command(cmd) -> texte, fermer() }.
// ============================================================================

var tls = require('tls');

var DELAI_MS = 7000;   // Vercel Hobby = 10 s max : délai serré, réessai au cron suivant

// Extrait d'un accumulateur BUFFER la réponse complète d'une commande taguée.
// Renvoie { texte, consommation } (littéraux inlinés) ou null si incomplète.
// Les littéraux sont sautés OCTET par OCTET : un faux "A5 OK" dans le corps
// d'un email NE TERMINE PAS la commande.
function extraireReponse(acc, tag) {
  var morceaux = [], i = 0;
  while (i < acc.length) {
    var finLigne = acc.indexOf(10, i);
    if (finLigne === -1) return null;
    var ligne = acc.slice(i, finLigne + 1).toString('latin1');
    var m = /\{(\d+)\}\r?\n$/.exec(ligne);
    if (m) {
      var n = parseInt(m[1], 10);
      if (acc.length < finLigne + 1 + n) return null;
      morceaux.push(ligne, '<LIT>' + acc.slice(finLigne + 1, finLigne + 1 + n).toString('utf8') + '</LIT>');
      i = finLigne + 1 + n;
      continue;
    }
    if (ligne.indexOf(tag + ' ') === 0) {
      morceaux.push(ligne);
      return { texte: morceaux.join(''), consommation: finLigne + 1 };
    }
    morceaux.push(ligne);
    i = finLigne + 1;
  }
  return null;
}

function connexionReelle(opts) {
  return new Promise(function (res, rej) {
    var so = tls.connect({ host: opts.host, port: 993, rejectUnauthorized: true }, function () {
      var accumulateur = Buffer.alloc(0), compteur = 0, enCours = null;

      so.on('data', function (chunk) {
        accumulateur = Buffer.concat([accumulateur, chunk]);
        if (!enCours) return;
        var fin = extraireReponse(accumulateur, enCours.tag);
        if (fin !== null) {
          accumulateur = accumulateur.slice(fin.consommation);
          var a = enCours; enCours = null;
          clearTimeout(a.minuteur);
          a.res(fin.texte);
        }
      });

      res({
        command: function (cmd) {
          if (enCours) return Promise.reject(new Error('IMAP : commande deja en cours'));
          compteur++;
          var tag = 'A' + compteur;
          return new Promise(function (res2, rej2) {
            enCours = {
              tag: tag,
              res: res2,
              minuteur: setTimeout(function () {
                var a = enCours; enCours = null;
                try { so.destroy(); } catch (e) {}
                a.rej(new Error('IMAP : pas de reponse sous ' + DELAI_MS + ' ms (' + cmd + ')'));
              }, DELAI_MS)
            };
            so.write(tag + ' ' + cmd + '\r\n');
          });
        },
        fermer: function () { try { so.end(); } catch (e) {} }
      });
    });
    so.once('error', rej);
  });
}

function estOk(reponse, tag) {
  return new RegExp('\\b' + tag + ' OK', 'm').test(reponse);
}

function uidsDeRecherche(reponse) {
  var m = /\* SEARCH ([^\r\n]*)/.exec(reponse);
  if (!m) return [];
  return m[1].trim().split(/\s+/).filter(Boolean).map(Number);
}

function litteralFetch(reponse) {
  var m = /<LIT>([\s\S]*?)<\/LIT>/.exec(reponse);
  return m ? m[1] : null;
}

async function ouvrirBoite(opts, deps) {
  var ouvrir = (deps && deps.connexion) || connexionReelle;
  var api = await ouvrir(opts);

  var echapper = function (s) { return String(s).replace(/(["\\])/g, '\\$1'); };
  var r1 = await api.command('LOGIN "' + echapper(opts.user) + '" "' + echapper(opts.pass) + '"');
  if (!estOk(r1, 'A1')) {
    var refus = r1.split('\n').filter(function (l) { return / NO| BAD/.test(l.slice(0, 4)); }).join(' ');
    try { api.fermer(); } catch (e) {}
    throw new Error('IMAP LOGIN refuse : ' + refus.substring(0, 200));
  }
  var r2 = await api.command('SELECT INBOX');
  if (!estOk(r2, 'A2')) throw new Error('IMAP SELECT INBOX refuse');

  return {
    // Uids > dernierUid, tri croissant, plafonnés à max (l'API renvoie
    // toujours le dernier message avec n:* -> on filtre).
    chercherNouveaux: async function (dernierUid, max) {
      var r = await api.command('UID SEARCH UID ' + (dernierUid + 1) + ':*');
      var uids = uidsDeRecherche(r).filter(function (u) { return u > dernierUid; });
      uids.sort(function (a, b) { return a - b; });
      return uids.slice(0, max || 20);
    },
    // Message brut (RFC822) pour un UID, SANS marquer comme lu (BODY.PEEK)
    lireMessage: async function (uid) {
      var r = await api.command('UID FETCH ' + uid + ' (BODY.PEEK[])');
      return litteralFetch(r) || '';
    },
    finir: async function () {
      try { await api.command('LOGOUT'); } catch (e) {}
      api.fermer();
    },
    api: api
  };
}

module.exports = { ouvrirBoite: ouvrirBoite, extraireReponse: extraireReponse, uidsDeRecherche: uidsDeRecherche, litteralFetch: litteralFetch, estOk: estOk };

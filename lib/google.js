// ============================================================================
// Agent SAV U'mob v2 — B2.2 : adaptateur Google Sheets (LECTURE SEULE)
//
// RÔLE (et SEUL rôle) : lire le Google Sheet « Infos Service Client » via
// l'API Sheets v4, avec un COMPTE DE SERVICE Google (décision Corentin 22/10 :
// synchro automatique). C'est la seule couche autorisée à parler à Google.
//
// Authentification : JWT RS256 signé avec la clé privée du compte de service
// (portage du flux OAuth2 standard « service account »), échangé contre un
// access token Google. Scope : spreadsheets.readonly — l'agent ne peut JAMAIS
// modifier le Sheet, seulement le lire.
//
// Les identifiants (GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY) vivent
// UNIQUEMENT dans les variables d'environnement Vercel — jamais dans le code,
// jamais sur GitHub.
// ============================================================================

var crypto = require('crypto');

var TOKEN_URL = 'https://oauth2.googleapis.com/token';
var SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
var SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

function env(nom) { return process.env[nom] || ''; }

// La clé privée du JSON Google arrive soit avec de vrais retours à la ligne,
// soit avec les séquences littérales « \n » (copiées depuis le JSON) :
// les deux sont acceptées.
function clePriveePropre() {
  return env('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n').trim();
}

// Base64url sans remplissage (format JWT)
function b64url(chaine) {
  return Buffer.from(chaine, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Assertion JWT RS256 (header.claims signé SHA-256 avec la clé privée)
function construireJwt(clientEmail) {
  var enTete = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  var maintenant = Math.floor(Date.now() / 1000);
  var claims = b64url(JSON.stringify({
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: maintenant,
    exp: maintenant + 3600          // 1 h : durée standard des jetons Google
  }));
  var signataire = crypto.createSign('RSA-SHA256');
  signataire.update(enTete + '.' + claims);
  var signature = signateurOk(signataire.sign(clePriveePropre()));
  return enTete + '.' + claims + '.' + signature;
}

// Buffer → base64url
function signateurOk(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Cache du jeton pour l'instance serveur (une même instance Vercel traite
// plusieurs exécutions) — le premier appel déclenche l'échange, les appels
// PARALLÈLES attendent la MÊME promesse (mémo), jamais rééchangé tant que
// valide ; en cas d'échec le cache est vidé pour permettre une nouvelle
// tentative au prochain appel.
var _jeton = { promesse: null, expire: 0, enCours: false };

async function obtenirJeton() {
  var clientEmail = env('GOOGLE_CLIENT_EMAIL');
  if (!clientEmail || !clePriveePropre()) {
    throw new Error('GOOGLE_CLIENT_EMAIL ou GOOGLE_PRIVATE_KEY manquant — configurez le compte de service Google dans les variables d\'environnement Vercel');
  }
  if (_jeton.enCours && _jeton.promesse) return _jeton.promesse;      // échange en vol
  if (_jeton.promesse && Date.now() < _jeton.expire) return _jeton.promesse; // encore valide
  _jeton.enCours = true;
  _jeton.promesse = demanderJeton(clientEmail).then(function(tok) {
    _jeton.enCours = false;
    return tok;
  }, function(err) {
    _jeton.enCours = false;
    _jeton.promesse = null;
    throw err;
  });
  return _jeton.promesse;
}

async function demanderJeton(clientEmail) {
  var res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=' +
      encodeURIComponent(construireJwt(clientEmail))
  });
  var texte = '';
  try { texte = await res.text(); } catch (e) { texte = ''; }
  if (res.status >= 400) {
    throw new Error('Google token ' + res.status + ' : ' + texte.substring(0, 200));
  }
  var corps = JSON.parse(texte);
  if (!corps.access_token) {
    throw new Error('Google token : réponse sans access_token');
  }
  _jeton.expire = Date.now() + ((corps.expires_in || 3600) * 1000) - 60000; // marge 1 min
  return corps.access_token;
}

// Lecture d'une plage (notation A1 : « 'Onglet'!1:10 », « 'Onglet'!D:D »…).
// Renvoie values (tableau de lignes) — [] si vide.
async function lirePlage(sheetId, plage) {
  var jeton = await obtenirJeton();
  var url = SHEETS_API + encodeURIComponent(sheetId) + '/values/' + encodeURIComponent(plage);
  var res = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + jeton }
  });
  var texte = '';
  try { texte = await res.text(); } catch (e) { texte = ''; }
  if (res.status >= 400) {
    throw new Error('Google Sheets ' + res.status + ' (' + plage + ') : ' + texte.substring(0, 200));
  }
  var corps = texte ? JSON.parse(texte) : null;
  return (corps && corps.values) ? corps.values : [];
}

// Pour les tests : réinitialiser le cache de jeton
function reinitialiserCache() {
  _jeton = { promesse: null, expire: 0, enCours: false };
}

module.exports = {
  obtenirJeton: obtenirJeton,
  lirePlage: lirePlage,
  reinitialiserCache: reinitialiserCache
};

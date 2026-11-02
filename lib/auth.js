// ============================================================================
// Agent SAV U'mob v2 — C6-AUTH : lib/auth.js — authentification équipe
//
// RÔLE : les briques de l'authentification des collaborateurs U'mob sur la
// plateforme maison (C1) — ZÉRO dépendance (node:crypto uniquement, fidèle au
// style du repo) :
//
//   - hacherMotDePasse(mdp)           → 'scrypt$<sel hex>$<hash hex>'
//       scrypt (sel aléatoire 16 octets, N=16384, clé 32 octets). Le sel est
//       DANS la chaîne stockée : aucune colonne sel séparée.
//   - verifierMotDePasse(mdp, stocke) → true/false
//       comparaison timingSafeEqual — un hash absent/malformé = false, jamais
//       d'exception (une ligne corrompue ne fait pas tomber la route).
//   - creerJeton(utilisateur, secret, dureeMs) → 'b64url(JSON).b64url(HMAC)'
//       jeton signé HMAC-SHA256 (pas de lib JWT) : payload lisible {id, email,
//       nom, role, exp} + signature. Défaut durée 12 h.
//   - lireJeton(jeton, secret)        → payload | null
//       null si malformé, signature invalide (tamper) ou expiré.
//
// Le secret de signature : AUTH_SECRET si défini, SINON repli WEBHOOK_SECRET
// (le jeton change de signature si le secret change = sessions invalidées).
// ============================================================================

var cryptoReel = require('crypto');

var SCRYPT_N = 16384;   // 2^14 — standard OWASP
var SCRYPT_R = 8;
var SCRYPT_Taille = 32; // 32 octets de hash

function b64urlDe(tampon) {
  return Buffer.from(tampon).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function tamponDeB64url(s) {
  var b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Buffer.from(b64, 'base64');
}

// --- Mot de passe : hacher / vérifier ---------------------------------------

function hacherMotDePasse(mdp, deps) {
  var crypto = (deps && deps.crypto) || cryptoReel;
  var sel = crypto.randomBytes(16);
  var hash = crypto.scryptSync(String(mdp || ''), sel, SCRYPT_Taille, { N: SCRYPT_N, r: SCRYPT_R });
  return 'scrypt$' + sel.toString('hex') + '$' + hash.toString('hex');
}

function verifierMotDePasse(mdp, stocke, deps) {
  var crypto = (deps && deps.crypto) || cryptoReel;
  try {
    var parties = String(stocke || '').split('$');
    if (parties.length !== 3 || parties[0] !== 'scrypt') return false;
    var sel = Buffer.from(parties[1], 'hex');
    var attendu = Buffer.from(parties[2], 'hex');
    if (!attendu.length) return false;
    var calcule = crypto.scryptSync(String(mdp || ''), sel, attendu.length, { N: SCRYPT_N, r: SCRYPT_R });
    return crypto.timingSafeEqual(calcule, attendu);
  } catch (e) {
    return false; // hash malformé/ancien format → refus silencieux
  }
}

// --- Jeton signé HMAC (session collaborateur) -------------------------------

function creerJeton(utilisateur, secret, dureeMs, deps) {
  var crypto = (deps && deps.crypto) || cryptoReel;
  var cle = String(secret || '');
  if (!cle) throw new Error('secret de signature manquant');
  var duree = typeof dureeMs === 'number' ? dureeMs : 12 * 60 * 60 * 1000;
  var payload = {
    id: String((utilisateur && utilisateur.id) || ''),
    email: String((utilisateur && utilisateur.email) || ''),
    nom: String((utilisateur && utilisateur.nom) || ''),
    role: String((utilisateur && utilisateur.role) || 'collaborateur'),
    exp: Date.now() + duree
  };
  var corps = b64urlDe(JSON.stringify(payload));
  var sig = b64urlDe(crypto.createHmac('sha256', cle).update(corps).digest());
  return corps + '.' + sig;
}

function lireJeton(jeton, secret, deps) {
  var crypto = (deps && deps.crypto) || cryptoReel;
  try {
    var cle = String(secret || '');
    if (!cle) return null;
    var parties = String(jeton || '').split('.');
    if (parties.length !== 2) return null;
    var attendu = crypto.createHmac('sha256', cle).update(parties[0]).digest();
    var donne = tamponDeB64url(parties[1]);
    if (donne.length !== attendu.length || !crypto.timingSafeEqual(donne, attendu)) return null;
    var payload = JSON.parse(tamponDeB64url(parties[0]).toString('utf8'));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// Le secret de signature : AUTH_SECRET (recommandé) sinon WEBHOOK_SECRET.
function secretSignature() {
  return process.env.AUTH_SECRET || process.env.WEBHOOK_SECRET || '';
}

module.exports = {
  hacherMotDePasse: hacherMotDePasse,
  verifierMotDePasse: verifierMotDePasse,
  creerJeton: creerJeton,
  lireJeton: lireJeton,
  secretSignature: secretSignature
};

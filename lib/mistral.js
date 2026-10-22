// ============================================================================
// Agent SAV U'mob v2 — B3.2 : adaptateur Mistral (le SEUL module qui parle à
// api.mistral.ai)
//
// RÔLE (architecture v1.1 §3.3) : le cerveau (lib/cerveau.js) est du Node PUR
// — il construit la requête et parse la réponse. Le réseau Mistral vit ICI
// et ici seulement. Le jour où on change de fournisseur modèle, on ne
// réécrit que ce fichier.
//
// Conventions portées du prod (v136 requeteHTTP) :
//   - erreur si code >= 400, 200 premiers caractères du corps
//   - retry borné (2 re-essais) sur les coupures TRANSITOIRES uniquement
//     (502/503/504/529 + erreurs réseau) — jamais sur 401/429/400
//   - response_format json_object : le cerveau rend TOUJOURS du JSON
//
// La clé (MISTRAL_API_KEY) vit UNIQUEMENT dans les variables d'environnement
// Vercel — jamais dans le code, jamais sur GitHub, jamais dans le chat.
// ============================================================================

var MISTRAL_API = 'https://api.mistral.ai/v1/chat/completions';
var TRANSITOIRES = [502, 503, 504, 529];   // leçon de l'ancien système (piège §8)
var MODELE_DEFAUT = 'mistral-large-latest'; // décision Corentin 22/10 : le meilleur

function env(nom) { return process.env[nom] || ''; }

// Un appel nu — jamais appelé directement hors de ce fichier.
// B6.4 — options.texteLibre : PAS de response_format (mode question interne,
// réponse en texte brut — v2.20.76). Par défaut : JSON strict, comme avant.
async function unAppel(messages, options) {
  var corps = {
    model: options.modele || MODELE_DEFAUT,
    messages: messages,
    temperature: (typeof options.temperature === 'number') ? options.temperature : 0.3,
    max_tokens: options.max_tokens || 900
  };
  if (!options.texteLibre) corps.response_format = { type: 'json_object' };
  var res = await fetch(MISTRAL_API, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env('MISTRAL_API_KEY'),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(corps)
  });
  var texte = '';
  try { texte = await res.text(); } catch (e) { texte = ''; }
  return { statut: res.status, corps: texte };
}

// Appel Mistral avec retry borné (2 re-essais) sur coupures transitoires.
// Renvoie { texte, modele, usage } ou throw avec le statut et l'extrait.
async function appelMistral(messages, options) {
  options = options || {};
  if (!env('MISTRAL_API_KEY')) {
    throw new Error('MISTRAL_API_KEY absente — à ajouter dans Vercel (Settings → Environment Variables)');
  }
  var essaisMax = 1 + (typeof options.reEssais === 'number' ? options.reEssais : 2); // 1 + 2 par défaut
  var dernier = { statut: 0, corps: '' };
  for (var i = 0; i < essaisMax; i++) {
    var r;
    try {
      r = await unAppel(messages, options);
    } catch (e) {
      dernier = { statut: 0, corps: String((e && e.message) || e) };
      continue; // erreur réseau pure → transitoire → re-essai
    }
    if (r.statut >= 400) {
      dernier = r;
      if (TRANSITOIRES.indexOf(r.statut) === -1) break; // 401/429/400… : pas de re-essai
      continue; // 502/503/504/529 → re-essai
    }
    var d = {};
    try { d = JSON.parse(r.corps || '{}'); } catch (e) { d = {}; }
    var contenu = (d.choices && d.choices[0] && d.choices[0].message) ? String(d.choices[0].message.content || '') : '';
    return { texte: contenu, modele: d.model || MODELE_DEFAUT, usage: d.usage || null };
  }
  throw new Error('Mistral ' + dernier.statut + ' : ' + String(dernier.corps || '').substring(0, 200));
}

module.exports = { appelMistral: appelMistral };

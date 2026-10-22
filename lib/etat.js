// ============================================================================
// Agent SAV U'mob v2 — B3.1 : état structuré du dossier (le formulaire)
//
// RÔLE (cahier des charges v1 §6, architecture v1.1 §3.2 étape 3) :
// la conversation tient un FORMULAIRE. Une info fournie une fois y est
// enregistrée pour toujours → redemander une info déjà donnée (la faute n°1
// de l'ancien agent) devient IMPOSSIBLE PAR CONSTRUCTION, sans contrôle.
//
// Ce module est du Node PUR (architecture §3.3) : aucun réseau, aucune
// connaissance de respond.io ni de Google. Les normalisations téléphone et
// plaque sont des portages IDENTIQUES de lib/clients.js (prod v136),
// dupliqués volontairement ici pour ne dépendre d'aucun adaptateur.
//
// Ce qui est DÉTERMINISTE ici (lisible par du code, sans loterie) :
//   - plaques d'immatriculation (regex, canonique AA123BB)
//   - téléphones (regex, canonique 336…)
//   - photos / messages vocaux reçus
//   - « une minute / je regarde » → le client va chercher une info (règle 3)
//   - détection push campagne (portage v124 : vocabulaire campagne ET PAS de
//     signature « Agent IA U'mob »)
//   - signaux fiche respond.io (tags « Prise de main », « Demande
//     Commerciale ») et table agent_sav.clients (enseigne, plaques flotte,
//     statut risque)
// Ce qui reste au CERVEAU (B3.2, sémantique) : panne, jours de fermeture,
// étape de conversation, récapitulatif. Le cerveau propose, ce formulaire
// garde la vérité du dossier.
//
// Les messages attendus sont la forme NORMALISÉE de B2.1 (lib/contexte.js,
// triés du plus ancien au plus récent par trierMessages) :
//   { texte, media, type_media, sortant, humain }
// ============================================================================

// --- Portages identiques lib/clients.js (prod v136) -------------------------
function normaliserTelephone(s) {
  var d = String(s || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.slice(0, 4) === '0033') return '33' + d.slice(4);
  if (d.charAt(0) === '0' && d.length === 10) return '33' + d.slice(1);
  if (d.length === 9 && (d.charAt(0) === '6' || d.charAt(0) === '7')) return '33' + d;
  return d;
}

function normaliserImmat(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Apostrophes typographiques → ASCII (les clients WhatsApp écrivent « c'est »)
function normaliserApostrophes(s) {
  return String(s || '').replace(/[\u2018\u2019]/g, "'");
}

// ----------------------------------------------------------------------------
// Formulaire vierge — UNE copie par dossier (persistée dans dossiers.etat jsonb)
// ----------------------------------------------------------------------------
function etatVierge() {
  return {
    etape: 1,                  // étape de conversation 1-6 (mise à jour par le cerveau B3.2)
    plaques: [],               // canonique AA123BB — JAMAIS redemandées (règle 1)
    panne: '',                 // description du problème (cerveau B3.2)
    photos: false,             // photos reçues
    vocal_recu: false,         // message vocal reçu (règle 5)
    telephone_contact: '',     // personne à contacter le jour J (canonique 336…)
    telephones_connus: [],     // tous les numéros vus dans la conversation
    jours_fermeture: '',       // (cerveau B3.2)
    client_cherche_info: false,// « une minute » → ACCUEILLIR ET ATTENDRE, jamais relancer (règle 3)
    campagne_push: false,      // le dernier entrant répond à un push (portage v124)
    demande_commerciale: false,// signal prix/achat/location → équipe commerciale (§4)
    prise_de_main: false,      // tag « Prise de main » → l'agent se tait jusqu'à reprise
    enseigne: '',              // table clients
    statut_risque: '',         // table clients (ex. « Impaye » → réponse neutre + transfert)
    nom: '',                   // fiche respond.io
    dernier_sortant: ''        // texte du dernier message sortant (détection push / demande tél)
  };
}

// Canonique AA123BB → lisible GG-798-NL (pour les récapitulatifs)
function formaterPlaque(p) {
  var c = normaliserImmat(p);
  return c.length === 7 ? c.slice(0, 2) + '-' + c.slice(2, 5) + '-' + c.slice(5) : c;
}

// ----------------------------------------------------------------------------
// Extraction PLAQUES — format français AA-123-BB (2009, flotte U'mob), toutes
// séparateurs tolérés (aa-123-bb, gg798nl, GJ 337 WF), casse indifférente.
// Mots de 2 lettres interdits en première/dernière position (anti « et 123 ou »).
// Les lettres I, O, U sont exclues par construction (format officiel).
// ----------------------------------------------------------------------------
var MOTS_INTERDITS = { ET: 1, LA: 1, LE: 1, DE: 1, NE: 1, CE: 1, EN: 1, ES: 1, TA: 1, SA: 1, MA: 1, VA: 1, RA: 1, DA: 1, CA: 1, NA: 1, EX: 1, AX: 1, TX: 1, RE: 1, SE: 1, FE: 1, ME: 1, TE: 1, IE: 1, YE: 1, ZE: 1, UP: 1 };

function extrairePlaques(texte) {
  var t = normaliserApostrophes(texte);
  var trouvailles = [];
  var re = /\b([A-HJ-NP-TV-Z]{2})[ \-–—]?(\d{3})[ \-–—]?([A-HJ-NP-TV-Z]{2})\b/gi;
  var m;
  while ((m = re.exec(t)) !== null) {
    var c = normaliserImmat(m[1] + m[2] + m[3]);
    if (c.length !== 7) continue;
    if (MOTS_INTERDITS[m[1].toUpperCase()] || MOTS_INTERDITS[m[3].toUpperCase()]) continue; // « et 123 ou » → pas une plaque
    if (trouvailles.indexOf(c) === -1) trouvailles.push(c);
  }
  return trouvailles;
}

// ----------------------------------------------------------------------------
// Extraction TÉLÉPHONES — mobiles français (06/07, +33, 0033), séparateurs
// tolérés, canonique 336… Garde : jamais au milieu d'un nombre plus long
// (lookbehind/lookahead) — un horodatage ne devient pas un numéro.
// ----------------------------------------------------------------------------
function extraireTelephones(texte) {
  var t = normaliserApostrophes(texte);
  var trouvailles = [];
  var re = /(?<!\d)(?:\+33|0033|0)[ .\-]?\d(?:[ .\-]?\d){8}(?!\d)/g;
  var m;
  while ((m = re.exec(t)) !== null) {
    var c = normaliserTelephone(m[0]);
    if (c && c.length >= 10 && trouvailles.indexOf(c) === -1) trouvailles.push(c);
  }
  return trouvailles;
}

// ----------------------------------------------------------------------------
// Détection PUSH CAMPAGNE — portage v2.20.124 (incident AGB RESTAURATION) :
// un sortant est un push s'il porte le vocabulaire campagne ET NE PORTE PAS
// la signature « Agent IA U'mob » (les messages de l'agent l'ont toujours).
// Un push template n'est PAS marqué sender 'user' → on ne regarde JAMAIS le
// sender, seulement le texte.
// ----------------------------------------------------------------------------
function estPushCampagne(texteSortant) {
  var t = normaliserApostrophes(texteSortant);
  if (!t) return false;
  if (/Agent IA U'?mob/i.test(t)) return false; // signature = message de l'agent
  return /tourne prochainement|votre secteur|prochainement dans votre secteur|passage programm/i.test(t);
}

// Le dernier sortant de l'agent demande-t-il le numéro de la personne à
// contacter le jour de l'intervention ? (étape 3 du cahier des charges)
var RE_DEMANDE_TEL = /num[eé]ro|t[eé]l[eé]phone|t[eé]l[eé]phoner|appeler|contacter|joindre|annoncer/i;
var RE_DEMANDE_TEL_CONTEXTE = /personne|jour de l|intervention|technicien|arriv[eé]e/i;

function dernierSortantDemandeTelephone(texteSortant) {
  var t = normaliserApostrophes(texteSortant);
  return RE_DEMANDE_TEL.test(t) && RE_DEMANDE_TEL_CONTEXTE.test(t);
}

// ----------------------------------------------------------------------------
// Application d'UN message normalisé (B2.1) au formulaire.
// Sortant : on retient le texte (détection push / demande téléphone) et on
// récupère plaques + téléphones (une info dite par l'agent est CONNUE du
// dossier — la règle 1 interdit de la redemander, quel que soit le côté).
// Entrant : tout ce qui précède + médias, « va chercher une info », push,
// signal commercial, téléphone à contacter après demande.
// ----------------------------------------------------------------------------
function appliquerMessage(etat, message) {
  var m = message || {};
  var texte = normaliserApostrophes(m.texte || '');

  // Plaques : n'importe quel côté de la conversation (règle 1)
  var plaques = extrairePlaques(texte);
  for (var i = 0; i < plaques.length; i++) {
    if (etat.plaques.indexOf(plaques[i]) === -1) etat.plaques.push(plaques[i]);
  }

  // Téléphones : n'importe quel côté → connus ; à contacter si demandé + fourni
  var tels = extraireTelephones(texte);
  for (var j = 0; j < tels.length; j++) {
    if (etat.telephones_connus.indexOf(tels[j]) === -1) etat.telephones_connus.push(tels[j]);
  }
  if (!m.sortant && !etat.telephone_contact && tels.length &&
      dernierSortantDemandeTelephone(etat.dernier_sortant)) {
    etat.telephone_contact = tels[0]; // le seul champ qui BLOQUE le transfert (règle 6)
  }

  if (m.sortant) {
    etat.dernier_sortant = texte;
    return etat;
  }

  // --- entrant ---
  // Médias (règle 5 : vocal → proposer écrit/photos ; photos → reçues)
  if (m.type_media === 'image' || (m.media && !m.type_media)) etat.photos = true;
  if (m.type_media === 'audio') etat.vocal_recu = true;

  // Règle 3 : le client va chercher une info → accueillir et ATTENDRE.
  // Recalculé à CHAQUE message entrant : dès qu'il revient avec l'info, tombé.
  etat.client_cherche_info =
    /une minute|deux minutes|2 min|je regarde|je cherche|laissez[- ]moi (?:voir|regarder|chercher|trouver)/i.test(texte);

  // Portage v124 : ce message répond-il à un push campagne ?
  etat.campagne_push = estPushCampagne(etat.dernier_sortant);

  // Signal commercial (§4 : prix, achat, location → équipe commerciale).
  // C'est un SIGNAL : le cerveau tranche, ce drapeau ne force rien.
  if (/\b(prix|tarifs?|louer|location|acheter|achat|devis|racheter|abonnement)\b/i.test(texte)) {
    etat.demande_commerciale = true;
  }
  return etat;
}

// Reconstruit le formulaire sur TOUT l'historique (cahier des charges §7 :
// l'état est reconstruit à partir de TOUT l'historique, pas du dernier msg).
// Entrée : messages normalisés B2.1, du PLUS ANCIEN au plus récent.
function reconstruireEtat(messages) {
  var etat = etatVierge();
  var msgs = messages || [];
  for (var i = 0; i < msgs.length; i++) appliquerMessage(etat, msgs[i]);
  return etat;
}

// Fiche respond.io (B2.1) → signaux équipe (§7.4 : « Prise de main » etc.)
function appliquerFiche(etat, fiche) {
  var f = fiche || {};
  etat.nom = String(f.nom || etat.nom || '');
  var tags = f.tags || [];
  for (var i = 0; i < tags.length; i++) {
    var t = String(tags[i] || '').trim().toLowerCase();
    if (t === 'prise de main') etat.prise_de_main = true;
    if (t === 'demande commerciale') etat.demande_commerciale = true;
  }
  return etat;
}

// Ligne agent_sav.clients (miroir Sheet, B2.2) → enseigne, plaques flotte,
// statut risque. Les plaques flotte sont CONNUES (règle 4 : jamais redemandées).
function appliquerClient(etat, client) {
  var c = client || {};
  if (c.enseigne) etat.enseigne = String(c.enseigne);
  if (c.statut_risque) etat.statut_risque = String(c.statut_risque);
  var brutes = String(c.plaque || '').split('/');
  for (var i = 0; i < brutes.length; i++) {
    var p = normaliserImmat(brutes[i]);
    if (p && etat.plaques.indexOf(p) === -1) etat.plaques.push(p);
  }
  return etat;
}

// Intégration B2.1 : le JSON de /api/contexte → formulaire complet.
// (le processeur B4 cherchera AUSSI la ligne clients par téléphone — le
// webhook connaît le numéro WhatsApp du contact — puis appliqueraClient.)
function etatDepuisContexte(ctx) {
  var c = ctx || {};
  var etat = reconstruireEtat(c.messages || []);
  appliquerFiche(etat, c.contact || {});
  return etat;
}

module.exports = {
  etatVierge: etatVierge,
  formaterPlaque: formaterPlaque,
  extrairePlaques: extrairePlaques,
  extraireTelephones: extraireTelephones,
  estPushCampagne: estPushCampagne,
  dernierSortantDemandeTelephone: dernierSortantDemandeTelephone,
  appliquerMessage: appliquerMessage,
  reconstruireEtat: reconstruireEtat,
  appliquerFiche: appliquerFiche,
  appliquerClient: appliquerClient,
  etatDepuisContexte: etatDepuisContexte,
  normaliserTelephone: normaliserTelephone,
  normaliserImmat: normaliserImmat
};

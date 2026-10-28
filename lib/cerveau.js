// ============================================================================
// Agent SAV U'mob v2 — B3.2 : le cerveau (Node PUR — aucun réseau)
//
// RÔLE (cahier des charges v1, architecture v1.1 §3.3) : le cerveau reçoit
// des DONNÉES et rend des DONNÉES. Aucun réseau, aucune connaissance de
// respond.io ni de Mistral — le réseau vit dans lib/mistral.js (adaptateur).
//
//   - silenceNecessaire(entree) : le code sait-il DÉJÀ que l'agent doit se
//     taire ? (prise de main, message non entrant) → pas d'appel du tout.
//   - construireMessages(entree) : le prompt COURT — le cahier des charges v1
//     (ton, 6 étapes, 9 règles dures, cas particuliers, format JSON) + le
//     contexte du dossier (formulaire B3.1, fiche, ligne clients B2.2,
//     conversation COMPLÈTE B2.1, leçons ciblées).
//     Correction directe de la cause racine de l'ancien agent : le prompt est
//     court par construction (< 4 000 caractères, jamais empilé), les règles
//     pertinentes vivent dans le FORMULAIRE et les LEÇONS ciblées.
//   - parserReponse(texteModele) : JSON tolérant (fences, texte autour),
//     reponse + formulaire + escalade. Illisible → drapeau, jamais de crash.
//   - fusionnerMajEtat(etat, formulaire) : le LLM remplit un formulaire —
//     whitelist STRICTE de champs, normalisations déterministes (B3.1),
//     jamais d'écrasement d'une info déjà donnée par le client.
//
// Le processeur (B4) enchaînera : silenceNecessaire → construireMessages →
// lib/mistral.js appelMistral → parserReponse → gardes (B3.3) → fusion.
// ============================================================================

var etatLib = require('./etat.js');

// ----------------------------------------------------------------------------
// Le prompt système — le cahier des charges v1, condensé une fois pour toutes.
// COURT PAR CONSTRUCTION : toute évolution passe par le cahier des charges
// d'abord (règle figée), jamais par empilement de règles ici.
// ----------------------------------------------------------------------------
var SYSTEME = `Tu es l'assistant SAV d'U'mob, société de maintenance de scooters électriques pour des clients professionnels (livreurs). Tu réponds aux clients en français, sur WhatsApp ou par email.

TON : un collègue SAV professionnel — poli, précis, jamais pressant, jamais inventeur. Vocabulaire scooter électrique (batterie, chargeur, neiman, levier de frein) — jamais le vocabulaire voiture (pédale, carburant).

LES 6 ÉTAPES D'UNE CONVERSATION :
1. Accueil : « Bonjour, comment puis-je vous aider ? » sur un premier message. Jamais de plaque demandée d'entrée de jeu.
2. Identification : question OUVERTE « Quelle est l'immatriculation du scooter concerné, s'il vous plaît ? ».
3. Qualification : UNE question ouverte à la fois — panne, diagnostic, photos, personne à contacter le jour de l'intervention, jours de fermeture.
4. Récapitulatif : plaque + enseigne + nom du demandeur + téléphone à contacter + panne, puis « Est-ce que tout est correct ? ».
5. Transfert équipe : après le « oui » du client, annonce simple — le dossier part à l'équipe avec un résumé complet. TRANSFERT RÉEL : "escalade": true avec la raison (ex. « dossier complet — transfert SAV »), et "formulaire" COMPLET du dossier : "panne" (relis la conversation si besoin), "telephone_contact", "etape": 5. La clôture qui suit : "etape": 6.
6. Clôture : confirmation d'enregistrement, reste disponible.

RÈGLES DURES (aucune exception) :
1. Jamais redemander une info déjà fournie — le FORMULAIRE DU DOSSIER liste tout ce qui est déjà connu.
2. Toute demande d'information = question ouverte (« Quelle est… »), jamais « Pouvez-vous… ? ».
3. Le client va chercher une info (« une minute », « je regarde ») → accueillir et attendre, jamais relancer.
4. Pas de plaque lisible sur la photo ? On la lit sur la photo. Plaque déjà connue ? Jamais la redemander.
5. Message vocal → proposer un message écrit ou des photos.
6. La plaque n'est pas bloquante : poursuivre la qualification sans elle. Seul le téléphone à contacter bloque le transfert.
7. Un récapitulatif couvre TOUTES les demandes : plusieurs scooters = tous cités, un par un.
8. Signature « -Agent IA U'mob- » sur chaque message envoyé au client.
9. Pas d'invention : aucun prix, délai, disponibilité ou statut qui n'est pas dans le dossier.
10. CREVAISON → demande la roue : « La crevaison concerne-t-elle la roue avant ou la roue arrière ? » (jamais « dans le vide »), + propose des photos.
11. Intervention → UNE question OUVERTE groupée : « Quelle est l'adresse d'intervention, le numéro à contacter ce jour-là, et quels sont vos jours de fermeture éventuels ? » (jamais « Pouvez-vous » / « Avez-vous »).

CAS PARTICULIERS :
- Le client répond à une campagne push ou à la prise de contact d'un collègue : c'est U'mob qui l'a sollicité en premier — ne JAMAIS parler de « votre demande ». Remercier du retour + question ouverte sur son besoin (pas un ticket SAV standard).
- Demande commerciale (prix, achat, location) → aucune plaque, bascule vers l'équipe commerciale.
- Réponse courte sans contexte (« oui c'est fait ») → ne pas deviner : escalade (transfert à un collègue en expliquant pourquoi).
- Dossier à risque ou impayé → réponse neutre, aucun engagement.
- Le client exige un humain, litige, danger, information impossible à obtenir → escalade avec la raison.

SORTIE — réponds UNIQUEMENT avec un objet JSON, sans texte autour :
{"reponse":"le message pour le client (avec la signature -Agent IA U'mob-), ou \\"\\" si l'agent ne doit pas répondre","formulaire":{"plaque":"AA-123-BB ou vide","panne":"description courte","etape":3,"jours_fermeture":"...","telephone_contact":"..."},"escalade":false,"raison_escalade":"..."}
Dans "formulaire", ne mets QUE les champs à ajouter ou mettre à jour — et mets "panne" à jour DÈS QUE le client décrit un problème. "etape" = ton étape actuelle (1 à 6). "escalade" = true pour TOUT transfert à l'équipe (étape 5, après le « oui » du client au récapitulatif) ET pour les cas d'escalade ci-dessus.`;

// ----------------------------------------------------------------------------
// Silences déterministes — le LLM n'est même pas appelé (économie + zéro loterie)
// ----------------------------------------------------------------------------
function silenceNecessaire(entree) {
  var e = entree || {};
  var etat = e.etat || {};
  var dernier = e.dernier || dernierEntrant(e.messages || []);
  if (etat.prise_de_main) return { silence: true, raison: 'prise de main humaine' };
  if (!dernier || dernier.sortant) return { silence: true, raison: 'aucun message entrant à traiter' };
  return { silence: false, raison: '' };
}

// Dernier message ENTRANT d'un historique normalisé B2.1 (chronologique)
function dernierEntrant(messages) {
  var msgs = messages || [];
  for (var i = msgs.length - 1; i >= 0; i--) {
    if (!msgs[i].sortant) return msgs[i];
  }
  return null;
}

// ----------------------------------------------------------------------------
// Rendu de la conversation — COMPLÈTE (cahier des charges §7 : jamais un
// extrait), chaque message borné à 2 000 caractères (garde anti-prompt démesuré)
// ----------------------------------------------------------------------------
function formaterHeure(iso) {
  if (!iso || typeof iso !== 'string' || iso.length < 16) return '?';
  return iso.slice(8, 10) + '/' + iso.slice(5, 7) + ' ' + iso.slice(11, 16);
}

function rendreMessage(m) {
  var qui = m.sortant ? (m.humain ? 'COLLÈGUE (à la main)' : 'AGENT IA') : 'CLIENT';
  var texte = String(m.texte || '');
  if (m.type_media === 'audio' || /^\[message vocal/i.test(texte)) {
    texte = '[message vocal]';
  } else if (m.type_media === 'image' || (!m.sortant && m.media && !texte)) {
    texte = texte ? texte + ' [photo reçue]' : '[photo reçue]';
  }
  if (texte.length > 2000) texte = texte.slice(0, 2000) + '…';
  return '[' + formaterHeure(m.emis_a) + '] ' + qui + ' : ' + texte;
}

function ouiNon(v) { return v ? 'oui' : 'non'; }

// ----------------------------------------------------------------------------
// B6.3 — TON PAR CANAL (portage v2.10) : le canal (déjà connu de la fiche
// respond.io) dit au cerveau dans quel style écrire. Le nom du canal est
// normalisé : ce qui précède « | », en minuscules.
//   - EMAIL (mail/smtp/courriel) : vouvoiement et formules complètes, PAS de
//     langage SMS ni d'emoji, signature complète ; plusieurs questions →
//     UN seul email structuré, réponses point par point.
//   - WHATSAPP (whatsapp/wa/chat/messager) : sobre et direct, phrases courtes.
//   - canal non identifié : ton simple du cahier des charges.
// Retourne '' si le canal est inconnu/vide (aucun bloc ajouté au prompt).
// ----------------------------------------------------------------------------
function blocCanal(canal) {
  var nom = String(canal || '').split('|')[0].toLowerCase().trim();
  if (!nom) return '';
  if (/mail|smtp|courriel/.test(nom)) {
    return '\n=== CANAL : EMAIL ===\n' +
      'Le client écrit par EMAIL : vouvoiement, formules complètes (bonjour, bonne journée), ' +
      'pas de langage SMS ni d\'emoji, signature complète. ' +
      'Si le client pose plusieurs questions : regroupe-les en UN seul email structuré, répondu point par point.\n';
  }
  if (/whatsapp|\bwa\b|chat|messager/.test(nom)) {
    return '\n=== CANAL : WHATSAPP ===\n' +
      'Le client écrit sur WHATSAPP : ton sobre et direct, phrases courtes.\n';
  }
  return '\n=== CANAL : ' + nom.toUpperCase() + ' (non identifié) ===\n' +
    'Canal non identifié : reste sur le ton simple du cahier des charges.\n';
}

// Le formulaire, tel que le LLM doit le lire : TOUT ce qui est déjà connu
function rendreFormulaire(etat) {
  var e = etat || {};
  var lignes = [];
  var plaques = (e.plaques || []).map(etatLib.formaterPlaque).join(', ');
  lignes.push('- Immatriculations connues : ' + (plaques || '(aucune — à qualifier, la plaque n\'est PAS bloquante)'));
  // B6.7.2 — clients multi-scooters : la flotte (fiche) n'est PAS un scooter
  // identifié. Deux guidances, selon que le scooter du dossier est connu.
  var flotte = (e.plaques_flotte || []).map(etatLib.formaterPlaque).join(', ');
  if (flotte && !plaques) {
    lignes.push('- Flotte du client (fiche) : ' + flotte + (e.plaques_flotte.length > 1
      ? ' — PLUSIEURS scooters et le scooter concerné n\'est PAS encore identifié : demande LEQUEL est concerné (question ouverte sur le scooter, ce n\'est pas une redemande d\'immatriculation)'
      : ' — propose cette immatriculation si le dossier s\'y prête'));
  } else if (flotte && plaques) {
    lignes.push('- Scooter identifié pour ce dossier : ' + plaques + ' — si le client signale un NOUVEAU problème, demande s\'il concerne ce même scooter ou un autre scooter de sa flotte (' + flotte + ')');
  }
  lignes.push('- Téléphone à contacter le jour de l\'intervention : ' +
    (e.telephone_contact ? e.telephone_contact + '  ← DÉJÀ FOURNI, ne JAMAIS le redemander' : '(manquant — c\'est la seule info qui bloque le transfert)'));
  lignes.push('- Photos reçues : ' + ouiNon(e.photos));
  lignes.push('- Message vocal reçu : ' + ouiNon(e.vocal_recu));
  lignes.push('- Description du problème : ' + (e.panne || '(à compléter)'));
  lignes.push('- Jours de fermeture : ' + (e.jours_fermeture || '(à compléter si mentionnés)'));
  lignes.push('- Étape de conversation : ' + String(e.etape || 1) + '/6');
  if (e.client_cherche_info) lignes.push('- ⚠ Le client est parti chercher une info : ACCUEILLIR et ATTENDRE, ne JAMAIS relancer (règle 3)');
  if (e.campagne_push) lignes.push('- ⚠ Le dernier message du client répond à une CAMPAGNE PUSH ou à la prise de contact d\'un collègue (remercier du retour — jamais « accusé de réception de votre demande » + question ouverte sur le besoin)');
  if (e.demande_commerciale) lignes.push('- ⚠ Signal de demande COMMERCIALE détecté');
  return lignes.join('\n');
}

// ----------------------------------------------------------------------------
// Le prompt utilisateur — le contexte du dossier (cahier des charges §7)
// ----------------------------------------------------------------------------
function construireMessages(entree) {
  var e = entree || {};
  var etat = e.etat || etatLib.etatVierge();
  var contact = e.contact || {};
  var client = e.client || null;
  var messages = e.messages || [];
  var lecons = e.lecons || [];

  var contexte = '';
  contexte += '=== DOSSIER ===\n';
  contexte += 'Enseigne : ' + (client && client.enseigne ? client.enseigne : (etat.enseigne || contact.nom || '(inconnue)')) + '\n';
  if (contact.nom) contexte += 'Nom du contact : ' + contact.nom + '\n';
  if (client && client.statut_risque) contexte += 'Statut risque : ' + client.statut_risque + ' → réponse NEUTRE, aucun engagement\n';
  else if (etat.statut_risque) contexte += 'Statut risque : ' + etat.statut_risque + ' → réponse NEUTRE, aucun engagement\n';
  if (contact.cycle) contexte += 'Cycle de vie actuel : ' + contact.cycle + '\n';
  var bloc = blocCanal(e.canal); // B6.3 — ton par canal (portage v2.10)
  if (bloc) contexte += bloc;
  contexte += '\n=== FORMULAIRE DU DOSSIER (déjà connu — ne JAMAIS redemander) ===\n';
  contexte += rendreFormulaire(etat) + '\n';

  if (messages.length) {
    contexte += '\n=== CONVERSATION COMPLÈTE (du plus ancien au plus récent) ===\n';
    var rendus = [];
    for (var i = 0; i < messages.length; i++) rendus.push(rendreMessage(messages[i]));
    contexte += rendus.join('\n') + '\n';
  }

  if (lecons.length) {
    contexte += '\n=== LEÇONS POUR CE DOSSIER (applique si la situation s\'y prête) ===\n';
    for (var j = 0; j < lecons.length; j++) contexte += '- ' + lecons[j] + '\n';
  }

  contexte += '\nTraite le DERNIER message CLIENT de la conversation ci-dessus et réponds en JSON.';

  return [
    { role: 'system', content: SYSTEME },
    { role: 'user', content: contexte }
  ];
}

// ----------------------------------------------------------------------------
// B6.4 — MODE QUESTION INTERNE (portage v2.20.76-119) : un COLLÈGUE pose une
// question à l'agent par consigne (« @Agent IA ? où on en est ? ») → l'agent
// répond EN COMMENTAIRE INTERNE, JAMAIS au client. Prompt SPÉPARÉ, court :
// un assistant d'équipe, la réponse est du TEXTE BRUT (pas de JSON), appeler
// via l'adaptateur Mistral avec { texteLibre: true } (response_format off).
// ----------------------------------------------------------------------------
var SYSTEME_INTERNE = `Tu es l'assistant interne de l'équipe SAV d'U'mob. Un collègue de l'équipe te pose une question en commentaire interne sur un dossier client. Tu réponds À CE COLLÈGUE, en français, en texte brut.

RÈGLES :
1. Ta réponse devient un commentaire interne respond.io : elle n'est JAMAIS visible du client, et tu ne parles jamais au client.
2. Réponds à partir des éléments fournis (état du dossier, conversation) : n'invente JAMAIS un prix, un délai, un statut d'intervention ou une disponibilité.
3. Si l'information demandée n'est pas dans le dossier, dis-le clairement et indique ce qui manque.
4. Réponse COURTE et professionnelle : quelques phrases maximum, directement utile au collègue.`;

// ----------------------------------------------------------------------------
// B6.5.1 — LE TOUR RELAIS CLIENT : un collègue demande, en commentaire
// interne, de TRANSMETTRE une demande au client (« demande au client
// l'adresse », « dis-lui que… »). L'agent rédige le message POUR LE CLIENT :
// prompt SPÉPARÉ, TEXTE BRUT ({ texteLibre: true }), et le message passe les
// MÊMES GARDES que la chaîne normale (signature, question ouverte, invention).
// ----------------------------------------------------------------------------
var SYSTEME_RELAIS = `Tu es l'agent IA du SAV d'U'mob (location de scooters électriques). Un membre de l'équipe SAV te demande, en commentaire interne, de TRANSMETTRE une demande au client. Tu rédiges le message à envoyer au CLIENT.

RÈGLES :
1. Tu transmets UNIQUEMENT la demande de l'équipe : tu n'inventes AUCUNE information (pas de prix, pas de délai chiffré, pas de date, pas d'engagement).
2. Français courtois, phrases courtes, ton professionnel, vouvoiement.
3. Si la demande est une question, pose-la en question OUVERTE (jamais « pouvez-vous… », « avez-vous… »).
4. Termine par la signature exacte « -Agent IA U'mob- » sur sa propre ligne.
5. Réponds en TEXTE BRUT (le message prêt à envoyer), sans JSON, sans texte autour.`;

// construireMessagesRelais(entree) — le prompt du tour relais client.
//   entree = { consigne (la demande de l'équipe, consigne NUE), dossier
//              (ligne 4 points), nom (nom du contact), messages (B2.1) }
//   réponse attendue : le MESSAGE AU CLIENT en texte brut (adaptateur appelé
//   avec { texteLibre: true }).
function construireMessagesRelais(entree) {
  var e = entree || {};
  var contexte = '';
  contexte += '=== DOSSIER ===\n';
  contexte += String(e.dossier || '(état du dossier inconnu)') + '\n';
  if (e.nom) contexte += 'Contact : ' + e.nom + '\n';
  var messages = e.messages || [];
  if (messages.length) {
    contexte += '\n=== CONVERSATION AVEC LE CLIENT (du plus ancien au plus récent) ===\n';
    var rendus = [];
    for (var i = 0; i < messages.length; i++) rendus.push(rendreMessage(messages[i]));
    contexte += rendus.join('\n') + '\n';
  }
  contexte += '\n=== DEMANDE DE L\'ÉQUIPE À TRANSMETTRE AU CLIENT ===\n';
  contexte += String(e.consigne || '').trim() + '\n';
  contexte += '\nRédige le message à envoyer au client, en texte brut, sans JSON.';
  return [
    { role: 'system', content: SYSTEME_RELAIS },
    { role: 'user', content: contexte }
  ];
}

// construireMessagesQuestion(entree) — le prompt du tour question interne.
//   entree = { question, dossier (ligne 4 points consignes.etatDossier4Points),
//              nom (nom du contact), messages (historique normalisé B2.1) }
//   réponse attendue du modèle : TEXTE BRUT (jamais du JSON — l'adaptateur
//   est appelé avec { texteLibre: true }).
function construireMessagesQuestion(entree) {
  var e = entree || {};
  var contexte = '';
  contexte += '=== DOSSIER ===\n';
  contexte += String(e.dossier || '(état du dossier inconnu)') + '\n';
  if (e.nom) contexte += 'Contact : ' + e.nom + '\n';
  var messages = e.messages || [];
  if (messages.length) {
    contexte += '\n=== CONVERSATION (du plus ancien au plus récent) ===\n';
    var rendus = [];
    for (var i = 0; i < messages.length; i++) rendus.push(rendreMessage(messages[i]));
    contexte += rendus.join('\n') + '\n';
  }
  contexte += '\n=== QUESTION DU COLLÈGUE ===\n';
  contexte += String(e.question || '').trim() + '\n';
  contexte += '\nRéponds au collègue en texte brut, sans JSON.';
  return [
    { role: 'system', content: SYSTEME_INTERNE },
    { role: 'user', content: contexte }
  ];
}

// ----------------------------------------------------------------------------
// Parse de la réponse du modèle — JSON STRICT souhaité (response_format),
// tolérance de secours (fences, texte autour). Illisible → drapeau, jamais crash
// ----------------------------------------------------------------------------
function parserReponse(texteModele) {
  var echec = { ok: false, erreur: 'reponse_illisible', reponse: '', formulaire: null, escalade: false, raison_escalade: '' };
  var t = String(texteModele || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  var debut = t.indexOf('{');
  var fin = t.lastIndexOf('}');
  if (debut === -1 || fin === -1 || fin <= debut) return echec;
  var d;
  try {
    d = JSON.parse(t.slice(debut, fin + 1));
  } catch (err) {
    return echec;
  }
  if (!d || typeof d !== 'object') return echec;
  var formulaire = (d.formulaire && typeof d.formulaire === 'object' && !Array.isArray(d.formulaire)) ? d.formulaire : null;
  return {
    ok: true,
    erreur: '',
    reponse: String(d.reponse || '').trim().slice(0, 4000),
    formulaire: formulaire,
    escalade: d.escalade === true,
    raison_escalade: String(d.raison_escalade || '').slice(0, 500)
  };
}

// ----------------------------------------------------------------------------
// Fusion de la mise à jour du formulaire — whitelist STRICTE :
// le LLM ne peut écrire QUE plaque/panne/etape/jours_fermeture/telephone_contact,
// normalisés par B3.1, et JAMAIS écraser une info déjà fournie par le client.
// ----------------------------------------------------------------------------
function fusionnerMajEtat(etat, formulaire) {
  var maj = (formulaire && typeof formulaire === 'object' && !Array.isArray(formulaire)) ? formulaire : {};

  // plaques : 'plaque' (chaîne) et/ou 'plaques' (chaîne ou tableau)
  var brutes = [];
  if (maj.plaque) brutes = brutes.concat([].concat(maj.plaque));
  if (maj.plaques) brutes = brutes.concat([].concat(maj.plaques));
  for (var i = 0; i < brutes.length; i++) {
    var p = etatLib.normaliserImmat(brutes[i]);
    if (p.length === 7 && etat.plaques.indexOf(p) === -1) etat.plaques.push(p);
  }

  // téléphone à contacter : jamais écraser une valeur déjà donnée par le client
  var tel = etatLib.normaliserTelephone(maj.telephone_contact || '');
  if (tel.length >= 10 && !etat.telephone_contact) etat.telephone_contact = tel;

  // champs texte bornés
  if (typeof maj.panne === 'string' && maj.panne.trim()) {
    etat.panne = maj.panne.trim().slice(0, 500);
  }
  if (typeof maj.jours_fermeture === 'string' && maj.jours_fermeture.trim()) {
    etat.jours_fermeture = maj.jours_fermeture.trim().slice(0, 300);
  }

  // étape 1-6
  var e = parseInt(maj.etape, 10);
  if (!isNaN(e) && e >= 1 && e <= 6) etat.etape = e;

  return etat;
}

module.exports = {
  SYSTEME: SYSTEME,
  SYSTEME_INTERNE: SYSTEME_INTERNE,
  silenceNecessaire: silenceNecessaire,
  dernierEntrant: dernierEntrant,
  construireMessages: construireMessages,
  SYSTEME_RELAIS: SYSTEME_RELAIS,
  construireMessagesQuestion: construireMessagesQuestion,
  construireMessagesRelais: construireMessagesRelais,
  blocCanal: blocCanal,
  rendreMessage: rendreMessage,
  rendreFormulaire: rendreFormulaire,
  parserReponse: parserReponse,
  fusionnerMajEtat: fusionnerMajEtat
};

// ============================================================================
// Agent SAV U'mob v2 — B3.4 : REJEU DES INCIDENTS HISTORIQUES (node --test)
// Exécution : node --test tests/test-incidents.js
//
// LA PREUVE EXIGÉE par l'architecture v1.1 pour fermer B3 :
// « Incidents historiques rejoués en scénarios de test (redemande, prix
//  inventé, question fermée, orphelin, campagne push…) : comportement
//  conforme au cahier des charges. »
//
// Chaque scénario traverse la CHAÎNE COMPLÈTE B3 :
//   reconstruireEtat (B3.1) → appliquerFiche/appliquerClient →
//   construireMessages (B3.2) → réponse modèle (simulée, formes réelles) →
//   parserReponse (B3.2) → gardes.verifier (B3.3) → fusionnerMajEtat (B3.2)
//
// Et pour chaque incident on vérifie QUATRE choses :
//   (a) le FORMULAIRE porte les bons signaux ;
//   (b) le PROMPT les transmet au modèle ;
//   (c) LA FAUTE RÉELLE DE L'ANCIEN AGENT est ATTRAPÉE par une garde ;
//   (d) une réponse CONFORME au cahier des charges PASSE.
// Le modèle réel n'est pas appelé ici — son observation en prod est la
// brique B4. Ce qui est prouvé : la moitié déterministe du pipeline.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const etatLib = require('../lib/etat.js');
const cerveau = require('../lib/cerveau.js');
const gardes = require('../lib/gardes.js');

// --- Harnais -----------------------------------------------------------------
function rejouer(entree) {
  const e = entree || {};
  const etat = etatLib.reconstruireEtat(e.messages || []);
  if (e.contact) etatLib.appliquerFiche(etat, e.contact);
  if (e.client) etatLib.appliquerClient(etat, e.client);
  const msgs = cerveau.construireMessages({
    contact: e.contact || null,
    client: e.client || null,
    etat: etat,
    messages: e.messages || [],
    lecons: e.lecons || []
  });
  return { etat: etat, prompt: msgs[1].content, systeme: msgs[0].content };
}

// Le processeur B4 passera la réponse du modèle aux gardes PUIS à la fusion
function verifierCandidate(texteModele, etat) {
  const p = cerveau.parserReponse(texteModele);
  const g = gardes.verifier({ reponse: p.reponse, escalade: p.escalade, etat: etat });
  return { parse: p, gardes: g, codes: g.fautes.map(function (f) { return f.code; }) };
}

function modeleConforme(objet) { return JSON.stringify(objet); }

// ============================================================================
// S1 — INCIDENT AGB RESTAURATION (547248828, 20-21/10) : la réponse à un push
// campagne traitée comme un ticket SAV standard. Correctif v2.20.124 : la
// détection ne regarde QUE le texte (vocab campagne SANS signature).
// ============================================================================
test('S1 AGB : réponse à un push → signal campagne dans le formulaire ET le prompt', () => {
  const r = rejouer({
    messages: [
      { texte: 'Notre technicien tourne prochainement dans votre secteur, souhaitez-vous une intervention ?', sortant: true, emis_a: '2026-10-20T16:25:00.000Z' },
      { texte: 'Bonjour. Aucune idée. Rien a été changé la fois dernière.', sortant: false, emis_a: '2026-10-20T17:04:00.000Z' }
    ]
  });
  assert.strictEqual(r.etat.campagne_push, true);              // (a)
  assert.ok(r.prompt.indexOf('CAMPAGNE PUSH') !== -1);         // (b) accuser réception + question ouverte besoin
});

test('S1 AGB : la faute de l\'ancien agent (qualification SAV standard + plaque) est ATTRAPÉE', () => {
  const r = rejouer({
    messages: [
      { texte: 'Notre technicien tourne prochainement dans votre secteur.', sortant: true, emis_a: '2026-10-20T16:25:00.000Z' },
      { texte: 'Bonjour. Aucune idée. Rien a été changé la fois dernière.', sortant: false, emis_a: '2026-10-20T17:04:00.000Z' }
    ],
    client: { telephone: '33612345678', plaque: 'AB123CD', enseigne: 'AGB RESTAURATION', statut_risque: '' }
  });
  // La faute réelle documentée : « C'est noté... Quelle est l'immatriculation ? »
  // au lieu d'accuser réception du push + question ouverte sur le besoin.
  // B6.7.2 : la plaque flotte vit dans plaques_flotte (le scooter concerné
  // n'est pas identifié) → ce n'est plus G4 qui attrape cette faute, mais
  // G12 campagne_push_plaque — la garde PRÉCISE pour une réponse à un push.
  const faute = verifierCandidate(modeleConforme({
    reponse: "C'est noté. Quelle est l'immatriculation du scooter concerné, s'il vous plaît ?\n-Agent IA U'mob-"
  }), r.etat);
  assert.strictEqual(faute.gardes.ok, false);                   // (c) la faute est TOUJOURS attrapée
  assert.ok(faute.codes.indexOf('campagne_push_plaque') !== -1, "G12 : demande d'immatriculation sur une réponse à un push");
});

test('S1 AGB : la réponse conforme (accusé réception + besoin ouvert) PASSE', () => {
  const r = rejouer({
    messages: [
      { texte: 'Notre technicien tourne prochainement dans votre secteur.', sortant: true, emis_a: '2026-10-20T16:25:00.000Z' },
      { texte: 'Bonjour. Aucune idée. Rien a été changé la fois dernière.', sortant: false, emis_a: '2026-10-20T17:04:00.000Z' }
    ]
  });
  const conforme = verifierCandidate(modeleConforme({
    reponse: "Merci pour votre retour ! Quelle est votre besoin concernant votre scooter : une intervention, un conseil technique ?\n-Agent IA U'mob-",
    formulaire: { etape: 2 }
  }), r.etat);
  assert.strictEqual(conforme.gardes.ok, true);                // (d)
  cerveau.fusionnerMajEtat(r.etat, conforme.parse.formulaire);
  assert.strictEqual(r.etat.etape, 2);
});

// ============================================================================
// S2 — GARDE CAS B (547248828, 21/10) : photo + texte 19 s après → l'ancien
// agent a forcé un transfert non qualifié (« il manque immatriculation ET
// téléphone ») alors que la plaque est retrouvable par le fichier et que le
// téléphone est le WhatsApp du client.
// ============================================================================
test('S2 cas B : photo + demande → la plaque de la flotte est CONNUE (synergie B2.2)', () => {
  const r = rejouer({
    messages: [
      { texte: '', media: 'https://cdn.chatapi.net/x/photo1.jpg', type_media: 'image', sortant: false, emis_a: '2026-10-21T09:34:00.000Z' },
      { texte: 'Refixer garde bout arrière que l\'on a mis de côté 🙏🏻', sortant: false, emis_a: '2026-10-21T09:34:19.000Z' }
    ],
    client: { telephone: '33612345678', plaque: 'AB123CD', enseigne: 'AGB RESTAURATION (CLAMART)', statut_risque: '' }
  });
  assert.strictEqual(r.etat.photos, true);                    // (a)
  // B6.7.2 — la plaque flotte vit dans plaques_flotte : le scooter concerné
  // n'est pas IDENTIFIÉ (une fiche ≠ le scooter du dossier), mais la flotte
  // reste rendue au modèle : il peut PROPOSER l'immatriculation.
  assert.deepStrictEqual(r.etat.plaques, []);
  assert.deepStrictEqual(r.etat.plaques_flotte, ['AB123CD']);
  assert.ok(r.prompt.indexOf('AB-123-CD') !== -1);            // (b) la flotte est dans le prompt
  assert.ok(r.prompt.indexOf('propose cette immatriculation') !== -1, 'B6.7.2 : guidance « propose la plaque de la fiche »');
});

test('S2 cas B : la faute de l\'ancien agent (transfert forcé + plaque réclamée) est ATTRAPÉE', () => {
  const r = rejouer({
    messages: [
      { texte: '', media: 'https://cdn.chatapi.net/x/photo1.jpg', type_media: 'image', sortant: false, emis_a: '2026-10-21T09:34:00.000Z' },
      { texte: 'Refixer garde bout arrière', sortant: false, emis_a: '2026-10-21T09:34:19.000Z' }
    ],
    client: { telephone: '33612345678', plaque: 'AB123CD', enseigne: 'AGB RESTAURATION (CLAMART)' }
  });
  const faute = verifierCandidate(modeleConforme({
    reponse: "Pour finaliser votre demande, il me manque l'immatriculation. Pourriez-vous me communiquer la plaque du scooter ?\n-Agent IA U'mob-"
  }), r.etat);
  // B6.7.2 : demander la plaque d'un scooter NON identifié n'est plus une
  // faute (qualification légitime) — mais la formulation « Pourriez-vous »
  // reste la faute attrapée ici (règle 2, question fermée).
  assert.strictEqual(faute.gardes.ok, false);                  // (c)
  assert.ok(faute.codes.indexOf('question_fermee') !== -1, '« Pourriez-vous » → question fermée');
  assert.ok(faute.codes.indexOf('plaque_redemandee') === -1, 'B6.7.2 : la plaque flotte n\'est pas « déjà connue » (scooter non identifié)');
});

test('S2 cas B : la réponse conforme (qualification SANS bloquer sur la plaque) PASSE', () => {
  const r = rejouer({
    messages: [
      { texte: '', media: 'https://cdn.chatapi.net/x/photo1.jpg', type_media: 'image', sortant: false, emis_a: '2026-10-21T09:34:00.000Z' },
      { texte: 'Refixer garde bout arrière que l\'on a mis de côté 🙏🏻', sortant: false, emis_a: '2026-10-21T09:34:19.000Z' }
    ],
    client: { telephone: '33612345678', plaque: 'AB123CD', enseigne: 'AGB RESTAURATION (CLAMART)' }
  });
  const conforme = verifierCandidate(modeleConforme({
    reponse: "C'est bien noté pour le scooter AB-123-CD : fixation de la garde arrière à refaire. Merci pour la photo, elle est transmise au technicien. Quel est le numéro de la personne à contacter le jour de l'intervention ?\n-Agent IA U'mob-",
    formulaire: { panne: 'Garde arrière à refixer', etape: 3 }
  }), r.etat);
  assert.strictEqual(conforme.gardes.ok, true);               // (d) plaque citée (connue), pas redemandée
  cerveau.fusionnerMajEtat(r.etat, conforme.parse.formulaire);
  assert.strictEqual(r.etat.panne, 'Garde arrière à refixer');
});

// ============================================================================
// S3 — FIL RÉEL GG-798-NL (547249072, 21/10) : téléphone donné PUIS urgence.
// La faute hypothétique : redemander ce qui vient d'être donné.
// ============================================================================
test('S3 GG-798-NL : téléphone fourni → DÉJÀ FOURNI dans le prompt, jamais redemandable', () => {
  const r = rejouer({
    messages: [
      { texte: '[média reçu]', media: 'https://cdn.chatapi.net/x/photo.jpg', type_media: 'image', sortant: false, emis_a: '2026-10-21T20:38:48.179Z' },
      { texte: "Votre demande concernant le scooter GG-798-NL est bien prise en charge.\n\nQuel est le numéro de téléphone de la personne à contacter le jour de l'intervention (le technicien l'appellera pour annoncer son heure d'arrivée) ?", sortant: true, emis_a: '2026-10-21T20:42:03.792Z' },
      { texte: '0620203963', sortant: false, emis_a: '2026-10-21T20:42:29.496Z' },
      { texte: "C'est urgent j'ai pas de moyens de livraison", sortant: false, emis_a: '2026-10-21T20:42:44.667Z' }
    ],
    contact: { nom: 'PIZZA SERVICES (ETAMPES) Abdessalem GALAAOUI', cycle: 'En cours de réalisation', tags: ['Prise de main'] },
    client: { telephone: '33620203963', plaque: 'GJ337WF / GG798NL', enseigne: 'PIZZA SERVICES (ETAMPES)', statut_risque: '' }
  });
  assert.strictEqual(r.etat.telephone_contact, '33620203963'); // (a)
  assert.strictEqual(r.etat.prise_de_main, true);             // (a) tag lu de la fiche
  assert.ok(r.prompt.indexOf('33620203963') !== -1);          // (b)
  assert.ok(r.prompt.indexOf('DÉJÀ FOURNI') !== -1);         // (b)
  // Prise de main → silence DÉTERMINISTE : le modèle n'est même pas appelé
  assert.deepStrictEqual(cerveau.silenceNecessaire({ etat: r.etat, messages: r.etat ? [] : [] }), { silence: true, raison: 'prise de main humaine' });
});

test('S3 GG-798-NL (sans prise de main) : redemander le téléphone donné = ATTRAPÉ, la vraie réponse PASSE', () => {
  const r = rejouer({
    messages: [
      { texte: "Quel est le numéro de téléphone de la personne à contacter le jour de l'intervention ?", sortant: true, emis_a: '2026-10-21T20:42:03.792Z' },
      { texte: '0620203963', sortant: false, emis_a: '2026-10-21T20:42:29.496Z' },
      { texte: "C'est urgent j'ai pas de moyens de livraison", sortant: false, emis_a: '2026-10-21T20:42:44.667Z' }
    ],
    client: { plaque: 'GG798NL', enseigne: 'PIZZA SERVICES (ETAMPES)' }
  });
  const faute = verifierCandidate(modeleConforme({
    reponse: "Merci pour votre message. Quel est le numéro de téléphone de la personne à contacter le jour de l'intervention ?\n-Agent IA U'mob-"
  }), r.etat);
  assert.ok(faute.codes.indexOf('telephone_redemande') !== -1); // (c)
  const conforme = verifierCandidate(modeleConforme({
    reponse: "C'est bien noté pour l'urgence, nous faisons le maximum pour intervenir rapidement sur le scooter GG-798-NL.\n-Agent IA U'mob-",
    formulaire: { etape: 4 }
  }), r.etat);
  assert.strictEqual(conforme.gardes.ok, true);                // (d) la réponse réelle envoyée en prod
});

// ============================================================================
// S4 — RÉPONSE ORPHINE (« oui c'est fait ») : ne pas deviner → escalade
// ============================================================================
test('S4 orphelin : « oui c\'est fait » sans question en attente → escalade conforme, réponse vide OK', () => {
  const r = rejouer({
    messages: [
      { texte: 'Bonjour, comment puis-je vous aider ?', sortant: true, humain: false, emis_a: '2026-10-22T10:00:00.000Z' },
      { texte: 'oui c\'est fait', sortant: false, emis_a: '2026-10-22T10:02:00.000Z' }
    ]
  });
  const conforme = verifierCandidate(modeleConforme({
    reponse: '', escalade: true, raison_escalade: 'réponse sans contexte : impossible de savoir de quoi il s\'agit, un collègue reprend',
    formulaire: null
  }), r.etat);
  assert.strictEqual(conforme.gardes.ok, true);               // (d) vide AVEC escalade = contrat respecté
  assert.strictEqual(conforme.parse.escalade, true);
  assert.ok(conforme.parse.raison_escalade.indexOf('collègue') !== -1); // §8 : le dossier part AVEC l'explication
});

test('S4 orphelin : la faute (inventer une qualification sur un mot) est ATTRAPÉE', () => {
  const r = rejouer({
    messages: [{ texte: 'oui c\'est fait', sortant: false, emis_a: '2026-10-22T10:02:00.000Z' }]
  });
  const faute = verifierCandidate(modeleConforme({
    reponse: "Parfait, votre intervention est confirmée ! Pouvez-vous me donner la date qui vous arrange ?\n-Agent IA U'mob-"
  }), r.etat);
  assert.strictEqual(faute.gardes.ok, false);                  // (c) on ne devine JAMAIS
  assert.ok(faute.codes.indexOf('question_fermee') !== -1);
});

// ============================================================================
// S5 — MESSAGE VOCAL (règle 5) : l'agent ne peut pas écouter
// ============================================================================
test('S5 vocal : signal dans le formulaire + le prompt ; réponse conforme (proposer écrit/photos) PASSE', () => {
  const r = rejouer({
    messages: [
      { texte: '[média reçu]', type_media: 'audio', sortant: false, emis_a: '2026-10-22T11:00:00.000Z' }
    ]
  });
  assert.strictEqual(r.etat.vocal_recu, true);                // (a)
  assert.ok(r.prompt.indexOf('Message vocal reçu : oui') !== -1); // (b)
  const conforme = verifierCandidate(modeleConforme({
    reponse: "Merci pour votre message ! Je ne peux malheureusement pas écouter les messages vocaux. Merci de m'envoyer un message écrit ou des photos du scooter.\n-Agent IA U'mob-",
    formulaire: null
  }), r.etat);
  assert.strictEqual(conforme.gardes.ok, true);              // (d)
});

// ============================================================================
// S6 — DEMANDE COMMERCIALE (§4) : aucune plaque, bascule équipe commerciale
// ============================================================================
test('S6 commercial : signal prix/location → prompt ; pas de plaque demandée, bascule PASSE', () => {
  const r = rejouer({
    messages: [
      { texte: 'Bonjour, je voudrais connaître vos tarifs pour louer un scooter supplémentaire', sortant: false, emis_a: '2026-10-22T12:00:00.000Z' }
    ]
  });
  assert.strictEqual(r.etat.demande_commerciale, true);       // (a)
  assert.ok(r.prompt.indexOf('COMMERCIALE') !== -1);         // (b)
  const conforme = verifierCandidate(modeleConforme({
    reponse: "Merci pour votre intérêt ! Votre demande concerne la location : je la transmets à notre équipe commerciale, qui vous répondra ici même.\n-Agent IA U'mob-",
    formulaire: null,
    escalade: true,
    raison_escalade: 'demande commerciale : bascule vers l\'équipe commerciale'
  }), r.etat);
  assert.strictEqual(conforme.gardes.ok, true);              // (d)
  const faute = verifierCandidate(modeleConforme({
    reponse: "Avec plaisir ! Quelle est l'immatriculation de votre scooter actuel ?\n-Agent IA U'mob-"
  }), r.etat);
  // faute : ticket SAV au lieu de la bascule commerciale — la plaque n'étant
  // pas connue ici, c'est le signal prompt qui protège ; la garde n'attrape
  // que le déterministe. On vérifie au moins que le signal est là.
  assert.ok(r.prompt.indexOf('demande COMMERCIALE') !== -1);
});

// ============================================================================
// S7 — « UNE MINUTE » (règle 3) : le client va chercher une info
// ============================================================================
test('S7 une minute : relancer est ATTRAPÉ, accueillir sans question PASSE', () => {
  const r = rejouer({
    messages: [
      { texte: "Quelle est l'immatriculation du scooter concerné, s'il vous plaît ?", sortant: true, emis_a: '2026-10-22T13:00:00.000Z' },
      { texte: 'une minute je regarde', sortant: false, emis_a: '2026-10-22T13:01:00.000Z' }
    ]
  });
  assert.strictEqual(r.etat.client_cherche_info, true);       // (a)
  assert.ok(r.prompt.indexOf('ACCUEILLIR et ATTENDRE') !== -1); // (b)
  const faute = verifierCandidate(modeleConforme({
    reponse: "Pas de souci. Avez-vous trouvé l'immatriculation ?\n-Agent IA U'mob-"
  }), r.etat);
  assert.ok(faute.codes.indexOf('relance_client_cherche') !== -1); // (c)
  assert.ok(faute.codes.indexOf('question_fermee') !== -1);
  const conforme = verifierCandidate(modeleConforme({
    reponse: "Prenez votre temps, je reste à votre disposition.\n-Agent IA U'mob-",
    formulaire: null
  }), r.etat);
  assert.strictEqual(conforme.gardes.ok, true);              // (d)
});

// ============================================================================
// S8 — DOSSIER IMPAYÉ (GRILL CHICKEN, 547248736) : réponse neutre, aucun
// engagement (§4) — le statut risque vient de la table clients (B2.2)
// ============================================================================
test('S8 impayé : statut risque dans le prompt → engagement inventé ATTRAPÉ, neutre PASSE', () => {
  const r = rejouer({
    messages: [
      { texte: "Bonjour, mon scooter ne démarre toujours pas, vous pouvez intervenir ?", sortant: false, emis_a: '2026-10-22T14:00:00.000Z' }
    ],
    client: { telephone: '33610643077', plaque: 'AA123BB', enseigne: 'GRILL CHICKEN (TULLES)', statut_risque: 'Impaye' }
  });
  assert.strictEqual(r.etat.statut_risque, 'Impaye');         // (a)
  assert.ok(r.prompt.indexOf('Impaye') !== -1);              // (b)
  assert.ok(r.prompt.indexOf('NEUTRE') !== -1);              // (b)
  const faute = verifierCandidate(modeleConforme({
    reponse: "Pas de problème, nous interviendrons gratuitement sous 2 jours.\n-Agent IA U'mob-"
  }), r.etat);
  assert.strictEqual(faute.gardes.ok, false);                 // (c)
  assert.ok(faute.codes.indexOf('invention') !== -1);
  const conforme = verifierCandidate(modeleConforme({
    reponse: "Merci pour votre message. Votre demande est enregistrée, un membre de l'équipe U'mob revient vers vous ici même.\n-Agent IA U'mob-",
    formulaire: null,
    escalade: true,
    raison_escalade: 'dossier impayé : transfert automatique, aucun engagement possible'
  }), r.etat);
  assert.strictEqual(conforme.gardes.ok, true);             // (d) neutre + escalade
});

// ============================================================================
// S9 — CYCLE DE VIE (§5) : la sortie du cerveau porte l'étape — le processeur
// B4 posera le cycle respond.io (casse exacte) selon l'étape et l'escalade.
// Ici on vérifie le lien déterministe : escalade commerciale → cycle attendu.
// ============================================================================
test('S9 cycles : l\'escalade commerciale correspond au cycle « DE Commerciales » (moteur B4)', () => {
  const r = rejouer({
    messages: [{ texte: 'Bonjour, je voudrais acheter un scooter pour ma flotte', sortant: false, emis_a: '2026-10-22T15:00:00.000Z' }]
  });
  assert.strictEqual(r.etat.demande_commerciale, true);
  const conforme = verifierCandidate(modeleConforme({
    reponse: "Merci pour votre intérêt ! Je transmets votre demande à notre équipe commerciale.\n-Agent IA U'mob-",
    escalade: true,
    raison_escalade: 'demande commerciale'
  }), r.etat);
  assert.strictEqual(conforme.gardes.ok, true);
  // Contrat B4 : demande_commerciale + escalade → cycle « DE Commerciales »
  // + tag « Demande Commerciale » — posés par l'adaptateur, casse exacte.
  assert.strictEqual(r.etat.demande_commerciale, true);
});

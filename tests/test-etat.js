// ============================================================================
// Agent SAV U'mob v2 — B3.1 : tests de l'état structuré (node --test)
// Exécution : node --test tests/test-etat.js
// (aucune dépendance, aucun réseau — les scénarios rejouent les VRAIES
//  conversations et incidents documentés du journal)
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const lib = require('../lib/etat.js');

// ============================================================================
// 1) FORMULAIRE ET FORMATAGE
// ============================================================================

test('etatVierge : forme du formulaire', () => {
  const e = lib.etatVierge();
  assert.strictEqual(e.etape, 1);
  assert.deepStrictEqual(e.plaques, []);
  assert.strictEqual(e.panne, '');
  assert.strictEqual(e.photos, false);
  assert.strictEqual(e.vocal_recu, false);
  assert.strictEqual(e.telephone_contact, '');
  assert.deepStrictEqual(e.telephones_connus, []);
  assert.strictEqual(e.client_cherche_info, false);
  assert.strictEqual(e.campagne_push, false);
  assert.strictEqual(e.demande_commerciale, false);
  assert.strictEqual(e.prise_de_main, false);
  assert.strictEqual(e.dernier_sortant, '');
});

test('formaterPlaque : canonique → lisible (pour les récapitulatifs)', () => {
  assert.strictEqual(lib.formaterPlaque('gg-798-nl'), 'GG-798-NL');
  assert.strictEqual(lib.formaterPlaque('GG798NL'), 'GG-798-NL');
  assert.strictEqual(lib.formaterPlaque('GJ 337 WF'), 'GJ-337-WF');
});

// ============================================================================
// 2) EXTRACTION PLAQUES (règles 1, 4, 7)
// ============================================================================

test('extrairePlaques : formes réelles clients (casse/séparateurs variés)', () => {
  assert.deepStrictEqual(lib.extrairePlaques('mon scooter GG-798-nl ne démarre plus'), ['GG798NL']);
  assert.deepStrictEqual(lib.extrairePlaques('gg798nl'), ['GG798NL']);
  assert.deepStrictEqual(lib.extrairePlaques('la GJ 337 WF aussi'), ['GJ337WF']);
  assert.deepStrictEqual(lib.extrairePlaques('GG-798-NL et GJ-337-WF'), ['GG798NL', 'GJ337WF']);
});

test('extrairePlaques : AUCUN faux positif (règle 7 pièges réels)', () => {
  assert.deepStrictEqual(lib.extrairePlaques('ça fait et 123 ou plus 1000€ par mois'), []);
  assert.deepStrictEqual(lib.extrairePlaques('3 mois en panne'), []);
  assert.deepStrictEqual(lib.extrairePlaques('0620203963'), []);
  assert.deepStrictEqual(lib.extrairePlaques('https://cdn.chatapi.net/whatsapp_business/558644/2597dd9727141a6d908b73aa012f9d3fimage1792615131346.jpg'), []);
  assert.deepStrictEqual(lib.extrairePlaques('un il ou au'), []);
});

test('extrairePlaques : apostrophe typographique ne casse rien', () => {
  assert.deepStrictEqual(lib.extrairePlaques("c'est le GG–798–NL (tirets longs)"), ['GG798NL']);
});

// ============================================================================
// 3) EXTRACTION TÉLÉPHONES
// ============================================================================

test('extraireTelephones : formes réelles (06…, +33, 0033, espaces)', () => {
  assert.deepStrictEqual(lib.extraireTelephones('0620203963'), ['33620203963']);
  assert.deepStrictEqual(lib.extraireTelephones('06 20 20 39 63'), ['33620203963']);
  assert.deepStrictEqual(lib.extraireTelephones('06.20.20.39.63'), ['33620203963']);
  assert.deepStrictEqual(lib.extraireTelephones('+33610643077'), ['33610643077']);
  assert.deepStrictEqual(lib.extraireTelephones('0033612345678'), ['33612345678']);
});

test('extraireTelephones : jamais dans un nombre plus long (garde)', () => {
  assert.deepStrictEqual(lib.extraireTelephones('1792615349496'), []);
  assert.deepStrictEqual(lib.extraireTelephones('10620203963'), []);
  assert.deepStrictEqual(lib.extraireTelephones('plaque GG-798-NL'), []);
});

// ============================================================================
// 4) REJEU DU FIL RÉEL GG-798-NL (contact 547249072, prod validée 22/10)
// ============================================================================

test('reconstruireEtat : fil réel GG-798-NL — photo, demande tél, réponse client', () => {
  const msgs = [
    { texte: '[média reçu]', media: 'https://cdn.chatapi.net/whatsapp_business/558644/547249072/2597dd9727141a6d908b73aa012f9d3fimage1792615131346.jpg', type_media: 'image', sortant: false },
    { texte: "Votre demande concernant le scooter GG-798-NL est bien prise en charge. Voici le récapitulatif :\nScooter : GG-798-NL (PIZZA SERVICES, Étampes)\nProblème : démarre mais n'avance pas (moteur silencieux, interrupteur sous la selle en marche)\nPhotos reçues : tableau de bord et connexion batterie/faisceau\n\nQuel est le numéro de téléphone de la personne à contacter le jour de l'intervention (le technicien l'appellera pour annoncer son heure d'arrivée) ?", sortant: true },
    { texte: '0620203963', sortant: false },
    { texte: "C'est urgent j'ai pas de moyens de livraison", sortant: false },
    { texte: "Voici ce que nous pouvons faire pour vous...", sortant: true }
  ];
  const e = lib.reconstruireEtat(msgs);
  assert.strictEqual(e.photos, true);
  assert.deepStrictEqual(e.plaques, ['GG798NL']);      // connue du dossier → jamais redemandée
  assert.strictEqual(e.telephone_contact, '33620203963'); // demandé PUIS fourni → enregistré
  assert.deepStrictEqual(e.telephones_connus, ['33620203963']);
  assert.strictEqual(e.client_cherche_info, false);
  assert.strictEqual(e.campagne_push, false);          // les sortants portent la signature
});

test('reconstruireEtat : plaque donnée par le client → dédupliquée, casse normalisée', () => {
  const e = lib.reconstruireEtat([
    { texte: 'Bonjour mon scooter GG-798-nl démarre mais avance pas', sortant: false },
    { texte: "C'est noté. Quelle est le problème exactement ?", sortant: true },
    { texte: 'GG-798-NL toujours pareil', sortant: false }
  ]);
  assert.deepStrictEqual(e.plaques, ['GG798NL']);
});

test('reconstruireEtat : téléphone fourni SANS demande → connu, pas contact', () => {
  const e = lib.reconstruireEtat([{ texte: 'mon numéro est 06 20 20 39 63', sortant: false }]);
  assert.deepStrictEqual(e.telephones_connus, ['33620203963']);
  assert.strictEqual(e.telephone_contact, ''); // on ne devine pas — le cerveau demande si utile
});

test('reconstruireEtat : téléphone contact DÉJÀ fourni → jamais écrasé', () => {
  const e = lib.reconstruireEtat([
    { texte: "Quel est le numéro de la personne à contacter le jour de l'intervention ?", sortant: true },
    { texte: '0620203963', sortant: false },
    { texte: 'on peut aussi appeler le 06 99 88 77 66', sortant: false }
  ]);
  assert.strictEqual(e.telephone_contact, '33620203963');
  assert.deepStrictEqual(e.telephones_connus, ['33620203963', '33699887766']);
});

// ============================================================================
// 5) RÈGLES DURES EN FORMULAIRE
// ============================================================================

test('règle 3 : « une minute » → client_cherche_info ; retour du client → tombé', () => {
  let e = lib.reconstruireEtat([{ texte: 'une minute je regarde', sortant: false }]);
  assert.strictEqual(e.client_cherche_info, true);
  e = lib.reconstruireEtat([
    { texte: 'une minute je regarde', sortant: false },
    { texte: 'GG-798-NL compteur HS', sortant: false }
  ]);
  assert.strictEqual(e.client_cherche_info, false);
});

test('règle 5 : message vocal → vocal_recu (pas une photo)', () => {
  const e = lib.reconstruireEtat([{ texte: '[média reçu]', type_media: 'audio', sortant: false }]);
  assert.strictEqual(e.vocal_recu, true);
  assert.strictEqual(e.photos, false);
});

test('règle 7 : plusieurs scooters → TOUTES les plaques dans le formulaire', () => {
  const e = lib.reconstruireEtat([
    { texte: 'GG-798-NL ne démarre plus et GJ-337-WF a la batterie qui ne charge plus', sortant: false }
  ]);
  assert.deepStrictEqual(e.plaques, ['GG798NL', 'GJ337WF']);
});

// ============================================================================
// 6) PUSH CAMPAGNE (portage v124 — incident AGB RESTAURATION documenté)
// ============================================================================

test('estPushCampagne : vocab campagne SANS signature → push ; signature → pas un push', () => {
  assert.strictEqual(lib.estPushCampagne('Notre technicien tourne prochainement dans votre secteur, souhaitez-vous une intervention ?'), true);
  assert.strictEqual(lib.estPushCampagne("Bonjour ! Voici ce que nous pouvons faire pour vous...\n-Agent IA U'mob-"), false);
  assert.strictEqual(lib.estPushCampagne('Bonjour, comment puis-je vous aider ?'), false);
  assert.strictEqual(lib.estPushCampagne(''), false);
});

test('campagne_push : réponse du client juste après un push → signalé (incident AGB)', () => {
  const e = lib.reconstruireEtat([
    { texte: 'Notre technicien tourne prochainement dans votre secteur, un passage est prévu bientôt.', sortant: true },
    { texte: 'Bonjour. Aucune idée. Rien a été changé la fois dernière', sortant: false }
  ]);
  assert.strictEqual(e.campagne_push, true);
});

test('campagne_push : l agent répond pour de vrai → le marqueur tombe', () => {
  const e = lib.reconstruireEtat([
    { texte: 'Notre technicien tourne prochainement dans votre secteur.', sortant: true },
    { texte: 'Bonjour. Aucune idée.', sortant: false },
    { texte: "Merci pour votre retour. Quelle est l'immatriculation du scooter concerné, s'il vous plaît ?\n-Agent IA U'mob-", sortant: true },
    { texte: 'GG-798-NL', sortant: false }
  ]);
  assert.strictEqual(e.campagne_push, false);
  assert.deepStrictEqual(e.plaques, ['GG798NL']);
});

// ============================================================================
// 7) SIGNAUX COMMERCiaux / FICHE / TABLE CLIENTS
// ============================================================================

test('demande_commerciale : signal mots-clés seulement (pas de false positive SAV)', () => {
  const e = lib.reconstruireEtat([{ texte: 'Bonjour, je voudrais connaître vos tarifs pour louer un scooter', sortant: false }]);
  assert.strictEqual(e.demande_commerciale, true);
  const e2 = lib.reconstruireEtat([{ texte: "Mon scooter GG-798-NL ne démarre plus, j'ai payé pour réparer", sortant: false }]);
  assert.strictEqual(e2.demande_commerciale, false);
});

test('appliquerFiche : tags « Prise de main » et « Demande Commerciale »', () => {
  let e = lib.etatVierge();
  lib.appliquerFiche(e, { nom: 'X (VILLE)', cycle: 'A qualifier', tags: ['Prise de main', 'imported_x'] });
  assert.strictEqual(e.prise_de_main, true);
  assert.strictEqual(e.nom, 'X (VILLE)');
  e = lib.etatVierge();
  lib.appliquerFiche(e, { nom: 'Y', tags: ['Demande Commerciale'] });
  assert.strictEqual(e.demande_commerciale, true);
});

test('appliquerClient : plaques flotte groupées + enseigne + statut risque (PIZZA SERVICES réel)', () => {
  const e = lib.etatVierge();
  lib.appliquerClient(e, {
    telephone: '33620203963',
    plaque: 'GJ337WF / GG798NL',
    enseigne: 'PIZZA SERVICES (ETAMPES)',
    statut_risque: 'Impaye'
  });
  assert.deepStrictEqual(e.plaques, ['GJ337WF', 'GG798NL']);
  assert.strictEqual(e.enseigne, 'PIZZA SERVICES (ETAMPES)');
  assert.strictEqual(e.statut_risque, 'Impaye');
});

test('appliquerClient : fusion sans doublon avec les plaques de la conversation', () => {
  const e = lib.reconstruireEtat([{ texte: 'GG-798-nl ne démarre plus', sortant: false }]);
  lib.appliquerClient(e, { plaque: 'GJ337WF / GG798NL' });
  assert.deepStrictEqual(e.plaques, ['GG798NL', 'GJ337WF']);
});

// ============================================================================
// 8) INTÉGRATION B2.1 — etatDepuisContexte (forme EXACTE du JSON /api/contexte)
// ============================================================================

test('etatDepuisContexte : le JSON réel du contact 547249072 → formulaire complet', () => {
  const ctx = {
    contact: {
      nom: 'PIZZA SERVICES (ETAMPES) Abdessalem GALAAOUI',
      cycle: 'En cours de réalisation',
      tags: ['imported_20260929_090947', 'Prise de main'],
      erreur: null
    },
    messages: [
      { id: '1792615128179000', ts: 1792615128179, emis_a: '2026-10-21T20:38:48.179Z', texte: '[média reçu]', media: 'https://cdn.chatapi.net/whatsapp_business/558644/547249072/2597dd9727141a6d908b73aa012f9d3fimage1792615131346.jpg', type_media: '', sortant: false, humain: false },
      { id: '1792615322941727', ts: 1792615323792, emis_a: '2026-10-21T20:42:03.792Z', texte: "Votre demande concernant le scooter GG-798-NL est bien prise en charge. Voici le récapitulatif :\nScooter : GG-798-NL (PIZZA SERVICES, Étampes)\n\nQuel est le numéro de téléphone de la personne à contacter le jour de l'intervention (le technicien l'appellera pour annoncer son heure d'arrivée) ?", media: '', type_media: '', sortant: true, humain: false },
      { id: '1792615349496000', ts: 1792615349496, emis_a: '2026-10-21T20:42:29.496Z', texte: '0620203963', media: '', type_media: '', sortant: false, humain: false },
      { id: '1792615364667000', ts: 1792615364667, emis_a: '2026-10-21T20:42:44.667Z', texte: "C'est urgent j'ai pas de moyens de livraison", media: '', type_media: '', sortant: false, humain: false },
      { id: '1792615529532930', ts: 1792615530372, emis_a: '2026-10-21T20:45:30.372Z', texte: "Voici ce que nous pouvons faire pour vous :\n\nTÉLÉPHONE À CONTACTER : Abdessalem au 06 20 20 39 63 (le technicien l'appellera pour annoncer son heure d'arrivée)\n-Agent IA U'mob-", media: '', type_media: '', sortant: true, humain: false }
    ],
    commentaires: [],
    avertissements: ['commentaires : 404 — non lisibles via l\'API respond.io (aucun endpoint GET, seule la création existe)'],
    brut: null
  };
  const e = lib.etatDepuisContexte(ctx);
  assert.strictEqual(e.prise_de_main, true);
  assert.strictEqual(e.nom, 'PIZZA SERVICES (ETAMPES) Abdessalem GALAAOUI');
  assert.strictEqual(e.photos, true);
  assert.deepStrictEqual(e.plaques, ['GG798NL']);
  assert.strictEqual(e.telephone_contact, '33620203963');
  assert.strictEqual(e.campagne_push, false);
});

test('etatDepuisContexte : contexte vide → formulaire vierge, jamais de crash', () => {
  const e = lib.etatDepuisContexte(null);
  assert.strictEqual(e.etape, 1);
  assert.deepStrictEqual(e.plaques, []);
});

// ============================================================================
// B6.3 — PUSH CAMPAGNE : vocabulaire COMPLET v2.20.116
// ============================================================================
test('B6.3 estPushCampagne : « technicien … secteur » → PUSH', () => {
  assert.strictEqual(lib.estPushCampagne("Un technicien passe prochainement dans votre secteur."), true);
  assert.strictEqual(lib.estPushCampagne("Notre technicien intervient dans votre secteur cette semaine."), true);
});

test('B6.3 estPushCampagne : « pneus ou plaquettes » → PUSH', () => {
  assert.strictEqual(lib.estPushCampagne("Besoin de pneus ou plaquettes ? Profitez de notre passage."), true);
});

test('B6.3 estPushCampagne : « tout autre besoin » → PUSH', () => {
  assert.strictEqual(lib.estPushCampagne("Pour tout autre besoin, répondez à ce message."), true);
});

test('B6.3 estPushCampagne : « dans le cadre de votre maintenance » → PUSH', () => {
  assert.strictEqual(lib.estPushCampagne("Dans le cadre de votre maintenance, nous vous proposons un contrôle gratuit."), true);
});

test('B6.3 estPushCampagne : RÉTRO-COMPAT — l ancien vocabulaire B3.1 reste un PUSH', () => {
  assert.strictEqual(lib.estPushCampagne('Notre équipe tourne prochainement dans votre secteur'), true);
  assert.strictEqual(lib.estPushCampagne('Passage programmé la semaine prochaine'), true);
});

test('B6.3 estPushCampagne : signature « Agent IA U mob » → JAMAIS un push (règle inchangée)', () => {
  assert.strictEqual(lib.estPushCampagne("Bonjour, dans le cadre de votre maintenance je regarde.\n-Agent IA U'mob-"), false);
  assert.strictEqual(lib.estPushCampagne("Le technicien est dans votre secteur.\n-Agent IA U'mob-"), false);
});

test('B6.3 estPushCampagne : message neutre → pas un push', () => {
  assert.strictEqual(lib.estPushCampagne("Merci pour votre message, nous revenons vers vous."), false);
  assert.strictEqual(lib.estPushCampagne(""), false);
});

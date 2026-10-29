// ============================================================================
// Agent SAV U'mob v2 — B3.3 : tests des gardes (node --test)
// Exécution : node --test tests/test-gardes.js
// (aucune dépendance — chaque garde est rejouée contre les incidents réels
//  documentés de l'ancien agent, et les VRAIES réponses validées en prod
//  doivent PASSER)
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const gardes = require('../lib/gardes.js');
const etatLib = require('../lib/etat.js');

function etatAvec(maj) {
  const e = etatLib.etatVierge();
  return Object.assign(e, maj || {});
}

function codes(resultat) {
  return resultat.fautes.map(function (f) { return f.code; });
}

// ============================================================================
// G1 — SIGNATURE (règle 8)
// ============================================================================

test('G1 : signature manquante → faute', () => {
  const r = gardes.verifier({ reponse: 'Bonjour, comment puis-je vous aider ?', etat: etatViergeF() });
  assert.strictEqual(r.ok, false);
  assert.ok(codes(r).indexOf('signature') !== -1);
  assert.ok(r.fautes[0].rappel.indexOf('Agent IA U') !== -1); // rappel précis pour la régénération
});

test('G1 : signature présente (apostrophe typographique tolérée) → ok', () => {
  const r = gardes.verifier({ reponse: "Bonjour, je regarde votre demande.\n-Agent IA U'mob-", etat: etatViergeF() });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.fautes, []);
});

function etatViergeF() { return etatLib.etatVierge(); }

// ============================================================================
// G2 — QUESTION FERMÉE (règle 2)
// ============================================================================

test('G2 : « Pouvez-vous me donner la plaque ? » → faute (question fermée)', () => {
  const r = gardes.verifier({ reponse: "Pouvez-vous me donner l'immatriculation ?\n-Agent IA U'mob-", etat: etatViergeF() });
  assert.ok(codes(r).indexOf('question_fermee') !== -1);
});

test("G2 : « Quelle est l'immatriculation du scooter concerné, s'il vous plaît ? » → question OUVERTE, ok", () => {
  const r = gardes.verifier({ reponse: "Quelle est l'immatriculation du scooter concerné, s'il vous plaît ?\n-Agent IA U'mob-", etat: etatViergeF() });
  assert.strictEqual(r.ok, true);
});

test('G2 : « Est-ce que tout est correct ? » → exception explicite du récap, ok', () => {
  const r = gardes.verifier({ reponse: "Voici le récapitulatif : scooter GG-798-NL, panne moteur silencieux. Est-ce que tout est correct ?\n-Agent IA U'mob-", etat: (function () { const e = etatLib.etatVierge(); e.plaques = ['GG798NL']; return e; })() });
  assert.strictEqual(r.ok, true);
});

test('G2 : « Vous pouvez essayer de basculer le disjoncteur » → PAS une question fermée', () => {
  const r = gardes.verifier({ reponse: "Vous pouvez essayer de basculer le disjoncteur sous la selle (position OFF puis ON).\n-Agent IA U'mob-", etat: etatViergeF() });
  assert.strictEqual(r.ok, true);
});

// ============================================================================
// G3 — INVENTION : prix, délai chiffré, « gratuit » (règle 9)
// ============================================================================

test('G3 : prix inventé (150€), « gratuit », délai chiffré (« sous 2 jours ») → fautes', () => {
  const r1 = gardes.verifier({ reponse: "La réparation coûtera 150€.\n-Agent IA U'mob-", etat: etatViergeF() });
  assert.ok(codes(r1).indexOf('invention') !== -1);
  const r2 = gardes.verifier({ reponse: "C'est gratuit, nous prenons en charge.\n-Agent IA U'mob-", etat: etatViergeF() });
  assert.ok(codes(r2).indexOf('invention') !== -1);
  const r3 = gardes.verifier({ reponse: "Le technicien passera sous 2 jours.\n-Agent IA U'mob-", etat: etatViergeF() });
  assert.ok(codes(r3).indexOf('invention') !== -1);
});

test('G3 : « intervenir rapidement », « dans les plus brefs délais » → ok (pas chiffré)', () => {
  const r = gardes.verifier({ reponse: "Nous faisons le maximum pour intervenir rapidement.\n-Agent IA U'mob-", etat: etatViergeF() });
  assert.strictEqual(r.ok, true);
});

// ============================================================================
// G4 — PLAQUE REDEMANDÉE ALORS QUE CONNUE (règle 1/4 — la faute n°1 historique)
// ============================================================================

test('G4 : plaque connue + redemandée → faute (faute n°1 de l\'ancien agent)', () => {
  const etat = etatAvec({ plaques: ['GG798NL'] });
  const r = gardes.verifier({ reponse: "Quelle est l'immatriculation du scooter concerné, s'il vous plaît ?\n-Agent IA U'mob-", etat: etat });
  assert.ok(codes(r).indexOf('plaque_redemandee') !== -1);
  assert.ok(r.fautes[0].rappel.indexOf('GG-798-NL') !== -1); // le rappel cite la plaque
});

test('G4 : plaque inconnue + question identification → ok (étape 2 normale)', () => {
  const r = gardes.verifier({ reponse: "Quelle est l'immatriculation du scooter concerné, s'il vous plaît ?\n-Agent IA U'mob-", etat: etatViergeF() });
  assert.strictEqual(r.ok, true);
});

test('G4 : récap qui CITE la plaque connue → ok (citer ≠ redemander)', () => {
  const etat = etatAvec({ plaques: ['GG798NL'] });
  const r = gardes.verifier({ reponse: "Votre demande concernant le scooter GG-798-NL est bien prise en charge.\n-Agent IA U'mob-", etat: etat });
  assert.strictEqual(r.ok, true);
});

// ============================================================================
// G5 — TÉLÉPHONE REDEMANDÉ ALORS QUE FOURNI (règle 1/6)
// ============================================================================

test('G5 : téléphone fourni + redemandé → faute', () => {
  const etat = etatAvec({ telephone_contact: '33620203963' });
  const r = gardes.verifier({ reponse: "Quel est le numéro de la personne à contacter le jour de l'intervention ?\n-Agent IA U'mob-", etat: etat });
  assert.ok(codes(r).indexOf('telephone_redemande') !== -1);
});

test('G5 : téléphone manquant + demande légitime → ok (seule info qui bloque)', () => {
  const r = gardes.verifier({ reponse: "Quel est le numéro de la personne à contacter le jour de l'intervention ?\n-Agent IA U'mob-", etat: etatViergeF() });
  assert.strictEqual(r.ok, true);
});

// ============================================================================
// G6 — RÉCAP MULTI-SCOOTERS INCOMPLET (règle 7)
// ============================================================================

test("G6 : 2 scooters connus, récap qui n'en cite qu'un → faute", () => {
  const etat = etatAvec({ plaques: ['GG798NL', 'GJ337WF'] });
  const r = gardes.verifier({ reponse: "Voici le récapitulatif :\nScooter : GG-798-NL (compteur)\nEst-ce que tout est correct ?\n-Agent IA U'mob-", etat: etat });
  assert.ok(codes(r).indexOf('recap_incomplet') !== -1);
  assert.ok(r.fautes[0].rappel.indexOf('GJ-337-WF') !== -1); // le rappel cite le scooter manquant
});

test("G6 : 2 scooters connus, récap complet (formats d'écriture variés) → ok", () => {
  const etat = etatAvec({ plaques: ['GG798NL', 'GJ337WF'] });
  const r = gardes.verifier({ reponse: "Voici le récapitulatif :\nScooter 1 : GG-798-NL (compteur HS)\nScooter 2 : GJ337WF (batterie)\nEst-ce que tout est correct ?\n-Agent IA U'mob-", etat: etat });
  assert.strictEqual(r.ok, true);
});

test('G6 : récap avec UN seul scooter connu → ok (rien d\'incomplet)', () => {
  const etat = etatAvec({ plaques: ['GG798NL'] });
  const r = gardes.verifier({ reponse: "Voici le récapitulatif : scooter GG-798-NL, panne compteur. Est-ce que tout est correct ?\n-Agent IA U'mob-", etat: etat });
  assert.strictEqual(r.ok, true);
});

// ============================================================================
// G7 — RELANCE PENDANT QUE LE CLIENT CHERCHE (règle 3)
// ============================================================================

test('G7 : client parti chercher + question dans la réponse → faute (jamais relancer)', () => {
  const etat = etatAvec({ client_cherche_info: true });
  const r = gardes.verifier({ reponse: "Prenez votre temps. Avez-vous trouvé la plaque ?\n-Agent IA U'mob-", etat: etat });
  assert.ok(codes(r).indexOf('relance_client_cherche') !== -1);
});

test('G7 : client parti chercher + accueil sans question → ok', () => {
  const etat = etatAvec({ client_cherche_info: true });
  const r = gardes.verifier({ reponse: "Prenez votre temps, je reste à votre disposition.\n-Agent IA U'mob-", etat: etat });
  assert.strictEqual(r.ok, true);
});

// ============================================================================
// G8 — VOCABULAIRE VOITURE (ton, §1)
// ============================================================================

test('G8 : « pédale » / « carburant » / « essence » → faute', () => {
  const r1 = gardes.verifier({ reponse: "Vérifiez la pédale de frein.\n-Agent IA U'mob-", etat: etatViergeF() });
  assert.ok(codes(r1).indexOf('vocabulaire_voiture') !== -1);
  const r2 = gardes.verifier({ reponse: "Vérifiez le niveau de carburant.\n-Agent IA U'mob-", etat: etatViergeF() });
  assert.ok(codes(r2).indexOf('vocabulaire_voiture') !== -1);
});

test('G8 : vocabulaire scooter électrique (batterie, chargeur, levier de frein) → ok', () => {
  const r = gardes.verifier({ reponse: "Vérifiez la connexion de la batterie et le levier de frein.\n-Agent IA U'mob-", etat: etatViergeF() });
  assert.strictEqual(r.ok, true);
});

// ============================================================================
// G9 — RÉPONSE VIDE SANS ESCALADE
// ============================================================================

test('G9 : réponse vide sans escalade → faute', () => {
  const r = gardes.verifier({ reponse: '', escalade: false, etat: etatViergeF() });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(codes(r), ['reponse_vide']);
});

test('G9 : réponse vide AVEC escalade → ok (le processeur transfère, n\'envoie rien)', () => {
  const r = gardes.verifier({ reponse: '', escalade: true, etat: etatViergeF() });
  assert.strictEqual(r.ok, true);
});

// ============================================================================
// REJEU DES VRAIES RÉPONSES VALIDÉES EN PROD — elles doivent TOUTES PASSER
// ============================================================================

test('rejeu prod : la vraie réponse du fil GG-798-NL (22/10, « disjoncteur ») passe TOUTES les gardes', () => {
  const etat = etatAvec({ plaques: ['GG798NL'], telephone_contact: '33620203963', photos: true });
  const vraie = "Voici ce que nous pouvons faire pour vous :\n\nVotre demande est enregistrée en urgence pour le scooter GG-798-NL. Nous allons faire le mieux pour intervenir rapidement.\nIl semble que votre scooter ait un problème lié au compteur. Vous pouvez essayer de basculer le disjoncteur sous la selle (position OFF puis ON à nouveau) pour voir si cela rétablit le fonctionnement.\n\nUn collègue va planifier l'intervention et vous recontacter rapidement pour vous proposer un créneau.\n\n-Agent IA U'mob-";
  const r = gardes.verifier({ reponse: vraie, escalade: false, etat: etat });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.fautes, []);
});

test('rejeu prod : la vraie demande téléphone de l\'étape 3 passe (téléphone PAS encore fourni)', () => {
  const etat = etatAvec({ plaques: ['GG798NL'] }); // pas encore de téléphone
  const vraie = "Votre demande concernant le scooter GG-798-NL est bien prise en charge.\n\nQuel est le numéro de téléphone de la personne à contacter le jour de l'intervention (le technicien l'appellera pour annoncer son heure d'arrivée) ?\n\n-Agent IA U'mob-";
  const r = gardes.verifier({ reponse: vraie, escalade: false, etat: etat });
  assert.strictEqual(r.ok, true);
});

test('rejeu incident : l\'ancien agent redemandait la plaque ALORS QUE la fiche la connaissait → aujourd\'hui G4 l\'attrape', () => {
  // Incident documenté (22/10) : canonique « retrouver vos contrats » alors que la plaque
  // était retrouvable — ici on rejoue la redemande avec la plaque connue du dossier
  const etat = etatAvec({ plaques: ['GG798NL'] });
  const ancienneFaute = "C'est noté. Quelle est l'immatriculation du scooter concerné ?\n-Agent IA U'mob-";
  const r = gardes.verifier({ reponse: ancienneFaute, escalade: false, etat: etat });
  assert.strictEqual(r.ok, false);
  assert.ok(codes(r).indexOf('plaque_redemandee') !== -1);
});

// ============================================================================
// FAUTES CUMULÉES + REPLI NEUTRE
// ============================================================================

test('fautes cumulées : toutes remontées, chacune avec son rappel précis', () => {
  const etat = etatAvec({ plaques: ['GG798NL'] });
  const r = gardes.verifier({
    reponse: "Pouvez-vous me donner la plaque ? La réparation coûtera 200€.",
    escalade: false,
    etat: etat
  });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(codes(r).sort(), ['invention', 'plaque_redemandee', 'question_fermee', 'signature']);
});

test('repliNeutre : aucune question, aucun prix, signature présente — il passe SES PROPres gardes', () => {
  const repli = gardes.messageRepliNeutre();
  const r = gardes.verifier({ reponse: repli, escalade: false, etat: etatViergeF() });
  assert.strictEqual(r.ok, true); // le repli ne doit jamais être lui-même fautif
  assert.ok(repli.indexOf("Agent IA U'mob") !== -1);
});

// ============================================================================
// B5.4.3 — G10 (plaque hors parc traitée), exception G4, G11 (transfert
// étape 5-6 sans escalade) — incidents console Corentin 23/10
// ============================================================================

test('G10 : plaque hors parc signalée + réponse qui la CITE → ok (redemande légitime)', () => {
  const etat = etatAvec({ plaques: ['GB585DD', 'GF887DD'] });
  const r = gardes.verifier({
    reponse: "J'ai bien noté le levier de frein cassé sur votre GB-585-DD. En revanche, je ne retrouve pas la plaque GF-887-DD dans notre parc — quelle est la saisie exacte de l'immatriculation ?\n-Agent IA U'mob-",
    escalade: false,
    etat: etat,
    plaques_hors_parc: ['GF887DD']
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.fautes, []);
});

test('G10 + exception G4 : la réponse CITE la plaque hors parc ET demande sa saisie → ni plaque_hors_parc_ignoree ni plaque_redemandee', () => {
  const etat = etatAvec({ plaques: ['GB585DD', 'GF887DD'] });
  const r = gardes.verifier({
    reponse: "Je ne retrouve pas la plaque GF887DD dans notre parc. Quelle est la saisie exacte de la plaque ?\n-Agent IA U'mob-",
    escalade: false,
    etat: etat,
    plaques_hors_parc: ['GF887DD']
  });
  assert.strictEqual(r.ok, true); // la redemande d'une plaque HORS PARC est LÉGITIME
});

test('G10 : plaque hors parc citée dans un message mixte mais IGNORÉE par la réponse → faute avec rappel précis', () => {
  const etat = etatAvec({ plaques: ['GB585DD', 'GF887DD'] });
  const r = gardes.verifier({
    reponse: "Merci pour ces précisions. J'ai bien noté le levier de frein cassé sur votre GB-585-DD.\n-Agent IA U'mob-",
    escalade: false,
    etat: etat,
    plaques_hors_parc: ['GF887DD']
  });
  assert.strictEqual(r.ok, false);
  assert.ok(codes(r).indexOf('plaque_hors_parc_ignoree') !== -1);
  assert.ok(r.fautes[0].rappel.indexOf('GF-887-DD') !== -1);
});

test('G10 : réponse qui parle du parc SANS citer la plaque → ok (formulation libre tolérée)', () => {
  const etat = etatAvec({ plaques: ['GF887DD'] });
  const r = gardes.verifier({
    reponse: "Merci, c'est noté. Par contre je ne retrouve pas ce scooter dans notre parc — quelle est la saisie exacte de l'immatriculation ?\n-Agent IA U'mob-",
    escalade: false,
    etat: etat,
    plaques_hors_parc: ['GF887DD']
  });
  assert.strictEqual(r.ok, true);
});

test('G10 : pas de plaques_hors_parc (clé absente) → la garde ne dit rien (rétrocompatibilité)', () => {
  const etat = etatAvec({ plaques: ['GB585DD'] });
  const r = gardes.verifier({
    reponse: "J'ai bien noté votre problème de frein.\n-Agent IA U'mob-",
    escalade: false,
    etat: etat
  });
  assert.strictEqual(r.ok, true);
});

test('G11 : annonce de transfert à l étape 5-6 SANS escalade → faute (incident console 23/10 : le cycle ne changeait pas)', () => {
  // Réalité du terrain : l'état PRÉ-fusion ne porte jamais d'étape (rien ne
  // la dérive des messages) — c'est le MODÈLE qui réclame etape: 6 dans son
  // formulaire, comme Mistral dans l'incident console.
  const etat = etatAvec({ plaques: ['GB585DD', 'GF887DD'], telephone_contact: '33620203963' });
  const incident = "Vos demandes pour les scooters GB-585-DD et GF-887-DD sont bien enregistrées. L'équipe technique prendra contact avec vous pour organiser les interventions.\n-Agent IA U'mob-";
  const r = gardes.verifier({ reponse: incident, escalade: false, etat: etat, etape_candidate: 6 });
  assert.strictEqual(r.ok, false);
  assert.ok(codes(r).indexOf('transfert_sans_escalade') !== -1);
});

test('G11 : même annonce AVEC escalade true → ok', () => {
  const etat = etatAvec({ plaques: ['GB585DD'], telephone_contact: '33620203963' });
  const transfert = "Merci pour votre confirmation. Je transmets votre dossier à notre équipe technique, qui prendra contact avec vous.\n-Agent IA U'mob-";
  const r = gardes.verifier({ reponse: transfert, escalade: true, etat: etat, etape_candidate: 5 });
  assert.strictEqual(r.ok, true);
});

test('G11 : étape < 5 avec une phrase sur l équipe → PAS de faute (qualification en cours)', () => {
  const etat = etatAvec({ plaques: ['GB585DD'] });
  const r = gardes.verifier({
    reponse: "C'est noté, l'équipe technique regardera votre scooter. Quel est le numéro de téléphone à contacter le jour de l'intervention ?\n-Agent IA U'mob-",
    escalade: false,
    etat: etat,
    etape_candidate: 3
  });
  assert.strictEqual(r.ok, true);
});

test('G11 : étape 5-6 réponse de clôture SANS mot de transfert → ok (simple politesse)', () => {
  const etat = etatAvec({ plaques: ['GB585DD'] });
  const r = gardes.verifier({
    reponse: "Avec plaisir, je reste disponible si besoin. Bonne journée.\n-Agent IA U'mob-",
    escalade: false,
    etat: etat,
    etape_candidate: 6
  });
  assert.strictEqual(r.ok, true);
});

test('G11 : sans etape_candidate ni etape dans l état (vieux comportement) → PAS de faute', () => {
  const etat = etatAvec({ plaques: ['GB585DD'] });
  const r = gardes.verifier({
    reponse: "L'équipe technique prendra contact avec vous pour l'intervention.\n-Agent IA U'mob-",
    escalade: false,
    etat: etat
  });
  assert.strictEqual(r.ok, true); // rétrocompatibilité : la garde ne dit rien sans étape connue
});

// ============================================================================
// B6.3 — G12 : CAMPAGNE PUSH (v2.20.116) : pas de qualification standard
// sur une réponse à un push — la plaque n'est PAS redemandée d'entrée.
// ============================================================================
test('G12 : réponse push qui demande l immatriculation → FAUTE campagne_push_plaque', () => {
  const etat = etatAvec({ campagne_push: true });
  const r = gardes.verifier({
    reponse: "Bonjour, quelle est l'immatriculation de votre scooter ?\n-Agent IA U'mob-",
    escalade: false,
    etat: etat
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.fautes.some((f) => f.code === 'campagne_push_plaque'));
});

test('G12 : réponse push qui interroge le BESOIN → conforme', () => {
  const etat = etatAvec({ campagne_push: true });
  const r = gardes.verifier({
    reponse: "Bonjour, merci pour votre retour. Quel est le besoin concernant votre scooter ?\n-Agent IA U'mob-",
    escalade: false,
    etat: etat
  });
  assert.strictEqual(r.ok, true);
});

test('G12 : SANS signal push → la demande d immatriculation reste LÉGITIME (étape 2)', () => {
  const etat = etatAvec({}); // pas de campagne_push
  const r = gardes.verifier({
    reponse: "Bonjour, quelle est l'immatriculation du scooter concerné, s'il vous plaît ?\n-Agent IA U'mob-",
    escalade: false,
    etat: etat
  });
  assert.strictEqual(r.ok, true);
});

test('G12 : le rappel est réinjectable au cerveau (texte de régénération présent)', () => {
  const etat = etatAvec({ campagne_push: true });
  const r = gardes.verifier({
    reponse: "Quelle est la plaque de votre scooter ?\n-Agent IA U'mob-",
    escalade: false,
    etat: etat
  });
  const f = r.fautes.find((x) => x.code === 'campagne_push_plaque');
  assert.ok(f && f.rappel.indexOf('CAMPAGNE PUSH') !== -1 && f.rappel.indexOf('OUVERTE') !== -1);
});

// ============================================================================
// B6.7.2 — CLIENTS MULTI-SCOOTERS : la flotte (fiche) n'est pas un scooter
// identifié — incident console Corentin 28/10 (repli neutre injustifié sur
// « problème de guidon » d'un client Domino's à 11 scooters).
// ============================================================================

test('B6.7.2 G4 : client MULTI-SCOOTERS (flotte, scooter NON identifié) → demander l\'immatriculation n\'est PAS une faute', () => {
  // AVANT B6.7.2 : les plaques flotte vivaient dans plaques → G4 tirait
  // « déjà connue » sur la question légitime « lequel est concerné ? » →
  // régénération → récidive → repli neutre + transfert systématique.
  const etat = etatAvec({ plaques: [], plaques_flotte: ['GP349AW', 'GP405AW', 'GP440AW'] });
  const r = gardes.verifier({ reponse: "Merci pour votre message. Lequel de vos scooters est concerné ? Quelle est l'immatriculation du scooter concerné, s'il vous plaît ?\n-Agent IA U'mob-", etat: etat });
  assert.strictEqual(r.ok, true, 'la question d\'identification d\'un client flotte est une QUALIFICATION, pas une redemande');
});

test('B6.7.2 G4 : flotte + plaque IDENTIFIÉE en conversation → la redemande reste une faute (règle 1 inchangée)', () => {
  const etat = etatAvec({ plaques: ['GG798NL'], plaques_flotte: ['GJ337WF', 'GG798NL'] });
  const r = gardes.verifier({ reponse: "Quelle est l'immatriculation du scooter concerné, s'il vous plaît ?\n-Agent IA U'mob-", etat: etat });
  assert.strictEqual(r.ok, false);
  assert.ok(codes(r).indexOf('plaque_redemandee') !== -1);
  assert.ok(r.fautes[0].rappel.indexOf('GG-798-NL') !== -1);
});


// ============================================================================
// B6.14 — G13 : RÈGLE 12 — un récapitulatif de dossier SAV ne pose JAMAIS la
// confirmation sans l'adresse d'intervention : absente du dossier et non
// demandée dans le message → faute « recap_sans_adresse » (régénération).
// ============================================================================
test('G13 : récap « tout est correct » SANS adresse dans le dossier ni dans la question → FAUTE', () => {
  const etat = etatAvec({ panne: 'levier cassé', plaques: ['AB123CD'] });
  const r = gardes.verifier({
    reponse: "Voici le récapitulatif : AB-123-CD, levier cassé, 0612345678. Est-ce que tout est correct ?\n-Agent IA U'mob-",
    etat: etat
  });
  assert.ok(codes(r).indexOf('recap_sans_adresse') !== -1);
  assert.ok(r.fautes.find((x) => x.code === 'recap_sans_adresse').rappel.indexOf('RÈGLE 12') !== -1);
});

test('G13 : récap qui DEMANDE l adresse → conforme (la confirmation viendra après)', () => {
  const etat = etatAvec({ panne: 'levier cassé', plaques: ['AB123CD'] });
  const r = gardes.verifier({
    reponse: "Merci. Pour finaliser le dossier : quelle est l'adresse d'intervention pour AB-123-CD ?\n-Agent IA U'mob-",
    etat: etat
  });
  assert.strictEqual(codes(r).indexOf('recap_sans_adresse'), -1);
});

test('G13 : récap avec adresse DÉJÀ CONNUE dans le dossier → conforme (le récap la cite à confirmer)', () => {
  const etat = etatAvec({ panne: 'levier cassé', plaques: ['AB123CD'], adresse: '12 rue de la Gare, Lyon' });
  const r = gardes.verifier({
    reponse: "Voici le récapitulatif : AB-123-CD, levier cassé, 0612345678, adresse : 12 rue de la Gare. Est-ce que tout est correct ?\n-Agent IA U'mob-",
    etat: etat
  });
  assert.strictEqual(codes(r).indexOf('recap_sans_adresse'), -1);
});

test('G13 : SANS panne décrite → pas de faute d adresse (pas un dossier SAV à récapituler)', () => {
  const etat = etatAvec({});
  const r = gardes.verifier({
    reponse: "Voici le récapitulatif. Est-ce que tout est correct ?\n-Agent IA U'mob-",
    etat: etat
  });
  assert.strictEqual(codes(r).indexOf('recap_sans_adresse'), -1);
});

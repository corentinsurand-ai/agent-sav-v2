// ============================================================================
// Agent SAV U'mob v2 — B3.2 : tests du cerveau + adaptateur Mistral (node --test)
// Exécution : node --test tests/test-cerveau.js
// (aucune dépendance, aucun réseau réel — Mistral est SIMULÉ via fetch)
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');

process.env.MISTRAL_API_KEY = 'cle-test-b3';

const cerveau = require('../lib/cerveau.js');
const etatLib = require('../lib/etat.js');
const mistral = require('../lib/mistral.js');

// ============================================================================
// 1) LE PROMPT — court par construction, complet par construction
// ============================================================================

test('SYSTEME : court par construction (< 4 000 caractères — cause racine ancien agent : 187 563)', () => {
  assert.ok(cerveau.SYSTEME.length > 1000);   // assez pour tout dire
  assert.ok(cerveau.SYSTEME.length < 4000);   // jamais une soupe de règles
});

test('SYSTEME : les 9 règles dures + 6 étapes + ton + cas particuliers + JSON', () => {
  const s = cerveau.SYSTEME;
  assert.ok(s.indexOf('Jamais redemander une info déjà fournie') !== -1);
  assert.ok(s.indexOf('question ouverte') !== -1);
  assert.ok(s.indexOf('jamais relancer') !== -1);
  assert.ok(s.indexOf("Agent IA U'mob") !== -1);
  assert.ok(s.indexOf('Pas d\'invention') !== -1);
  assert.ok(s.indexOf('6 ÉTAPES') !== -1);
  assert.ok(s.indexOf('campagne push') !== -1);
  assert.ok(s.indexOf('escalade') !== -1);
  assert.ok(s.indexOf('JSON') !== -1); // exigé par response_format json_object
  assert.ok(s.indexOf('scooters électriques') !== -1);
});

// B6.8 — RÈGLES DURES DE QUALIFICATION : les leçons validées par Corentin
// (crevaison AVANT/ARRIÈRE + adresse/numéro/jours de fermeture dans la même
// question) sont dans le CODE, pas seulement dans la table agent_sav.lecons.
test('SYSTEME B6.8 : règle crevaison AVANT ou ARRIÈRE en dur', () => {
  const s = cerveau.SYSTEME;
  assert.ok(s.indexOf('CREVAISON') !== -1 && /roue avant ou la roue arrière/i.test(s),
    'une crevaison signalée impose la question de la roue avant ou arrière');
  assert.ok(s.indexOf('« dans le vide »') !== -1);
});

test('SYSTEME B6.8 : règle adresse + numéro contact + jours de fermeture groupés, formulation OUVERTE imposée', () => {
  const s = cerveau.SYSTEME;
  assert.ok(s.indexOf("adresse d'intervention") !== -1);
  assert.ok(s.indexOf('jours de fermeture') !== -1);
  assert.ok(s.indexOf('« Pouvez-vous » / « Avez-vous »') !== -1,
    'la règle impose la formulation ouverte pour éviter la garde question_fermee');
});

test('construireMessages : 2 messages (system + user), le formulaire est dans le contexte', () => {
  const etat = etatLib.reconstruireEtat([
    { texte: 'mon scooter GG-798-nl ne démarre plus', sortant: false },
    { texte: "Quel est le numéro de la personne à contacter le jour de l'intervention ?", sortant: true },
    { texte: '0620203963', sortant: false }
  ]);
  const msgs = cerveau.construireMessages({
    contact: { nom: 'PIZZA SERVICES (ETAMPES) Abdessalem GALAAOUI', cycle: 'En cours de réalisation', tags: [] },
    client: { enseigne: 'PIZZA SERVICES (ETAMPES)', statut_risque: 'Impaye', plaque: 'GJ337WF / GG798NL' },
    etat: etat,
    messages: [
      { texte: 'Bonjour mon scooter ne démarre plus', sortant: false, emis_a: '2026-10-21T20:30:00.000Z' },
      { texte: "Quelle est l'immatriculation du scooter concerné, s'il vous plaît ?\n-Agent IA U'mob-", sortant: true, humain: false, emis_a: '2026-10-21T20:31:00.000Z' },
      { texte: 'GG-798-nl', sortant: false, emis_a: '2026-10-21T20:32:00.000Z' }
    ]
  });
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'system');
  assert.strictEqual(msgs[1].role, 'user');
  const u = msgs[1].content;
  // Le formulaire : plaque connue, téléphone déjà fourni, risque
  assert.ok(u.indexOf('GG-798-NL') !== -1);
  assert.ok(u.indexOf('33620203963') !== -1);
  assert.ok(u.indexOf('DÉJÀ FOURNI') !== -1);
  assert.ok(u.indexOf('Impaye') !== -1);
  assert.ok(u.indexOf('PIZZA SERVICES (ETAMPES)') !== -1);
  // La conversation complète, avec les rôles
  assert.ok(u.indexOf('[21/10 20:32] CLIENT : GG-798-nl') !== -1);
  assert.ok(u.indexOf('AGENT IA') !== -1);
  assert.ok(u.indexOf('Traite le DERNIER message CLIENT') !== -1);
  // Le contexte total reste raisonnable
  assert.ok(u.length < 20000);
});

test('rendreMessage : vocal, photo, collègue humain, message long borné', () => {
  assert.strictEqual(cerveau.rendreMessage({ texte: '[média reçu]', type_media: 'audio', sortant: false }), '[?] CLIENT : [message vocal]');
  assert.strictEqual(cerveau.rendreMessage({ texte: '', media: 'https://x/photo.jpg', type_media: 'image', sortant: false }), '[?] CLIENT : [photo reçue]');
  assert.ok(cerveau.rendreMessage({ texte: 'ok à la main', sortant: true, humain: true }).indexOf('COLLÈGUE (à la main)') !== -1);
  const long = cerveau.rendreMessage({ texte: 'a'.repeat(5000), sortant: false, emis_a: '2026-10-21T20:00:00.000Z' });
  assert.ok(long.length < 2030);
});

test('rendreFormulaire : tous les signaux de B3.1 rendus au LLM', () => {
  const etat = etatLib.etatVierge();
  etat.client_cherche_info = true;
  etat.campagne_push = true;
  etat.demande_commerciale = true;
  const f = cerveau.rendreFormulaire(etat);
  assert.ok(f.indexOf('ACCUEILLIR et ATTENDRE') !== -1);
  assert.ok(f.indexOf('CAMPAGNE PUSH') !== -1);
  assert.ok(f.indexOf('COMMERCIALE') !== -1);
  assert.ok(f.indexOf('la seule info qui bloque le transfert') !== -1); // téléphone manquant
});

test('construireMessages : leçons ciblées injectées, absentes si aucune', () => {
  const m1 = cerveau.construireMessages({ etat: etatLib.etatVierge(), messages: [], lecons: ['Ne jamais proposer de délai chiffré'] });
  assert.ok(m1[1].content.indexOf('Ne jamais proposer de délai chiffré') !== -1);
  const m2 = cerveau.construireMessages({ etat: etatLib.etatVierge(), messages: [], lecons: [] });
  assert.ok(m2[1].content.indexOf('LEÇONS') === -1);
});

test('silenceNecessaire : prise de main → silence SANS appeler le modèle', () => {
  const r = cerveau.silenceNecessaire({
    etat: { prise_de_main: true },
    dernier: { texte: 'Bonjour', sortant: false }
  });
  assert.deepStrictEqual(r, { silence: true, raison: 'prise de main humaine' });
  const r2 = cerveau.silenceNecessaire({ etat: {}, dernier: { texte: 'x', sortant: true } });
  assert.strictEqual(r2.silence, true);
  const r3 = cerveau.silenceNecessaire({ etat: {}, dernier: { texte: 'x', sortant: false } });
  assert.strictEqual(r3.silence, false);
});

test('dernierEntrant : dernier message client d\'un historique', () => {
  const d = cerveau.dernierEntrant([
    { texte: 'a', sortant: false },
    { texte: 'b', sortant: true },
    { texte: 'c', sortant: false },
    { texte: 'd', sortant: true }
  ]);
  assert.strictEqual(d.texte, 'c');
  assert.strictEqual(cerveau.dernierEntrant([{ texte: 'x', sortant: true }]), null);
});

// ============================================================================
// 2) PARSE DE LA RÉPONSE DU MODÈLE — tolérant, jamais de crash
// ============================================================================

test('parserReponse : JSON propre', () => {
  const r = cerveau.parserReponse('{"reponse":"Bonjour !\\n-Agent IA U\'mob-","formulaire":{"plaque":"GG-798-NL","etape":3},"escalade":false}');
  assert.strictEqual(r.ok, true);
  assert.ok(r.reponse.indexOf("Bonjour") === 0);
  assert.strictEqual(r.formulaire.etape, 3);
  assert.strictEqual(r.escalade, false);
});

test('parserReponse : JSON dans une clôture markdown + texte autour', () => {
  const r = cerveau.parserReponse('Voici ma réponse :\n```json\n{"reponse":"ok","escalade":true,"raison_escalade":"client exige un humain"}\n```\nBonne journée');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reponse, 'ok');
  assert.strictEqual(r.escalade, true);
  assert.strictEqual(r.raison_escalade, 'client exige un humain');
});

test('parserReponse : illisible → drapeau, JAMAIS de crash', () => {
  const r = cerveau.parserReponse('je vous réponds tout de suite, merci !');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.erreur, 'reponse_illisible');
  assert.strictEqual(r.reponse, '');
  const r2 = cerveau.parserReponse(null);
  assert.strictEqual(r2.ok, false);
});

test('parserReponse : reponse vide = silence voulu du modèle', () => {
  const r = cerveau.parserReponse('{"reponse":"","formulaire":null}');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reponse, '');
  assert.strictEqual(r.formulaire, null);
});

// ============================================================================
// 3) FUSION DU FORMULAIRE — whitelist stricte, jamais d'écrasement
// ============================================================================

test('fusionnerMajEtat : plaque normalisée, dédupliquée ; champs inconnus ignorés', () => {
  const etat = etatLib.reconstruireEtat([{ texte: 'GG-798-nl ne démarre pas', sortant: false }]);
  cerveau.fusionnerMajEtat(etat, { plaque: 'gg-798-NL', champsInconnu: 'x', hack: { plaques: [] } });
  assert.deepStrictEqual(etat.plaques, ['GG798NL']);
});

test('fusionnerMajEtat : nouvelle plaque du modèle AJOUTÉE (multi-scooters)', () => {
  const etat = etatLib.etatVierge();
  cerveau.fusionnerMajEtat(etat, { plaques: ['GG-798-NL', 'GJ-337-WF'] });
  assert.deepStrictEqual(etat.plaques, ['GG798NL', 'GJ337WF']);
});

test('fusionnerMajEtat : téléphone du modèle n\'écrase JAMAIS celui du client', () => {
  const etat = etatLib.reconstruireEtat([
    { texte: "Quel est le numéro de la personne à contacter le jour de l'intervention ?", sortant: true },
    { texte: '0620203963', sortant: false }
  ]);
  cerveau.fusionnerMajEtat(etat, { telephone_contact: '06 99 88 77 66' });
  assert.strictEqual(etat.telephone_contact, '33620203963');
  // mais il REMPLIT un champ vide (lu dans la conversation par le modèle)
  const etat2 = etatLib.etatVierge();
  cerveau.fusionnerMajEtat(etat2, { telephone_contact: '06 99 88 77 66' });
  assert.strictEqual(etat2.telephone_contact, '33699887766');
});

test('fusionnerMajEtat : étape bornée 1-6, textes bornés, formulaire null OK', () => {
  const etat = etatLib.etatVierge();
  cerveau.fusionnerMajEtat(etat, { etape: 9 });
  assert.strictEqual(etat.etape, 1); // hors bornes → ignoré
  cerveau.fusionnerMajEtat(etat, { etape: 4, panne: '  compteur HS  '.repeat(100) });
  assert.strictEqual(etat.etape, 4);
  assert.strictEqual(etat.panne.length, 500);
  cerveau.fusionnerMajEtat(etat, null); // aucun crash
  assert.strictEqual(etat.etape, 4);
});

// ============================================================================
// 4) ADAPTATEUR MISTRAL — fetch simulé (aucun réseau réel)
// ============================================================================

let appelsFetch = [];
let reponses = [];
function fetchSimule(url, options) {
  appelsFetch.push({ url: String(url), options: options || {} });
  const r = reponses.length ? reponses.shift() : { status: 200, corps: JSON.stringify({ choices: [{ message: { content: '{"reponse":"ok"}' } }] }) };
  if (r.reject) return Promise.reject(new Error(r.reject));
  return Promise.resolve({
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    text: async () => (r.corps !== undefined ? String(r.corps) : '')
  });
}
globalThis.fetch = fetchSimule;

test('appelMistral : succès — Bearer, modèle mistral-large-latest, response_format json_object', async () => {
  appelsFetch = []; reponses = [];
  reponses.push({ status: 200, corps: JSON.stringify({ model: 'mistral-large-latest', choices: [{ message: { content: '{"reponse":"bonjour"}' } }], usage: { prompt_tokens: 100 } }) });
  const r = await mistral.appelMistral([{ role: 'user', content: 'dis bonjour en JSON' }]);
  assert.strictEqual(r.texte, '{"reponse":"bonjour"}');
  assert.strictEqual(r.modele, 'mistral-large-latest');
  assert.strictEqual(r.usage.prompt_tokens, 100);
  assert.strictEqual(appelsFetch.length, 1);
  const o = appelsFetch[0].options;
  assert.strictEqual(o.headers.Authorization, 'Bearer cle-test-b3');
  const corps = JSON.parse(o.body);
  assert.strictEqual(corps.model, 'mistral-large-latest');
  assert.deepStrictEqual(corps.response_format, { type: 'json_object' });
});

test('appelMistral : MISTRAL_API_KEY absente → erreur explicite, AUCUN appel réseau', async () => {
  const sauvee = process.env.MISTRAL_API_KEY;
  delete process.env.MISTRAL_API_KEY;
  appelsFetch = [];
  await assert.rejects(mistral.appelMistral([{ role: 'user', content: 'x' }]), /MISTRAL_API_KEY absente/);
  assert.strictEqual(appelsFetch.length, 0);
  process.env.MISTRAL_API_KEY = sauvee;
});

test('appelMistral : 401 → throw IMMÉDIAT, pas de re-essai (erreur durable)', async () => {
  appelsFetch = []; reponses = [];
  reponses.push({ status: 401, corps: '{"message":"unauthorized"}' });
  await assert.rejects(mistral.appelMistral([{ role: 'user', content: 'x' }]), /Mistral 401/);
  assert.strictEqual(appelsFetch.length, 1); // pas de retry sur 401
});

test('appelMistral : 503 puis 200 → re-essai transitoire et succès', async () => {
  appelsFetch = []; reponses = [];
  reponses.push({ status: 503, corps: 'service unavailable' });
  reponses.push({ status: 200, corps: JSON.stringify({ choices: [{ message: { content: '{"reponse":"ok"}' } }] }) });
  const r = await mistral.appelMistral([{ role: 'user', content: 'x' }]);
  assert.strictEqual(r.texte, '{"reponse":"ok"}');
  assert.strictEqual(appelsFetch.length, 2);
});

test('appelMistral : 3× 503 → épuisement des 2 re-essais puis throw', async () => {
  appelsFetch = []; reponses = [];
  for (let i = 0; i < 3; i++) reponses.push({ status: 503, corps: 'service unavailable' });
  await assert.rejects(mistral.appelMistral([{ role: 'user', content: 'x' }]), /Mistral 503/);
  assert.strictEqual(appelsFetch.length, 3); // 1 + 2 re-essais, jamais plus
});

test('appelMistral : erreur réseau pure puis succès → transitoire', async () => {
  appelsFetch = []; reponses = [];
  reponses.push({ reject: 'ECONNRESET' });
  reponses.push({ status: 200, corps: JSON.stringify({ choices: [{ message: { content: '{"reponse":"ok"}' } }] }) });
  const r = await mistral.appelMistral([{ role: 'user', content: 'x' }]);
  assert.strictEqual(r.texte, '{"reponse":"ok"}');
  assert.strictEqual(appelsFetch.length, 2);
});

// ============================================================================
// 5) INTÉGRATION COMPLÈTE — le fil réel GG-798-NL du début à la fusion
// ============================================================================

test('intégration : fil réel → prompt → réponse simulée → parse → fusion du formulaire', () => {
  // 1. Le fil réel validé en prod (547249072), déjà reconstitué en B3.1
  const messages = [
    { texte: '[média reçu]', media: 'https://cdn.chatapi.net/whatsapp_business/558644/547249072/2597dd9727141a6d908b73aa012f9d3fimage1792615131346.jpg', type_media: 'image', sortant: false, emis_a: '2026-10-21T20:38:48.179Z' },
    { texte: "Votre demande concernant le scooter GG-798-NL est bien prise en charge.\n\nQuel est le numéro de téléphone de la personne à contacter le jour de l'intervention (le technicien l'appellera pour annoncer son heure d'arrivée) ?", sortant: true, humain: false, emis_a: '2026-10-21T20:42:03.792Z' },
    { texte: '0620203963', sortant: false, emis_a: '2026-10-21T20:42:29.496Z' },
    { texte: "C'est urgent j'ai pas de moyens de livraison", sortant: false, emis_a: '2026-10-21T20:42:44.667Z' }
  ];
  const etat = etatLib.reconstruireEtat(messages);
  // (flux B4 : le processeur enrichit AUSSI le formulaire depuis la ligne clients)
  etatLib.appliquerClient(etat, { enseigne: 'PIZZA SERVICES (ETAMPES)', plaque: 'GJ337WF / GG798NL' });
  // 2. Le prompt
  const msgs = cerveau.construireMessages({
    contact: { nom: 'PIZZA SERVICES (ETAMPES) Abdessalem GALAAOUI', cycle: 'En cours de réalisation', tags: [] },
    client: { enseigne: 'PIZZA SERVICES (ETAMPES)', plaque: 'GJ337WF / GG798NL' },
    etat: etat, messages: messages
  });
  assert.ok(msgs[1].content.indexOf("C'est urgent j'ai pas de moyens de livraison") !== -1);
  // 3. Une réponse modèle plausible
  const reponseModele = JSON.stringify({
    reponse: "C'est bien noté pour l'urgence, nous faisons le maximum pour intervenir rapidement sur le scooter GG-798-NL.\n-Agent IA U'mob-",
    formulaire: { panne: "Démarre mais n'avance pas, moteur silencieux", etape: 3 },
    escalade: false
  });
  // 4. Parse puis fusion
  const p = cerveau.parserReponse(reponseModele);
  assert.strictEqual(p.ok, true);
  cerveau.fusionnerMajEtat(etat, p.formulaire);
  assert.strictEqual(etat.panne.indexOf('moteur silencieux') !== -1, true);
  assert.strictEqual(etat.etape, 3);
  assert.strictEqual(etat.telephone_contact, '33620203963'); // toujours celui du client
  assert.deepStrictEqual(etat.plaques, ['GG798NL']); // B6.7.2 — citée en conversation = identifiée
  assert.deepStrictEqual(etat.plaques_flotte, ['GJ337WF', 'GG798NL']); // flotte à part
  // 5. La réponse partira vers les gardes (B3.3), pas directement au client
  assert.ok(p.reponse.indexOf("Agent IA U'mob") !== -1);
});

// ============================================================================
// B6.3 — TON PAR CANAL (blocCanal, portage v2.10)
// ============================================================================
test("B6.3 blocCanal : canal EMAIL → vouvoiement, formules complètes, pas de SMS/emoji, UN email structuré", () => {
  const b = cerveau.blocCanal("mail");
  assert.ok(b.indexOf("CANAL : EMAIL") !== -1);
  assert.ok(b.indexOf("vouvoiement") !== -1);
  assert.ok(b.indexOf("pas de langage SMS") !== -1);
  assert.ok(b.indexOf("UN seul email structuré") !== -1);
});

test("B6.3 blocCanal : canal WHATSAPP → sobre, direct, phrases courtes", () => {
  const b = cerveau.blocCanal("whatsapp");
  assert.ok(b.indexOf("CANAL : WHATSAPP") !== -1);
  assert.ok(b.indexOf("sobre et direct") !== -1);
});

test("B6.3 blocCanal : variations tolérées (courriel, smtp, wa, chat, suffixe « | » v2.10)", () => {
  assert.ok(cerveau.blocCanal("courriel").indexOf("EMAIL") !== -1);
  assert.ok(cerveau.blocCanal("smtp|55").indexOf("EMAIL") !== -1);
  assert.ok(cerveau.blocCanal("wa|123").indexOf("WHATSAPP") !== -1);
  assert.ok(cerveau.blocCanal("chat").indexOf("WHATSAPP") !== -1);
});

test("B6.3 blocCanal : canal non identifié → bloc neutre ; canal vide → AUCUN bloc", () => {
  assert.ok(cerveau.blocCanal("signet").indexOf("non identifié") !== -1);
  assert.strictEqual(cerveau.blocCanal(""), "");
  assert.strictEqual(cerveau.blocCanal(null), "");
});

test("B6.3 construireMessages : canal passé → le bloc est DANS le prompt (avant le formulaire)", () => {
  const msgs = cerveau.construireMessages({
    contact: { nom: "Marco", cycle: "", tags: [] },
    etat: etatLib.etatVierge(),
    messages: [{ texte: "bonjour", sortant: false, humain: false, emis_a: "2026-10-22T08:00:00Z" }],
    canal: "mail"
  });
  const c = msgs[1].content;
  assert.ok(c.indexOf("CANAL : EMAIL") !== -1);
  assert.ok(c.indexOf("FORMULAIRE DU DOSSIER") > c.indexOf("CANAL : EMAIL"));
});

test("B6.3 construireMessages : SANS canal → pas de bloc canal (ton simple, rétro-compat)", () => {
  const msgs = cerveau.construireMessages({
    contact: { nom: "Marco", cycle: "", tags: [] },
    etat: etatLib.etatVierge(),
    messages: []
  });
  assert.ok(msgs[1].content.indexOf("CANAL :") === -1);
});

// ============================================================================
// B6.4 — MODE QUESTION INTERNE (Mistral LIBRE — jamais au client)
// ============================================================================

const consignes = require('../lib/consignes.js');

function msgT(texte, ts, sortant) {
  return { texte: texte, ts: ts || 1792683528000, emis_a: new Date(ts || 1792683528000).toISOString(), sortant: !!sortant };
}

test('B6.4 SYSTEME_INTERNE : assistant d\'équipe, texte brut, jamais au client', () => {
  const s = cerveau.SYSTEME_INTERNE;
  assert.ok(s.indexOf('assistant interne') !== -1);
  assert.ok(s.indexOf('JAMAIS visible du client') !== -1);
  assert.ok(s.indexOf("n'invente JAMAIS") !== -1);
  assert.ok(s.indexOf('texte brut') !== -1);
  assert.ok(s.length < 1500, 'court par construction');
});

test('B6.4 construireMessagesQuestion : dossier 4 points + question + historique rendus', () => {
  const msgs = cerveau.construireMessagesQuestion({
    question: 'où on en est ?',
    dossier: consignes.etatDossier4Points({
      cycle: 'En cours de réalisation',
      etat: { plaques: ['GG798NL'], panne: 'ne démarre pas', telephone_contact: '0612345678' },
      suiviRefs: ['EVE05189']
    }),
    nom: 'PIZZA SERVICES ETAMPES',
    messages: [msgT('Bonjour GG-798-NL ne démarre pas', 1792683528000), msgT('Bien noté.', 1792683529000, true)]
  });
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'system');
  assert.strictEqual(msgs[0].content, cerveau.SYSTEME_INTERNE);
  const u = msgs[1].content;
  assert.ok(u.indexOf('Cycle : En cours de réalisation') !== -1);
  assert.ok(u.indexOf('Intervention Praxedo : EVE05189') !== -1);
  assert.ok(u.indexOf('PIZZA SERVICES ETAMPES') !== -1);
  assert.ok(u.indexOf('QUESTION DU COLLÈGUE') !== -1);
  assert.ok(u.indexOf('où on en est ?') !== -1);
  assert.ok(u.indexOf('CLIENT : Bonjour GG-798-NL ne démarre pas') !== -1);
  assert.ok(u.indexOf('Réponds au collègue en texte brut, sans JSON') !== -1);
});

test('B6.4 construireMessagesQuestion : sans historique ni dossier → prompt minimal sans crash', () => {
  const msgs = cerveau.construireMessagesQuestion({ question: 'quoi ?' });
  assert.ok(msgs[1].content.indexOf('(état du dossier inconnu)') !== -1);
  assert.ok(msgs[1].content.indexOf('quoi ?') !== -1);
});

test('B6.4 appelMistral { texteLibre: true } : PAS de response_format (réponse brute)', async () => {
  appelsFetch = []; reponses = [];
  reponses.push({ status: 200, corps: JSON.stringify({ choices: [{ message: { content: 'Le dossier attend le téléphone sur place.' } }] }) });
  const r = await mistral.appelMistral([{ role: 'user', content: 'où on en est ?' }], { texteLibre: true });
  assert.strictEqual(r.texte, 'Le dossier attend le téléphone sur place.');
  const corps = JSON.parse(appelsFetch[0].options.body);
  assert.strictEqual(corps.response_format, undefined, 'aucun response_format en mode texte libre');
});

test('B6.4 appelMistral sans option : response_format json_object conservé (rétro-compat)', async () => {
  appelsFetch = []; reponses = [];
  reponses.push({ status: 200, corps: JSON.stringify({ choices: [{ message: { content: '{"reponse":"ok"}' } }] }) });
  await mistral.appelMistral([{ role: 'user', content: 'dis bonjour' }]);
  const corps = JSON.parse(appelsFetch[0].options.body);
  assert.deepStrictEqual(corps.response_format, { type: 'json_object' });
});

// ============================================================================
// B6.5.1 — LE TOUR RELAIS CLIENT (prompt séparé, texte brut)
// ============================================================================
test('B6.5.1 SYSTEME_RELAIS : transmission au client, zéro invention, signature, question OUVERTE', () => {
  const s = cerveau.SYSTEME_RELAIS;
  assert.ok(s.indexOf("TRANSMETTRE") !== -1, "rôle : transmettre une demande au client");
  assert.ok(s.indexOf("n'invente") !== -1, "zéro invention");
  assert.ok(s.indexOf("OUVERTE") !== -1, "question ouverte exigée");
  assert.ok(s.indexOf("-Agent IA U'mob-") !== -1, "signature exigée");
  assert.ok(s.indexOf("TEXTE BRUT") !== -1, "pas de JSON");
  assert.ok(s.length < 1200, "prompt court (borne projet) : " + s.length);
});

test('B6.5.1 construireMessagesRelais : dossier + conversation + demande de l\'équipe rendus', () => {
  const msgs = cerveau.construireMessagesRelais({
    consigne: "demande au client l'adresse pour l'intervention",
    dossier: "Cycle : — — Plaque : GH367WG — Intervention Praxedo : — — Attente client : rien en attente",
    nom: "JMBS (COSMO SUSHI)",
    messages: [
      { sortant: false, texte: "bonjour", ts: 1000 },
      { sortant: true, texte: "Bonjour, comment puis-je vous aider ?", ts: 2000 }
    ]
  });
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].role, 'system');
  assert.strictEqual(msgs[0].content, cerveau.SYSTEME_RELAIS);
  assert.strictEqual(msgs[1].role, 'user');
  assert.ok(msgs[1].content.indexOf("l'adresse pour l'intervention") !== -1, "la demande est rendue");
  assert.ok(msgs[1].content.indexOf("GH367WG") !== -1, "le dossier 4 points est rendu");
  assert.ok(msgs[1].content.indexOf("JMBS (COSMO SUSHI)") !== -1, "le contact est rendu");
  assert.ok(msgs[1].content.indexOf("CLIENT") !== -1, "la conversation est rendue");
});

test('B6.5.1 construireMessagesRelais : entrée vide → jamais de crash', () => {
  const msgs = cerveau.construireMessagesRelais({});
  assert.strictEqual(msgs.length, 2);
  assert.ok(msgs[1].content.indexOf("inconnu") !== -1);
});

// ============================================================================
// B6.7.2 — CLIENTS MULTI-SCOOTERS : le formulaire rendu au LLM distingue
// flotte (fiche) et scooter identifié, et guide le rapprochement.
// ============================================================================

test('B6.7.2 rendreFormulaire : flotte SANS scooter identifié → « LEQUEL est concerné »', () => {
  const etat = etatLib.etatVierge();
  etatLib.appliquerClient(etat, { plaque: 'GP349AW / GP405AW / GP440AW', enseigne: "DOMINO'S PIZZA" });
  const f = cerveau.rendreFormulaire(etat);
  assert.ok(f.indexOf('Flotte du client') !== -1);
  assert.ok(f.indexOf('LEQUEL est concerné') !== -1, 'le LLM est guidé vers la question « lequel »');
  assert.ok(f.indexOf('Immatriculations connues : (aucune') !== -1, "la flotte n'est PLUS listée comme connue");
});

test('B6.7.2 rendreFormulaire : flotte mono-scooter SANS identification → proposition de l\'immatriculation', () => {
  const etat = etatLib.etatVierge();
  etatLib.appliquerClient(etat, { plaque: 'GG798NL', enseigne: 'PIZZA SERVICES' });
  const f = cerveau.rendreFormulaire(etat);
  assert.ok(f.indexOf('propose cette immatriculation') !== -1);
});

test('B6.7.2 rendreFormulaire : scooter identifié + flotte → guidance rapprochement « NOUVEAU problème »', () => {
  const etat = etatLib.etatVierge();
  etatLib.appliquerClient(etat, { plaque: 'GJ337WF / GG798NL', enseigne: "DOMINO'S PIZZA" });
  etatLib.appliquerMessage(etat, { texte: 'le scooter GG-798-NL a un problème de guidon', sortant: false });
  const f = cerveau.rendreFormulaire(etat);
  assert.ok(f.indexOf('Scooter identifié pour ce dossier : GG-798-NL') !== -1);
  assert.ok(f.indexOf('NOUVEAU problème') !== -1, 'guidance : même scooter ou un autre');
});

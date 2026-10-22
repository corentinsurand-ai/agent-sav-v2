// ============================================================================
// Agent SAV U'mob v2 — B6.2 : tests du scan « Attente client » + reprise-de-zéro
// (node --test, PUR — aucun réseau, aucun timer réel)
// ============================================================================
const { test } = require("node:test");
const assert = require("node:assert");
const scan = require("../lib/scan.js");

const H = 3600 * 1000;
const T0 = 1780000000000; // référence injectée — jamais Date.now()

function message(texte, sortant, heures) {
  return { texte: texte, sortant: sortant, ts: T0 + heures * H };
}

// ------------------------------------------------------------- ATTENDRE ----
test("B6.2 attendReponse : « ? » → attend une réponse", () => {
  assert.strictEqual(scan.attendReponse("Quelle est l'immatriculation du scooter ?"), true);
});

test("B6.2 attendReponse : demande explicite sans « ? » → attend", () => {
  assert.strictEqual(scan.attendReponse("Merci de m envoyer des photos de la panne."), true);
  assert.strictEqual(scan.attendReponse("Pouvez-vous me préciser le modèle"), true);
});

test("B6.2 attendReponse : clôture / information pure → n'attend RIEN (v2.20.88)", () => {
  assert.strictEqual(scan.attendReponse("Bien noté, je reste disponible."), false);
  assert.strictEqual(scan.attendReponse("Votre demande est enregistrée, l'équipe revient vers vous."), false);
});

test("B6.2 attendReponse : texte vide ou média → rien (comportement historique)", () => {
  assert.strictEqual(scan.attendReponse(""), false);
  assert.strictEqual(scan.attendReponse("(média reçu)"), false);
});

// ------------------------------------------------------------------ SCAN ----
test("B6.2 scan : question sans réponse depuis 2 h → poser « Attente client »", () => {
  const decisions = scan.scanAttenteClient(T0 + 3 * H, [{
    contactId: "111",
    cycleActuel: "Nouvelle Demande",
    conversationFermee: false,
    messages: [message("Bonjour, mon scooter ne démarre pas", false, 0), message("Quelle est l'immatriculation du scooter ?", true, 1)]
  }]);
  assert.strictEqual(decisions.length, 1);
  assert.strictEqual(decisions[0].contactId, "111");
  assert.strictEqual(decisions[0].action, "poser_cycle");
  assert.strictEqual(decisions[0].cycle, "Attente client");
  assert.strictEqual(decisions[0].silence_ms, 2 * H);
});

test("B6.2 scan : le client A répondu après la question → RIEN", () => {
  const decisions = scan.scanAttenteClient(T0 + 5 * H, [{
    contactId: "111",
    cycleActuel: "Nouvelle Demande",
    conversationFermee: false,
    messages: [message("Question ?", true, 0), message("AA-123-BB", false, 1)]
  }]);
  assert.strictEqual(decisions.length, 0);
});

test("B6.2 scan : silence < 2 h → RIEN (pas de cycle prématuré)", () => {
  const decisions = scan.scanAttenteClient(T0 + 90 * 60 * 1000, [{
    contactId: "111",
    cycleActuel: "Nouvelle Demande",
    conversationFermee: false,
    messages: [message("Question ?", true, 0)]
  }]);
  assert.strictEqual(decisions.length, 0);
});

test("B6.2 scan : silence exactement 2 h → décision (seuil atteint)", () => {
  const decisions = scan.scanAttenteClient(T0 + 2 * H, [{
    contactId: "111",
    cycleActuel: "Nouvelle Demande",
    conversationFermee: false,
    messages: [message("Question ?", true, 0)]
  }]);
  assert.strictEqual(decisions.length, 1);
});

test("B6.2 scan : dernier sortant SANS attente de réponse → RIEN (clôture)", () => {
  const decisions = scan.scanAttenteClient(T0 + 10 * H, [{
    contactId: "111",
    cycleActuel: "Nouvelle Demande",
    conversationFermee: false,
    messages: [message("Votre demande est enregistrée.", true, 0)]
  }]);
  assert.strictEqual(decisions.length, 0);
});

test("B6.2 scan : cycle DÉJÀ « Attente client » → RIEN (idempotent)", () => {
  const decisions = scan.scanAttenteClient(T0 + 5 * H, [{
    contactId: "111",
    cycleActuel: "Attente client",
    conversationFermee: false,
    messages: [message("Question ?", true, 0)]
  }]);
  assert.strictEqual(decisions.length, 0);
});

test("B6.2 scan : cycle « Traitée » → JAMAIS touché", () => {
  const decisions = scan.scanAttenteClient(T0 + 5 * H, [{
    contactId: "111",
    cycleActuel: "Traitée",
    conversationFermee: false,
    messages: [message("Question ?", true, 0)]
  }]);
  assert.strictEqual(decisions.length, 0);
});

test("B6.2 scan : conversation FERMÉE → RIEN (l'équipe gère)", () => {
  const decisions = scan.scanAttenteClient(T0 + 5 * H, [{
    contactId: "111",
    cycleActuel: "Nouvelle Demande",
    conversationFermee: true,
    messages: [message("Question ?", true, 0)]
  }]);
  assert.strictEqual(decisions.length, 0);
});

test("B6.2 scan : ordre des messages QUELCONQUE — le dernier sortant par ts gagne", () => {
  const decisions = scan.scanAttenteClient(T0 + 5 * H, [{
    contactId: "111",
    cycleActuel: "A qualifier",
    conversationFermee: false,
    messages: [
      message("Question récente ?", true, 3),
      message("Ancien message du client", false, 0),
      message("Ancienne clôture sans réponse attendue", true, 1)
    ]
  }]);
  assert.strictEqual(decisions.length, 1);
  assert.strictEqual(decisions[0].silence_ms, 2 * H);
});

test("B6.2 scan : aucun message sortant → RIEN", () => {
  const decisions = scan.scanAttenteClient(T0 + 5 * H, [{
    contactId: "111",
    cycleActuel: "Nouvelle Demande",
    conversationFermee: false,
    messages: [message("Bonjour", false, 0)]
  }]);
  assert.strictEqual(decisions.length, 0);
});

test("B6.2 scan : plusieurs contacts — décision pour chacun, les autres intacts", () => {
  const decisions = scan.scanAttenteClient(T0 + 5 * H, [
    { contactId: "a", cycleActuel: "Nouvelle Demande", conversationFermee: false, messages: [message("Question ?", true, 0)] },
    { contactId: "b", cycleActuel: "Attente client", conversationFermee: false, messages: [message("Question ?", true, 0)] },
    { contactId: "c", cycleActuel: "Nouvelle Demande", conversationFermee: false, messages: [message("Bien noté.", true, 0)] }
  ]);
  assert.strictEqual(decisions.length, 1);
  assert.strictEqual(decisions[0].contactId, "a");
});

test("B6.2 scan : entrant APRÈS le sortant mais avant 2 h quand même compté → RIEN (le client a répondu)", () => {
  const decisions = scan.scanAttenteClient(T0 + 5 * H, [{
    contactId: "111",
    cycleActuel: "Nouvelle Demande",
    conversationFermee: false,
    messages: [message("Question ?", true, 2), message("je regarde", false, 3)]
  }]);
  assert.strictEqual(decisions.length, 0);
});

// -------------------------------------------------------- REPRISE-DE-ZÉRO --
test("B6.2 repriseDeZeroNecessaire : conversation fermée → TRUE (v2.20.64)", () => {
  assert.strictEqual(scan.repriseDeZeroNecessaire("Nouvelle Demande", true), true);
});

test("B6.2 repriseDeZeroNecessaire : cycle « Traitée » (peu importe qui l'a posé) → TRUE", () => {
  assert.strictEqual(scan.repriseDeZeroNecessaire("Traitée", false), true);
});

test("B6.2 repriseDeZeroNecessaire : dossier en cours → FALSE", () => {
  assert.strictEqual(scan.repriseDeZeroNecessaire("Nouvelle Demande", false), false);
  assert.strictEqual(scan.repriseDeZeroNecessaire("Attente client", false), false);
  assert.strictEqual(scan.repriseDeZeroNecessaire("", false), false);
});

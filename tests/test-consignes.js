// ============================================================================
// Agent SAV U'mob v2 — B6.3 : tests des CONSIGNES INTERNES @Agent IA
// (node --test, PUR — aucun réseau, aucun timer réel)
// ============================================================================
const { test } = require("node:test");
const assert = require("node:assert");
const consignes = require("../lib/consignes.js");

const T0 = 1780000000000; // référence injectée — jamais Date.now()
const MIN = 60 * 1000;

// ------------------------------------------------------------- MENTION ----
test("B6.3 mentionneAgent : « @Agent IA … » (casse/espacement tolérés)", () => {
  assert.strictEqual(consignes.mentionneAgent("@Agent IA arme l'intervention"), true);
  assert.strictEqual(consignes.mentionneAgent("@ agent  ia  poursuis"), true);
  assert.strictEqual(consignes.mentionneAgent("@Agent U'mob continue"), true);
  assert.strictEqual(consignes.mentionneAgent("@agent umob ok"), true);
});

test("B6.3 mentionneAgent : template respond.io {{@user.ID}} (v2.20.47)", () => {
  assert.strictEqual(consignes.mentionneAgent("{{@user.12345}} où on en est ?"), true);
});

test("B6.3 mentionneAgent : commentaire sans mention → PAS pour l'agent", () => {
  assert.strictEqual(consignes.mentionneAgent("J'appelle le client demain"), false);
  assert.strictEqual(consignes.mentionneAgent("Bonjour, ça va ?"), false);
});

// ------------------------------------------------------------ NETTOYAGE ----
test("B6.3 nettoyerConsigne : retire la mention + les « : » de tête (v2.20.119)", () => {
  assert.strictEqual(consignes.nettoyerConsigne("@Agent IA : arme l'intervention EVE123456"), "arme l'intervention EVE123456");
  assert.strictEqual(consignes.nettoyerConsigne("@agent ia -; question : suite ?"), "question : suite ?");
  assert.strictEqual(consignes.nettoyerConsigne("@Agent IA\tpoursuis  la  qualification"), "poursuis la qualification");
});

test("B6.3 nettoyerConsigne : texte sans mention → texte nettoyé tel quel", () => {
  assert.strictEqual(consignes.nettoyerConsigne("  bonjour  "), "bonjour");
});

// -------------------------------------------------------- MODE QUESTION ----
test("B6.3 estQuestionInterne : « ? … » en TÊTE (v2.20.76)", () => {
  assert.strictEqual(consignes.estQuestionInterne("? où on en est sur ce dossier"), true);
  assert.strictEqual(consignes.estQuestionInterne("??? tu as la plaque ?"), true);
});

test("B6.3 estQuestionInterne : « Question : … » en tête", () => {
  assert.strictEqual(consignes.estQuestionInterne("Question: c'est quoi le statut ?"), true);
  assert.strictEqual(consignes.estQuestionInterne("Question - pourquoi le client n'a pas répondu ?"), true);
});

test("B6.3 estQuestionInterne : question en MILIEU de texte → PAS une question interne", () => {
  assert.strictEqual(consignes.estQuestionInterne("Bonjour, ça va ?"), false);
  assert.strictEqual(consignes.estQuestionInterne("Le client a demandé une info ? bizarre"), false);
});

test("B6.3 questionInterne : renvoie le CONTENU de la question", () => {
  assert.strictEqual(consignes.questionInterne("? où on en est"), "où on en est");
});

// ---------------------------------------------------------------- DEDUP ----
test("B6.3 cleDedup : casse + ponctuation indifférentes (v2.20.99)", () => {
  assert.strictEqual(
    consignes.cleDedup("444445", "Arme Praxedo. "),
    consignes.cleDedup("444445", "arme praxedo")
  );
});

test("B6.3 cleDedup : 2 contacts ≠ 2 clés", () => {
  assert.notStrictEqual(
    consignes.cleDedup("111", "arme praxedo"),
    consignes.cleDedup("222", "arme praxedo")
  );
});

test("B6.3 dedup15min : consigne nouvelle → nouvelle: true", () => {
  const r = consignes.dedup15min(T0, "444445", "Arme Praxedo", []);
  assert.strictEqual(r.nouvelle, true);
});

test("B6.3 dedup15min : repost < 15 min → ignorée", () => {
  const cle = consignes.cleDedup("444445", "Arme Praxedo");
  const r = consignes.dedup15min(T0 + 10 * MIN, "444445", "arme praxedo", [{ cle: cle, ts: T0 }]);
  assert.strictEqual(r.nouvelle, false);
});

test("B6.3 dedup15min : repost APRÈS 15 min → nouvelle (v2.20.99)", () => {
  const cle = consignes.cleDedup("444445", "Arme Praxedo");
  const r = consignes.dedup15min(T0 + 16 * MIN, "444445", "arme praxedo", [{ cle: cle, ts: T0 }]);
  assert.strictEqual(r.nouvelle, true);
});

test("B6.3 dedup15min : une AUTRE consigne dans la fenêtre → nouvelle", () => {
  const cle = consignes.cleDedup("444445", "Arme Praxedo");
  const r = consignes.dedup15min(T0 + 5 * MIN, "444445", "poursuis la qualification", [{ cle: cle, ts: T0 }]);
  assert.strictEqual(r.nouvelle, true);
});

// ---------------------------------------------------- REPRISE / ATTENTE ----
test("B6.3 consigneReprise : « poursuis/continue/reprends/qualif » (v2.20.54)", () => {
  assert.strictEqual(consignes.consigneReprise("poursuis la qualification"), true);
  assert.strictEqual(consignes.consigneReprise("continue avec le client"), true);
  assert.strictEqual(consignes.consigneReprise("reprends le dossier"), true);
  assert.strictEqual(consignes.consigneReprise("relance la qualification"), true);
  assert.strictEqual(consignes.consigneReprise("ne fais rien"), false);
});

test("B6.3 consigneAttendReponseClient : « dès que le client répond… » (v2.20.119)", () => {
  assert.strictEqual(consignes.consigneAttendReponseClient("dès que le client répond, relance la qualification"), true);
  assert.strictEqual(consignes.consigneAttendReponseClient("quand le client répond tu reprends"), true);
  assert.strictEqual(consignes.consigneAttendReponseClient("en attendant sa réponse ne relance pas"), true);
  assert.strictEqual(consignes.consigneAttendReponseClient("une fois que le client répond tu armes"), true);
  assert.strictEqual(consignes.consigneAttendReponseClient("après que le client répond on verra"), true);
});

test("B6.3 consigneAttendReponseClient : PAS de faux positif sur un CONSTAT", () => {
  assert.strictEqual(consignes.consigneAttendReponseClient("le client a répondu, il veut un devis"), false);
  assert.strictEqual(consignes.consigneAttendReponseClient("j'ai répondu au client"), false);
});

// ------------------------------------------------------------- PLAQUES ----
test("B6.3 plaquesCitees : plaque citée par un collègue → VALIDÉE (v2.20.58)", () => {
  assert.deepStrictEqual(consignes.plaquesCitees("c'est AB-123-CD, arme-le"), ["AB123CD"]);
  assert.deepStrictEqual(consignes.plaquesCitees("la plaque gg798nl"), ["GG798NL"]);
  assert.deepStrictEqual(consignes.plaquesCitees("AB-12-CD"), ["AB12CD"]); // forme courte 6 car
});

test("B6.3 plaquesCitees : trop court / rien → vide", () => {
  assert.deepStrictEqual(consignes.plaquesCitees("A-12-B"), []);
  assert.deepStrictEqual(consignes.plaquesCitees("appelle le client demain matin"), []);
  assert.deepStrictEqual(consignes.plaquesCitees(""), []);
});

test("B6.3 plaquesCitees : dédup + ordre préservé", () => {
  assert.deepStrictEqual(consignes.plaquesCitees("AB-123-CD puis AB123CD et EF-456-GH"), ["AB123CD", "EF456GH"]);
});

// -------------------------------------------------------------- RÉFÉRENCES ----
test("B6.3 extraireRefsInterventions : refs EVE PRIORITAIRES (v2.20.65)", () => {
  assert.deepStrictEqual(consignes.extraireRefsInterventions("intervention EVE123456, véhicule 44556677"), ["EVE123456"]);
  assert.deepStrictEqual(consignes.extraireRefsInterventions("eve12 et EVE345678"), ["EVE12", "EVE345678"]);
});

test("B6.3 extraireRefsInterventions : sans EVE → groupes 4-8 chiffres à bords de mot", () => {
  assert.deepStrictEqual(consignes.extraireRefsInterventions("l'intervention 4455 est planifiée, dossier 887766"), ["4455", "887766"]);
});

test("B6.3 extraireRefsInterventions : un téléphone (10 chiffres) ne matche PAS", () => {
  assert.deepStrictEqual(consignes.extraireRefsInterventions("appelle le 0612345678 please"), []);
});

test("B6.3 extraireRefsInterventions : rien → vide", () => {
  assert.deepStrictEqual(consignes.extraireRefsInterventions("bonjour"), []);
  assert.deepStrictEqual(consignes.extraireRefsInterventions(""), []);
});

// ------------------------------------------------------------- ANALYSE ----
test("B6.3 analyser : consigne d'armement complète", () => {
  const a = consignes.analyser({ texte: "@Agent IA : arme l'intervention EVE123456 pour AB-123-CD", auteur: "Marine", ts: T0 });
  assert.strictEqual(a.pour_agent, true);
  assert.strictEqual(a.question_interne, false);
  assert.strictEqual(a.consigne, "arme l'intervention EVE123456 pour AB-123-CD");
  assert.deepStrictEqual(a.references, ["EVE123456"]);
  assert.deepStrictEqual(a.plaques, ["AB123CD"]);
  assert.strictEqual(a.reprise, false);
});

test("B6.3 analyser : question interne + attente client", () => {
  const a = consignes.analyser({ texte: "@Agent IA ? dès que le client répond tu reprends la qualification", auteur: "Nicolas", ts: T0 });
  assert.strictEqual(a.pour_agent, true);
  assert.strictEqual(a.question_interne, true);
  assert.strictEqual(a.attend_reponse, true);
  assert.strictEqual(a.reprise, true);
});

test("B6.3 analyser : commentaire SANS mention → tout neutre", () => {
  const a = consignes.analyser({ texte: "J'appelle le client demain", auteur: "Marine", ts: T0 });
  assert.strictEqual(a.pour_agent, false);
  assert.strictEqual(a.question_interne, false);
  assert.strictEqual(a.consigne, "");
  assert.deepStrictEqual(a.plaques, []);
  assert.strictEqual(a.reprise, false);
});

// --------------------------------------------------- ÉTAT DOSSIER 4 PTS ----
test("B6.3 etatDossier4Points : dossier complet → rien en attente (v2.20.74-79)", () => {
  const l = consignes.etatDossier4Points({
    cycle: "A créer dans Praxedo",
    etat: { plaques: ["AB123CD"], panne: "levier cassé", photos: true, telephone_contact: "33612345678" },
    suiviRefs: ["EVE123456"]
  });
  assert.strictEqual(l, "Cycle : A créer dans Praxedo — Plaque : AB123CD — Intervention Praxedo : EVE123456 — Attente client : rien en attente");
});

test("B6.3 etatDossier4Points : téléphone manquant = BLOQUANT, cité en premier", () => {
  const l = consignes.etatDossier4Points({
    cycle: "A qualifier",
    etat: { plaques: ["AB123CD"], panne: "levier cassé", photos: false, telephone_contact: "" },
    suiviRefs: []
  });
  assert.ok(l.indexOf("Attente client : téléphone à contacter (bloquant)") !== -1);
});

test("B6.3 etatDossier4Points : plaque manquante signalée NON bloquante", () => {
  const l = consignes.etatDossier4Points({
    cycle: "A qualifier",
    etat: { plaques: [], panne: "levier cassé", photos: true, telephone_contact: "33612345678" },
    suiviRefs: []
  });
  assert.ok(l.indexOf("Attente client : plaque (non bloquante)") !== -1);
  assert.ok(l.indexOf("Plaque : —") !== -1);
});

test("B6.3 etatDossier4Points : la PANNERIE (panne) manquante aussi signalée", () => {
  const l = consignes.etatDossier4Points({
    cycle: "Nouvelle Demande",
    etat: { plaques: ["AB123CD"], panne: "", photos: false, telephone_contact: "33612345678" },
    suiviRefs: []
  });
  assert.ok(l.indexOf("description de la panne") !== -1);
});

test("B6.3 une consigne NE RETIRE PAS le tag (v2.20.106) — le module n'expose AUCUN retrait", () => {
  // la lecture d'une consigne est pure : rien dans analyser() ne touche aux
  // tags ; le retrait « Prise de main » est une décision SÉPARÉE (lib/scan.js)
  const a = consignes.analyser({ texte: "@Agent IA retire la prise de main", auteur: "Marine", ts: T0 });
  assert.strictEqual(a.pour_agent, true);
  assert.strictEqual(a.attend_reponse, false);
});

// ============================================================================
// Agent SAV U'mob v2 — B6.1 : tests des ACTIONS B4.2 (node --test, PUR)
// Aucune dépendance, aucun réseau : lib/actions.js est 100 % déterministe.
// ============================================================================
const { test } = require("node:test");
const assert = require("node:assert");
const actions = require("../lib/actions.js");
const etatLib = require("../lib/etat.js");

function etatComplet() {
  return {
    etape: 5,
    plaques: ["GG798NL"],
    panne: "crémaillère de direction HS",
    telephone_contact: "06 12 34 56 78",
    enseigne: "PIZZA SERVICES ETAMPES",
    nom: "Marie Dupont",
    jours_fermeture: "lundi",
    prise_de_main: false,
    demande_commerciale: false
  };
}

// ---------------------------------------------------------------- CORPS ----
test("B6.1 corpsMessage : forme EXACTE prod v136 {channelId, message{text}}", () => {
  const c = actions.corpsMessage("Bonjour", "12345");
  assert.deepStrictEqual(c, { channelId: 12345, message: { type: "text", text: "Bonjour" } });
});

test("B6.1 corpsMessage : canal absent → channelId null (respond.io choisit)", () => {
  assert.strictEqual(actions.corpsMessage("Bonjour", null).channelId, null);
  assert.strictEqual(actions.corpsMessage("Bonjour", "abc").channelId, null);
});

test("B6.1 corpsCycle : {name} (POST /lifecycle/update)", () => {
  assert.deepStrictEqual(actions.corpsCycle("A qualifier"), { name: "A qualifier" });
});

test("B6.1 corpsTag : TABLEAU [nom] (POST /tag, portage l.2866)", () => {
  assert.deepStrictEqual(actions.corpsTag("Prise de main"), ["Prise de main"]);
});

// ---------------------------------------------------------------- MANQUES --
test("B6.1 manquesDossier : dossier complet → aucun bloquant", () => {
  const m = actions.manquesDossier(etatComplet());
  assert.strictEqual(m.complet, true);
  assert.strictEqual(m.bloquants.length, 0);
});

test("B6.1 manquesDossier : plaque absente → NON bloquante (règle 6 / v2.20.89)", () => {
  const e = etatComplet();
  e.plaques = [];
  const m = actions.manquesDossier(e);
  assert.strictEqual(m.complet, true);
  assert.ok(m.nonBloquants.length === 1);
  assert.ok(m.nonBloquants[0].indexOf("NON bloquante") !== -1);
});

test("B6.1 manquesDossier : téléphone absent → BLOQUANT (seul bloquant réel)", () => {
  const e = etatComplet();
  e.telephone_contact = "";
  const m = actions.manquesDossier(e);
  assert.strictEqual(m.complet, false);
  assert.ok(m.bloquants.some((b) => b.indexOf("téléphone") !== -1 || b.indexOf("numéro") !== -1));
});

test("B6.1 manquesDossier : panne absente → bloquante (rien à créer dans Praxedo)", () => {
  const e = etatComplet();
  e.panne = "";
  const m = actions.manquesDossier(e);
  assert.strictEqual(m.complet, false);
  assert.ok(m.bloquants.some((b) => b.indexOf("panne") !== -1));
});

// ------------------------------------------------------ COMMENTAIRE SAV ----
test("B6.1 texteTransfertSav dossier COMPLET : récapitulatif + ACTION À FAIRE", () => {
  const t = actions.texteTransfertSav({ etat: etatComplet(), raison_escalade: "récapitulatif validé" });
  assert.ok(t.indexOf("TRANSFERT SAV") === 0);
  assert.ok(t.indexOf("— RÉCAPITULATIF DE LA QUALIFICATION —") !== -1);
  assert.ok(t.indexOf("GG-798-NL") !== -1); // plaque formatée
  assert.ok(t.indexOf("crémaillère de direction HS") !== -1);
  assert.ok(t.indexOf("06 12 34 56 78") !== -1);
  assert.ok(t.indexOf("PIZZA SERVICES ETAMPES") !== -1);
  assert.ok(t.indexOf("ACTION À FAIRE") !== -1);
  assert.ok(t.indexOf("Praxedo") !== -1);
});

test("B6.1 texteTransfertSav dossier INCOMPLET : RAISON + manques PRÉCIS (v2.20.95)", () => {
  const e = etatComplet();
  e.telephone_contact = "";
  e.panne = "";
  e.plaques = [];
  const t = actions.texteTransfertSav({ etat: e, raison_escalade: "" });
  assert.ok(t.indexOf("RAISON DU TRANSFERT : qualification incomplète") !== -1);
  assert.ok(t.indexOf("IL MANQUE PRÉCISÉMENT :") !== -1);
  assert.ok(t.indexOf("POUR PASSER À « A créer dans Praxedo »") !== -1);
  assert.ok(t.indexOf("NON bloquante") !== -1); // la plaque jamais bloquante
});

test("B6.1 texteTransfertSav : la raison du cerveau est reprise telle quelle", () => {
  const t = actions.texteTransfertSav({ etat: etatComplet(), raison_escalade: "" });
  // dossier complet → pas de RAISON (récapitulatif)
  assert.ok(t.indexOf("RAISON DU TRANSFERT") === -1);
  const e = etatComplet();
  e.panne = "";
  const t2 = actions.texteTransfertSav({ etat: e, raison_escalade: "urgence déclarée par le client" });
  assert.ok(t2.indexOf("urgence déclarée par le client") !== -1);
});

test("B6.1 texteTransfertSav : JAMAIS de mention @user ni d'assignation (décision Corentin 23/10)", () => {
  const t1 = actions.texteTransfertSav({ etat: etatComplet(), raison_escalade: "" });
  const e = etatComplet();
  e.telephone_contact = "";
  const t2 = actions.texteTransfertSav({ etat: e, raison_escalade: "" });
  for (const t of [t1, t2]) {
    assert.ok(t.indexOf("@user") === -1);
    assert.ok(t.indexOf("{{") === -1);
    assert.ok(t.indexOf("Marine") === -1);
    assert.ok(t.indexOf("Nicolas") === -1);
    assert.ok(t.indexOf("assigné") === -1);
  }
});

// --------------------------------------------------------- ACTIONSPREVUES --
test("B6.1 actionsPrevues silence → AUCUNE écriture (l'humain a la main)", () => {
  assert.deepStrictEqual(actions.actionsPrevues({ statut: "silence" }), []);
});

test("B6.1 actionsPrevues RESET sans prise de main → envoi seul", () => {
  const a = actions.actionsPrevues({ statut: "reset", type: "reset", reponse: "Mémoire purgée", etat: { prise_de_main: false } });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].action, "envoyer_message");
});

test("B6.1 actionsPrevues RESET avec prise de main → envoi + RETRAIT du tag", () => {
  const a = actions.actionsPrevues({ statut: "reset", type: "reset", reponse: "Mémoire purgée", etat: { prise_de_main: true } });
  assert.strictEqual(a.length, 2);
  assert.strictEqual(a[0].action, "envoyer_message");
  assert.strictEqual(a[1].action, "retirer_tag");
  assert.strictEqual(a[1].tag, "Prise de main");
});

test("B6.1 actionsPrevues rejet plaque → envoi seul (cycle inchangé, pas de tag)", () => {
  const a = actions.actionsPrevues({ statut: "traite", type: "plaque", reponse: "Cette plaque ne correspond pas", etat: {} });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].action, "envoyer_message");
});

test("B6.1 actionsPrevues conversation sans escalade, cycle inchangé → envoi seul", () => {
  const a = actions.actionsPrevues({ statut: "traite", type: "cerveau", reponse: "Bien noté.", escalade: false, etat: {}, cycle_prevu: { cycle: null, raison: "" } });
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].action, "envoyer_message");
});

test("B6.1 actionsPrevues cycle prévu → ENVOI d'abord PUIS poser_cycle (ordre)", () => {
  const a = actions.actionsPrevues({
    statut: "traite", type: "cerveau", reponse: "Quelle est l'immatriculation ?", escalade: false,
    etat: {}, cycle_prevu: { cycle: "Attente client", raison: "question posée" }
  });
  assert.strictEqual(a.length, 2);
  assert.strictEqual(a[0].action, "envoyer_message");
  assert.strictEqual(a[1].action, "poser_cycle");
  assert.strictEqual(a[1].cycle, "Attente client");
});

test("B6.1 actionsPrevues ESCALADE dossier complet → envoi + cycle + tag PDM + commentaire récapitulatif", () => {
  const a = actions.actionsPrevues({
    statut: "traite", type: "cerveau", reponse: "Je transmets au service technique.", escalade: true,
    raison_escalade: "récapitulatif validé par le client", etat: etatComplet(),
    cycle_prevu: { cycle: "A créer dans Praxedo", raison: "dossier complet" }
  });
  assert.strictEqual(a.length, 4);
  assert.strictEqual(a[0].action, "envoyer_message");
  assert.strictEqual(a[1].action, "poser_cycle");
  assert.strictEqual(a[1].cycle, "A créer dans Praxedo");
  assert.strictEqual(a[2].action, "ajouter_tag");
  assert.strictEqual(a[2].tag, "Prise de main");
  assert.strictEqual(a[3].action, "commentaire");
  assert.ok(a[3].texte.indexOf("RÉCAPITULATIF") !== -1);
});

test("B6.1 actionsPrevues ESCALADE dossier incomplet → commentaire avec manques, cycle A qualifier", () => {
  const e = etatComplet();
  e.telephone_contact = "";
  const a = actions.actionsPrevues({
    statut: "traite", type: "cerveau", reponse: "Je transmets.", escalade: true, raison_escalade: "",
    etat: e, cycle_prevu: { cycle: "A qualifier", raison: "incomplet" }
  });
  assert.strictEqual(a.length, 4);
  assert.strictEqual(a[1].cycle, "A qualifier");
  assert.ok(a[3].texte.indexOf("IL MANQUE PRÉCISÉMENT") !== -1);
});

test("B6.1 actionsPrevues demande COMMERCIALE → tag « Demande Commerciale », pas « Prise de main »", () => {
  const e = etatComplet();
  e.demande_commerciale = true;
  const a = actions.actionsPrevues({
    statut: "traite", type: "cerveau", reponse: "Je transmets à l'équipe commerciale.", escalade: true,
    raison_escalade: "prix demandé", etat: e, cycle_prevu: { cycle: "DE Commerciales", raison: "commercial" }
  });
  const tags = a.filter((x) => x.action === "ajouter_tag").map((x) => x.tag);
  assert.deepStrictEqual(tags, ["Demande Commerciale"]);
  const com = a.find((x) => x.action === "commentaire");
  assert.ok(com.texte.indexOf("DEMANDE COMMERCIALE") === 0);
  assert.ok(com.texte.indexOf("Prise de main") !== -1); // consigne de retrait à la fin
});

test("B6.1 actionsPrevues repli neutre → envoi + tag PDM + commentaire (l'humain reprend)", () => {
  const a = actions.actionsPrevues({
    statut: "repli", type: "cerveau", reponse: "Bien noté, je reste disponible.", escalade: true,
    raison_escalade: "récidive des gardes", etat: { telephone_contact: "", panne: "", plaques: [] }, cycle_prevu: null
  });
  assert.strictEqual(a.length, 3);
  assert.strictEqual(a[1].action, "ajouter_tag");
  assert.strictEqual(a[1].tag, "Prise de main");
  assert.strictEqual(a[2].action, "commentaire");
  assert.ok(a[2].texte.indexOf("récidive des gardes") !== -1);
});

// ---------------------------------------------------------- EXECUTERCTIONS --
test("B6.1 executerActions : io factice — tous les appels dans l'ordre, tous ok", async () => {
  const appels = [];
  const io = {
    envoyerMessage: async (texte, canal) => { appels.push(["envoyerMessage", texte, canal]); },
    poserCycle: async (cycle) => { appels.push(["poserCycle", cycle]); },
    ajouterTag: async (tag) => { appels.push(["ajouterTag", tag]); },
    retirerTag: async (tag) => { appels.push(["retirerTag", tag]); },
    ecrireCommentaire: async (texte) => { appels.push(["ecrireCommentaire", texte]) }
  };
  const liste = actions.actionsPrevues({
    statut: "traite", type: "cerveau", reponse: "Je transmets.", escalade: true, raison_escalade: "",
    etat: etatComplet(), cycle_prevu: { cycle: "A créer dans Praxedo", raison: "" }
  });
  const comptes = await actions.executerActions(liste, io);
  assert.strictEqual(comptes.length, 4);
  assert.ok(comptes.every((c) => c.ok === true));
  assert.strictEqual(appels.length, 4);
  assert.strictEqual(appels[0][0], "envoyerMessage");
  assert.strictEqual(appels[3][0], "ecrireCommentaire");
});

test("B6.1 executerActions : une écriture en ÉCHEC n'interrompt JAMAIS les suivantes", async () => {
  const io = {
    envoyerMessage: async () => { throw new Error("respond.io 503 : boom"); },
    poserCycle: async () => {},
    ajouterTag: async () => {},
    retirerTag: async () => {},
    ecrireCommentaire: async () => {}
  };
  const comptes = await actions.executerActions([
    { action: "envoyer_message", texte: "a" },
    { action: "poser_cycle", cycle: "A qualifier" },
    { action: "commentaire", texte: "c" }
  ], io);
  assert.strictEqual(comptes[0].ok, false);
  assert.ok(comptes[0].erreur.indexOf("503") !== -1);
  assert.strictEqual(comptes[1].ok, true);
  assert.strictEqual(comptes[2].ok, true);
});

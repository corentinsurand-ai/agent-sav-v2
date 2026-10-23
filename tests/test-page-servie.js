// ============================================================================
// Agent SAV U'mob v2 — B6.4.1 : tests du JavaScript RÉELLEMENT SERVI
// Exécution : node --test tests/test-page-servie.js
//
// POURQUOI cette suite existe (incident réel 23/10 — Corentin : « j'arrive pas
// à chercher la fiche client, et après je peux plus envoyer de message ») :
// la page /api/test vit dans une TEMPLATE LITERAL (backticks) du fichier
// serveur. Ce qui part au navigateur n'est PAS ce qui est écrit dans la
// source : les échappements (\n, \\, ${…}) sont INTERPRÉTÉS à l'évaluation.
// Le regex d'aperçu « /\n+/g » devenait un regex contenant un VRAI saut de
// ligne → SyntaxError fatale dans le navigateur → TOUT le script mort →
// tous les boutons inertes, sans aucun message d'erreur.
//
// Les autres suites testent le SERVEUR (handler, JSON) et cherchent des
// sous-chaînes dans la page — aucune ne fait ANALYSER le JavaScript servi.
// Cette suite comble exactement ce trou : elle force la page RÉELLEMENT
// SERVIE (template évaluée, comme le fait Vercel) et la fait parser.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// La page telle que Vercel la construit : on évalue la template literal de
// api/test.js EXACTEMENT comme le fait Node au chargement du module.
function pageServie() {
  const src = fs.readFileSync(path.join(__dirname, "..", "api", "test.js"), "utf8");
  const m = src.match(/var PAGE_HTML = `([\s\S]*?)`;\n/);
  assert.ok(m, "PAGE_HTML (template literal) introuvable dans api/test.js");
  return eval("`" + m[1] + "`"); // mêmes règles d'échappement que le module réel
}

function scriptServi() {
  const page = pageServie();
  const m = page.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "la page servie ne contient pas de bloc <script>");
  return m[1];
}

test("la page /api/test servie est un HTML complet et cohérent", () => {
  const page = pageServie();
  assert.ok(page.indexOf("<!DOCTYPE html>") === 0, "la page doit commencer par <!DOCTYPE html>");
  ["btn-fiche", "btn-envoyer", "btn-reset", 'id="tel"', 'id="msg"'].forEach(function (id) {
    assert.ok(page.indexOf(id) !== -1, "la page servie doit contenir l'élément " + id);
  });
});

test("B6.4.1 — le JavaScript SERVI est syntaxiquement valide (régression boutons morts)", () => {
  const script = scriptServi();
  // Si le script servi ne se parse pas, TOUS les boutons de la console sont
  // morts silencieusement (les onclick sont attachés à la fin du script).
  assert.doesNotThrow(function () { new Function(script); },
    "le script réellement servi doit être syntaxiquement valide");
});

test("B6.4.1 — le regex d'aperçu garde son \\n INTACT dans la page servie", () => {
  const page = pageServie();
  // Le regex doit arriver au navigateur comme deux caractères \ + n…
  assert.ok(page.indexOf("replace(/\\n+/g") !== -1,
    "la page servie doit contenir replace(/\\n+/g avec l'antislash littéral");
  // …et JAMAIS comme un vrai saut de ligne DANS un regex (le bug B6.4).
  assert.ok(page.indexOf("\n+/g") === -1,
    "aucun regex servi ne doit contenir un saut de ligne brut");
});

test("B6.4.1 — aucun autre échappement de template ne se retrouve brut dans le script servi", () => {
  // Filet de sécurité générique : à part les sauts de ligne NORMAUX du code
  // (fin de ligne), le script servi ne doit pas contenir de caractère de
  // contrôle inattendu (0x0B, 0x0C, 0x00-0x08) issu d'une séquence
  // d'échappement interprétée.
  const script = scriptServi();
  const suspects = [];
  for (var i = 0; i < script.length; i++) {
    var c = script.charCodeAt(i);
    if ((c < 9) || (c === 11) || (c === 12)) suspects.push(i);
  }
  assert.deepStrictEqual(suspects, [],
    "caractères de contrôle inattendus aux positions : " + suspects.join(", "));
});

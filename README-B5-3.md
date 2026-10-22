# B5.3 — Cycles et transferts visibles sur l'écran (divergence n°3)

`lib/comparaison.js` + `api/observations.js` + `lib/process.js` — la carte de
l'écran de comparaison est ENRICHIE pour répondre à la demande de Corentin
(23/10) : « je n'ai rien sur la console du nouveau ! or je veux voir tout ça
et savoir quel aurait été le comportement du nouveau ». Correction de la
divergence n°3 de l'audit ancien vs v2.

## Ce que la carte affiche maintenant

1. **📍 Cycle + 🏷️ Tags du contact** (sous le nom, sur chaque carte) : les
   valeurs ACTUELLES de la fiche respond.io (lues via B2.1). Limite
   documentée honnêtement dans le bandeau : l'API respond.io ne permet PAS
   de relire l'HISTORIQUE des changements de cycle ni les commentaires
   internes — seule la valeur du moment est lisible.
2. **⚙️ Bloc « B4.2 (mode actif) ferait »** (dans la carte NOUVEAU) : la
   SIMULATION de ce que le mode actif ferait pour cette observation —
   jamais exécutée, zéro écriture respond.io :
   - **escalade** → le transfert complet de l'ancien système : cycle
     « A qualifier » + tag « Prise de main » + commentaire interne
     « TRANSFERT SAV — merci de reprendre la main sur ce dossier » +
     motif du transfert (= la raison d'escalade journalisée) ;
   - **RESET** (type `reset`) → réponse canonique + retrait du tag
     « Prise de main », mémoire purgée ;
   - **rejet plaque** (type `plaque`) → garde cas A, cycle inchangé,
     poursuite au 2e échec ;
   - **sans escalade** → « aucun transfert — l'agent IA poursuit la
     conversation (cycle inchangé) ».
3. **Type d'observation dans le pied de carte** (`type : reset` /
   `type : plaque`) — absent pour une observation cerveau normale.

## Détail technique

- `lib/process.js` : les observations canoniques RESET et plaque portent
  désormais un champ `type` dans leur `detail` (additif — les observations
  existantes sans `type` restent affichables, défaut « cerveau »).
- `lib/comparaison.js` (moteur pur) : `actionsSimulees(type, escalade,
  raison)` calcule la liste des actions ; chaque ligne porte
  `cycle_ancien`, `tags_ancien`, `type_observation`, `actions_simulees`.
- `api/observations.js` : rendu (VERSION B5.3), 100 % lecture inchangée,
  zéro appel Mistral, zéro écriture.

## Non-constructions volontaires

- Les cycles CIBLES du cerveau en cours de qualification (fin de
  qualification → « A qualifier », pièces d'usure → « Attente interne »,
  etc.) ne sont PAS simulés : la liste exacte des cycles ancien (12) vs
  cahier des charges (9) reste à trancher avant B4.2 — la simulation
  n'invente pas un mapping non validé.
- Le tag « Demande Commerciale » et son cycle « DE Commerciales » : non
  simulés (le signal n'est pas encore journalisé dans l'observation) —
  arrive avec B4.2.

## Tests

6 tests (section B5.3 de `tests/test-observations.js`) :
cycle/tags remontent, escalade → transfert complet simulé, sans escalade →
aucun transfert, RESET → actions canoniques, rejet plaque → garde cas A,
écran rend cycle + tags + bloc B4.2 + motif. Plus 2 asserts `detail.type`
ajoutés aux tests bout en bout RESET et plaque de `tests/test-process.js`.

Exécution : `node --test tests/test-observations.js` — 23/23 (17 + 6).
Projet complet : 248/248 (31+42+25+23+23+27+15+39+23).

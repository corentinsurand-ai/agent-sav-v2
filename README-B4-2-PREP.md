# B4.2-PREP.1 — RESET / RAZ (purge de la mémoire)

`lib/process.js` — la commande RESET/RAZ de l'ancien système (`couperMemoire`)
reconstruite dans la v2, en DÉTERMINISTE. Première brique du chantier « tout
sauf l'assignation » décidé par Corentin (voir l'audit ancien vs v2).

## Comportement

Quand le DERNIER message entrant du contact est exactement `RESET` ou `RAZ`
(casse et espaces tolérés, texte seul — jamais un média, jamais une phrase qui
CONTIENT le mot) :

1. **Priorité absolue** : détecté AVANT le silence de prise de main — comme
   dans l'ancien système, le RESET retire toujours le tag. Le message est
   traité même si un humain a la main.
2. **Purge de la mémoire v2** : le formulaire du dossier (`agent_sav.dossiers`)
   repart à l'état vierge (panne, plaque de conversation, téléphone à
   contacter, étape… tout est purgé). La **fiche client B2.2 est réappliquée**
   (enseigne, plaques flotte, statut risque) : ce sont des données du client,
   pas de la conversation.
3. **Réponse canonique identique à l'ancien** (parité vérifiable sur l'écran
   de comparaison B5, ANCIEN = NOUVEAU sur le même fil) :
   « Mémoire de la conversation réinitialisée. Votre prochain message sera
   traité comme une nouvelle demande. -Agent IA U'mob- »
4. **Zéro appel Mistral** — c'est du code, pas du modèle.
5. Journal : entrée `process_reset` + entrée `observation` classique
   (`envoyee: false` en mode observation → visible sur l'écran B5).
6. Statut `reset` dans le résumé du run (`resultats[].statut`).

## Non-réponses volontaires

- « veuillez reset le gps » → traitement NORMAL (une phrase banale ne doit
  jamais purger un dossier en cours).
- RESET accompagné d'un média → traitement normal.
- Le retrait du tag « Prise de main » côté respond.io n'existe pas encore :
  la v2 n'écrit jamais dans respond.io (aucun envoi, aucun tag, aucun cycle)
  — l'écriture arrive en B4.2.

## Tests

`tests/test-process.js` — 5 tests dédiés (33 au total dans la suite) :
scénario complet (canonique + 0 appel + dossier purgé + flotte conservée +
journal), casse/espaces + RAZ, priorité sur « Prise de main », anti-faux
positif, et unitaire `estResetRaz`. Total projet : **236/236 verts**
(31 webhook + 42 contexte + 25 clients + 23 état + 23 cerveau + 27 gardes +
15 incidents + 33 process + 17 observations).

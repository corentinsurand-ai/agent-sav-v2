# B4.2-PREP.2 — Vérification de la plaque contre le parc (garde cas A)

`lib/process.js` + `api/process.js` — la garde « cas A » de l'ancien système
reconstruite dans la v2, en DÉTERMINISTE : une plaque donnée par le client est
vérifiée contre le PARC complet avant toute qualification. Correction de la
divergence n°2 de l'audit ancien vs v2 (deuxième brique du chantier
« tout sauf l'assignation »).

## Comportement

Quand le DERNIER message entrant du contact cite une ou plusieurs plaques :

1. **Plaque « nouvelle » uniquement** : ne sont vérifiées que les plaques
   citées pour la PREMIÈRE FOIS dans le fil (l'état est reconstruit sur tout
   l'historique SANS le dernier message). Les plaques de la flotte du client
   (miroir B2.2) et les plaques déjà dites dans la conversation — quel que
   soit le côté, règle 1 — ne sont JAMAIS revérifiées.
2. **Vérification contre le parc** : le miroir `agent_sav.clients` contient
   TOUTES les plaques du parc (colonne `plaque`, « / »-séparées) → requête
   PostgREST `plaque=ilike.*AA123BB*` (recherche pleine colonne,
   insensible à la casse), `limit=1`. Zéro appel Mistral.
3. **Plaque absente du parc** → réponse canonique IDENTIQUE à l'ancien
   (parité vérifiable sur l'écran B5, ANCIEN = NOUVEAU sur le même fil) :
   « Cette plaque ne correspond pas à notre parc. Quelle est la saisie
   exacte de la plaque ? »
4. **Comportement cas A — jamais de blocage** : la plaque citée RESTE dans
   l'état du dossier. Si le client la RÉPÈTE, elle n'est plus « nouvelle »
   (déjà dans l'historique) et la qualification POURSUIT normalement
   (règle 6 : la plaque n'est pas bloquante). Une seule vérification par
   plaque, pas de rejet en boucle.
5. Journal : entrée `process_plaque` (plaques absentes citées) + entrée
   `observation` classique (`envoyee: false` en mode observation → visible
   sur l'écran B5). Statut `traite`, `appels_mistral: 0`.
6. La garde s'exécute APRÈS le silence de prise de main : si un humain a la
   main, l'agent ne répond pas, même pour une plaque inconnue (§8).

## Non-réponses volontaires

- Vérification parc en ERREUR (Supabase injoignable) → JAMAIS de rejet :
  la qualification poursuit (best effort — la plaque n'est pas bloquante).
- Aucun vérificateur injecté (appel direct de `lib/process.js` sans `parc`)
  → traitement normal, aucun rejet.
- Média seul sans texte → aucune plaque à vérifier.
- La plaque reste ensuite dans le dossier : le cerveau peut la citer dans le
  récapitulatif une fois la qualification poursuivie.

## Fichiers

- `lib/process.js` — la garde (déterministe, zéro réseau : la vérification
  est INJECTÉE en paramètre `parc`), la réponse canonique `REPONSE_PLAQUE`.
- `api/process.js` — `plaqueDansParc(plaque)` : la requête PostgREST sur
  `agent_sav.clients`, best effort (erreur → `true`, jamais de rejet).
- `tests/test-process.js` — section B4.2-PREP.2 (contact dédié 444445,
  parc de test = `GG798NL` flotte + `AB123CD` autre client).

## Tests

6 tests (section B4.2-PREP.2 de `tests/test-process.js`) :

1. Hors parc bout en bout : rejet canonique exact, 0 appel Mistral,
   requête parc effectuée, journal `process_plaque` + observation
   `envoyee: false`, plaque conservée dans le dossier, message consommé.
2. Présente dans le parc (autre ligne du miroir) : pas de rejet,
   traitement normal (1 appel Mistral).
3. Plaque de la flotte (B2.2) : jamais revérifiée — aucune requête parc.
4. Cas A : la plaque RÉPÉTÉE n'est plus nouvelle → la qualification
   poursuit (2e échec, 1 appel Mistral, jamais de blocage).
5. Vérification parc en erreur → jamais de rejet (best effort).
6. Sans vérificateur injecté → traitement normal (rétrocompatibilité).

Exécution : `node --test tests/test-process.js` — 39/39 (33 + 6).
Projet complet : 242/242 (31+42+25+23+23+27+15+17+39).

## CORRECTIF B5.4.1 (23/10) — cas A COMPLET : l'étape 2 manquait

Incident console de test (Corentin, 23/10) : conversation avec GE-365-DD puis
GR-335-TT — « le cycle ne change jamais ». Cause : le portage n'avait pris que
l'ÉTAPE 1 de la garde cas A de l'ancien (le rejet canonique). Le v2.20.6/9/10
comportait DEUX étapes, et c'est l'étape 2 qui change le cycle :

1. **ÉTAPE 1 — 1re vérification** (B4.2-PREP.2, inchangée) : plaque citée
   pour la 1re fois absente du parc → rejet canonique
   « Cette plaque ne correspond pas à notre parc. Quelle est la saisie
   exacte de la plaque ? », 0 Mistral. Une seule fois, JAMAIS deux.
2. **ÉTAPE 2 — TRANSFERT AUTO** (porté en B5.4.1) : une vérification a déjà
   été envoyée dans le fil (canonique v2 OU texte de l'ancien agent :
   « vérifier l'immatriculation », « je ne retrouve pas cette
   immatriculation »…) ET le client REDONNE une plaque TOUJOURS absente du
   parc (confirmée, corrigée ou nouvelle — toutes les plaques du message
   sont revérifiées, y compris répétées) → TRANSFERT DÉTERMINISTE, 0 Mistral :
   - réponse canonique v2.20.9/10 : « Merci pour la confirmation. Je ne
     retrouve pas l'immatriculation GR-335-TT dans notre parc. Je transmets
     votre demande à un membre de notre équipe, qui aura accès à notre
     conversation et vous répondra au plus vite. » + signature ;
   - `escalade: true` + raison « PLAQUE NON IDENTIFIÉE AU PARC (cas A) : … » ;
   - type `cas_a` → en mode actif B4.2 : cycle « A qualifier » + tag
     « Prise de main » + commentaire TRANSFERT SAV ; à l'écran B5.3/console :
     le bloc « B4.2 (mode actif) ferait » affichera le transfert complet.

Sans cette étape, la conversation restait bloquée à re-demander la plaque
indéfiniment — chez l'ancien, un collègue reprenait la main dès la
confirmation. C'est ce qui fait passer le cycle à « A qualifier ».

Ne transfèrent JAMAIS (la qualification poursuit par le cerveau) : une plaque
corrigée reconnue au parc ; un message mixte (au moins une plaque du message
au parc — la plaque reconnue débloque) ; un message sans plaque après
vérification ; une erreur du vérificateur parc (règle 6 : jamais de rejet ni
de transfert sur erreur). Aucune 2e vérification n'est jamais envoyée : après
l'étape 2, un nouveau message avec une plaque toujours hors parc RE-déclenche
le transfert (en prod le tag « Prise de main » posé par B4.2 rendra la main à
un humain → silence ; dans le bac à sable il n'y a pas de tag, c'est visible
dans les actions simulées).

Compteurs mis à jour : `tests/test-process.js` 46/46 (39 + 8 cas A - 1
réécrit), `tests/test-console.js` 14/14 (12 + 2 cas A bout en bout).

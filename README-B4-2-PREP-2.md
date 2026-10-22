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

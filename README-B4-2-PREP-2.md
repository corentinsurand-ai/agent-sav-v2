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

## CORRECTIF B5.4.2 (23/10) — cas A : le transfert auto est ANNULÉ, le cycle devient VISIBLE

Historique : le signalement console de Corentin (« GE-365-DD puis GR-335-TT,
le cycle ne change jamais ») avait été mal interprété en B5.4.1 comme un
transfert automatique manquant. Clarification de Corentin : **le
fonctionnement d'origine était le bon** — il voulait VOIR le cycle que le mode
actif poserait, pas de transfert auto sur la plaque. B5.4.1 est ANNULÉ :

- `lib/process.js` : retour à la garde 2bis ORIGINALE (B4.2-PREP.2) — étape 1
  seule. Une plaque citée pour la 1re fois absente du parc → rejet canonique
  (0 Mistral) ; une plaque RÉPÉTÉE ou de la flotte n'est JAMAIS revérifiée ;
  au 2e échec la qualification poursuit par le cerveau (la plaque n'est PAS
  bloquante — règle 6). Le transfert reste la décision du CERVEAU.
  Helpers `formaterPlaque`/`verificationPlaqueDejaDemandee` supprimés.

- NOUVEAU `lib/cycles.js` (Node pur, zéro réseau) : le mapping §5 état →
  cycle respond.io, DÉTERMINISTE (jamais le LLM), à la casse exacte :
  - `CYCLES` : les 9 noms exacts (cycles-respondio.md fait foi) ;
  - `dossierComplet(etat)` : `telephone_contact && panne && etape >= 5`
    (la plaque n'est PAS bloquante — règle 6) ;
  - `cyclePrevu({statut, type, escalade, raison_escalade, etat, reponse})`
    → `{cycle, raison}` :
    - reset / silence / rejet plaque → `null` (cycle inchangé) ;
    - escalade + `demande_commerciale` → « DE Commerciales » ;
    - escalade + risque « Impayé » → « Bloquée Impayé » ;
    - escalade + « Mauvais payeur » → « Attente Paiement ou pré-auto CB » ;
    - escalade + dossier complet → « A créer dans Praxedo » ;
    - escalade sinon → « A qualifier » ;
    - réponse avec « ? » → « Attente client » (posé après 2 h sans réponse
      par le scan horaire) ;
    - sinon → `null` (inchangé).
    JAMAIS « En cours de réalisation » ni « Traitée » (Praxedo B6+).

- `lib/process.js` : chaque journal d'observation porte désormais
  `detail.cycle_prevu = {cycle, raison}` (le cycle que B4.2 mode actif
  poserait). `lib/comparaison.js` le propage (`ligne.cycle_prevu`) et
  `actionsSimulees` affiche le cycle RÉEL prévu (retombe sur « A qualifier »
  pour les anciennes entrées sans cycle_prevu).

- `api/test.js` (B5.4.2) : la console affiche à CHAQUE échange
  « 📍 Cycle que B4.2 poserait : … ». `api/observations.js` (écran B5) :
  la ligne meta affiche « ⚙️ B4.2 poserait : … ».

Compteurs : `tests/test-process.js` 39/39 (retour à l'original + test
plaque répétée restauré + assertion cycle_prevu), `tests/test-console.js`
16/16 (scénario GE-365-DD/GR-335-TT réécrit sur le comportement validé +
cycle_prevu), `tests/test-cycles.js` 21/21 (NOUVEAU). Projet complet : 285/285.

## CORRECTIF B5.4.3 (23/10) — messages MIXTES + le transfert de l'étape 5 devient RÉEL

Deux incidents console signalés par Corentin (23/10) :

1. **« levier de frein avant cassé. GF-887-DD a une crevaison arrière » → la
   réponse ne disait QUE « cette plaque ne correspond pas à notre parc »** :
   la garde interceptait TOUT le message et ignorait le problème décrit (la
   panne n'était même pas capturée). Le canonique seul reste pour une plaque
   citée SEULE ; un message MIXTE passe désormais au CERVEAU avec le résultat
   de la vérification INJECTÉ (l'autorité du parc reste déterministe, ici) :
   - `messageMixte(texte, plaques)` (PUR) : ≥ 2 mots significatifs hors
     plaque (stoplist grammaticale, tous formats d'écriture retirés) ;
   - mixte → leçon « la plaque X n'est PAS dans notre parc — réponds au
     reste, mais demande la saisie exacte (question OUVERTE) » + journal
     `process_plaque_mixte` ;
   - plaque seule → canonique 0 Mistral, INCHANGÉ (comportement validé).
2. **« après avoir fini la qualification, le cycle ne change pas »** : le
   prompt ne disait PAS que l'étape 5 = escalade — Mistral répondait « vos
   demandes sont bien enregistrées, l'équipe technique prendra contact »
   avec `escalade: false` (clôture muette, le dossier ne part jamais) :
   - `lib/cerveau.js` : étape 5 = TRANSFERT RÉEL (`"escalade": true` + raison
     + formulaire COMPLET : panne, telephone_contact, etape 5) ; SORTIE :
     « escalade = true pour TOUT transfert à l'équipe » + « mets panne à
     jour DÈS QUE le client décrit un problème » ;
   - G11 (`transfert_sans_escalade`) : annonce de transfert réclamée à
     l'étape 5-6 (formulaire.etape du modèle, passé en `etape_candidate`) SANS
     escalade → faute → régénération. Après correction → escalade true →
     cycle « A créer dans Praxedo » (dossier complet) ;
   - G10 (`plaque_hors_parc_ignoree`) : la réponse doit traiter la plaque
     hors parc (la citer, ou « notre parc »/« saisie exacte »/« immatriculation ») ;
   - exception G4 : plaque hors parc non résolue → la demande de saisie est
     LÉGITIME (ce n'est pas une redemande).

NB : l'état pré-fusion ne porte JAMAIS d'étape ni de panne (rien ne les
dérive des messages) — le formulaire complet à l'étape 5 est ce qui rend le
dossier complet et le cycle « A créer dans Praxedo » visible.

Compteurs : `tests/test-gardes.js` 37/37 (27 + G10/G4x/G11), `tests/test-process.js`
43/43 (mixte bout en bout, G10 régénération, G11 régénération → « A créer
dans Praxedo », seuil pur), `tests/test-console.js` 17/17. Projet : 300/300.

# B5.4 — La console de test du nouvel agent (bac à sable)

`api/test.js` + `lib/comparaison.js` (export `actionsSimulees`) — un bac à sable
pour tester le NOUVEL agent sans toucher au réel, demandé par Corentin (23/10) :
« construis-moi une petite fonction dans la console pour faire des tests avec
le nouvel agent où je peux voir ses réponses, ses comportements avec les
cycles, ses vérifications via le sheet et je veux que la fonction reset marche ».

## URL

`https://agent-sav-v2-umob.vercel.app/api/test?secret=<WEBHOOK_SECRET>`
(ou header `x-webhook-secret` — mêmes règles d'auth que l'écran B5).

## Ce que c'est

- **La chaîne RÉELLE** jusqu'au bout : fiche client lue dans le miroir
  `agent_sav.clients` (B2.2, par téléphone), vérification plaque contre le
  parc (MÊME requête que `api/process.js` — B4.2-PREP.2), Mistral RÉEL
  (`lib/mistral.js`), gardes, fusion, RESET/RAZ (B4.2-PREP.1).
- **ZÉRO écriture nulle part** : uniquement des GET Supabase (aucun message,
  aucun journal, aucun dossier), aucun accès respond.io
  (`RESPONDIO_TOKEN` n'est même pas requis — le fil de test n'existe pas
  dans respond.io).
- **La mémoire vit dans le navigateur** : renvoyée à CHAQUE échange
  (`memoire` = `[{sortant, texte, ts}]`, 60 messages max, ts strictement
  croissants réassignés côté serveur). Deux onglets = deux fils
  indépendants. **RESET la purge** (bouton dédié ou message « reset ») —
  même comportement que la prod : réponse canonique, formulaire à zéro,
  fiche client conservée.

## Utilisation

1. **Fiche client** : renseigner un numéro de téléphone → « Charger la
   fiche » → enseigne, plaques flotte, statut risque affichés (et injectés
   dans le traitement via `appliquerClient`). Un numéro inconnu = fiche
   absente, le test fonctionne quand même.
2. **Conversation** : écrire un message client → « Envoyer ». Chaque échange
   affiche une carte : réponse simulée, statut (`traite`/`silence`/`repli`/
   `reset`), type (`cerveau`/`reset`/`plaque`), appels Mistral réels,
   escalade éventuelle, **vérification du parc** (chaque plaque du message →
   dans le parc / ABSENTE), **ce que B4.2 (mode actif) ferait** (cycles
   respond.io casse exacte, tag « Prise de main », commentaire interne,
   retrait du tag au RESET — simulation, jamais exécuté), le journal
   d'étapes, et l'état compact du formulaire (étape, plaque, panne, prise de
   main).
3. **RESET** : bouton rouge (envoie « RESET ») → réponse canonique + la page
   purge sa mémoire : le message suivant repart de zéro, exactement comme en
   prod.

## Comportements involontaires notés

- `mode` forcé `observation` : même quand B4.2 existera, le bac à sable
  n'enverra jamais chez respond.io.
- `lecons` vides : aucune leçon active n'est injectée (le bac à sable teste
  le cerveau nu).
- Vérification parc « affichage » : l'endpoint vérifie toutes les plaques du
  message pour l'afficher, mais l'AUTORITÉ reste `traiterMessage` (garde cas
  A : 1 vérification par plaque NOUVELLE seulement, jamais de blocage).
- 400 si corps invalide ou message vide ; 405 hors GET/POST ; 401 sans
  secret ; 500 si `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/`MISTRAL_API_KEY`
  absents.

## Tests

`node --test tests/test-console.js` — 12 tests : auth (401), méthode (405),
configuration (500), page HTML, message simple (1 appel Mistral, aucun
transfert), plaque hors parc (rejet canonique, 0 Mistral, garde cas A,
`dans_parc:false`), plaque du parc (qualifiée, `dans_parc:true`), RESET
(canonique, 0 Mistral, état à zéro, actions « retrait du tag »), téléphone
(fiche client injectée, enseigne visible), GET `?telephone` (fiche ou null),
message vide (400), et l'INVARIANT : zéro écriture Supabase (uniquement des
GET), aucun accès respond.io.

# B3 — Le cerveau (cahier des charges v1, architecture v1.1 §3.3-3.4)

> Brique « Cerveau + gardes ». Preuve exigée par l'architecture avant annonce :
> les incidents historiques rejoués en scénarios de test (redemande, prix
> inventé, question fermée, orphelin, campagne push…) — comportement conforme
> au cahier des charges.

## Découpage (une sous-brique = une validation de Corentin)

| # | Sous-brique | Contenu |
|---|---|---|
| B3.1 | **État structuré** (livré) | `lib/etat.js` — le formulaire du dossier |
| B3.2 | **Cerveau** (livré) | `lib/cerveau.js` (pur) + `lib/mistral.js` (adaptateur) — réponse candidate + mise à jour du formulaire |
| B3.3 | **Gardes** (livré) | `lib/gardes.js` — code déterministe avant envoi, faute → 1 régénération, récidive → repli neutre |
| B3.2 | Cerveau | prompt court (règles v1) + 1 appel Mistral `mistral-large-latest` + adaptateur Mistral isolé ; rend réponse candidate + mise à jour du formulaire |
| B3.3 | Gardes | `lib/gardes.js` — code déterministe avant envoi (question fermée, prix/délai sans source, signature, plaque/téléphone redemandés, récap multi-scooters) |
| B3.4 | Rejeu des incidents | scénarios des incidents réels documentés (AGB, GG-798-NL…) contre cerveau + gardes |

## B3.1 — `lib/etat.js` : le formulaire (fautes impossibles par construction)

Node PUR : aucun réseau, aucune connaissance de respond.io/Google. Les
normalisations téléphone/plaque sont des portages identiques de `lib/clients.js`
(v136), dupliqués volontairement pour ne dépendre d'aucun adaptateur.

### Champs du formulaire
- `plaques[]` (canonique `AA123BB`) — jamais redemandées (règle 1)
- `telephone_contact` (canonique `336…`) — le SEUL champ qui bloque le transfert (règle 6)
- `telephones_connus[]`, `photos`, `vocal_recu` (règle 5)
- `client_cherche_info` (« une minute / je regarde » → attendre, règle 3)
- `campagne_push` (portage v124 : vocab campagne SANS signature « Agent IA U'mob »)
- `demande_commerciale` (signal prix/achat/location, §4)
- `prise_de_main` (tag fiche → l'agent se tait)
- `enseigne`, `statut_risque` (table `agent_sav.clients`, B2.2)
- `etape` (1-6, mise à jour par le cerveau B3.2), `panne`, `jours_fermeture` (cerveau)
- `dernier_sortant` (détection push / demande de téléphone)

### API
```js
const etat = require('./lib/etat.js');
etat.etatVierge();                      // formulaire vide (persisté dans dossiers.etat)
etat.reconstruireEtat(messagesB21);     // TOUT l'historique → formulaire
etat.etatDepuisContexte(jsonContexte);  // le JSON de /api/contexte → formulaire
etat.appliquerFiche(e, ficheB21);       // tags « Prise de main », « Demande Commerciale »
etat.appliquerClient(e, ligneClients);  // plaques flotte, enseigne, statut risque
etat.formaterPlaque('GG798NL');         // → 'GG-798-NL' (récapitulatifs)
```

### Garde anti-faux-positifs
- Plaques : mots de 2 lettres interdits en position lettre (« et 123 ou »
  n'est pas une plaque), lettres I/O/U exclues par construction, dédoublonnage
  insensible à la casse et aux séparateurs.
- Téléphones : jamais capturés au milieu d'un nombre plus long (horodatages,
  numéros de commande).

### Tests — `node --test tests/test-etat.js` (23 tests)
Rejouent les VRAIES conversations validées en prod (GG-798-NL, contact
547249072), l'incident push campagne (AGB), les règles 1, 3, 5, 6, 7 et
l'intégration exacte du JSON de /api/contexte.

## B3.2 — le cerveau (`lib/cerveau.js`, pur) + l'adaptateur Mistral (`lib/mistral.js`)

- **`lib/cerveau.js` — Node PUR, aucun réseau.**
  - `SYSTEME` : le cahier des charges v1 condensé UNE fois (ton, 6 étapes,
    9 règles dures, cas particuliers, format de sortie JSON) — **court par
    construction : < 4 000 caractères** (l'ancien : 187 563, cause racine
    documentée).
  - `silenceNecessaire(entree)` : prise de main / pas de message entrant →
    silence DÉTERMINISTE, le modèle n'est même pas appelé.
  - `construireMessages(entree)` : prompt système + contexte du dossier —
    formulaire B3.1 (plaques connues, téléphone « DÉJÀ FOURNI », signaux ⚠),
    fiche, ligne clients (risque → réponse neutre), conversation COMPLÈTE
    B2.1 (rôles CLIENT / AGENT IA / COLLÈGUE (à la main), photo/vocal rendus,
    chaque message borné 2 000 car.), leçons ciblées injectées seulement si
    présentes.
  - `parserReponse(texteModele)` : JSON strict souhaité (`response_format
    json_object` côté API), tolérance de secours (fences, texte autour) ;
    illisible → drapeau `reponse_illisible`, jamais de crash.
  - `fusionnerMajEtat(etat, formulaire)` : le LLM remplit un FORMULAIRE —
    whitelist stricte (plaque/plaques, panne, jours_fermeture, etape 1-6,
    telephone_contact), normalisations B3.1, et **jamais d'écrasement** d'une
    info déjà donnée par le client.
- **`lib/mistral.js` — le SEUL module qui parle à api.mistral.ai.**
  - `appelMistral(messages, options)` : `mistral-large-latest` (décision
    Corentin), Bearer `MISTRAL_API_KEY` (env var Vercel, jamais dans le code),
    `response_format json_object`, erreur ≥ 400 avec 200 premiers caractères.
  - Retry borné : 2 re-essais MAX, uniquement sur coupures transitoires
    (502/503/504/529 + erreurs réseau) — jamais sur 401/429 (leçon §8).
- Le processeur (B4) enchaînera : `silenceNecessaire` → `construireMessages`
  → `appelMistral` → `parserReponse` → **gardes (B3.3)** → `fusionnerMajEtat`.
  La réponse candidate ne part JAMAIS directement au client.

### Tests — `node --test tests/test-cerveau.js` (23 tests)
Prompt court borné + les 9 règles présentes ; rendus formulaire/photo/vocal/
collègue/leçons ; silences ; parse (propre, fences, texte autour, illisible,
silence voulu) ; fusion (dédup, jamais d'écrasement, étape bornée, champs
inconnus ignorés) ; adaptateur simulé (Bearer, json_object, 401 immédiat, 503
puis 200, 3×503 → épuisement, erreur réseau) ; intégration complète sur le fil
réel GG-798-NL.

## B3.3 — les gardes (`lib/gardes.js`)

**Code DÉTERMINISTE avant envoi** (cahier des charges §6.2) : vérifiées en
millisecondes contre le formulaire B3.1, zéro appel modèle, zéro loterie.
Faute → **UNE** régénération avec le rappel précis de la règle ; récidive →
**repli neutre** + Prise de main (B4). Le client ne voit jamais une réponse
fautive. Une garde nouvelle ne s'ajoute que si une leçon l'exige (§6.5).

| Garde | Règle | Détection |
|---|---|---|
| `signature` | 8 | « Agent IA U'mob » absent (apostrophe typographique tolérée) |
| `question_fermee` | 2 | « Pouvez-vous / Avez-vous / est-ce que vous… » — exception : « Est-ce que tout est correct ? » |
| `invention` | 9 | montant en €, « gratuit », délai chiffré (« sous X jours/heures ») |
| `plaque_redemandee` | 1/4 | question sur la plaque ALORS QUE le formulaire la connaît |
| `telephone_redemande` | 1/6 | question sur le téléphone ALORS QU'il est fourni |
| `recap_incomplet` | 7 | récapitulatif multi-scooters qui ne cite pas chaque plaque (formats variés) |
| `relance_client_cherche` | 3 | question dans la réponse pendant que le client cherche une info |
| `vocabulaire_voiture` | ton | « pédale / carburant / essence » |
| `reponse_vide` | — | réponse vide sans escalade explicite |

API : `gardes.verifier({ reponse, escalade, etat })` →
`{ ok, fautes: [{ code, rappel }] }` — le `rappel` est le texte exact
réinjecté au cerveau pour l'unique régénération.
`gardes.messageRepliNeutre()` — le repli de dernier recours (aucune info,
aucune promesse, aucune question — et il passe ses propres gardes).

### Tests — `node --test tests/test-gardes.js` (27 tests)
Chaque garde rejouée contre les fautes documentées de l'ancien agent, ET les
vraies réponses validées en prod (fil GG-798-NL : réponse « disjoncteur »,
demande téléphone de l'étape 3) doivent toutes PASSER. Fautes cumulées
remontées ensemble, repli neutre auto-vérifié.



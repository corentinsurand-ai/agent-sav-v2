# B3 — Le cerveau (cahier des charges v1, architecture v1.1 §3.3-3.4)

> Brique « Cerveau + gardes ». Preuve exigée par l'architecture avant annonce :
> les incidents historiques rejoués en scénarios de test (redemande, prix
> inventé, question fermée, orphelin, campagne push…) — comportement conforme
> au cahier des charges.

## Découpage (une sous-brique = une validation de Corentin)

| # | Sous-brique | Contenu |
|---|---|---|
| B3.1 | **État structuré** (livré) | `lib/etat.js` — le formulaire du dossier |
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

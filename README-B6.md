# B6.1 + B6.2 — les actions B4.2 STRUCTURÉES + le scan « Attente client »

Réponse à la décision de Corentin du 23/10 (« je veux tout sauf la partie
assignation ») : le périmètre arbitré se construit. Ces deux briques préparent
la bascule B4.2 SANS rien activer — le mode observation ne change pas d'un
octet, et le mode actif reste verrouillé derrière le feu vert de Corentin.

## B6.1 — lib/actions.js : ce que B4.2 ferait, en STRUCTURÉ

Pour chaque tour traité, `lib/process.js` calcule désormais la liste EXACTE et
ordonnée des écritures que le mode actif exécuterait sur respond.io. Cette
liste est journalisée dans l'entrée `observation` (`detail.actions_b42`) et
exposée dans la console de test (`actions_b42`) — Corentin voit donc, pour
chaque échange, le transfert complet simulé : envoi, cycle, tags, et le
commentaire interne TRANSFERT SAV **avec son texte intégral**.

| Action | Écriture respond.io (formes EXACTES du prod v2.20.136) |
| --- | --- |
| `envoyer_message` | `POST /contact/id:{id}/message` `{channelId, message:{type:'text',text}}` (l.7612) |
| `poser_cycle` | `POST /contact/id:{id}/lifecycle/update` `{name}` (l.6283) — casse exacte via `lib/cycles.js`, JAMAIS le LLM |
| `ajouter_tag` | `POST /contact/id:{id}/tag` `["Prise de main"]` (l.2866) |
| `retirer_tag` | `DELETE /contact/id:{id}/tag` `["Prise de main"]` (l.2972 — format singulier) |
| `commentaire` | `POST /contact/id:{id}/comment` `{text}` (l.2864) |

Règles portées de l'ancien système :

- **Ordre** : la réponse au client part D'ABORD, puis le cycle, puis les tags,
  puis le commentaire — le client n'attend jamais derrière une écriture.
- **RESET** : réponse canonique + retrait du tag « Prise de main » (si présent).
- **Escalade SAV** : tag « Prise de main » + commentaire « TRANSFERT SAV » —
  récapitulatif complet si le dossier est complet, sinon RAISON DU TRANSFERT +
  manques PRÉCIS (v2.20.95 : « IL MANQUE PRÉCISÉMENT… », « POUR PASSER À
  A créer dans Praxedo »). Le téléphone reste le SEUL bloquant, la plaque
  jamais bloquante (v2.20.89).
- **Demande commerciale** : tag « Demande Commerciale » + commentaire
  « DEMANDE COMMERCIALE » (pas de « Prise de main »).
- **Repli neutre** : envoi du repli + tag « Prise de main » + commentaire.
- **EXCLU (décision Corentin 23/10)** : aucune assignation de conversation,
  aucune mention `@user`, aucun routage Marine/Nicolas — les commentaires
  sont adressés à l'équipe sans mention.
- Le suivi Praxedo « @Agent IA intervention… » (v2.20.68) n'est pas encore
  cité dans le commentaire : il le sera quand la brique Praxedo existera.

### L'exécution réelle existe — mais VERROUILLÉE

`lib/respondio.js` porte désormais les 5 fonctions d'écriture (adaptateur =
seule couche autorisée à écrire chez respond.io). Le seul site d'appel est
`api/process.js`, derrière le **double verrou** :

```
MODE_AGENT=actif    (l'ancien verrou, inchangé)
B42_EXECUTION=1      (le nouveau verrou B6.1 — ABSENT de Vercel aujourd'hui)
```

Tant que `B42_EXECUTION` n'existe pas dans les variables d'environnement
Vercel, le code d'exécution est INATTEIGNABLE — testé (le test « mode actif
NON ARMÉ » prouve zéro écriture respond.io + rétrogradation avec
avertissement, exactement comme avant). La bascule B4.2 sera donc un
**changement de configuration** (poser 2 variables Vercel + basculer l'URL du
webhook respond.io), pas une livraison de code. Chaque écriture exécutée est
journalisée (`b42_envoyer_message`, `b42_poser_cycle`, `b42_ajouter_tag`,
`b42_commentaire`) ; une écriture en échec n'interrompt JAMAIS les suivantes.

## B6.2 — lib/scan.js : le scan « Attente client » + reprise-de-zéro (PUR)

La part DÉTERMINISTE des deux maintenances horaires (exécution branchée en
B4.2, decision pure testée dès maintenant) :

- `attendReponse(texte)` (portage v2.20.88) : un message sortant attend une
  réponse si « ? » ou demande explicite — une clôture, une confirmation
  d'enregistrement ou une information pure n'attend RIEN.
- `scanAttenteClient(maintenant, contacts)` : question posée sans réponse
  depuis ≥ 2 h → poser « Attente client ». Idempotent (rien si déjà posé),
  jamais sur « Traitée » ni conversation fermée. Le temps est INJECTÉ
  (testable, aucun timer réel).
- `repriseDeZeroNecessaire(cycleActuel, conversationFermee)` (équivalent
  v2.20.64/117) : conversation fermée ou cycle « Traitée » → le prochain
  message du client repart d'un dossier NEUF — plus jamais de tag fantôme
  sur un dossier terminé.

## Compteurs

- `tests/test-actions.js` **24/24** (NOUVEAU — corps exacts, manques,
  commentaire SAV, ordre des actions, io factice, échec non bloquant)
- `tests/test-scan.js` **19/19** (NOUVEAU)
- `tests/test-process.js` **46/46** (43 + 3 : actions journalisées en
  observation, mode ARMÉ exécute les formes exactes chez respond.io, mode
  actif non armé = zéro écriture)
- `tests/test-console.js` **19/19** (17 + 2 : actions_b42 dans le JSON,
  affichage embarqué)
- Projet complet : **348/348 verts** (13 suites, une par une).

## Ce que Corentin voit dans la console

Sur chaque carte d'échange, le bloc « B4.2 (mode actif) ferait » affiche
désormais les actions STRUCTURÉES avec l'aperçu du commentaire interne —
par exemple après le « oui » au récapitulatif :

> • envoyer la réponse au client
> • poser le cycle « A créer dans Praxedo »
> • poser le tag « Prise de main »
> • commentaire interne (jamais visible du client) — aperçu : « TRANSFERT
>   SAV : merci de reprendre la main… — RÉCAPITULATIF DE LA QUALIFICATION —
>   Scooter : AB-123-CD · Problème : levier de frein cassé… »

Le bac à sable reste ZÉRO écriture (Supabase en GET uniquement, aucun accès
respond.io) — invariant testé.

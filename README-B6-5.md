# B6.5 — COMMENTAIRES INTERNES @Agent IA DANS LA CONSOLE DE TEST

**Décision de Corentin (23/10) : « ajoute dans la console de test une fonction pour mettre
des commentaires à l'agent comme je le ferais dans respond.io, qu'il fasse les réponses
à moi ou au client en fonction de ce que je lui dis de faire ou non. »**

## Ce que ça fait

La console de test (`/api/test?secret=<WEBHOOK_SECRET>`) gagne une seconde zone de saisie :
**« Commentaire interne — comme un collègue dans respond.io »**. Le comportement est
FIDÈLE à la chaîne réelle B6.4 (webhook + tour consigne de `lib/process.js`), dans le bac
à sable : Mistral réel, zéro écriture, zéro accès respond.io.

| Ce que tu écris | Ce que l'agent fait (affiché dans la console) |
|---|---|
| `@Agent IA ? où en est le dossier ?` (ou `Question : …`) | **Répond À TOI en commentaire interne** (Mistral réel, texte libre) — jamais au client. En mode actif armé, ce commentaire serait POSTÉ dans respond.io. |
| `@Agent IA l'intervention EVE12345 est lancée` | **Armement Praxedo** : cycle « En cours de réalisation » + compte-rendu de vérification (réel si PRAXEDO_INTERVENTIONS_URL est posé, sinon « indisponible ») ; les refs sont persistées (suivi_refs). |
| `@Agent IA poursuis avec ce client` | **Reprise** : l'agent répond AU CLIENT (simulé, non envoyé) sur le dernier message client. |
| `@Agent IA dès que le client répond…` | **Attente client** : silence, il ne relance jamais (v2.20.119). |
| `@Agent IA c'est bien le scooter GH-456-IJ` | Consigne info, et la **plaque du collègue est VALIDÉE** (elle rejoint le dossier — plus jamais redemandée au client, v2.20.58). |
| `@Agent IA le client parle fort` (info) | Consigne **journalisée**, aucune action automatique. |
| Un commentaire **sans** mention `@Agent IA` | **IGNORÉ** — fidèle au filtre du webhook : jamais enfilé en prod. |
| La même consigne répétée < 15 min | **Dédup v2.20.99** : ignorée. |

## Mémoire des consignes côté navigateur

La console renvoie à CHAQUE requête :
- `memoire` : le fil de la conversation client (inchangé) ;
- `commentaires` (NOUVEAU) : l'historique de tes commentaires internes → la plaque d'un
  collègue reste validée aux échanges suivants (le 1bis de `lib/process.js` les relit) ;
- `persistant` (NOUVEAU) : `{suivi_refs, consigne_vue}` — le rôle du dossier Supabase
  en prod : suivi armé + dédup 15 min. **RESET purge tout** (fil + commentaires + persistant).

## API

`POST /api/test?secret=…` accepte désormais un champ `commentaire` (à la place de `message`) :

```json
{ "telephone": "06…", "commentaire": "@Agent IA ? où en est le dossier ?",
  "memoire": [...], "commentaires": [...], "persistant": { "suivi_refs": [], "consigne_vue": null } }
```

Réponse : `{ok, tour: "consigne"|"commentaire", statut, type
(question_interne|armement|reprise|attente_client|info|dedup|commentaire_ignore),
reponse (au CLIENT — reprise), reponse_commentaire (À TOI — question/armement),
analyse {consigne, references, plaques…}, actions_b42, journal, persistant, etat}`.

## Ce qui n'a PAS changé

- Aucun autre endpoint modifié (webhook, process, scan, observations : intacts).
- Le bac à sable reste ZÉRO écriture : que des GET Supabase, aucun accès respond.io
  (Mistral réel en POST, comme avant).
- `lib/process.js` NON modifié : la console réutilise le MÊME tour consigne que la prod
  (déclencheur='consigne', mêmes journaux consigne_*).

## Tests

`tests/test-console.js` 20 → 30 (+10) : filtre sans mention, question interne (réponse au
collègue, jamais au client, 1 Mistral), armement (cycle + compte-rendu + refs persistées),
reprise (réponse au client simulée), info journalisée, dédup 15 min bout en bout (persistant
renvoyé → renvoyé → ignorer), plaque collègue validée + persistée à l'échange suivant,
400 ni message ni commentaire, interface servie. Invariant zéro écriture Supabase +
zéro respond.io vérifié sur chaque test.

**Total B6.5 : 497/497 tests verts sur 19 suites** (487 + 10).

---

# B6.5.1 — RELAIS CLIENT : « @Agent IA demande au client… »

**Incident Corentin (23/10, capture console) : « pourquoi l'agent ne fait rien avec mon
commentaire ! »** — la consigne `@Agent IA demande au client l'adresse pour l'intervention`
tombait dans `info` (journalisée, aucune action) : la classification n'avait PAS de motif
« consigne adressée au client ». L'ancien agent avait la même limite. CORRECTIF : un
NOUVEAU motif de consigne — le RELAIS CLIENT.

## Ce que ça fait

| Ce que tu écris | Ce que l'agent fait |
|---|---|
| `@Agent IA demande au client l'adresse pour l'intervention` | **Rédige le message AU CLIENT** (Mistral réel, texte libre) qui transmet ta demande — en mode actif ARMÉ, ce message serait ENVOYÉ au client (action `envoyer_message`). |
| `@Agent IA dis au client que le technicien passe` | Pareil : transmission de l'information AU CLIENT. |
| `@Agent IA demande-lui son adresse` / `dis-lui…` / `informe le client…` / `transmets au client…` | Pareil (client implicite ou nommé). |

## Qualité et garde-fous

- Le message AU CLIENT passe les **MÊMES GARDES** que la chaîne normale (signature,
  question fermée, invention) : faute → **UNE régénération** avec les rappels (borne
  2 appels Mistral), récidive → **transmission LITTÉRALE** de ta consigne
  (« Message de l'équipe SAV : « … » » + signature) : zéro invention par construction.
- Le relais **BYPASSE le silence de prise de main** : un collègue qui donne l'ordre de
  parler au client, c'est la main rendue à l'agent.
- **Priorités inchangées** : question interne (?) > refs Praxedo (EVE…) > attente
  (« dès que le client répond ») > RELAIS > reprise > info. Une consigne de relais qui
  CITE une ref Praxedo reste un ARMEMENT (B6.4).
- **Faux positifs écartés** : « le client a demandé… » (participe passé + auxiliaire),
  « la demande au client » (nom + article), « dis au technicien », les reprises.
- Après l'envoi (mode actif), le scan horaire posera « Attente client » si le client
  ne répond pas sous 2 h (comportement existant, inchangé).

## Fichiers

`lib/consignes.js` (`consigneRelaisClient` + champ `relais_client` d'`analyser`),
`lib/cerveau.js` (`SYSTEME_RELAIS` + `construireMessagesRelais`, prompt court 711 car.),
`lib/process.js` (tour relais dans le tour consigne : gardes + régénération + repli
littéral), `api/test.js` (VERSION B6.5.1, type `relais_client`, carte console
« message AU CLIENT »).

## Tests

+13 : test-consignes 33→37 (motifs, faux positifs, analyser), test-cerveau 34→37
(SYSTEME_RELAIS + prompt), test-process 64→69 (relais conforme, bypass prise de
main, régénération bornée, repli littéral, priorité armement), test-console 30→31
(version B6.5.1 + relais bout en bout).

**Total : 510/510 tests verts sur 19 suites** (497 + 13).

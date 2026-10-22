# B5.1 — L'écran de comparaison §9

`api/observations.js` + `lib/comparaison.js` — la brique qui rend la comparaison
LISIBLE : pour chaque observation du mode B4.1, côte à côte sur une seule page :

- 👤 **le message client** qui a déclenché l'observation,
- 🤖 **la réponse RÉELLE de l'ancien agent** (celle que le client a reçue — le
  1er message sortant envoyé après le message client),
- 🧠 **la réponse SIMULÉE du nouveau cerveau** (jamais envoyée).

C'est le filet §9 du cahier des charges : Corentin compare, se fait une
conviction, et décide de la bascule (B4.2 mode actif) — pas l'inverse.

## Utilisation

Ouvrir dans le navigateur :

```
https://agent-sav-v2-umob.vercel.app/api/observations?secret=<WEBHOOK_SECRET>
```

Paramètres :
- `secret` : **obligatoire** (mêmes règles que les autres routes — 401 sinon) ;
- `limit` : nombre d'observations affichées, défaut 15, borné 30 (les plus
  récentes, puis re-triées chronologiquement pour la lecture du fil).

## Comment le moteur associe les messages

`lib/comparaison.js` (Node pur, zéro réseau, testable à 100 %) :

1. **Message client** = le DERNIER message ENTRANT au moment de l'observation
   (horodatage ≤ celui de l'entrée journal). Un message arrivé APRÈS
   l'observation est exclu — l'écran ne doit pas comparer la réponse à une
   question qu'elle n'a pas vue. Repli anti-dérive d'horloge : si respond.io et
   Supabase ne sont pas d'accord sur l'heure, le dernier entrant est pris quand
   même.
2. **Réponse ancien** = le 1er message SORTANT après ce message client (l'ancien
   agent ou un collègue — tout ce qui part réellement). Pas encore répondu →
   placeholder « aucune réponse réelle (encore) ».
3. **Réponse nouveau** = `detail.reponse` de l'entrée journal `observation`
   (`envoyee: false` — jamais envoyée au client).
4. Média seul → « (média reçu) » + lien 📎. Contexte respond.io en panne au
   moment de la lecture → carte avec avertissement, jamais de crash.

## Garanties

- **100 % LECTURE** : journal Supabase + contexte respond.io en GET uniquement.
  Aucune écriture nulle part, aucun appel Mistral (testé).
- Bornes d'appels : 10 contacts max par page (contexte par contact UNIQUE).
- Réponses : 200 HTML ; 401 secret invalide ; 405 non GET ; 500 config.

## Tests

`tests/test-observations.js` — 16 tests (moteur pur + écran avec fetch simulé).
Total projet : **230/230 verts** (31 webhook + 42 contexte + 25 clients +
23 état + 23 cerveau + 27 gardes + 15 incidents + 28 process + 16 observations).

## Limites assumées

- La comparaison porte sur les observations déjà journalisées par B4.1 : tant
  que le cron minute n'est pas posé (cron-job.org), la page reste vide.
- L'historique respond.io évolue : la « réponse ancien » affichée est celle
  présente au moment du rechargement de la page (si un collègue répond APRÈS,
  elle apparaît au rechargement suivant).
- Au-delà de 10 contacts différents dans la fenêtre affichée, les contacts
  supplémentaires gardent leur réponse simulée mais sans message client
  (avertissement affiché).

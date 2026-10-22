# B4.1 — Le processeur, MODE OBSERVATION

`api/process.js` + `lib/process.js` — la brique qui fait tourner la chaîne complète
(contexte → état → cerveau → gardes → fusion) sur les VRAIES conversations, **SANS
JAMAIS envoyer la réponse au client** : elle est journalisée « non envoyée ».
L'ancien agent continue de répondre en réel — c'est le filet de sécurité du cahier
des charges §9 (bascule uniquement sur la conviction de Corentin, réversible en 30 s).

## Ce que fait un run de /api/process

1. **Filet anti-blocage** : un message resté `en_cours` depuis > 30 min (crash
   Vercel entre claim et fin) est réenfilé — plus jamais de message invisible.
2. **Candidats** : les messages `statut = en_file` (les plus anciens d'abord,
   max 5 par run, borné 20 via `?max=`).
3. **CLAIM ATOMIQUE anti-double-traitement** : `PATCH ...?statut=eq.en_file` →
   seule l'exécution qui fait basculer la ligne vers `en_cours` la traite. Une
   exécution parallèle (ou un cron lancé deux fois) obtient un tableau vide et
   passe son tour. Deux runs simultanés ne peuvent JAMAIS répondre deux fois.
4. **Supersede** : si plusieurs messages du même contact sont en file, seul le
   PLUS RÉCENT est traité (la chaîne relit TOUT l'historique de toute façon) ;
   les autres passent `traite` avec une entrée journal `process_supersede`.
5. **La chaîne par contact** :
   - contexte complet B2.1 (fiche + historique + commentaires, 60 messages) ;
   - fiche client B2.2 par téléphone (enseigne, plaques flotte, statut risque) ;
   - leçons actives (ciblées client OU générales, max 5) ;
   - silence déterministe (prise de main → le modèle n'est MÊME PAS appelé) ;
   - cerveau B3.2 : 1 appel `mistral-large-latest` (2 max en cas de régénération) ;
   - gardes B3.3 : faute → 1 régénération AVEC rappels, récidive → repli neutre
     + prise de main — jamais de 3e appel ;
   - fusion du formulaire, whitelist stricte ;
   - journal de chaque étape dans `agent_sav.journal` ;
   - formulaire persisté dans `agent_sav.dossiers` (le cycle actuel est conservé
     tel quel : les cycles sont posés par l'adaptateur, jamais par le cerveau).
6. **Mode OBSERVATION** (défaut, `MODE_AGENT` non positionné) : la réponse finale
   est écrite dans le journal avec `envoyee: false`. **Aucune écriture chez
   respond.io** (aucun envoi de message, aucun cycle, aucun tag) — le code de
   l'envoi n'existe tout simplement pas dans B4.1.

## Sécurité

- `?secret=<WEBHOOK_SECRET>` (ou header `x-webhook-secret`), OU
  `Authorization: Bearer <CRON_SECRET>` pour les déclenchements planifiés.
- Configuration vérifiée AVANT tout claim : si `MISTRAL_API_KEY` (ou une autre
  variable) manque → 500 explicite, et AUCUN message n'est consommé.
- Un échec de traitement (respond.io injoignable, Mistral en panne persistante)
  → message `statut = erreur` + journal — JAMAIS rebouclé (un message empoisonné
  ne consomme pas Mistral en boucle).
- Historique respond.io illisible → erreur, jamais une réponse sur un extrait.

## Installation (Corentin, ~5 minutes)

1. **`MISTRAL_API_KEY`** dans Vercel → Settings → Environment Variables :
   la MÊME clé que l'ancien système Apps Script. Jamais dans le chat. Puis
   Redeploy (le push GitHub de B4.1 déploie déjà la route /api/process).
2. **Deuxième webhook respond.io** (NE PAS retirer l'ancien — il continue de
   répondre aux clients) : respond.io → Settings → Developer Webhooks →
   ajouter une URL : `https://agent-sav-v2-umob.vercel.app/api/webhook?secret=<WEBHOOK_SECRET>`
   → les messages arrivent AUSSI dans Supabase (file d'observation), l'ancien
   système reste seul à répondre.
3. **Test manuel** :
   `curl -s "https://agent-sav-v2-umob.vercel.app/api/process?secret=<WEBHOOK_SECRET>"`
   → `{"ok":true,"brique":"B4","version":"B4.1","mode":"observation","contacts":0}`.
4. **Vérification d'observation** : écrire depuis un contact de test (ex. le
   contact test personnel) → attendre ~1 min → relancer le curl → la réponse
   simulée apparaît dans `resultats` avec `envoyee:false`, et dans
   `agent_sav.journal` (étape `observation`). Ligne visible aussi dans
   `agent_sav.dossiers` (formulaire du contact).

### Planification (à choisir, PAS urgent pour valider B4.1)

Le cron minute n'a volontairement PAS été ajouté à `vercel.json` : sur le plan
Hobby, un cron plus fréquent qu'une fois par jour fait **échouer le build**
(Vercel limite la fréquence par plan) — et bloquerait tous les déploiements.
Trois options :

- **a. Manuel** (suffisant pour valider B4.1) : curl quand on veut observer.
- **b. Planificateur externe gratuit** (cron-job.org ou équivalent) : appeler
  l'URL du §3 toutes les 1 à 5 minutes — zéro coût, zéro changement vercel.json.
- **c. Vercel Pro** (~20 $/mois) : alors j'ajoute `"*/1 * * * *"` sur
  /api/process dans vercel.json (un push, le cron envoie Bearer CRON_SECRET
  automatiquement).

## Limites assumées (documentées, pas cachées)

- **Observation uniquement** : l'envoi réel + la pose des cycles respond.io
  (casse exacte des 9 cycles) = B4.2, après comparaison côte à côte.
- `MODE_AGENT=actif` est aujourd'hui rétrogradé en observation avec un
  avertissement journalisé — impossible d'envoyer quoi que ce soit par accident.
- Le modèle réel n'est testé qu'en prod réelle : les 214 tests simulent Mistral
  (c'est la définition même du mode observation : la preuve du modèle, c'est
  la comparaison sur les vraies conversations).

## Tests

`node --test tests/test-process.js` — 28 tests : silences déterministes, chaîne
complète, régénération avec rappels, récidive → repli neutre, budget 2 appels
max, fusion sans écrasement, leçons, client à risque, claim atomique concurrent,
supersede, filet anti-blocage 30 min, erreur Mistral persistante, JAMAIS
d'écriture respond.io. Suite complète : 214/214 verts.

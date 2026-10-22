# B2.2 — Synchro Google Sheet « Infos Service Client » → Supabase

## Ce que fait cette brique

Lecture (SEULE, jamais d'écriture) du Google Sheet « Infos Service Client »
(onglet fusionné `Client_contacts_risq_contr_prod`) et écriture de son miroir
dans la table `agent_sav.clients` de Supabase :

- **Clé = téléphone** normalisé (`06 12 34 56 78` → `33612345678`) — un
  client peut avoir plusieurs scooters : les plaques sont regroupées.
- Lecture **par en-têtes** (tolérante aux décalages de lignes de titre, aux
  accents, à la casse) — aucun index de colonne en dur, comme en prod v136.
- **Upsert idempotent** (`on_conflict=telephone`) : la synchro est rejouable
  à l'infini, sans doublon.
- **Cron Vercel quotidien** : 05:00 UTC (07:00 Paris) — synchro automatique.
- Mode `dry=1` : analyse SANS écrire (validation avant la première vraie
  synchro).

Nouveaux fichiers : `lib/google.js` (adaptateur Google Sheets, compte de
service, scope lecture seule), `lib/clients.js` (lecture par en-têtes +
regroupement + upsert), `api/sync-clients.js` (endpoint + auth cron),
`tests/test-clients.js` (23 tests). `vercel.json` gagne le cron quotidien.

## Installation (une seule fois, ~10 minutes)

### 1. Créer le compte de service Google

1. Ouvrir **https://console.cloud.google.com**
2. En haut : créer un projet (nom proposé : `agent-sav-umob`) — le plan
   gratuit suffit.
3. Menu ☰ → **API et services → Bibliothèque** → chercher **Google Sheets
   API** → **Activer**.
4. Menu ☰ → **IAM et administration → Comptes de service** →
   **+ Créer un compte de service** → nom : `sav-synchro` → Créer,
   ignorer les étapes 2 et 3 → **Terminer**.
5. Sur la ligne du compte créé : onglet **Clés** → **Ajouter une clé →
   Créer une clé → JSON** → un fichier `.json` se télécharge.
6. Ouvrir ce JSON : garder les valeurs `client_email` et `private_key`.

### 2. Partager le Sheet avec le compte de service

7. Ouvrir le Sheet **« Infos Service Client »** → bouton **Partager** →
   ajouter l'adresse `client_email` (finissant par
   `.iam.gserviceaccount.com`) → rôle **Lecteur** → Envoyer.
8. Dans l'URL du Sheet, copier l'ID (entre `/d/` et `/edit`) :
   `https://docs.google.com/spreadsheets/d/`**`<ID>`**`/edit`

### 3. Variables d'environnement Vercel (Projet agent-sav-v2 → Settings → Environment Variables, Production)

| Variable | Valeur |
|---|---|
| `GOOGLE_CLIENT_EMAIL` | le `client_email` du JSON |
| `GOOGLE_PRIVATE_KEY` | la `private_key` du JSON (TOUTE la valeur, y compris `-----BEGIN…-----` et `-----END…-----`) |
| `GOOGLE_SHEET_ID` | l'ID du Sheet (étape 8) |
| `CRON_SECRET` | **la même valeur que WEBHOOK_SECRET** (copier-coller) |

⚠️ Jamais de clé dans le chat ni sur GitHub — uniquement dans Vercel.
⚠️ Pour `GOOGLE_PRIVATE_KEY` : coller la valeur telle quelle, les `\n` sont
gérés par le code.

### 4. Déployer et vérifier

Le push GitHub redéploie automatiquement. Puis vérifier dans l'ordre :

```
1. Analyse à blanc (RIEN n'est écrit) :
   https://<projet>.vercel.app/api/sync-clients?secret=<WEBHOOK_SECRET>&dry=1
   → ok:true, lignes_lues, clients_detectés, échantillon des 3 premiers

2. Première vraie synchro :
   https://<projet>.vercel.app/api/sync-clients?secret=<WEBHOOK_SECRET>
   → ok:true, ecrits: N

3. Contrôle Supabase (Table Editor → agent_sav → clients) :
   N lignes, téléphones en 33…, plaques regroupées.
```

Ensuite la synchro tourne TOUTE SEULE chaque matin (07:00 Paris).

## Tests

```
node --test tests/test-webhook.js
node --test tests/test-contexte.js
node --test tests/test-clients.js
```
(84 tests au total : 31 + 30 + 23 — jamais `node --test tests/` en bloc)

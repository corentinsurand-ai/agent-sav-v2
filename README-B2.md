# Brique B2.1 — Lecture du contexte respond.io (LECTURE SEULE)

## Ce que fait B2.1

Nouvel endpoint **`/api/contexte`** : assemble pour un contact tout ce que
l'agent devra voir avant de répondre :

- **Fiche** : nom, cycle de vie, tags (dont « Prise de main »)
- **Messages** : historique complet, normalisé (texte, média, vocal, horodatage
  réel via `status[]`), sens entrant/sortant, distinction **agent IA vs
  collègue humain**, trié du plus ancien au plus récent
- **Commentaires** : consignes internes des collègues

**B2.1 n'envoie JAMAIS de message, n'écrit JAMAIS chez respond.io, n'insère
JAMAIS rien dans Supabase.** C'est un outil de validation 100 % lecture.
L'ancien système continue de fonctionner normalement.

## Installation (5 minutes, sur le déploiement Vercel EXISTANT)

### 1. Récupérer la clé API respond.io

Dans respond.io : **Settings → API** (rubrique « API Keys » / Developer).
C'est la même clé que celle déjà utilisée par l'ancien système (propriété
`RESPONDIO_TOKEN` du script Apps Script).

⚠️ **Ne collez cette clé nulle part sauf dans Vercel** (jamais dans le chat,
jamais dans un fichier).

### 2. L'ajouter dans Vercel

Projet **agent-sav-v2-b1-1** sur vercel.com :

1. **Settings → Environment Variables**
2. **Add New** :
   - Key : `RESPONDIO_TOKEN`
   - Value : *(la clé API respond.io)*
   - Environments : Production (et Preview si souhaité)
3. **Save**

### 3. Redéployer avec le nouveau code

- Soit drag & drop du dossier `agent-sav-v2/` complet sur
  vercel.com → projet agent-sav-v2-b1-1 → **Deploy** (nouvelles fonctions :
  `api/contexte.js`, `lib/respondio.js`, `lib/contexte.js`)
- Soit **Redeploy** après avoir poussé les nouveaux fichiers.

### 4. Vérifier

```
GET https://<votre-deploiement>.vercel.app/api/webhook
→ {"ok":true,"brique":"B1","version":"B1.1",...}     (inchangé)

GET https://<votre-deploiement>.vercel.app/api/contexte?secret=<WEBHOOK_SECRET>&contact=<id>
→ {"ok":true,"brique":"B2","version":"B2.1","contact":{...},"messages":[...],"commentaires":[...]}
```

## Variables d'environnement Vercel (récapitulatif complet)

| Variable | Rôle | Brique |
|---|---|---|
| `WEBHOOK_SECRET` | secret partagé webhook + contexte | B1 (déjà en place) |
| `SUPABASE_URL` | projet Supabase umob-crm | B1 (déjà en place) |
| `SUPABASE_SERVICE_KEY` | clé service_role « agent-sav » | B1 (déjà en place) |
| `RESPONDIO_TOKEN` | clé API respond.io (lecture) | **B2.1 — À AJOUTER** |

## Tests

```
node --test tests/test-webhook.js    # 31 tests — brique B1
node --test tests/test-contexte.js   # 30 tests — brique B2.1
```

(ne pas lancer `node --test tests/` en bloc — MODULE_NOT_FOUND)

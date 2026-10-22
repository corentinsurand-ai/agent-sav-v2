# Agent SAV U'mob v2 — Brique B1 (webhook)

**Ce que fait cette brique (et tout ce qu'elle fait) :**
quand respond.io envoie un message client, elle l'enregistre dans Supabase
(table `agent_sav.messages`) et répond `200` en moins d'une seconde.
Les autres événements (commentaires, mises à jour de contact…) sont
accusés mais ignorés proprement. Rien d'autre. Aucune réponse au client
n'est encore générée — c'est voullu (briques suivantes, une par une,
validées une par une).

**Installation : dans le projet Supabase EXISTANT `umob-crm`.**
Aucun nouveau projet (limite gratuite : 2 projets — CRM et Constat restent
tels quels). Les tables de l'agent vivent dans un **schéma dédié `agent_sav`** :
un compartiment étanche, aucune collision possible avec le CRM.

---

## Étape 1 — Créer les tables (2 minutes)

1. Ouvrir https://supabase.com/dashboard → le projet **umob-crm** (celui du CRM).
2. Menu gauche : **SQL Editor** → **New query**.
3. Coller TOUT le contenu de `supabase/schema.sql` → **Run**.
   → Si tout est vert, c'est fait (le script est rejouable sans risque).

## Étape 2 — Ouvrir le schéma `agent_sav` à l'API (1 minute, INDISPENSABLE)

1. Dans le projet umob-crm : **Settings → API**.
2. Descendre jusqu'à **Exposed schemas**.
3. Ajouter `agent_sav` à côté de `public` → **Save**.

*(Sans ça, l'API ne peut pas voir les tables et le webhook renverra une erreur 404.)*

## Étape 3 — Copier les 2 clés

Toujours dans **Settings → API** :

1. **Project URL** — copier (ex. `https://xxxx.supabase.co`).
2. **service_role key** (clé secrète) — copier.
   ⚠️ Cette clé donne un accès TOTAL au projet. Elle ne doit vivre QUE dans
   les variables d'environnement Vercel — jamais dans un code, un email ou GitHub.

## Étape 4 — Déployer sur Vercel (5 minutes)

1. Aller sur https://vercel.com/new.
2. Glisser-déposer le dossier décompressé de ce zip (aucun framework à
   configurer : Vercel détecte le dossier `api/` tout seul).
3. **AVANT de cliquer sur Deploy** : ouvrir « Environment Variables » et
   ajouter les 3 variables :

   | Nom | Valeur |
   |---|---|
   | `WEBHOOK_SECRET` | un NOUVEAU secret fort, choisi par toi (différent de l'ancien `8503520`) |
   | `SUPABASE_URL` | l'URL du projet umob-crm (étape 3.1) |
   | `SUPABASE_SERVICE_KEY` | la clé service_role (étape 3.2) |

4. **Deploy** → attendre « Congratulations ».
5. Vérification immédiate : ouvrir
   `https://TON-PROJET.vercel.app/api/webhook`
   → la page doit afficher : `{"ok":true,"brique":"B1","version":"B1.1","schema":"agent_sav"}`

## Ce qui NE CHANGE PAS (important)

- **respond.io continue de pointer sur l'ancien système** — rien à faire
  côté respond.io pour cette brique. L'ancien agent répond comme avant.
- Le CRM et le Constat ne sont ni modifiés ni mis en pause : ils utilisent
  le schéma `public`, l'agent utilise le schéma `agent_sav`.
- La bascule complète se fera plus tard (brique B6) en changeant l'URL du
  webhook dans respond.io — opération réversible en 30 secondes.

## Contenu du dossier

- `api/webhook.js` — le webhook (enregistre + accuse réception < 1 s)
- `lib/normaliser.js` — portage fidèle de la lecture des messages
  (texte, photo, vocal, email, horodatage, filtre des emails internes
  Praxedo/no-reply — mêmes règles que la prod actuelle)
- `supabase/schema.sql` — les 5 tables du schéma `agent_sav` (messages,
  dossiers, leçons, journal, clients)
- `tests/test-webhook.js` — 31 tests, tous verts (`node --test tests/test-webhook.js`)

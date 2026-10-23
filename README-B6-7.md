# B6.7 — Leçons de terrain : la notation devient une leçon injectée dans le cerveau

> Suite directe de B6.6 : la première note réelle de Corentin (3/5,
> `vocabulaire_voiture`, « tu dois demander lors d'une crevaison si il s'agit
> d'une crevaison avant ou arrière ! ») ne reste pas au fond d'une table —
> elle devient une LEÇON que l'agent applique, seule, au bon moment.

Règle projet (Corentin, 23/10) : **« attention à ne pas surcharger l'agent »**.
Un correctif à la fois, la structure AVANT le prompt, mesuré par les moyennes
des notations — jamais de course aux sous-règles.

## 1. La mécanique : déclencheurs → injection ciblée

Une leçon de terrain, c'est :

| Champ | Rôle | Exemple |
|---|---|---|
| `regle` | le texte de la leçon (entrera TEL QUEL dans le prompt) | « Crevaison : demander si le pneu est AVANT ou ARRIÈRE » |
| `declencheurs` | mots-clés séparés par `,` `;` `/` (≥ 3 lettres) | `crevaison, pneu, crevé` |
| `portee` | `generale` (tous les dossiers) ou `client` (un `contact_id`) | `generale` |
| `occurrences` | combien de fois le terrain l'a confirmée (seed puis renfort) | 1 |
| `statut` | `active` \| `validee` \| `annulee` \| `promue` | `active` |

- **Injection CIBLÉE** : une leçon avec déclencheurs n'entre dans le prompt
  QUE si un de ses mots-clés (normalisé : accents/casse/ponctuation
  insensibles) apparaît dans la conversation. « j'ai une crevaison » → la
  leçon crevaison entre ; « mon scooter ne démarre pas » → elle N'ENTRE PAS
  (zéro pollution du prompt — la règle projet).
- Une leçon SANS déclencheurs s'applique à chaque tour (comportement B6.3
  inchangé).
- **MAX 3 leçons par tour**, triées par occurrences décroissantes (les plus
  éprouvées d'abord), dédupliquées.
- Le crochet prompt existait depuis B6.3 : `construireMessages({lecons})`
  insère un bloc « === LEÇONS POUR CE DOSSIER === » dans le contexte.
- En PROD (api/process.js), le ciblage est identique :
  `chercherLecons(contactId, ctx)` lit les leçons `active|validee` puis
  filtre par déclencheurs sur TOUTE la conversation.

## 2. La boucle complète : note → leçon → renfort → promotion

1. **Corentin note** (B6.6) : 1-5 + type de règle + commentaire →
   `agent_sav.notations`.
2. **Il crée la leçon** dans la console (carte « Leçons de terrain ») :
   texte + déclencheurs. À la création, `occurrences` est SEEDÉ par le
   nombre de notations passées dont le commentaire cite un déclencheur —
   la note qui a motivé la leçon compte, sans double comptage.
3. **Chaque nouvelle notation renforce** : si le COMMENTAIRE de la note cite
   un déclencheur de la leçon (`commentaireCiteLecon`), `occurrences` +1
   (PATCH ciblé). C'est le terrain qui re-confirme.
4. **À ≥ 2 occurrences**, la leçon est candidate PROMOTION en règle dure
   (dans le vocabulaire/gardes du cerveau). Décision de Corentin, JAMAIS
   automatique : le bouton statut permet `validee` ou `promue` quand il
   l'estime ; `annulee` la retire de l'injection sans la supprimer.
5. **Vibe lit les notations** (`GET /api/test?secret=…&notations=1` ou SQL)
   pour faire progresser l'agent brique par brique.

## 3. Le SQL à exécuter (une seule fois, SQL Editor Supabase)

La table `agent_sav.lecons` existe depuis B1 — il ne manque QUE la colonne
`declencheurs` (section 8 de `supabase/schema.sql`) :

```sql
alter table agent_sav.lecons add column if not exists declencheurs text not null default '';
```

Sans cette colonne, les endpoints leçons répondent une erreur explicite :
« colonne declencheurs absente — exécute la section 8 de
supabase/schema.sql ».

## 4. Les endpoints et l'UI console

- `GET /api/test?secret=…&lecons=1` — la liste des leçons (tous statuts).
- `POST /api/test?secret=…` body `{lecon: {regle, declencheurs, portee,
  contact_id}}` → 201. Validations : `regle` requise, `portee` ∈
  {generale, client} (contact_id requis si client).
- `POST /api/test?secret=…` body `{lecon_action: {id, statut}}` → 200
  (`active|validee|annulee|promue`).
- `POST {noter}` (B6.6) renvoie EN PLUS `lecons_renforcees`.
- Les échanges et tours consigne renvoient `lecons_appliquees` (les leçons
  entrées dans le prompt de CE tour).
- La page : une carte **« Leçons de terrain (B6.7) »** (liste avec statut,
  occurrences et déclencheurs, création de leçon, boutons de statut) et une
  ligne « 🧠 Leçons de terrain appliquées » sur chaque carte d'échange /
  commentaire. Après une notation qui renforce, la liste se recharge.

## 5. Invariant du bac à sable (inchangé dans l'esprit)

Le bac à sable n'écrit chez Supabase QUE dans les tables d'apprentissage :
`agent_sav.notations` (POST) et `agent_sav.lecons` (POST création, PATCH
renfort/statut). Zéro respond.io, zéro autre table — vérifié test par test
(`verifierZeroEcritureSaufApprentissage`).

## 6. Tests

- Nouvelle suite `tests/test-lecons.js` (11 tests, module PUR) :
  normalisation, parsing déclencheurs, ciblage, portée client, statuts,
  cap 3 + tri, renfort par commentaire.
- `tests/test-console.js` étendu (49 tests) : création/validation leçon,
  seed d'occurrences, renfort sur notation, GET leçons, statuts, injection
  ciblée prouvée DANS le prompt Mistral (positif, négatif, sans
  déclencheurs).
- Total : **539/539 tests verts sur 20 suites**.

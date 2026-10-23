# B6.6 — Conversations + Notations 1-5 : la boucle d'amélioration de l'agent

> Décision de Corentin (23/10) : « je veux que dans la console mes tests soient
> triés dans un petit menu par conversation, à chaque RESET cela ferme la
> conversation et en crée une autre. Permets-moi aussi de noter chaque réponse
> de l'agent de 1 à 5 avec un commentaire et la différenciation sur le type de
> règle, pour que toi tu récupères ça et fasses progresser l'agent. »

Deux ajouts à la console de test (`/api/test`) :

## 1. Le menu Conversations

- Une carte « Conversations » en haut de la console : un menu déroulant
  (`#menu-conv`) liste toutes les conversations de la session, titrées par le
  premier message (tronqué à 60 caractères), + un bouton **Nouvelle
  conversation** (`btn-conv-new`).
- Chaque conversation garde SON propre fil : cartes affichées, mémoire,
  commentaires internes, champs persistants (plaque du collègue, suivi refs,
  dédup), message en attente. Changer de conversation change de fil.
- **RESET ferme la conversation courante** (elle reste consultable dans le
  menu, marquée fermée) et en ouvre une NOUVELLE, vierge. Un message
  « RESET reçu — conversation fermée, une nouvelle est ouverte » l'annonce.
- Les conversations vivent dans le navigateur (aucune écriture côté serveur,
  comme toujours : deux onglets = deux sessions indépendantes).

## 2. La notation 1-5 par type de règle

Sous CHAQUE réponse de l'agent (échange client comme commentaire interne), un
widget de notation apparaît :

- **5 étoiles** (1 à 5) ;
- un **menu du type de règle** : les 15 règles ci-dessous, injectées par le
  serveur (source unique `TYPES_REGLES` dans `api/test.js`) ;
- un champ **commentaire** libre ;
- un bouton **Noter**.

| # | id | Libellé |
|---|----|---------|
| 1 | `ton` | Ton / politesse |
| 2 | `question_fermee` | Question fermée |
| 3 | `invention` | Info inventée (prix, délai, date) |
| 4 | `plaque_redemandee` | Plaque redemandée |
| 5 | `telephone_redemande` | Téléphone redemandé |
| 6 | `recap_incomplet` | Récapitulatif incomplet |
| 7 | `relance_client_cherche` | Relance pendant la recherche client |
| 8 | `vocabulaire_voiture` | Vocabulaire voiture / scooter |
| 9 | `signature` | Signature manquante |
| 10 | `qualification` | Qualification / étape de conversation |
| 11 | `transfert_escalade` | Transfert / escalade SAV |
| 12 | `cycle_vie` | Cycle de vie |
| 13 | `consigne` | Consignes (question interne, relais, armement) |
| 14 | `reponse_pertinence` | Réponse hors sujet / pertinence |
| 15 | `autre` | Autre |

Au clic, la note part au serveur (validation stricte : entier 1-5,
`conversation_id` requis, `type_regle` dans la whitelist, troncatures) puis
dans la table **`agent_sav.notations`** — la **SEULE écriture de tout le bac à
sable** (tout le reste reste 100 % lecture) :

- colonnes : `conversation_id`, `note` (check 1-5), `type_regle`,
  `commentaire`, `tour`, `type_tour`, `message_client`, `reponse_agent`,
  `cree_a` ;
- le message client et la réponse de l'agent notés sont ARCHIVÉS avec la note —
  le retour terrain est autoporteur.

### ⚠️ Une seule action manuelle : créer la table

Exécuter dans **Supabase → SQL Editor** la section 7 de
`supabase/schema.sql` :

```sql
create table if not exists agent_sav.notations (
  id bigint generated always as identity primary key,
  conversation_id text not null,
  note int not null check (note between 1 and 5),
  type_regle text not null,
  commentaire text not null default '',
  tour text not null default '',
  type_tour text not null default '',
  message_client text not null default '',
  reponse_agent text not null default '',
  cree_a timestamptz not null default now()
);
create index if not exists idx_notations_regle on agent_sav.notations (type_regle, cree_a desc);
alter table agent_sav.notations enable row level security;
grant all on agent_sav.notations to service_role;
grant usage, select on all sequences in schema agent_sav to service_role;
```

Sans cette table, chaque notation échoue avec l'erreur explicite
« table agent_sav.notations absente ? exécute la section 7 de
supabase/schema.sql » — rien n'est perdu silencieusement.

## API

- `POST /api/test?secret=…` avec `{noter: {conversation_id, note, type_regle,
  commentaire, tour, type_tour, message_client, reponse_agent}}` → `201` (ou
  `400` si invalide). Géré AVANT la validation message/commentaire.
- `GET /api/test?secret=…&notations=1` → les 200 notations les plus récentes +
  un **résumé** : `{total, moyenne, par_regle: {<id>: {nb, moyenne,
  libelle}}}` — les moyennes PAR RÈGLE, prêtes à piloter les corrections.

## Comment l'agent progresse à partir des notes

1. Corentin teste dans la console et note chaque réponse (règle + commentaire).
2. Les notes s'accumulent dans `agent_sav.notations`.
3. `GET ?notations=1` (ou `select * from agent_sav.notations order by cree_a
   desc;` dans le SQL Editor) livre le résumé par règle : les règles les moins
   bien notées disent PAR QUOI commencer.
4. Chaque correctif ciblé devient une brique (une validation de Corentin), et
   la même table mesure la remontée des moyennes — preuve chiffrée du progrès.

## Ce qui n'a PAS changé

- Zéro écriture ailleurs : pas un message, pas un commentaire, pas un tag
  respond.io, aucun dossier Supabase — la console reste un vrai bac à sable.
- La chaîne réelle jusqu'au bout : fiche client miroir, parc, Mistral réel,
  gardes, consignes B6.5, relais B6.5.1.

## Correctif embarqué (B6.4.1 récidive, attrapée par le filet)

Pendant le dev : `l\'agent` (un seul antislash) dans la source servait
`l'agent` — l'apostrophe cassait la chaîne JavaScript du widget de notation →
`SyntaxError` → TOUS les boutons morts. Le filet `tests/test-page-servie.js`
l'a attrapée avant la prod (2ᵈ incident évité par la suite B6.4.1). Au passage
la suite lit désormais la page via `module.exports.PAGE_HTML` (la page
ÉVALUÉE, plus fidèle que le re-eval manuel de la template).

## Tests

`node --test tests/test-console.js` (37) + `node --test
tests/test-page-servie.js` (4) — 516/516 verts sur 19 suites (fichier par
fichier, jamais en bloc).

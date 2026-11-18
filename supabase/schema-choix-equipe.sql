-- ============================================================================
-- Agent SAV U'mob v2 — schéma agent_sav.choix_equipe (brique C15-ACT v126)
-- À rejouer tel quel dans SQL Editor (idempotent) — projet umob-crm.
--
-- RÔLE : source de vérité des ACTIONS ÉQUIPE de la plateforme (commentaires,
-- cycles/assignations modifiés à la main, fiches sociétés, rattachements,
-- vus/lus partagés). UNE ligne par (cle, type, cle2) — upsert, jamais de
-- doublon — et lue EN ENTIER au chargement : plus de fenêtre de 1000/5000
-- actions, plus aucune perte (le journal agent_sav.journal, lui, continue
-- de grossir avec les événements et n'est plus lu que comme historique).
--
--   cle       = clé stable de conversation (T<9 derniers chiffres du tel>,
--               M<email normalisé>, N<nom>, SOC:<enseigne normalisée>)
--   type      = commentaire | comm_edite | comm_supprime | cycle | assigne |
--               rattache | detache | entreprise | societe | societe_supprime |
--               notif | vu | lu
--   cle2      = sous-clé d'unicité : uid du commentaire, personne du « vu",
--               estampille pour les notifs, '' sinon
--   valeur    = texte de l'action (cycle choisi, JSON de la société, …)
--   detail    = jsonb libre (ex. {uid, heure} pour un commentaire)
--   auteur    = prénom du compte connecté (déduit du jeton, jamais du client)
--   horodatage= now() à l'écriture / à chaque upsert (dernière version gagne)
-- ============================================================================

create schema if not exists agent_sav;

create table if not exists agent_sav.choix_equipe (
  id bigint generated always as identity primary key,
  cle text not null,
  type text not null,
  cle2 text not null default '',
  valeur text,
  detail jsonb,
  auteur text,
  horodatage timestamptz not null default now(),
  constraint choix_equipe_uniq unique (cle, type, cle2)
);

create index if not exists choix_equipe_horodatage_idx on agent_sav.choix_equipe (horodatage);
create index if not exists choix_equipe_cle_idx on agent_sav.choix_equipe (cle);

alter table agent_sav.choix_equipe enable row level security;

-- ----------------------------------------------------------------------------
-- GRANTS service_role (OBLIGATOIRES pour toute NOUVELLE table du schéma
-- agent_sav : le « grant all on all tables » déjà joué ne s'applique qu'aux
-- tables existantes au moment de son exécution).
-- ----------------------------------------------------------------------------
grant usage on schema agent_sav to service_role;
grant all on agent_sav.choix_equipe to service_role;
grant all on all sequences in schema agent_sav to service_role;

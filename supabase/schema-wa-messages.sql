-- ============================================================================
-- Agent SAV U'mob v2 — C4 : table des messages WhatsApp (à exécuter dans le
-- SQL Editor du projet umob-crm — SEULEMENT cette section si le schéma
-- agent_sav existe déjà ; idempotent, rejouable sans risque)
-- ============================================================================

create table if not exists agent_sav.wa_messages (
  id bigint generated always as identity primary key,
  wa_id text not null,                          -- téléphone WhatsApp du client (ex 33620476040)
  nom_profil text,                              -- nom du profil WhatsApp (si fourni par Meta)
  texte text,
  type text not null default 'texte',           -- texte | image | audio | interactive | …
  wamid text not null unique,                   -- id Meta — dédup des rejeus de webhook
  brut jsonb not null,                          -- message Meta complet, pour diagnostic
  recu_a timestamptz not null default now(),    -- timestamp Meta (jamais 01/01/1970)
  statut text not null default 'nouveau'        -- nouveau | lu
);
create index if not exists idx_wa_messages_wa_id on agent_sav.wa_messages (wa_id, recu_a);
alter table agent_sav.wa_messages enable row level security;
grant all on agent_sav.wa_messages to service_role;
grant usage, select on all sequences in schema agent_sav to service_role;

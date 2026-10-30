-- ============================================================================
-- Agent SAV U'mob v2 — schéma agent_sav.emails (brique C5 : Email)
-- À rejouer tel quel dans SQL Editor (idempotent) — projet umob-crm.
-- ============================================================================

create schema if not exists agent_sav;

create table if not exists agent_sav.emails (
  id bigint generated always as identity primary key,
  message_id text,
  sens text not null default 'entrant',          -- 'entrant' | 'sortant'
  from_addr text,
  to_addr text,
  sujet text,
  texte text,
  brut jsonb,
  recu_a timestamptz default now(),
  lu boolean default false
);

-- C5.2 réception : uid IMAP du dernier email importé (point de reprise du polling)
alter table agent_sav.emails add column if not exists uid_imap bigint;
create index if not exists emails_uid_imap_idx on agent_sav.emails (uid_imap);

alter table agent_sav.emails add column if not exists statut_reception text;
alter table agent_sav.emails add column if not exists from_nom text;

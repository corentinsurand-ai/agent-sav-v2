-- ============================================================================
-- Agent SAV U'mob v2 — C5 : table agent_sav.emails
-- Messages EMAIL (sortants via /api/email-send, entrants via le polling
-- IMAP C5.2). Idempotent : rejouable sans risque sur l'installation existante.
-- ============================================================================

create table if not exists agent_sav.emails (
  id bigint generated always as identity primary key,
  message_id text unique,             -- Message-ID SMTP
  sens text not null default 'entrant', -- 'entrant' | 'sortant'
  from_addr text,                     -- adresse émettrice
  to_addr text,                       -- adresse destinataire
  sujet text,
  texte text,
  brut jsonb,                         -- payload / métadonnées brutes
  recu_a timestamptz,                 -- horodatage (réception ou envoi)
  statut_reception text,              -- sent | lu | null (pas d'accusé SMTP)
  lu boolean not null default false,  -- lu par un agent dans la plateforme
  created_at timestamptz not null default now()
);

alter table agent_sav.emails add column if not exists message_id text;
alter table agent_sav.emails add column if not exists sens text not null default 'entrant';
alter table agent_sav.emails add column if not exists from_addr text;
alter table agent_sav.emails add column if not exists to_addr text;
alter table agent_sav.emails add column if not exists sujet text;
alter table agent_sav.emails add column if not exists texte text;
alter table agent_sav.emails add column if not exists brut jsonb;
alter table agent_sav.emails add column if not exists recu_a timestamptz;
alter table agent_sav.emails add column if not exists statut_reception text;
alter table agent_sav.emails add column if not exists lu boolean not null default false;
create unique index if not exists emails_message_id_key on agent_sav.emails (message_id);

alter table agent_sav.emails enable row level security;

grant usage on schema agent_sav to service_role;
grant all on all tables in schema agent_sav to service_role;
grant all on all sequences in schema agent_sav to service_role;

-- ============================================================================
-- Agent SAV U'mob v2 — B1 : schéma SQL, à exécuter dans un projet Supabase
-- EXISTANT (aucun nouveau projet → zéro coût, pas de limite dépassée).
--
-- Toutes les tables vivent dans le schéma DÉDIÉ « agent_sav » : compartiment
-- étanche — AUCUN risque de collision avec les tables existantes du projet
-- (CRM ou autre), rien de l'installation actuelle n'est modifié ni supprimé.
-- Idempotent : rejouable sans risque.
-- RLS activé partout : seul le service key peut lire/écrire.
-- ============================================================================

create schema if not exists agent_sav;

-- 1. MESSAGES — file entrante + historique normalisé (et brut conservé pour diagnostic)
create table if not exists agent_sav.messages (
  id uuid primary key default gen_random_uuid(),
  event_id text not null unique,                -- dédup respond.io (retries rejoués)
  contact_id text not null,
  conversation_id text,
  canal_nom text,
  canal_id text,
  texte text,
  media_url text,
  type_media text,                              -- audio | image | video | null
  emis_a timestamptz,                           -- horodatage d'émission si présent dans le payload (status[]), sinon null
  recu_a timestamptz not null default now(),    -- heure de réception (jamais de 01/01/1970)
  statut text not null default 'en_file',       -- en_file | en_cours | traite | ignore
  brut jsonb not null                           -- payload complet, pour diagnostic futur
);
create index if not exists idx_messages_contact on agent_sav.messages (contact_id);
create index if not exists idx_messages_statut on agent_sav.messages (statut, recu_a);
alter table agent_sav.messages enable row level security;

-- 2. DOSSIERS — une ligne par conversation : l'état structuré (le formulaire
--    du cahier des charges §6) + le cycle de vie actuel (cahier des charges §5)
create table if not exists agent_sav.dossiers (
  contact_id text primary key,
  etat jsonb not null default '{}'::jsonb,      -- plaque, panne, photos, tel contact, jours fermeture…
  cycle_actuel text not null default 'Nouvelle Demande',  -- casse EXACTE respond.io
  maj_a timestamptz not null default now()
);
alter table agent_sav.dossiers enable row level security;

-- 3. LECONS — circuit d'apprentissage (cahier des charges §6) :
--    portée client ou générale, occurrences, promotion en règle dure à ≥ 2
create table if not exists agent_sav.lecons (
  id uuid primary key default gen_random_uuid(),
  portee text not null check (portee in ('client', 'generale')),
  contact_id text,                              -- null si portée générale
  regle text not null,
  occurrences int not null default 1,
  statut text not null default 'active',         -- active | validee | annulee | promue
  creee_a timestamptz not null default now(),
  maj_a timestamptz not null default now()
);
alter table agent_sav.lecons enable row level security;

-- 4. JOURNAL — chaque étape du traitement, horodatée. Source UNIQUE de la
--    future console (B7) et du résumé hebdo : rien d'autre ne les alimente.
create table if not exists agent_sav.journal (
  id uuid primary key default gen_random_uuid(),
  horodatage timestamptz not null default now(),
  contact_id text,
  etape text not null,                          -- webhook_enfile, webhook_email_interne, cerveau, gardes, observation, cycle…
  texte text,
  detail jsonb
);
create index if not exists idx_journal_contact on agent_sav.journal (contact_id, horodatage);
alter table agent_sav.journal enable row level security;

-- 5. CLIENTS — miroir du fichier clients (Google Sheet), synchronisé automatiquement
--    (décision Corentin 22/10). Clé = téléphone.
create table if not exists agent_sav.clients (
  telephone text primary key,
  plaque text,
  enseigne text,
  statut_risque text,
  brut jsonb,
  maj_a timestamptz not null default now()
);
alter table agent_sav.clients enable row level security;

-- 6. DROITS API — un schéma personnalisé N'AUTORISE RIEN par défaut (contraire-
--    ment à public, où Supabase accorde automatiquement les privilèges) : sans
--    ces GRANT, l'API renvoie « permission denied for schema agent_sav ».
--    Uniquement le rôle service : la clé publishable/anon ne peut RIEN
--    (RLS activé + aucune policy = aucun accès).
grant usage on schema agent_sav to service_role;
grant all on all tables in schema agent_sav to service_role;
grant all on all sequences in schema agent_sav to service_role;

-- 7. NOTATIONS (B6.6) — la boucle d'amélioration de la console de test : les
--    notes 1-5 de Corentin sur les réponses de l'agent, AVEC LE TYPE DE RÈGLE
--    concerné (les gardes + familles du cahier des charges) et un commentaire.
--    Chaque ligne = un message client + une réponse d'agent notés. Vibe lit
--    cette table (clé service) pour en tirer des leçons et faire progresser
--    l'agent ; GET /api/test?secret=…&notations=1 expose la liste + résumé.
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

-- 8. LEÇONS — DÉCLENCHEURS (B6.7) : la table agent_sav.lecons existe depuis B1
--    (portee client/generale, regle, occurrences, statut active|validee|annulee|promue).
--    B6.7 ajoute la ciblage : DECLencheurs = les mots-clés qui
--    rendent la leçon APPLICABLE à la situation en cours (« crevaison, pneu, crevé »).
--    Une leçon SANS déclencheurs reste applicable à CHAQUE tour (comportement B6.3).
--    À exécuter dans le SQL Editor après la section 7.
alter table agent_sav.lecons add column if not exists declencheurs text not null default '';

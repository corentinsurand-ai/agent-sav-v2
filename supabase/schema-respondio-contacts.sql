-- ============================================================================
-- Agent SAV U'mob v2 — C8-IMP : table agent_sav.respondio_contacts
--
-- RÔLE : miroir des contacts respond.io (API Platform), importés une fois puis
-- régénérables par POST /api/clients-import {respondio:[…]}. Conserve TOUT ce
-- que l'API expose sur un contact :
--   statut (open|closed), cycle_vie (lifecycle — mêmes cycles que la
--   plateforme), tags (jsonb), assignee (jsonb : utilisateur assigné),
--   champs (jsonb : custom_fields — societe, code_client, plaque, ville,
--   probleme_signale, demandeur, reference, praxedo…).
-- Consommé par la plateforme maison C1 via GET ?respondio=1 pour rattacher
-- les conversations WhatsApp importées aux entreprises (par tel, puis repli
-- sur champs.societe / champs.code_client).
--
-- NOTE : les commentaires internes respond.io NE SONT PAS récupérables via
-- l'API (endpoint Comment en écriture seule). Les importer manuellement si
-- besoin (export UI respond.io).
--
-- Idempotent : rejouable sans erreur. GRANTs service_role inclus.
-- Exécution : Supabase SQL Editor (projet umob-crm), une seule fois.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS agent_sav;

CREATE TABLE IF NOT EXISTS agent_sav.respondio_contacts (
  id        bigint PRIMARY KEY,
  prenom    text NOT NULL DEFAULT '',
  nom       text NOT NULL DEFAULT '',
  tel       text NOT NULL DEFAULT '',
  email     text NOT NULL DEFAULT '',
  statut    text NOT NULL DEFAULT 'open',
  cycle_vie text,
  tags      jsonb NOT NULL DEFAULT '[]',
  assignee  jsonb,
  champs    jsonb NOT NULL DEFAULT '{}',
  cree_a    timestamptz,
  maj_a     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS respondio_contacts_tel_idx ON agent_sav.respondio_contacts (tel);
CREATE INDEX IF NOT EXISTS respondio_contacts_email_idx ON agent_sav.respondio_contacts (email);

COMMENT ON COLUMN agent_sav.respondio_contacts.cycle_vie IS 'lifecycle respond.io (Nouvelle Demande, Traitée, En cours de réalisation, Annulée…)';
COMMENT ON COLUMN agent_sav.respondio_contacts.champs IS 'custom_fields respond.io (societe, code_client, plaque_d_immatriculation, ville_de_la_flotte, probleme_signale, praxedo_*)';

ALTER TABLE agent_sav.respondio_contacts ENABLE ROW LEVEL SECURITY;

-- Aucune policy : seul le service_role (bypass RLS) accède à la table.

GRANT USAGE ON SCHEMA agent_sav TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_sav.respondio_contacts TO service_role;

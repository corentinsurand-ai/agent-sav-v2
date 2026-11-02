-- ============================================================================
-- Agent SAV U'mob v2 — C6-AUTH : table agent_sav.utilisateurs (équipe)
--
-- RÔLE : comptes des collaborateurs U'mob pour la plateforme maison C1 :
--   - connexion (email + mot de passe haché scrypt côté serveur)
--   - rôle : 'admin' (gère les comptes) ou 'collaborateur'
--   - actif : un compte désactivé ne peut plus se connecter
--
-- Idempotent : rejouable sans erreur. GRANTs service_role inclus (RÈGLE : une
-- NOUVELLE table agent_sav exige ses propres GRANTs).
-- Exécution : Supabase SQL Editor (projet umob-crm), une seule fois.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS agent_sav;

CREATE TABLE IF NOT EXISTS agent_sav.utilisateurs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email               text NOT NULL UNIQUE,
  nom                 text NOT NULL DEFAULT '',
  role                text NOT NULL DEFAULT 'collaborateur'
                      CHECK (role IN ('admin', 'collaborateur')),
  mot_de_passe        text NOT NULL,          -- 'scrypt$<sel hex>$<hash hex>'
  actif               boolean NOT NULL DEFAULT true,
  cree_a              timestamptz NOT NULL DEFAULT now(),
  derniere_connexion  timestamptz
);

-- Le mot de passe haché ne sort JAMAIS de la base côté service : la route ne
-- le sélectionne qu'à la connexion et ne le renvoie pas.
COMMENT ON COLUMN agent_sav.utilisateurs.mot_de_passe IS
  'hash scrypt (sel aleatoire) — jamais de mot de passe en clair';

CREATE INDEX IF NOT EXISTS utilisateurs_email_idx
  ON agent_sav.utilisateurs (email);

-- ----------------------------------------------------------------------------
-- Sécurité : RLS activé, tout passe par la clé service_role (backend Vercel)
-- ----------------------------------------------------------------------------
ALTER TABLE agent_sav.utilisateurs ENABLE ROW LEVEL SECURITY;

-- Aucune policy : seul le service_role (bypass RLS) accède à la table.

-- GRANTs service_role (RÈGLE durable : les nouvelles tables les exigent)
GRANT USAGE ON SCHEMA agent_sav TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_sav.utilisateurs TO service_role;

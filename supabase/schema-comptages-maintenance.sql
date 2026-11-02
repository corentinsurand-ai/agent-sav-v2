-- ============================================================================
-- Agent SAV U'mob v2 — C7-MAINT : table agent_sav.comptages_maintenance
--
-- RÔLE : stocker les comptages de maintenances précalculés par le script
-- déterministe (règles du cahier des charges « Maintenances » §3-4) à partir
-- du Google Sheet « Infos Service Client ». Une ligne PAR CODE CLIENT :
--   - donnees (jsonb) = { sans_contrat, sites: [ {cp, ville, adresse, pack,
--     droits, consommes, restants, contrat_debut, contrat_fin, derniere,
--     reparations_recentes, conclusion} ], connecteurs: {nb, conclusion,
--     dernier} }
--   - consommés par la plateforme maison C1 via GET /api/clients-import
--     ?liste=1 (fusion par code_client des brut.lignes) — un upsert par
--     POST {maintenances:[…]} régénère tout le comptage à chaque import.
--
-- Idempotent : rejouable sans erreur. GRANTs service_role inclus (RÈGLE : une
-- NOUVELLE table agent_sav exige ses propres GRANTs).
-- Exécution : Supabase SQL Editor (projet umob-crm), une seule fois.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS agent_sav;

CREATE TABLE IF NOT EXISTS agent_sav.comptages_maintenance (
  code_client  text PRIMARY KEY,
  nom          text NOT NULL DEFAULT '',
  donnees      jsonb NOT NULL,
  maj_a        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN agent_sav.comptages_maintenance.donnees IS
  'comptage précalculé (pack, droits, consommés, restants, dernière maintenance, conclusion) — régénéré par POST /api/clients-import {maintenances}';

-- ----------------------------------------------------------------------------
-- Sécurité : RLS activé, tout passe par la clé service_role (backend Vercel)
-- ----------------------------------------------------------------------------
ALTER TABLE agent_sav.comptages_maintenance ENABLE ROW LEVEL SECURITY;

-- Aucune policy : seul le service_role (bypass RLS) accède à la table.

-- GRANTs service_role (RÈGLE durable : les nouvelles tables les exigent)
GRANT USAGE ON SCHEMA agent_sav TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_sav.comptages_maintenance TO service_role;

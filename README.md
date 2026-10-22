# Agent SAV U'mob v2

Backend de l'agent SAV U'mob, reconstruit brique par brique.

Architecture : Vercel (functions) + Supabase (schéma agent_sav du projet umob-crm).
Tous les secrets vivent dans les variables d'environnement Vercel, jamais dans ce repo.

## Briques

- B1.1 : api/webhook — reçoit les webhooks respond.io, enregistre dans Supabase
- B2.1 : api/contexte — lit le contexte complet d'un contact (fiche, historique, commentaires), lecture seule

## Fichiers

- api/ : endpoints Vercel
- lib/ : logique (normalisation, adaptateur respond.io, assemblage contexte)
- supabase/ : schéma SQL des tables (schéma agent_sav)
- tests/ : suites node --test (aucune dépendance)

## Tests

Commandes : node --test tests/test-webhook.js puis node --test tests/test-contexte.js

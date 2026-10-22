# Agent SAV U'mob v2

Backend de l'agent SAV U'mob, reconstruit brique par brique.

Architecture : Vercel (functions) + Supabase (schéma agent_sav du projet umob-crm).
Tous les secrets vivent dans les variables d'environnement Vercel, jamais dans ce repo.

## Briques

- B1.1 : api/webhook — reçoit les webhooks respond.io, enregistre dans Supabase
- B2.1 : api/contexte — lit le contexte complet d'un contact (fiche, historique, commentaires), lecture seule
- B2.2 : api/sync-clients — miroir Google Sheet → agent_sav.clients (cron quotidien)
- B3 : le cerveau (lib/etat, lib/cerveau, lib/mistral, lib/gardes) — voir README-B3.md
- B4.1 : api/process — le processeur, MODE OBSERVATION (voir README-B4.md)
- B5 : api/observations — l'écran de comparaison §9 (voir README-B5.md)
- B5.3 : lib/comparaison + api/observations — cycles et transferts visibles à l'écran (voir README-B5-3.md)
- B4.2-PREP.1 : lib/process — RESET/RAZ, purge mémoire déterministe 0 Mistral (voir README-B4-2-PREP.md)
- B4.2-PREP.2 : lib/process + api/process — vérification plaque contre le parc, rejet canonique cas A (voir README-B4-2-PREP-2.md)
- B4.2-PREP.3 : cycles-respondio — liste exacte validée des 12 cycles respond.io, référence pour B4.2 (voir cycles-respondio.md)

## Fichiers

- api/ : endpoints Vercel
- lib/ : logique (normalisation, adaptateur respond.io, assemblage contexte)
- supabase/ : schéma SQL des tables (schéma agent_sav)
- tests/ : suites node --test (aucune dépendance)

## Tests

Commandes : node --test tests/test-webhook.js puis node --test tests/test-contexte.js, etc. — TOUJOURS fichier par fichier (jamais node --test tests/ en bloc).



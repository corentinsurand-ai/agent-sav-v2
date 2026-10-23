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
- B5.4 : api/test — la console de test du nouvel agent, bac à sable zéro écriture (voir README-B5-4.md)
- B5.4.2 : annulation du correctif B5.4.1 (transfert auto cas A — comportement d'origine validé par Corentin) + affichage du cycle que B4.2 poserait à chaque échange, mapping §5 déterministe via lib/cycles.js (voir README-B4-2-PREP-2.md § Correctif B5.4.2)
- B5.4.3 : messages MIXTES (plaque inconnue + description → le cerveau répond à tout, garde G10) + étape 5 = transfert RÉEL (escalade:true obligatoire, garde G11, formulaire complet) (voir README-B4-2-PREP-2.md § Correctif B5.4.3)
- B6.4.2 : DIGEST EMAIL ACTIVÉ EN MODE OBSERVATION (décision Corentin 23/10 « active-le en observation ») — le digest des prises de main part DANS LES DEUX MODES (notification pure : zéro écriture respond.io, `arme` ne verrouille toujours QUE les écritures respond.io) ; sans RESEND_API_KEY → journal digest_non_envoye, prises JAMAIS perdues (repasse au scan suivant) — 487/487 tests (voir README-B6-4.md § B6.4.2)
- B6.4.1 : CORRECTIF CONSOLE (incident réel 23/10 « boutons morts ») — le regex `\n` de l'aperçu TRANSFERT SAV, stocké dans la template literal de la page, était converti en VRAI saut de ligne à l'évaluation → SyntaxError du script servi → aucun bouton n'était branché (Charger la fiche, Envoyer, RESET, Entrée inertes) depuis B6.4 ; fix : `\\n` dans la source + NOUVELLE suite tests/test-page-servie.js qui fait PARSER le JavaScript réellement servi (voir README-B6-4.md § Correctif B6.4.1)
- B6.4 : LE BRANCHEMENT — consignes @Agent IA exécutables (webhook comment.created enfilé canal_nom=consigne, tour consigne dans lib/process : question interne Mistral libre, armement Praxedo + compte-rendu, reprise/attente, dédup 15 min), citation v2.20.68 exacte dans TRANSFERT SAV, api/scan.js maintenance horaire (attente client, purge Praxedo, reprise-de-zéro, retrait tag ≥ 2 h, digest Resend), champs persistants du dossier, renommage branché OFF par défaut — 482/482 tests (voir README-B6-4.md)
- B6.3 : consignes internes @Agent IA (lib/consignes.js), suivi Praxedo (lib/praxedo.js — 3 états, throttle 2 h, purge, armement), digest prise de main (lib/digest.js), renommage DÉSACTIVÉ par défaut (lib/renommage.js), ton par canal (blocCanal v2.10), vocabulaire push complet v116 + garde G12, photo récente < 5 min, identification par plaque en repli — 455/455 tests (voir README-B6-3.md)
- B6.1 : les actions B4.2 STRUCTURÉES (lib/actions.js — envoi, cycle, tags, commentaire TRANSFERT SAV, formes exactes prod v136) journalisées à chaque tour + exécution VERROUILLÉE derrière MODE_AGENT=actif + B42_EXECUTION=1 ; B6.2 : scan « Attente client » 2 h + reprise-de-zéro (lib/scan.js) (voir README-B6.md)
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



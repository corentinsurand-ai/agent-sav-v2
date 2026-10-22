# B6.4 — le branchement : les briques internes deviennent EXÉCUTABLES

Suite de la nuit : les briques B6.3 (consignes, Praxedo, scan, digest) étaient
PURES et testées — elles sont maintenant BRANCHÉES de bout en bout, du webhook
jusqu'à l'exécution. Toujours en mode observation par défaut, toujours zéro
assignation ni mention `@user` (décision Corentin 23/10), l'exécution réelle
reste verrouillée derrière `MODE_AGENT=actif` + `B42_EXECUTION=1` (feu vert).

482/482 tests verts (18 suites).

## 1. lib/actions.js — la citation de l'armement (v2.20.68)

Le commentaire « TRANSFERT SAV » (dossier complet) porte maintenant le texte
EXACT du prod v2.20.136 :

> ACTION À FAIRE : créer l'intervention dans Praxedo (plaque, problème,
> téléphone de la personne à contacter sur place), puis planifier le créneau
> avec le client. PUIS poster en commentaire le numéro d'intervention (ex :
> « @Agent IA intervention EVE123456 créée » ou « @Agent IA interventions
> 05189, 05190 créées » — les deux formats sont reconnus) pour armer le suivi
> automatique : la conversation passera seule en « Traitée » dès que TOUTES
> les interventions seront réalisées dans Praxedo (vérification toutes les
> 2 h). Retirer ensuite le tag « Prise de main » pour rendre la main à
> l'agent IA.

`executerActions` sait aussi exécuter `renommer` (via `io.renommerContact`) et
échoue EXPLICITEMENT sur une action inconnue (jamais de faux « ok »).

## 2. Le mode QUESTION INTERNE (lib/cerveau.js + lib/mistral.js)

Un collègue demande « @Agent IA ? où on en est » → l'agent répond AU COLLÈGUE
en commentaire interne, jamais au client :

- `SYSTEME_INTERNE` : prompt court (assistant d'équipe, texte brut, aucune
  invention, réponse courte) — séparé du cahier des charges client.
- `construireMessagesQuestion({question, dossier, nom, messages})` : dossier
  en 4 points (`consignes.etatDossier4Points`), conversation rendue,
  question du collègue.
- `mistral.appelMistral(messages, {texteLibre: true})` : PAS de
  `response_format` (réponse brute). Sans l'option : JSON strict, comme avant.

## 3. Le TOUR CONSIGNE (lib/process.js, declencheur='consigne')

Le pilotage par les collègues est branché dans la chaîne :

- QUESTION INTERNE → 1 appel Mistral libre → action `commentaire`
  (journalisée en observation, exécutée en actif armé).
- RÉFÉRENCES PRAXEDO (« @Agent IA intervention EVE… créée ») → ARMEMENT :
  cycle « En cours de réalisation » (JAMAIS reposé si déjà posé) +
  compte-rendu de vérification par réf (trouvée / introuvable / erreur /
  middleware absent) + `etat.suivi_refs` persisté.
- REPRISE + ATTENTE CLIENT → silence journalisé (v2.20.119).
- REPRISE simple → la chaîne NORMALE reprend sur le dernier message client,
  avec BYPASS du silence de prise de main (v2.20.54).
- Une consigne ne retire JAMAIS un tag (v2.20.106) ; la plaque citée par un
  collègue est VALIDÉE (v2.20.58) ; dédup 15 min contre `etat.consigne_vue`
  (v2.20.99).

## 4. api/webhook.js (B1.2) — les consignes ENTRENT par le webhook

Les commentaires ne sont PAS lisibles par GET respond.io (B2.1 : 404). Le
webhook est donc le SEUL canal d'entrée : `comment.created` AVEC mention
`@Agent IA` → la ligne est ENFILÉE dans `agent_sav.messages` avec
`canal_nom='consigne'` (statut `en_file`, event_id dédup, `createdAt` →
`emis_a`). Un commentaire sans mention reste ignoré (comportement inchangé).

## 5. api/process.js (B6.4) — le branchement

- La ligne claimée porte son `canal_nom` : `'consigne'` → tour consigne dans
  `lib/process.js` (texte de la consigne transmis au processeur).
- VÉRIFICATEUR Praxedo injecté : `PRAXEDO_INTERVENTIONS_URL` (web app Apps
  Script « Praxedo Interventions » v5.7.4 — `GET ?reference=REF` →
  `{found, interventions:[… statut_code]}`), 3 états via
  `praxedo.verifierReference`. Sans la variable : compte-rendu
  « indisponible », suivi armé quand même.
- CHAMPS PERSISTANTS : `suivi_refs`, `consigne_vue`, `tag_pdm_ts`,
  `digest_consolide`, `ts_check_praxedo` — lus du dossier AVANT le tour et
  RÉAPPLIQUÉS après (une reconstruction de l'état ne les perd plus jamais).
- `tag_pdm_ts` horodaté quand l'exécution pose le tag « Prise de main »
  (base du retrait ≥ 2 h par le scan).
- RENOMMAGE branché (OFF par défaut) : `decisionRenommage` déterministe ;
  l'écriture PATCH respond.io n'existe qu'en actif armé.

## 6. api/scan.js — NOUVEL endpoint : la maintenance horaire

`GET|POST /api/scan?secret=<WEBHOOK_SECRET>` (ou `Bearer CRON_SECRET`), sur
les ~15 dossiers les plus récents (`?contact=` pour un ciblage, `?limit=`) :

1. REPRISE-DE-ZÉRO : dossier « Traitée » → purge + retrait du tag fantôme
   (v2.20.64/117).
2. SUIVI PRAXEDO : throttle 2 h VÉRIFIÉ AVANT tout appel middleware ;
   TOUTES les refs réalisées → cycle « Traitée » + conversation fermée +
   dossier purgé (v2.20.66). Erreur middleware → JAMAIS purgé.
3. ATTENTE CLIENT : question sans réponse ≥ 2 h → cycle « Attente client »
   (v2.20.88).
4. RETRAIT DU TAG ≥ 2 h sur état OBSERVÉ uniquement (v2.20.117).
5. DIGEST : prises de main non consolidées → UN email consolidé (Resend),
   fenêtre 9h-18h, ≥ 45 min depuis le dernier `digest_envoye`.

Observation : tout est JOURNALISÉ (`scan_*`, `digest_*`), zéro écriture.
Actif armé : exécution via l'adaptateur.

**CRON** : plan Hobby Vercel = 1 cron/jour max (README-B4) → cron EXTERNE
recommandé (cron-job.org) : chaque minute `/api/process`, chaque heure
`/api/scan`. Rien n'est ajouté à vercel.json.

## 7. lib/email.js — l'adaptateur Resend

`envoyerEmail(sujet, corps)` → POST `api.resend.com/emails`, Bearer
`RESEND_API_KEY`, from `EMAIL_FROM`, to `ALERT_EMAIL` (défaut
`corentin.surand@umob.fr`, parité v136). SANS clé ou en erreur :
`{envoye:false, raison}` — JAMAIS de throw (un digest indisponible ne fait
jamais échouer un scan).

## 8. lib/respondio.js — deux nouvelles écritures

- `fermerConversation(contactId)` : POST `/conversation/close` (v2.20.66).
- `renommerContact(contactId, nom)` : PATCH `{fullName}` (v2.19.8) — forme à
  revérifier à la première activation réelle ; la décision reste OFF.

## Variables d'environnement à poser dans Vercel (QUAND tu décides)

| Variable | Rôle | Obligatoire pour |
|---|---|---|
| `PRAXEDO_INTERVENTIONS_URL` | URL de la web app Apps Script « Praxedo Interventions » | vérification des refs à l'armement + purge du scan (sans elle : compte-rendu « indisponible », jamais de purge) |
| `RESEND_API_KEY` + `EMAIL_FROM` (+ `ALERT_EMAIL` optionnel) | envoi réel du digest | digest email en mode actif armé |
| `RENOMMAGE_ACTIF=1` | active le renommage des fiches | renommage (OFF par défaut, parité v136) |
| `CANAUX` | mapping channelId → nom : `{"558644":"whatsapp","123":"mail"}` | ton par canal (sans elle : heuristique + ton simple) |
| `MODE_AGENT=actif` + `B42_EXECUTION=1` | le feu vert — exécution réelle | TOUTES les écritures respond.io + emails |

### Trouver les vrais channelIds (procédure CANAUX)

`/api/contexte?secret=…&contact=<id>` (ou l'écran d'observations) montre le
`channelId` de la fiche respond.io. Exemple réel constaté : `558644` =
WhatsApp. Ouvre une conversation par email, relève son channelId, puis
colle le mapping JSON dans la variable `CANAUX`.

## Tests

- `node --test tests/test-actions.js` (27) — citation v2.20.68 exacte, action
  `renommer`, action inconnue en échec explicite.
- `node --test tests/test-cerveau.js` (34) — prompt interne, question rendue,
  `texteLibre` sans `response_format`.
- `node --test tests/test-process.js` (64) — les 7 comportements du tour
  consigne + champs persistants + une consigne en file de bout en bout.
- `node --test tests/test-webhook.js` (36) — `comment.created` enfilé/ignoré,
  doublon, panne Supabase.
- `node --test tests/test-email.js` (6) — NOUVELLE suite.
- `node --test tests/test-scan.js` (18) — NOUVELLE suite : auth, observation
  vs actif armé, purge Praxedo, throttle, reprise-de-zéro, retrait tag,
  digest (envoyé / différé / < 45 min / filtre contact).

Et les 12 autres suites inchangées et vertes. **482/482**.

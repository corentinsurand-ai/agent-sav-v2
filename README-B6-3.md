# B6.3 — le pivot interne équipe : consignes @Agent IA, Praxedo, digest, canal, campagnes, photo

Suite de la nuit : la feuille de route B6+ de l'audit (23/10) se construit —
TOUJOURS en mode observation, TOUJOURS sans assignation ni mention `@user`
(décision Corentin 23/10), toujours zéro écriture respond.io. Six nouveaux
comportements, tous DÉTERMINISTES, tous purs et testés.

## 1. lib/consignes.js — les consignes internes @Agent IA (portage v2.20.47-119)

Les collègues pilotent l'agent PAR COMMENTAIRE respond.io. B2.1 lit déjà les
commentaires (GET, best-effort) ; ce module en fait la lecture déterministe :

- `mentionneAgent` : « @Agent IA … » / « @Agent U'mob … » (casse/espacement
  tolérés) ou template respond.io `{{@user.ID}}` (v2.20.47).
- `nettoyerConsigne` : mention retirée + « : ; - » de tête → la consigne NUE.
- `estQuestionInterne` / `questionInterne` : MODE QUESTION (v2.20.76) —
  « ? … » ou « Question : … » EN TÊTE. Le collègue interroge l'agent ; l'agent
  répondra AU COLLÈGUE, jamais au client.
- `cleDedup` / `dedup15min` : repost de la même consigne < 15 min → ignoré
  (v2.20.99 ; casse et ponctuation indifférentes, clé bornée 200 car).
- `consigneReprise` : « poursuis/continue/reprends/qualif » (v2.20.54).
- `consigneAttendReponseClient` : « dès que le client répond… », « en
  attendant sa réponse » (v2.20.119) — SANS faux positif sur « le client a
  répondu » (constat ≠ attente).
- `plaquesCitees` : une plaque citée par un COLLÈGUE est VALIDÉE (v2.20.58,
  regex tolérante 1-2 lettres / 2-3 chiffres, canonique ≥ 6) → elle rejoint le
  formulaire du dossier dans `lib/process.js`, jamais redemandée au client.
- `extraireRefsInterventions` : refs Praxedo `EVE…` PRIORITAIRES, sinon
  groupes de 4-8 chiffres à bords de mot — un téléphone (10 chiffres) ne
  matche PAS (v2.20.65).
- `analyser(commentaire)` : la lecture complète → `{pour_agent,
  question_interne, consigne, references, plaques, reprise, attend_reponse}`.
- `etatDossier4Points` : « Cycle : X — Plaque : Y — Intervention Praxedo :
  Z — Attente client : W » (v2.20.74-79), l'état du dossier en une ligne
  pour répondre au collègue qui demande où on en est (attente = 1er manquant :
  téléphone BLOQUANT, panne, plaque NON bloquante, photos ; « rien en
  attente » si complet).

**IMPORTANT (v2.20.106)** : une consigne ne retire JAMAIS un tag — le retrait
de « Prise de main » reste une décision séparée (lib/scan.js, lib/praxedo.js).
Et AUCUNE assignation / mention `@user` émise : décision Corentin 23/10.

## 2. lib/praxedo.js — le suivi Praxedo (portage v2.20.63-117)

- `statutRealisee` : codes DONE/REALIZED/REALISE/COMPLETED/VALIDATED/CLOSED,
  sinon texte réalis/done/completed/terminé (v2.20.70). Tolérant : objet
  (status/statut/etat/state) ou chaîne brute.
- `verifierReference({code, statutHttp, corps})` : UNE vérification, 3 états
  — `trouvee` / `introuvable` / `erreur`. HTTP ≥ 400 ou JSON invalide =
  **ERREUR, jamais « introuvable »** (v2.20.103 : on ne purge pas un dossier
  sur un Praxedo indisponible). Matching BIDIRECTIONNEL (casse et
  séparateurs normalisés). Liste = `interventions` | `resultats` | `data` |
  intervention unique ; `found === false` explicite = introuvable.
- `scanSuivis(maintenant, contacts)` : le passage horaire sur les dossiers
  avec interventions suivies — THROTTLE 2 h par contact. TOUTES les refs
  réalisées → `purger` + cycle « Traitée » (mémoire coupée, retrait du suivi,
  fermeture de conversation — v2.20.66). Les statuts sont FOURNIS par
  l'appelant (le middleware Praxedo existe déjà) : le module reste sans
  réseau. Une ref sans statut connu = NON réalisée (jamais purgée par défaut).
- `retirerTagDecision` : retrait du tag « Prise de main » ≥ 2 h après pose,
  UNIQUEMENT sur état OBSERVÉ (cycle contenant « trait », peu importe
  l'auteur, OU conversation fermée — v2.20.117). Un dossier en cours ne
  perd jamais sa prise de main sur un simple minutage.
- `decisionArmement` : une référence d'intervention citée par un collègue
  (consigne « @Agent IA arme l'intervention EVE… ») fait passer le dossier en
  « En cours de réalisation » (v2.20.63) ; sans référence, ou cycle déjà
  avancé (En cours / Traitée) → AUCUNE décision (le mode observation ne
  touche jamais les cycles).

## 3. lib/digest.js — le digest « prise de main » (portage v2.20.83)

- À la POSE d'une prise de main : digest IMMÉDIAT… sauf si le dernier digest
  date de < 15 min → DIFFÉRÉ au scan horaire, JAMAIS perdu.
- SCAN HORAIRE : envoi uniquement si ≥ 45 min depuis le dernier digest.
- FENÊTRE 9h-18h : en dehors, tout est différé au prochain passage.
- `corpsDigest(prises)` : le corps consolidé, une ligne par dossier repris.

## 4. lib/renommage.js — le renommage des contacts (portage v2.19.8)

« Nom du contact (Société - Ville) » quand la fiche client est identifiée.
Deux gardes : jamais deux fois (nom déjà suffixé), et **DÉSACTIVÉ par
défaut** — parité v2.20.136 (« contacts importés au bon format »). La
décision ne s'activera que par config explicite de Corentin.

## 5. Intégrations au fil de traitement (mode observation enrichi, SANS écriture)

- **Ton par canal** (portage v2.10) : `lib/cerveau.js` expose `blocCanal` —
  EMAIL (vouvoiement, formules complètes, pas de langage SMS ni d'emoji, UN
  email structuré point par point) / WHATSAPP (sobre, direct, phrases
  courtes) / canal non identifié (ton simple). `lib/process.js` accepte
  `canal` ; `api/process.js` résout le canal depuis le channelId de la fiche
  (env `CANAUX` : `{"<channelId>":"mail", …}` ou heuristique). Canal
  inconnu → AUCUN bloc, ton simple (rétro-compat).
- **Vocabulaire push COMPLET v2.20.116** : `estPushCampagne` reconnaît
  désormais « technicien … secteur », « pneus ou plaquettes », « tout autre
  besoin », « dans le cadre de votre maintenance » (l'ancien vocabulaire
  reste). La signature « Agent IA U'mob » exclut toujours (règle v124).
- **Garde G12** (`campagne_push_plaque`, v2.20.116) : réponse à un push qui
  demande l'immatriculation d'entrée → faute → régénération avec rappel
  (« accuse réception, interroge le BESOIN, question OUVERTE »). Sans signal
  push, l'étape 2 ne change pas.
- **Consignes @Agent IA en lecture seule** : `lib/process.js` journalise
  `consigne_detectee` (question interne, reprise, attente, refs, plaques)
  pour chaque commentaire @Agent IA — aucune action en observation. La
  plaque du collègue rejoint le formulaire (validée).
- **Photo récente** (v2.20.124) : plaque inconnue citée < 5 min APRÈS une
  photo → PLUS de rejet canonique : le cerveau répond, avec la leçon « la
  plaque est peut-être visible sur la photo — demande de la relire ou de
  donner la saisie exacte ». Photo plus ancienne → canonique inchangé.
- **Identification par la plaque** (audit §1 🟡) : dans `api/process.js`, si
  le contact n'est pas trouvé par téléphone, la plaque citée dans le dernier
  message identifie la ligne clients (journal `identification_par_plaque`).
- **Canal de la fiche** : `lib/contexte.js` expose désormais `channelId`
  (extraction tolérante) — utilisé par la résolution de canal.

## Ce qui N'A PAS été fait (décisions restantes à Corentin)

- **Aucun mode actif activé** : MODE_AGENT et B42_EXECUTION inchangés dans
  Vercel — feu vert explicite requis. L'exécution des nouvelles briques
  (armement Praxedo, scans horaires, envoi email du digest, renommage) sera
  branchée en B4.2 avec ce même verrou.
- **Aucune assignation ni mention @user** (exclue par décision du 23/10).
- Le mode question Mistral libre (l'agent RÉDIGE sa réponse au collègue),
  le branchement des scans horaires sur cron, l'envoi email réel du digest.

## Tests — 455/455 (17 suites)

Nouvelles suites : `test-consignes.js` (33), `test-praxedo.js` (26),
`test-digest.js` (12), `test-renommage.js` (9). Étendues : cerveau 23→29,
etat 23→30, gardes 37→41, process 46→55, console 19→20. Les 348 anciens
tests restent verts, inchangés d'un octet côté comportement observation.

```
node --test tests/test-consignes.js
node --test tests/test-praxedo.js
node --test tests/test-digest.js
node --test tests/test-renommage.js
```

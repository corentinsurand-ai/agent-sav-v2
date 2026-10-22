# Cycles de vie respond.io — liste exacte validée (B4.2-PREP.3)

Source : capture respond.io de Corentin (23/10) + confirmation caractère par
caractère par Corentin lui-même dans les paramètres respond.io. C'est la
référence unique pour B4.2 : l'adaptateur posera les cycles avec CES chaînes
exactes, en dur dans le code — à la lettre près.

> B5.4.2 : le mapping état → cycle (table §5 du cahier des charges) vit
> désormais dans `lib/cycles.js` (Node pur, déterministe) — `CYCLES` reprend
> ces chaînes exactes. La console de test et l'écran B5 affichent le cycle
> prévu à chaque échange via `cycle_prevu`.

## Les 12 cycles de respond.io

### 9 cycles PILOTÉS PAR L'AGENT (posés par le code B4.2, jamais par le LLM)

1. `Nouvelle Demande` — défaut (nouvelle conversation)
2. `DE Commerciales` — escalade commerciale (prix, achat, location)
3. `Bloquée Impayé` — client impayé
4. `A qualifier` — transfert SAV : un humain reprend la main
5. `Attente client` — silence 2 h après une question au client
6. `Attente Paiement ou pré-auto CB` — paiement attendu avant Praxedo
7. `A créer dans Praxedo` — qualification complète, intervention à créer
8. `En cours de réalisation` — intervention en cours
9. `Traitée` — interventions toutes réalisées (fermeture auto respond.io)

### 3 cycles MANUELS — JAMAIS posés par l'agent

- `Attente interne`
- `Annulée sans réponse`
- `Annulée par le client`

## Correction par rapport au cahier des charges v1.0 (§5)

Le cahier des charges listait « A facturer » comme 4e cycle manuel :
il N'EXISTE PAS dans respond.io (confirmé par Corentin le 23/10).
Total réel : 12 cycles (9 agent + 3 manuels), pas 13.

## Tags liés (posés/retirés par l'adaptateur B4.2)

- `Prise de main` — posé au transfert SAV, retiré au RESET et à la Traitée
- `Demande Commerciale` — posé à l'escalade commerciale

## Règle B4.2 (architecture v1.1 : cerveau ≠ canal)

L'agent ne pose JAMAIS un cycle manuel ni un nom hors de cette liste : la
correspondance étape métier → cycle est du CODE déterministe (l'adaptateur),
le LLM ne décide que de l'étape. Les 4 cycles dits « manuels » n'apparaissent
dans aucun mapping — un humain seul peut les poser dans respond.io.

# B6.7.2 — Clients multi-scooters (la flotte n'est pas un scooter identifié)

**Incident console Corentin, 28/10/2026** : fiche d'un client flotte (11 scooters) chargée,
RESET fait, message « j'ai un problème de guidon » → la garde G4 (plaque redemandée)
tirait « l'immatriculation est DÉJÀ CONNUE » sur la question légitime « quel scooter est
concerné ? » → régénération → récidive → **repli neutre + transfert SAV systématique**.
Tout client multi-scooters qui ne citait pas sa plaque était structurellement condamné.

## Cause racine

`appliquerClient` (B2.2) poussait les **plaques de la flotte** dans `etat.plaques` — le même
champ que la garde G4 lit pour « l'immatriculation est connue, ne la redemande jamais ».
Or une flotte ≠ le scooter concerné : la fiche n'identifie PAS le scooter du dossier.

## Le correctif (structurel, pas une sous-règle)

| Champ | Contenu | G4 « ne redemande jamais » |
|---|---|---|
| `etat.plaques` | plaques **citées dans la conversation** (client, agent, collègue) | ✅ active (règle 1 inchangée) |
| `etat.plaques_flotte` (nouveau) | plaques de la **fiche client** (B2.2) | ❌ inactive — demander LEQUEL est une qualification |

- `lib/etat.js` : `appliquerClient` remplit `plaques_flotte` (plus `plaques`) ; dès qu'une
  plaque flotte est **citée**, `appliquerMessage` la fait passer dans `plaques` → identifiée.
- `lib/cerveau.js` (`rendreFormulaire`) : la flotte est rendue au LLM avec la guidance
  adaptée — sans plaque identifiée : « demande LEQUEL est concerné » ; flotte mono-scooter :
  « propose cette immatriculation » ; **scooter identifié + flotte** : « si le client signale
  un NOUVEAU problème, demande s'il concerne ce même scooter ou un autre » (le
  rapprochement demandé par Corentin).
- `lib/process.js` : les plaques flotte restent exclues de la vérification parc (règle 4).
- `api/test.js` (console B6.7.2) : `etat.plaques_flotte` exposé, affichage « plaque
  identifiée » vs « flotte (fiche) ».

## Tests — 550/550 sur 20 suites (baseline 540)

- `test-gardes` +2 : flotte sans identification → question OK ; identifiée + flotte → redemande toujours fautive.
- `test-process` +2 : rejeu BOUT EN BOUT de l'incident (1 Mistral, plus de repli, prompt « LEQUEL ») + guidance rapprochement.
- `test-console` +2 : rejeu de la capture (question conforme, flotte visible) + RESET purger la conversation, garder la fiche dans `plaques_flotte`.
- `test-cerveau` +3, `test-etat` +1 : rendu prompt et passage flotte→identifiée.
- `test-incidents` mis à jour : S1 (la faute push est attrapée par G12 `campagne_push_plaque`,
  la garde précise) et S2 (la formulation « Pourriez-vous » reste faute ; demander la plaque
  d'un scooter non identifié n'en est plus une).

## Ce que ça change côté usage

RESET : la mémoire conversationnelle (scooter, panne) est purgée — seule la fiche (enseigne,
flotte, risque) est conservée, désormais dans `plaques_flotte`. Un client multi-scooters est
qualifié normalement : l'agent demande lequel est concerné ; une fois le scooter identifié,
il ne le redemande plus et propose le rapprochement « même scooter ou un autre ? ».

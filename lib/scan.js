// ============================================================================
// Agent SAV U'mob v2 — B6.2 : le scan « Attente client » + reprise-de-zéro
// (Node PUR)
//
// RÔLE (cahier des charges §5 + audit 23/10 « tout se construit ») : la part
// DÉTERMINISTE des deux maintenance horaires que le mode actif (B4.2)
// exécutera — JAMAIS le LLM :
//
//   1. SCAN « ATTENTE CLIENT » (portage v2.20.88) : le dernier message
//      sortant ATTEND une réponse (« ? » ou demande explicite) ET le client
//      n'a pas répondu depuis ≥ 2 h → poser le cycle « Attente client ».
//      Une clôture, une confirmation d'enregistrement ou une information
//      pure n'attend PAS de réponse → la conversation CONSERVE son cycle.
//      Idempotent : rien si le cycle est déjà « Attente client » ; jamais
//      sur une conversation fermée ou un cycle « Traitée ».
//
//   2. REPRISE-DE-ZÉRO (équivalent v2 de la v2.20.64/117) : un contact dont
//      la conversation est FERMÉE ou le cycle « Traitée » repart de zéro au
//      prochain message du client (dossier à purger + tag « Prise de main »
//      à retirer) — plus jamais de message client ignoré à cause d'un tag
//      fantôme sur un dossier terminé.
//
// ZÉRO réseau : le module ne fait que DÉCIDER (pur). L'exécution (lecture
// respond.io + posage) est branchée en B4.2 derrière le feu vert de
// Corentin ; la sortie alimente l'adaptateur (lib/respondio.js) et le
// journal. Testable à 100 %.
// ============================================================================

var CYCLE_ATTENTE_CLIENT = "Attente client";
var CYCLE_TRAITEE = "Traitée";

// Le message sortant ATTEND-il une réponse ? (portage v2.20.88
// dernierMessageAttendReponse) : « ? » ou demande explicite — une clôture
// (« bien noté », « demande enregistrée »), une information pure ou une
// formule de fin n'attend RIEN. Un texte illisible (ex. « (média reçu) »)
// n'attend rien (comportement historique conservé).
function attendReponse(texte) {
  var t = String(texte || "").toLowerCase();
  if (!t) return false;
  if (t.indexOf("?") !== -1) return true;
  return /(pouvez|pourriez|envoyez|envoye|communiquez|transmettez|confirmez|confirmer|merci de|quelle est|donnez|precisez|précisez)/.test(t);
}

// ----------------------------------------------------------------------------
// scanAttenteClient(maintenant, contacts) → décisions du passage horaire.
//
//   maintenant : epoch ms (injecté — jamais Date.now() ici, testable)
//   contacts   : [{
//     contactId, cycleActuel (lifecycle.name respond.io — casse exacte),
//     conversationFermee (bool),
//     messages: [{ texte, sortant (bool), ts (epoch ms) }] — ordre quelconque
//   }]
//
//   règle : dernier SORTANT qui attend une réponse, AUCUN entrant après lui,
//   silence ≥ 2 h (SEUIL_SCAN_MS), cycle pas déjà « Attente client »,
//   conversation ouverte, cycle ≠ « Traitée » → { action: "poser_cycle",
//   cycle: "Attente client", silence_ms, raison }.
// ----------------------------------------------------------------------------
var SEUIL_SCAN_MS = 2 * 60 * 60 * 1000; // 2 h (cahier des charges §5)

function scanAttenteClient(maintenant, contacts) {
  var decisions = [];
  var liste = contacts || [];
  var maintenant = Number(maintenant) || 0;

  for (var i = 0; i < liste.length; i++) {
    var c = liste[i] || {};
    var messages = c.messages || [];

    // Dernier sortant + dernier entrant (par plus grand ts, ordre quelconque).
    var dernierSortant = null;
    var dernierEntrantTs = 0;
    for (var m = 0; m < messages.length; m++) {
      var msg = messages[m] || {};
      var ts = Number(msg.ts) || 0;
      if (msg.sortant) {
        if (!dernierSortant || ts > dernierSortant.ts) {
          dernierSortant = { texte: String(msg.texte || ""), ts: ts };
        }
      } else if (ts > dernierEntrantTs) {
        dernierEntrantTs = ts;
      }
    }

    if (!dernierSortant) continue; // rien de notre part : rien à poser
    if (!attendReponse(dernierSortant.texte)) continue; // n'attend pas de réponse
    if (dernierEntrantTs >= dernierSortant.ts) continue; // le client a répondu
    var silence = maintenant - dernierSortant.ts;
    if (silence < SEUIL_SCAN_MS) continue; // pas encore 2 h

    var cycle = String(c.cycleActuel || "");
    if (cycle === CYCLE_ATTENTE_CLIENT) continue; // déjà posé (idempotent)
    if (cycle === CYCLE_TRAITEE) continue; // dossier terminé : jamais touché
    if (c.conversationFermee) continue; // fermée : l'équipe gère

    decisions.push({
      contactId: c.contactId,
      action: "poser_cycle",
      cycle: CYCLE_ATTENTE_CLIENT,
      silence_ms: silence,
      raison: "question posée au client sans réponse depuis " + Math.floor(silence / 3600000) + " h — « Attente client » (vérification horaire)"
    });
  }
  return decisions;
}

// ----------------------------------------------------------------------------
// repriseDeZeroNecessaire(cycleActuel, conversationFermee) → bool — le
// prochain message du client doit repartir d'un dossier NEUF (v2.20.64/117 :
// conversation fermée ou cycle « Traitée », peu importe qui l'a posé).
// La purge du dossier et le retrait du tag sont exécutés par B4.2 ; cette
// fonction est le DÉTECTEUR déterministe, appelé au moment du message.
// ----------------------------------------------------------------------------
function repriseDeZeroNecessaire(cycleActuel, conversationFermee) {
  if (conversationFermee === true) return true;
  return String(cycleActuel || "") === CYCLE_TRAITEE;
}

module.exports = {
  CYCLE_ATTENTE_CLIENT: CYCLE_ATTENTE_CLIENT,
  CYCLE_TRAITEE: CYCLE_TRAITEE,
  SEUIL_SCAN_MS: SEUIL_SCAN_MS,
  attendReponse: attendReponse,
  scanAttenteClient: scanAttenteClient,
  repriseDeZeroNecessaire: repriseDeZeroNecessaire
};

// ============================================================================
// Agent SAV U'mob v2 — C4 : /api/whatsapp-webhook — réception des messages
// WhatsApp Cloud API (Meta)
//
// RÔLE : recevoir les vrais messages WhatsApp des clients et les stocker
// dans agent_sav.wa_messages — la plateforme maison C1/C4 (prototype
// navigateur) les lit ensuite via /api/whatsapp-messages (lecture seule).
// L'ADAPTATEUR CANAL EST LE SEUL À PARLER À WHATSAPP (principe d'architecture
// cerveau ≠ canal) : ce webhook n'appelle JAMAIS de LLM, ne répond JAMAIS au
// client, il ne fait qu'ENREGISTRER (mode lecture C1).
//
//   GET  /api/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=<token>
//                     &hub.challenge=<n>   → vérification Meta (echo challenge)
//   POST /api/whatsapp-webhook  body = payload Meta Cloud API → 200 TOUJOURS
//        (Meta retente en cas d'erreur — un 500 provoquerait des rejeus en
//         rafale ; les échecs Supabase sont journalisés mais retournent 200)
//
// Payload géré (forme officielle Cloud API) :
//   { object: "whatsapp_business_account",
//     entry: [ { id, changes: [ { field: "messages", value: {
//       messages: [ { from, id, timestamp, type, text: { body } … } ],
//       contacts: [ { profile: { name }, wa_id } ] } ] } ] }
//   - value.statuses (accusés de livraison) → ignorés (200)
//   - messages sans texte (image/audio…) → type + placeholder, jamais d'appel
//     multimodal (même discipline que l'ancien système v136)
//
// DÉDUP : wamid unique (contrainte) + Prefer resolution=ignore-duplicates —
// les rejeus Meta sont absorbés sans doublon (même parade que la dédup
// event_id du webhook respond.io en B1).
//
// Config : WA_VERIFY_TOKEN (token de vérification Meta, à définir dans
// Vercel) ; repli sur WEBHOOK_SECRET si absent. Aucun secret dans le code.
// ============================================================================

var SCHEMA = 'agent_sav';

function env(nom) { return process.env[nom] || ''; }

function paramDe(req, nom) {
  try {
    if (req.query && req.query[nom] !== undefined) return String(req.query[nom]);
  } catch (e) {}
  var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice((req.url || '').indexOf('?') + 1) : '';
  var m = u.match(new RegExp('(?:^|&)' + nom + '=([^&]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

function urlSupabase(table, params) {
  var base = env('SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  return base + '/rest/v1/' + table + (params ? '?' + params : '');
}

// Extrait les messages utiles d'un payload Meta → [{wa_id, nom, texte, type,
// wamid, timestamp}] ; statuses et événements vides → []
function extraireMessages(corps) {
  var sortie = [];
  var contacts = {};
  if (!corps || corps.object !== 'whatsapp_business_account' || !Array.isArray(corps.entry)) return sortie;
  corps.entry.forEach(function(ent) {
    if (!ent || !Array.isArray(ent.changes)) return;
    ent.changes.forEach(function(ch) {
      var v = ch && ch.value;
      if (!v) return;
      (v.contacts || []).forEach(function(ct) {
        if (ct && ct.wa_id) contacts[String(ct.wa_id)] =
          String((ct.profile && ct.profile.name) || '');
      });
      (v.messages || []).forEach(function(msg) {
        if (!msg || !msg.id || !msg.from) return;
        var texte = '';
        var type = String(msg.type || 'text');
        if (msg.text && msg.text.body) texte = String(msg.text.body);
        else if (msg.button && msg.button.text) texte = String(msg.button.text);
        else if (msg.interactive && msg.interactive.button_reply) {
          texte = String((msg.interactive.button_reply.title || msg.interactive.button_reply.id || ''));
          type = 'interactive';
        } else if (msg.interactive && msg.interactive.list_reply) {
          texte = String((msg.interactive.list_reply.title || ''));
          type = 'interactive';
        } else if (type === 'image' || type === 'audio' || type === 'video' || type === 'document' || type === 'sticker') {
          texte = '[média reçu]';               // jamais multimodal (discipline v136)
        } else if (type === 'location') {
          texte = '[position partagée]';
        } else if (msg.contacts_) { /* liste de contacts partagée */ }
        if (type === 'contacts') texte = '[contacts partagés]';
        sortie.push({
          wa_id: String(msg.from),
          nom: contacts[msg.from] || '',
          texte: texte,
          type: type,
          wamid: String(msg.id),
          timestamp: String(msg.timestamp || ''),
          brut: msg
        });
      });
    });
  });
  return sortie;
}

async function enregistrerMessages(messages) {
  var cle = env('SUPABASE_SERVICE_KEY');
  var url = urlSupabase('wa_messages', 'on_conflict=wamid');
  var lot = messages.map(function(m) {
    return {
      wa_id: m.wa_id,
      nom_profil: m.nom || null,
      texte: m.texte,
      type: m.type,
      wamid: m.wamid,
      brut: m.brut,
      recu_a: m.timestamp
        ? new Date(parseInt(m.timestamp, 10) * 1000).toISOString()
        : new Date().toISOString()
    };
  });
  var res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': cle,
      'Authorization': 'Bearer ' + cle,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=ignore-duplicates,return=minimal',
      'Content-Profile': SCHEMA
    },
    body: JSON.stringify(lot)
  });
  if (res.status >= 400) {
    var corps = '';
    try { corps = (await res.text()).substring(0, 300); } catch (e) { corps = ''; }
    throw new Error('Supabase wa_messages ' + res.status + ' — ' + corps);
  }
  return lot.length;
}

async function journaliser(texte, detail) {
  try {
    var res = await fetch(urlSupabase('journal', ''), {
      method: 'POST',
      headers: {
        'apikey': env('SUPABASE_SERVICE_KEY'),
        'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
        'Content-Profile': SCHEMA
      },
      body: JSON.stringify({ etape: 'wa_webhook', texte: texte, detail: detail })
    });
    return res.ok;
  } catch (e) { return false; }
}

module.exports = async function handler(req, res) {
  // Vérification du webhook Meta (à l'ajout de l'URL dans le Business Manager)
  if (req.method === 'GET') {
    var mode = paramDe(req, 'hub.mode');
    var token = paramDe(req, 'hub.verify_token');
    var challenge = paramDe(req, 'hub.challenge');
    var attendu = env('WA_VERIFY_TOKEN') || env('WEBHOOK_SECRET');
    if (mode === 'subscribe' && token && token === attendu && challenge) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('verification echouee');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });
  }

  // POST : enregistrer les messages — 200 TOUJOURS (même si Supabase tombe :
  // Meta retenterait en rafale, on journalise l'échec et on avoue ok)
  var corps = req.body;
  if (!corps && typeof req.body !== 'object') {
    try { corps = JSON.parse(String(req.body || '{}')); } catch (e) { corps = null; }
  }
  var messages = corps ? extraireMessages(corps) : [];
  if (!messages.length) {
    // statuses (accusés de livraison), heartbeats ou payload inconnu → 200
    return res.status(200).json({ ok: true, enregistres: 0 });
  }
  if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_KEY')) {
    await journaliser('wa_webhook sans config Supabase', { messages: messages.length });
    return res.status(200).json({ ok: true, enregistres: 0, erreur_interne: 'config manquante' });
  }
  try {
    var ecrits = await enregistrerMessages(messages);
    await journaliser('wa_webhook : ' + ecrits + ' message(s) WhatsApp enregistré(s)', {
      wa_ids: messages.map(function(m) { return m.wa_id; })
    });
    return res.status(200).json({ ok: true, enregistres: ecrits });
  } catch (e) {
    // Échec d'écriture : 200 quand même (Meta ne doit pas rejuger en rafale),
    // l'échec est journalisé pour diagnostic.
    await journaliser('wa_webhook ERREUR écriture', { erreur: String((e && e.message) || e) });
    return res.status(200).json({ ok: true, enregistres: 0, erreur_interne: true });
  }
};

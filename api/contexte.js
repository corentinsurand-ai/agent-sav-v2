// ============================================================================
// Agent SAV U'mob v2 — B2.1 : /api/contexte — OUTIL DE VALIDATION, LECTURE SEULE
//                        + C8-ASSIST-1 : ASSISTANT IA DE LA PLATEFORME (POST)
//
// RÔLE : assembler et montrer le contexte complet d'un contact (fiche + messages
// + commentaires) pour VALIDER la brique B2 en prod réelle. C'est aussi la
// base de ce que le cerveau (B3+) lira à chaque message — mais B2 ne répond
// JAMAIS au client, n'écrit JAMAIS chez respond.io, n'insère JAMAIS dans
// Supabase : 100 % lecture.
//
//   GET /api/contexte?secret=<WEBHOOK_SECRET>&contact=<id>&limit=<1-100>
//
//   - secret  : OBLIGATOIRE (mêmes règles que le webhook : ?secret=... ou
//               header x-webhook-secret) — les données clients ne sont
//               jamais exposées sans secret.
//   - contact : OBLIGATOIRE — l'identifiant respond.io du contact.
//   - limit   : OPTIONNEL — nombre de messages d'historique (défaut 60,
//               borné 1-100, comme l'action « conversation » du prod v132).
//
// Réponses : 200 avec le contexte (les erreurs respond.io deviennent des
// « avertissements », pas des 500 — chaque section est best-effort) ;
// 400 contact manquant ; 401 secret invalide ; 405 méthode non GET ;
// 500 si RESPONDIO_TOKEN n'est pas configuré.
//
// ---- C8-ASSIST-1 (POST) : l'assistant IA de la plateforme (bulle 🤖 en bas
// à droite du canvas). Répond aux questions sur le FONCTIONNEMENT de la
// plateforme (doc intégrée ci-dessous) ET sur les DONNÉES réelles (clients,
// derniers échanges WhatsApp/email, cycles de vie respond.io, assignations).
// Fusionné dans cette route : limite Vercel Hobby = 12 fonctions serverless.
//   POST {question:"…", jeton, conversation?:{nom,tel,email,entreprise}}
//        → {ok:true, reponse:"…"} — jeton de session OU secret machine.
// ============================================================================

var VERSION = 'C8-ASSIST-1';

var contexte = require('../lib/contexte.js');
var mistral = require('../lib/mistral.js');

function env(nom) { return process.env[nom] || ''; }

function urlSupabase(chemin) {
  var base = (env('SUPABASE_URL') || '').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  return base + '/rest/v1/' + chemin;
}

function teteSupa() {
  return {
    'apikey': env('SUPABASE_SERVICE_KEY') || '',
    'Authorization': 'Bearer ' + (env('SUPABASE_SERVICE_KEY') || ''),
    'Accept-Profile': 'agent_sav'
  };
}

// Secret : ?secret=... (query) ou header x-webhook-secret — même logique
// exacte que api/webhook.js (B1), y compris le repli manuel sur req.url.
function secretDe(req) {
  var secret = '';
  try {
    if (req.query && req.query.secret) secret = String(req.query.secret);
  } catch (e) {}
  if (!secret) {
    var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice(req.url.indexOf('?') + 1) : '';
    var m = u.match(/(?:^|&)secret=([^&]*)/);
    if (m) secret = decodeURIComponent(m[1]);
  }
  if (!secret && req.headers && req.headers['x-webhook-secret']) secret = String(req.headers['x-webhook-secret']);
  return secret;
}

function paramDe(req, nom) {
  try {
    if (req.query && req.query[nom]) return String(req.query[nom]);
  } catch (e) {}
  var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice(req.url.indexOf('?') + 1) : '';
  var m = u.match(new RegExp('(?:^|&)' + nom + '=([^&]*)'));
  if (m) return decodeURIComponent(m[1]);
  return '';
}

// ---- C8-ASSIST-1 : assistant IA --------------------------------------------

var DOC_PLATEFORME = [
  'PLATEFORME SAV U\'MOB (agent-sav-v2) — GUIDE :',
  '- Accès : https://agent-sav-v2.vercel.app — connexion obligatoire (comptes équipe, jeton 12 h). Sans session, une porte de connexion bloque tout.',
  '- 3 volets redimensionnables/réordonnables (glisser les barres de titre) : Filtres (canaux, cycles, assignation), Liste des conversations, Fil complet.',
  '- Vue « Par contact » ou « Par entreprise » : les bandes enseignes ouvertes donnent un fil fusionné multi-contacts chronologique.',
  '- Tri de la liste : non lues d\'abord, puis date du dernier message (plus récent en haut).',
  '- Cycles de vie (respond.io) : Nouvelle Demande, A qualifier, A créer dans Praxedo, En cours de réalisation, Attente client (= Attente interne), Traitée, Annulée sans réponse, Annulée par le client, DE Commerciales, Bloquée Impayé, Attente Paiement ou pré-auto CB. Le cycle change par clic sur le tag du cycle (menu flottant). Changement local, non remonté à respond.io.',
  '- Canaux : WhatsApp réel (Cloud API Meta) et Email réel (SMTP/IMAP OVH, boîte service.technique@umob.fr). Envois réels depuis la barre de saisie selon le canal choisi ; anti double-envoi ; coches ✓/✓✓ bleues = statut de distribution.',
  '- Attribution des expéditeurs : chaque bulle sortante montre le vrai expéditeur (Marine Leca, Nicolas Surand, Corentin Surand, Alexandre Couly, Maxime Thille…) ou « Agent IA » pour les automatisations respond.io ; libellé « ✎ envoyé par … » sous la bulle si ce n\'est pas toi.',
  '- Commentaires internes : bulles jaunes 📌 intégrées au fil, tag @prénom pour notifier.',
  '- Outils : ⚡ Raccourcis personnels, 📋 Modèles WhatsApp (champs {client}/{plaque}/{lien_paiement}), ✉️ Signature email HTML persistée.',
  '- Profils 👥 : avatars/couleurs personnalisés, persistés par navigateur ; « Mes conversations » = assignées à MOI.',
  '- Recherche Ctrl/⌘+K universelle (texte, téléphone normalisé, SIREN) ; surlignage dans la liste et le fil.',
  '- Notifications 🔔 groupées par cycle de vie ; état lu/non lu persistant par navigateur.',
  '- Rafraîchissement auto 60 s (bouton 🔄, heure de dernière maj) ; bouton 🔔, comptes 🛡️ (admin), 🏢 Fiche société en panneau droit.',
  '- Données : Supabase (clients synchronisés du Google Sheet, wa_messages, emails, respondio_contacts importés de respond.io avec cycles/tags/assignations).'
].join('\n');

function jetonDe(req) {
  var j = '';
  try { if (req.headers && req.headers['x-jeton']) j = String(req.headers['x-jeton']); } catch (e) {}
  return j;
}

// Récupère (best-effort) un select Supabase — renvoie [] si la brique est KO.
async function supabaseSelect(chemin, repli) {
  try {
    var r = await fetch(urlSupabase(chemin), { headers: teteSupa() });
    if (!r.ok) return repli || [];
    var lignes = await r.json();
    return Array.isArray(lignes) ? lignes : (repli || []);
  } catch (e) { return repli || []; }
}

// Assemble les DONNÉES réelles compactes pour le prompt.
async function assemblerDonnees(conv) {
  var lignes = [];
  // 1. Contacts respond.io : identité + cycle + assignation (le plus utile)
  try {
    var rc = await supabaseSelect('respondio_contacts?select=prenom,nom,tel,email,cycle_vie,assignee&order=id.asc&limit=1000', []);
    rc.forEach(function (c) {
      var t = [];
      var nm = String(c.prenom || '') + ' ' + String(c.nom || '');
      if (nm.trim()) t.push(nm.trim());
      if (c.tel) t.push(String(c.tel).replace(/\s/g, ''));
      if (c.email) t.push(String(c.email));
      if (c.cycle_vie) t.push('cycle: ' + c.cycle_vie);
      if (c.assignee && c.assignee.firstName) t.push('assigné à ' + c.assignee.firstName + ' ' + (c.assignee.lastName || ''));
      if (t.length > 1) lignes.push('- CONTACT ' + t.join(' | '));
    });
  } catch (e) {}

  // 2. Derniers messages WhatsApp (fenêtre récente)
  try {
    var wm = await supabaseSelect('wa_messages?select=wa_id,nom_profil,texte,sens,sender_nom,recu_a&order=recu_a.desc&limit=350', []);
    wm.slice().reverse().forEach(function (m) {
      lignes.push('- WA ' + (m.recu_a || '') + ' | tel ' + m.wa_id + ' | ' + (m.nom_profil || '') +
        ' | ' + (m.sens === 'sortant' ? ('sortant par ' + (m.sender_nom || 'l\'équipe')) : 'entrant') +
        ' | ' + String(m.texte || '').replace(/\s+/g, ' ').substring(0, 140));
    });
  } catch (e) {}

  // 3. Derniers emails
  try {
    var em = await supabaseSelect('emails?select=from_addr,from_nom,to_addr,sujet,texte,sens,recu_a&order=recu_a.desc&limit=200', []);
    em.slice().reverse().forEach(function (m) {
      lignes.push('- EMAIL ' + (m.recu_a || '') + ' | ' + (m.sens === 'sortant'
        ? ('à ' + m.to_addr + (m.from_nom ? ' par ' + m.from_nom : ''))
        : ('de ' + m.from_addr)) +
        ' | sujet: ' + String(m.sujet || '') + ' | ' + String(m.texte || '').replace(/\s+/g, ' ').substring(0, 120));
    });
  } catch (e) {}

  // 4. Conversation ouverte dans le canvas (contexte prioritaire)
  if (conv && (conv.nom || conv.tel || conv.email || conv.entreprise)) {
    lignes.push('- CONVERSATION OUVERTE DANS LA PLATEFORME : ' +
      [conv.nom, conv.tel, conv.email, conv.entreprise].filter(Boolean).join(' | ') +
      ' — si la question porte sur « ce client », c\'est lui.');
    if (conv.tel) {
      var d = String(conv.tel).replace(/\D/g, '');
      var hist = await supabaseSelect('wa_messages?select=texte,sens,sender_nom,recu_a&wa_id=eq.' + encodeURIComponent(d) + '&order=recu_a.desc&limit=60', []);
      hist.slice().reverse().forEach(function (m) {
        lignes.push('- WA(ce client) ' + (m.recu_a || '') + ' | ' + (m.sens === 'sortant' ? ('sortant par ' + (m.sender_nom || 'l\'équipe')) : 'entrant') +
          ' | ' + String(m.texte || '').replace(/\s+/g, ' ').substring(0, 140));
      });
    }
    if (conv.email) {
      var mel = String(conv.email).trim().toLowerCase();
      var histE = await supabaseSelect('emails?select=from_addr,from_nom,to_addr,sujet,texte,sens,recu_a&or=(from_addr.eq.' + encodeURIComponent(mel) + ',to_addr.eq.' + encodeURIComponent(mel) + ')&order=recu_a.desc&limit=40', []);
      histE.slice().reverse().forEach(function (m) {
        lignes.push('- EMAIL(ce client) ' + (m.recu_a || '') + ' | sujet: ' + String(m.sujet || '') +
          ' | ' + String(m.texte || '').replace(/\s+/g, ' ').substring(0, 120));
      });
    }
  }
  return lignes.join('\n');
}

async function repondreAssistant(req, res) {
  // Corps déjà parsé par la branche POST (req.body) — le flux d'origine est
  // consommé sur Vercel, on n'y touche plus.
  var corps = (req && typeof req.body === 'object' && req.body) ? req.body : {};
  var question = String((corps.question || '') || '').trim();
  if (!question) {
    return res.status(400).json({ ok: false, erreur: 'question manquante : JSON {question:"…"} attendu' });
  }
  if (question.length > 1000) question = question.substring(0, 1000);
  if (!env('MISTRAL_API_KEY')) {
    return res.status(500).json({ ok: false, erreur: 'MISTRAL_API_KEY absente' });
  }

  var donnees = await assemblerDonnees(corps.conversation || null);

  var messages = [
    { role: 'system', content:
      'Tu es l\'assistant intégré de la plateforme SAV de U\'mob (service technique scooters électriques). ' +
      'Tu réponds en français, de façon concise et directe (max ~180 mots), avec des puces si utile. ' +
      'Deux types de questions : (1) le FONCTIONNEMENT de la plateforme → réponds avec la documentation ci-dessous ; ' +
      '(2) les DONNÉES (clients, derniers échanges, cycles, assignations) → appuie-toi sur les données réelles listées, ' +
      'cite les dates/téléphones pertinents. Si une information n\'est ni dans la doc ni dans les données, dis-le franchement au lieu d\'inventer. ' +
      'Tu ne donnes jamais de conseils juridiques ni de prix.\n\n' + DOC_PLATEFORME + '\n\nDONNÉES RÉELLES (fenêtre récente, contacts respond.io, messages WhatsApp/emails) :\n' + donnees
    },
    { role: 'user', content: question }
  ];

  try {
    var rep = await mistral.appelMistral(messages, {
      texteLibre: true,
      modele: env('MISTRAL_MODELE_ASSIST') || 'mistral-small-latest',  // rapide (Hobby 10 s)
      temperature: 0.2,
      max_tokens: 700,
      reEssais: 1
    });
    return res.status(200).json({ ok: true, brique: 'C8-ASSIST', version: VERSION, reponse: rep.texte, modele: rep.modele });
  } catch (e) {
    return res.status(502).json({ ok: false, erreur: 'assistant indisponible : ' + String((e && e.message) || e).substring(0, 200) });
  }
}

module.exports = async function handler(req, res) {
  // CORS — le canvas appelle POST depuis le navigateur.
  try { res.setHeader('Access-Control-Allow-Origin', '*'); } catch (e) {}
  if (req.method === 'OPTIONS') {
    try {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret, x-jeton');
    } catch (e) {}
    return res.status(204).end();
  }

  // ---- C8-ASSIST-1 : POST {question, jeton} → assistant IA --------------
  if (req.method === 'POST') {
    var corpsA = {};
    try { corpsA = (typeof req.body === 'object' && req.body) ? req.body : JSON.parse(String(req.body || '{}')); } catch (e) { corpsA = {}; }
    var authA = require('../lib/auth');
    var jetonCorps = (corpsA && corpsA.jeton) || jetonDe(req);
    var secretQ = '';
    try { if (req.query && req.query.secret) secretQ = String(req.query.secret); } catch (e) {}
    if (!authA.authentifierRequete(secretQ, jetonCorps).ok) {
      return res.status(401).json({ ok: false, erreur: 'jeton ou secret invalide' });
    }
    req.body = corpsA;
    return repondreAssistant(req, res);
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });
  }

  var secret = secretDe(req);
  if (!env('WEBHOOK_SECRET') || secret !== env('WEBHOOK_SECRET')) {
    return res.status(401).json({ ok: false, erreur: 'secret invalide' });
  }

  if (!env('RESPONDIO_TOKEN')) {
    return res.status(500).json({ ok: false, erreur: 'RESPONDIO_TOKEN manquant — ajoutez la clé API respond.io dans les variables d\'environnement Vercel puis Redeploy' });
  }

  var contact = paramDe(req, 'contact');
  if (!contact) {
    return res.status(400).json({ ok: false, erreur: 'parametre contact manquant' });
  }

  var limite = parseInt(paramDe(req, 'limit'), 10);
  if (!isFinite(limite) || limite < 1) limite = 60;   // défaut prod
  if (limite > 100) limite = 100;                    // borne « conversation » v132

  try {
    // Diagnostic brut=1 (méthode prod v135/v136) : mêmes appels + réponses
    // BRUTES respond.io pour diagnostiquer en prod (cycle de vie, 404…)
    var brut = paramDe(req, 'brut') === '1';
    var ctx = await contexte.assemblerContexte(contact, limite, brut);
    return res.status(200).json({
      ok: true,
      brique: 'B2',
      version: VERSION,
      contact_id: contact,
      limite: limite,
      contact: ctx.contact,
      messages: ctx.messages,
      commentaires: ctx.commentaires,
      avertissements: ctx.avertissements,
      brut: ctx.brut
    });
  } catch (e) {
    return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
  }
};

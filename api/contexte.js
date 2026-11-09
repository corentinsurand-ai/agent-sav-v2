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

var VERSION = 'C8-ASSIST-2';

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

// ---- C8-ASSIST-2 : résolution du client ------------------------------------

function normaliserTxt(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ');
}

// Formate les comptages de maintenances d'un client (source comptages_maintenance,
// mêmes données que la page entreprise du canvas).
function formaterMaintenances(maints) {
  var out = [];
  (maints || []).forEach(function (m) {
    var donnees = (m && m.donnees) || {};
    (donnees.sites || []).forEach(function (s) {
      var t = ['  - Site ' + (s.ville || '?')];
      if (s.pack) t.push('pack: ' + s.pack);
      if (s.droits != null) t.push('droits/an: ' + s.droits);
      if (s.restants != null) t.push('restants (année en cours): ' + s.restants);
      if (s.consommes != null) t.push('consommés (année en cours): ' + s.consommes);
      if (s.derniere) t.push('dernier passage: ' + s.derniere);
      if (s.contrat_fin) t.push('contrat jusqu\'au: ' + s.contrat_fin);
      out.push(t.join(' | '));
      (s.par_annee || []).forEach(function (p) {
        if (p.en_cours) {
          out.push('    ANNEE EN COURS: ' + (p.debut || '?') + ' → ' + (p.fin || '?') +
            ' | restants: ' + (p.restants != null ? p.restants : '?') +
            ' | consommés: ' + (p.consommes != null ? p.consommes : '?'));
        }
      });
      if (s.dates_passages && s.dates_passages.length) {
        out.push('    dates de passage: ' + s.dates_passages.join(', '));
      }
    });
  });
  return out.join('\n');
}

// Détecte le client concerné par la question (nom/enseigne/tél/plaque) —
// priorité à la conversation ouverte si la question ne nomme personne d'autre.
function detecterClient(question, conv, clients) {
  var q = normaliserTxt(question);
  var qDigits = (String(question || '').replace(/\D/g, '').match(/\d{6,}/g) || []);
  var qNoSp = q.replace(/ /g, '');
  var meilleur = null, meilleurScore = 0;
  var convTel = conv && conv.tel ? String(conv.tel).replace(/\D/g, '') : '';
  var convEnt = conv && conv.entreprise ? normaliserTxt(conv.entreprise) : '';
  clients.forEach(function (c) {
    var score = 0;
    var ens = normaliserTxt(c.enseigne);
    var ensNoSp = ens.replace(/ /g, '');
    if (ensNoSp.length >= 4 && qNoSp.indexOf(ensNoSp) !== -1) score += 5;
    var mots = ens.split(' ').filter(function (m) { return m.length >= 3; });
    mots.forEach(function (m) { if (q.indexOf(' ' + m + ' ') !== -1 || q.indexOf(m) !== -1) score += 2; });
    var tel = String(c.telephone || '').replace(/\D/g, '');
    if (tel) {
      if (qDigits.some(function (d) { return d.length >= 9 && (tel.indexOf(d) !== -1 || d.indexOf(tel) !== -1); })) score += 10;
      if (convTel && tel === convTel) score += 8;
    }
    if (convEnt && ens === convEnt) score += 8;
    var plaques = String(c.plaque || '').split('/').map(function (p) { return p.trim(); }).filter(Boolean);
    plaques.forEach(function (p) { if (q.indexOf(p) !== -1) score += 6; });
    var lignes = ((c.brut || {}).lignes) || [];
    lignes.forEach(function (l) {
      ['nom_contact', 'prenom'].forEach(function (ch) {
        var v = normaliserTxt(l[ch]);
        if (v && v.length >= 3 && qNoSp.indexOf(v.replace(/ /g, '')) !== -1) score += 3;
      });
    });
    if (score > meilleurScore) { meilleurScore = score; meilleur = c; }
  });
  return meilleurScore >= 4 ? meilleur : null;
}

// Assemble les DONNÉES réelles compactes pour le prompt.
async function assemblerDonnees(conv, _, question) {
  var lignes = [];

  // 0. Clients (table clients + comptages_maintenance = page entreprise)
  var clients = await supabaseSelect('clients?select=telephone,enseigne,plaque,statut_risque,brut&order=enseigne.asc&limit=2000', []);
  var comptages = await supabaseSelect('comptages_maintenance?select=code_client,nom,donnees&limit=5000', []);
  var maintParCode = {};
  comptages.forEach(function (m) { maintParCode[m.code_client] = m; });

  // Résolution du client : question d'abord, sinon conversation ouverte.
  var questionPourDetection = String(question || '');
  var clientDetecte = detecterClient(questionPourDetection, conv, clients);
  if (!clientDetecte && conv && conv.tel) {
    var dConv = String(conv.tel).replace(/\D/g, '');
    clientDetecte = clients.find(function (c) { return String(c.telephone || '').replace(/\D/g, '') === dConv; }) || null;
  }

  // 0a. FICHE PRIORITAIRE du client détecté (fiche + maintenances complètes)
  if (clientDetecte) {
    var cd = clientDetecte;
    var fic = ['### CLIENT CONCERNÉ (priorité absolue, ignore tout autre client) :'];
    fic.push('- Enseigne: ' + (cd.enseigne || '?') + ' | tel: ' + (cd.telephone || '?') +
      ' | plaques: ' + (cd.plaque || '?') + ' | statut risque: ' + (cd.statut_risque || '?'));
    var codes = [];
    (((cd.brut || {}).lignes) || []).forEach(function (l) {
      var t = ['  - Scooter'];
      if (l.immat) t.push('immat: ' + l.immat);
      if (l.produit) t.push('produit: ' + l.produit);
      if (l.code_client) t.push('code client: ' + l.code_client);
      if (l.nom_contact) t.push('contact: ' + l.nom_contact + (l.prenom ? ' ' + l.prenom : ''));
      if (l.email) t.push('email: ' + l.email);
      if (l.telephone) t.push('tél: ' + l.telephone);
      if (l.ville) t.push('ville: ' + l.ville);
      if (l.contrat) t.push('contrat: ' + l.contrat);
      if (l.impayes) t.push('impayés: ' + l.impayes);
      fic.push(t.join(' | '));
      if (l.code_client && codes.indexOf(l.code_client) === -1) codes.push(l.code_client);
    });
    var maints = codes.map(function (cc) { return maintParCode[cc]; }).filter(Boolean)
      .map(function (m) { return { code_client: m.code_client, nom: m.nom, donnees: m.donnees }; });
    var fm = formaterMaintenances(maints);
    if (fm) {
      fic.push('  MAINTENANCES (source comptages_maintenance — Réponds aux questions d\'entretien UNIQUEMENT avec ceci) :');
      fic.push(fm);
    } else {
      fic.push('  MAINTENANCES: aucune donnée de maintenance trouvée pour ce client — dis-le, n\'invente rien.');
    }
    lignes.push(fic.join('\n'));
  }

  // 0b. Annuaire compact de TOUS les clients (pour retrouver un client par nom)
  clients.forEach(function (c) {
    lignes.push('- CLIENT ' + (c.enseigne || '?') + ' | tel ' + (c.telephone || '?') +
      ' | plaques ' + (c.plaque || '?') + ' | risque ' + (c.statut_risque || '?'));
  });

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

  // 2. Derniers messages WhatsApp (fenêtre récente réduite : le bruit causait
  // des confusions entre clients — la fiche ciblée ci-dessus est prioritaire)
  try {
    var wm = await supabaseSelect('wa_messages?select=wa_id,nom_profil,texte,sens,sender_nom,recu_a&order=recu_a.desc&limit=120', []);
    wm.slice().reverse().forEach(function (m) {
      lignes.push('- WA ' + (m.recu_a || '') + ' | tel ' + m.wa_id + ' | ' + (m.nom_profil || '') +
        ' | ' + (m.sens === 'sortant' ? ('sortant par ' + (m.sender_nom || 'l\'équipe')) : 'entrant') +
        ' | ' + String(m.texte || '').replace(/\s+/g, ' ').substring(0, 140));
    });
  } catch (e) {}

  // 3. Derniers emails
  try {
    var em = await supabaseSelect('emails?select=from_addr,from_nom,to_addr,sujet,texte,sens,recu_a&order=recu_a.desc&limit=60', []);
    em.slice().reverse().forEach(function (m) {
      lignes.push('- EMAIL ' + (m.recu_a || '') + ' | ' + (m.sens === 'sortant'
        ? ('à ' + m.to_addr + (m.from_nom ? ' par ' + m.from_nom : ''))
        : ('de ' + m.from_addr)) +
        ' | sujet: ' + String(m.sujet || '') + ' | ' + String(m.texte || '').replace(/\s+/g, ' ').substring(0, 120));
    });
  } catch (e) {}

  // 4. Historique ciblé : conversation ouverte dans le canvas OU client détecté
  var telCible = '';
  if (conv && (conv.nom || conv.tel || conv.email || conv.entreprise)) {
    lignes.push('- CONVERSATION OUVERTE DANS LA PLATEFORME : ' +
      [conv.nom, conv.tel, conv.email, conv.entreprise].filter(Boolean).join(' | ') +
      ' — si la question porte sur « ce client », c\'est lui.');
    if (conv.tel) telCible = String(conv.tel).replace(/\D/g, '');
  }
  if (clientDetecte && clientDetecte.telephone) {
    var dDet = String(clientDetecte.telephone).replace(/\D/g, '');
    if (dDet && dDet !== telCible) {
      lignes.push('- HISTORIQUE DU CLIENT DÉTECTÉ (' + (clientDetecte.enseigne || '') + ') :');
      telCible = dDet;
    }
  }
  if (telCible) {
    var d = telCible;
    {
      var hist = await supabaseSelect('wa_messages?select=texte,sens,sender_nom,recu_a&wa_id=eq.' + encodeURIComponent(d) + '&order=recu_a.desc&limit=60', []);
      hist.slice().reverse().forEach(function (m) {
        lignes.push('- WA(client concerné) ' + (m.recu_a || '') + ' | ' + (m.sens === 'sortant' ? ('sortant par ' + (m.sender_nom || 'l\'équipe')) : 'entrant') +
          ' | ' + String(m.texte || '').replace(/\s+/g, ' ').substring(0, 140));
      });
    }
    var mailsCible = [];
    if (conv && conv.email) mailsCible.push(String(conv.email).trim().toLowerCase());
    if (clientDetecte && clientDetecte.brut && clientDetecte.brut.lignes) {
      clientDetecte.brut.lignes.forEach(function (l) {
        if (l.email) mailsCible.push(String(l.email).trim().toLowerCase());
      });
    }
    mailsCible = mailsCible.filter(function (v, i) { return v && mailsCible.indexOf(v) === i; }).slice(0, 3);
    for (var mi = 0; mi < mailsCible.length; mi++) {
      var mel = mailsCible[mi];
      var histE = await supabaseSelect('emails?select=from_addr,from_nom,to_addr,sujet,texte,sens,recu_a&or=(from_addr.eq.' + encodeURIComponent(mel) + ',to_addr.eq.' + encodeURIComponent(mel) + ')&order=recu_a.desc&limit=40', []);
      histE.slice().reverse().forEach(function (m) {
        lignes.push('- EMAIL(client concerné) ' + (m.recu_a || '') + ' | sujet: ' + String(m.sujet || '') +
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

  var donnees = await assemblerDonnees(corps.conversation || null, 0, question);

  var messages = [
    { role: 'system', content:
      'Tu es l\'assistant intégré de la plateforme SAV de U\'mob (service technique scooters électriques). ' +
      'Tu réponds en français, de façon concise et directe (max ~180 mots), avec des puces si utile. ' +
      'Deux types de questions : (1) le FONCTIONNEMENT de la plateforme → réponds avec la documentation ci-dessous ; ' +
      '(2) les DONNÉES (clients, échanges, cycles, assignations, MAINTENANCES) → appuie-toi UNIQUEMENT sur les données réelles listées. ' +
      'RÈGLES ABSOLUES :\n' +
      '- S\'il y a une section « ### CLIENT CONCERNÉ » dans les données, elle prime sur TOUT le reste : la question porte sur CE client, ignore les autres clients et les messages génériques.\n' +
      '- Les questions de maintenances / entretiens (restants, consommés, dates de passage, contrat) se répondent UNIQUEMENT avec la section MAINTENANCES du client concerné. « Année en cours » = l\'entrée ANNEE EN COURS (période glissante du contrat, pas l\'année civile) ; « restants » = champ restants. Si aucune donnée de maintenance n\'existe pour ce client, dis-le clairement.\n' +
      '- N\'invente JAMAIS une donnée, un chiffre, un nom ou une date. Si l\'information n\'est ni dans la doc ni dans les données, réponds franchement : « cette information n\'est pas disponible dans la plateforme ».\n' +
      '- Ne confonds jamais deux clients : vérifie toujours que la réponse concerne bien le client demandé (nom/enseigne/téléphone).\n' +
      'Tu ne donnes jamais de conseils juridiques ni de prix.\n\n' + DOC_PLATEFORME + '\n\nDONNÉES RÉELLES (client concerné, annuaire clients, contacts respond.io, messages WhatsApp/emails) :\n' + donnees
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

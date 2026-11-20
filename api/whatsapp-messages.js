// ============================================================================
// Agent SAV U'mob v2 — C4 : /api/whatsapp-messages — lecture des messages
// WhatsApp enregistrés (plateforme maison C1/C4/C2)
//
// RÔLE : donner au canvas de la plateforme les VRAIS messages reçus par
// /api/whatsapp-webhook, pour construire les conversations (historique +
// nouveaux messages au rechargement 🔌 — choix Corentin 30/10).
// Depuis C4-LEC-2 : les messages ENVOYÉS (sens='sortant', brique C2) sont
// renvoyés aussi, avec leur statut de distribution (statut_reception :
// sent | delivered | read | failed) → ✓/✓✓/✓✓ bleu dans le canvas.
// Depuis C4-MEDIA-1 (16/11) : brut->_media (URL publique du média stocké
// dans le bucket wa-media) est renvoyé aussi → la plateforme affiche les
// photos reçues directement dans le fil.
//
//   GET ?secret=<WEBHOOK_SECRET>                  → info
//   GET ?secret=…&liste=1&limite=1000             → les derniers messages
//   POST {importer:[…]} (secret) → import historique respond.io (upsert wamid)
//        (toutes les conversations confondues, ordre chronologique croissant,
//         limité aux plus récents : le canvas groupe par téléphone)
//   GET ?secret=…&tel=33620476040                  → l'historique d'un numéro
//   GET ?secret=…&journal=1[&etape=wa_send][&tel=…][&depuis=ISO][&jusqua=ISO][&limite=200]
//        → lecture du journal agent_sav.journal (C4-JOURNAL-1 : logs d'envoi WA,
//          ERREURS Meta 502, etc. — lisible enfin depuis la plateforme/CLI)
//   POST ?journal=1 {etape, texte, detail} → écriture d'une ligne journal
//        (C4-JOURNAL-2 : le front y trace les échecs d'envoi vus côté navigateur)
//
// COMPATIBILITÉ : si les colonnes sens/statut_reception n'existent pas
// encore dans la table (ALTER pas exécuté), on retombe automatiquement sur
// l'ancien select — la route ne casse jamais la plateforme pendant le setup.
// brut->_media ne pose AUCUN problème de compatibilité : brut existe depuis
// toujours (jsonb), la clé _media est simplement absente → null.
//
// CORS : Allow-Origin:* comme /api/clients-import (prototype navigateur,
// authentification par secret jamais présent dans le code).
//
// Réponses : 200 ; 401 secret ; 405 méthode ; 500 config/Supabase.
// ============================================================================

var VERSION = 'C4-JOURNAL-2';
var SCHEMA = 'agent_sav';

// null tant que la présence des colonnes C2 n'est pas confirmée ;
// true/false une fois testé (repli silencieux si le ALTER n'est pas passé).
var COLONNES_C2 = null;

function env(nom) { return process.env[nom] || ''; }

function secretDe(req) {
  var secret = '';
  try {
    if (req.query && req.query.secret) secret = String(req.query.secret);
  } catch (e) {}
  if (!secret) {
    var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice((req.url || '').indexOf('?') + 1) : '';
    var m = u.match(/(?:^|&)secret=([^&]*)/);
    if (m) secret = m[1];
  }
  if (!secret && req.headers && req.headers['x-webhook-secret']) {
    secret = String(req.headers['x-webhook-secret']);
  }
  return secret;
}

function jetonDe(req) {
  var j = '';
  try { if (req.query && req.query.jeton) j = String(req.query.jeton); } catch (e) {}
  if (!j) {
    var u = (req.url || '').indexOf('?') !== -1 ? req.url.slice((req.url || '').indexOf('?') + 1) : '';
    var m = u.match(/(?:^|&)jeton=([^&]*)/);
    if (m) j = decodeURIComponent(m[1]);
  }
  if (!j && req.headers && req.headers['x-jeton']) j = String(req.headers['x-jeton']);
  return j;
}

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

// C8-IMP-2 : brut->>sender_nom / sender / sender_id exposent le VRAI
// expéditeur des messages importés respond.io (léger — pas le brut entier).
// C4-MEDIA-1 : brut->_media (jsonb → objet {kind,id,mime,caption,url}) expose
// le média téléchargé par le webhook (null si absent — aucun repli requis).
// C4-AUTEUR-1 : brut->>envoye_par expose aussi (repli 'Plateforme' cote front
// quand un vieux message envoye depuis la plateforme n'a pas de sender_nom).
var SELECT_BASE = 'id,wa_id,nom_profil,texte,type,wamid,recu_a,brut->>sender_nom,brut->>sender,brut->>sender_id,brut->>envoye_par,brut->_media';
var SELECT_C2 = SELECT_BASE + ',sens,statut_reception';

// Lecture avec repli : tente d'abord select avec les colonnes C2
// (sens, statut_reception) ; si la table ne les a pas (PGRST204 — colonne
// inconnue), retombe sur l'ancien select une fois pour toutes.
async function supabaseGetAvecC2(params) {
  var essai = function(select) {
    return fetch(urlSupabase('wa_messages', params.replace('SELECT', select)), {
      method: 'GET',
      headers: {
        'apikey': env('SUPABASE_SERVICE_KEY'),
        'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
        'Accept-Profile': SCHEMA
      }
    });
  };
  if (COLONNES_C2 === false) {
    var r0 = await essai(SELECT_BASE);
    var c0 = '';
    try { c0 = await r0.text(); } catch (e) { c0 = ''; }
    if (!r0.ok) throw new Error('Supabase wa_messages ' + r0.status + ' — ' + c0.substring(0, 300));
    return c0 ? JSON.parse(c0) : [];
  }
  var res = await essai(SELECT_C2);
  var corps = '';
  try { corps = await res.text(); } catch (e) { corps = ''; }
  if (!res.ok) {
    if (corps.indexOf('statut_reception') !== -1 || corps.indexOf('PGRST204') !== -1) {
      COLONNES_C2 = false;                            // ALTER pas encore exécuté
      return supabaseGetAvecC2(params);               // → repli ancien select
    }
    throw new Error('Supabase wa_messages ' + res.status + ' — ' + corps.substring(0, 300));
  }
  COLONNES_C2 = true;
  return corps ? JSON.parse(corps) : [];
}

// Assainit un texte avant écriture Supabase (jsonb n'accepte ni  ni
// ni les contrôles bruts ; surrogats isolés interdits en JSON).
function nettoyerImport(s) {
  s = String(s == null ? '' : s);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').replace(/\t/g, ' ');
  s = s.replace(/[\uD800-\uDFFF]/g, '');
  return s.substring(0, 4000).trim();
}

module.exports = async function handler(req, res) {
  // ---- C5-REALTIME : branche wa-config (fusion wa-config.js, limite 12 fonctions Vercel)
  // Reachable via la rewrite vercel.json : /api/wa-config -> /api/whatsapp-messages?waConfig=1
  if (/(?:^|[?&])waConfig=1(?:&|$)/.test(req.url || '')) {
    if (req.method !== 'GET') return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });
    var authW = require('../lib/auth');
    if (!authW.authentifierRequete(secretDe(req), jetonDe(req)).ok) {
      return res.status(401).json({ ok: false, erreur: 'secret invalide', version: VERSION });
    }
    var urlS = env('SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
    var anonS = env('SUPABASE_ANON_KEY') || '';
    if (!urlS) return res.status(500).json({ ok: false, erreur: 'SUPABASE_URL manquante' });
    return res.status(200).json({ ok: true, url: urlS, anon: anonS, schema: SCHEMA, table: 'wa_messages' });
  }
  // CORS — la plateforme (navigateur) lit cette route en direct.
  try { res.setHeader('Access-Control-Allow-Origin', '*'); } catch (e) {}
  if (req.method === 'OPTIONS') {
    try {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret, x-jeton');
    } catch (e) {}
    return res.status(204).end();
  }

  var authA = require('../lib/auth');
  if (!authA.authentifierRequete(secretDe(req), jetonDe(req)).ok) {
    return res.status(401).json({ ok: false, erreur: 'secret invalide', version: VERSION });
  }

  // ---- C4-JOURNAL-2 : POST ?journal=1 {etape, texte, detail} → écrit une ligne
  // dans agent_sav.journal (utilisé par le front pour tracer les échecs d'envoi
  // WA vus côté navigateur : 401, réseau, 502 — qu'aucun appel serveur ne voit)
  if (req.method === 'POST' && paramDe(req, 'journal') === '1') {
    var corpsJ = req.body;
    if (!corpsJ || typeof corpsJ !== 'object') {
      try { corpsJ = JSON.parse(String(req.body || '{}')); } catch (e) { corpsJ = null; }
    }
    var etapeW = String((corpsJ && corpsJ.etape) || 'wa_send').slice(0, 60);
    var texteW = String((corpsJ && corpsJ.texte) || '').slice(0, 500);
    var detailW = (corpsJ && corpsJ.detail && typeof corpsJ.detail === 'object') ? corpsJ.detail : {};
    if (!texteW) {
      return res.status(400).json({ ok: false, erreur: 'corps invalide : texte requis' });
    }
    if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_KEY')) {
      return res.status(500).json({ ok: false, erreur: 'configuration Supabase manquante' });
    }
    try {
      var resW = await fetch(urlSupabase('journal', ''), {
        method: 'POST',
        headers: {
          'apikey': env('SUPABASE_SERVICE_KEY'),
          'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
          'Content-Profile': SCHEMA
        },
        body: JSON.stringify({ etape: etapeW, texte: texteW, detail: detailW })
      });
      if (!resW.ok) {
        var cW = '';
        try { cW = await resW.text(); } catch (e) { cW = ''; }
        return res.status(500).json({ ok: false, erreur: 'Supabase journal ' + resW.status + ' — ' + cW.substring(0, 200) });
      }
      return res.status(200).json({ ok: true, brique: 'C4', version: VERSION, mode: 'journal_ecriture', etape: etapeW });
    } catch (e) {
      return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
    }
  }

  // ---- C4-IMP-2 : POST {importer:[…]} → import de l'historique respond.io
  // (messages WhatsApp historiques récupérés de l'API Platform respond.io ;
  //  upsert sur wamid → régénérable sans doublons, max 200 par appel)
  if (req.method === 'POST') {
    var corpsI = req.body;
    if (!corpsI || typeof corpsI !== 'object') {
      try { corpsI = JSON.parse(String(req.body || '{}')); } catch (e) { corpsI = null; }
    }
    if (!corpsI || !Array.isArray(corpsI.importer)) {
      return res.status(400).json({ ok: false, erreur: 'corps invalide : JSON {importer:[…]} attendu' });
    }
    if (!corpsI.importer.length) {
      return res.status(400).json({ ok: false, erreur: 'corps invalide : importer vide' });
    }
    if (corpsI.importer.length > 200) {
      return res.status(400).json({ ok: false, erreur: 'trop de messages (max 200 par appel)' });
    }
    if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_KEY')) {
      return res.status(500).json({ ok: false, erreur: 'configuration Supabase manquante' });
    }
    var lignesI = [];
    for (var iI = 0; iI < corpsI.importer.length; iI++) {
      var im = corpsI.importer[iI];
      if (!im || typeof im !== 'object' || !im.wa_id || !im.wamid) continue;
      lignesI.push({
        wa_id: String(im.wa_id).replace(/\D/g, ''),
        nom_profil: nettoyerImport(im.nom_profil || ''),
        texte: nettoyerImport(im.texte || ''),
        type: String(im.type || 'text'),
        wamid: String(im.wamid),
        brut: (im.brut && typeof im.brut === 'object') ? im.brut : { source: 'respond.io' },
        recu_a: im.recu_a || new Date().toISOString(),
        sens: im.sens === 'sortant' ? 'sortant' : 'entrant',
        statut: im.statut === 'non_lu' ? 'non_lu' : 'lu',
        statut_reception: im.statut_reception || null
      });
    }
    if (!lignesI.length) {
      return res.status(400).json({ ok: false, erreur: 'aucun message valide (wa_id + wamid requis)' });
    }
    try {
      var resI = await fetch(urlSupabase('wa_messages', 'on_conflict=wamid'), {
        method: 'POST',
        headers: {
          'apikey': env('SUPABASE_SERVICE_KEY'),
          'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
          'Content-Type': 'application/json',
          'Accept-Profile': SCHEMA,
          'Content-Profile': SCHEMA,
          'Prefer': 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(lignesI)
      });
      var corpsR = '';
      try { corpsR = await resI.text(); } catch (e) { corpsR = ''; }
      if (!resI.ok) {
        return res.status(500).json({ ok: false, erreur: 'Supabase wa_messages ' + resI.status + ' — ' + corpsR.substring(0, 300) });
      }
      return res.status(200).json({
        ok: true, brique: 'C4', version: VERSION, mode: 'import',
        recus: corpsI.importer.length, ecrits: lignesI.length
      });
    } catch (e) {
      return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
    }
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, erreur: 'methode non autorisee' });
  }

  if (!env('SUPABASE_URL') || !env('SUPABASE_SERVICE_KEY')) {
    return res.status(500).json({ ok: false, erreur: 'configuration Supabase manquante (SUPABASE_URL, SUPABASE_SERVICE_KEY)' });
  }

  // ---- C4-MEDIA-2 : rattrapage des médias reçus AVANT le déploiement C40-PHOTOS
  // GET ?backfill_media=1 → messages de type média des 7 derniers jours (les
  // media id Meta expirent après 7 jours) sans brut._media.url : on télécharge
  // + stocke le média (lib/media.js) et on PATCH brut._media (+ texte si
  // placeholder '[média reçu]'). Max 10 traités par appel (limite durée Vercel),
  // en parallèle. Le front reboucle tant qu'il reste des candidats.
  if (paramDe(req, 'backfill_media') === '1') {
    try {
      var media = require('../lib/media');
      var ilYa7j = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      var rB = await fetch(urlSupabase('wa_messages',
        'select=wamid,type,texte,brut&type=in.(image,video,audio,document,sticker)&recu_a=gte.' +
        encodeURIComponent(ilYa7j) + '&order=recu_a.desc&limit=200'), {
        method: 'GET',
        headers: {
          'apikey': env('SUPABASE_SERVICE_KEY'),
          'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
          'Accept-Profile': SCHEMA
        }
      });
      var corpsB = '';
      try { corpsB = await rB.text(); } catch (e) { corpsB = ''; }
      if (!rB.ok) {
        return res.status(500).json({ ok: false, erreur: 'Supabase wa_messages ' + rB.status + ' — ' + corpsB.substring(0, 300) });
      }
      var rows = corpsB ? JSON.parse(corpsB) : [];
      var aTraiter = rows.filter(function(r0) {
        var md = media.mediaDeBrut(r0.brut);
        return md && !(r0.brut && r0.brut._media && r0.brut._media.url);
      });
      var tranche = aTraiter.slice(0, 10);
      var stockes = 0;
      await Promise.all(tranche.map(async function(r0) {
        var md = media.mediaDeBrut(r0.brut);
        var url = await media.stockerMedia(md, r0.wamid);
        if (!url) return;
        var newBrut = r0.brut;
        newBrut._media = media.mediaStockee(md, url);
        var newTexte = r0.texte;
        if (String(r0.texte || '') === '[média reçu]' && !md.caption) newTexte = media.placeholderDe(md.kind);
        else if (md.caption && String(r0.texte || '') === '[média reçu]') newTexte = md.caption;
        try {
          var rP = await fetch(urlSupabase('wa_messages', 'wamid=eq.' + encodeURIComponent(r0.wamid)), {
            method: 'PATCH',
            headers: {
              'apikey': env('SUPABASE_SERVICE_KEY'),
              'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal',
              'Content-Profile': SCHEMA
            },
            body: JSON.stringify({ brut: newBrut, texte: newTexte })
          });
          if (rP.ok) stockes++;
        } catch (e) { /* best effort */ }
      }));
      return res.status(200).json({
        ok: true, brique: 'C4', version: VERSION, mode: 'backfill_media',
        total: rows.length, a_traiter: aTraiter.length, traites: tranche.length, stockes: stockes
      });
    } catch (e) {
      return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
    }
  }

  // ---- C4-JOURNAL-1 : lecture du journal agent_sav.journal (logs d'envoi WA,
  // erreurs Meta, etc.) — GET ?journal=1[&etape=wa_send][&tel=33761182801]
  // [&depuis=2026-11-19T00:00:00Z][&jusqua=…][&limite=200]
  if (paramDe(req, 'journal') === '1') {
    try {
      var etapeJ = paramDe(req, 'etape') || 'wa_send';
      var limiteJ = parseInt(paramDe(req, 'limite'), 10) || 200;
      if (limiteJ < 1) limiteJ = 1;
      if (limiteJ > 1000) limiteJ = 1000;
      var paramsJ = 'select=horodatage,etape,texte,detail&etape=eq.' + encodeURIComponent(etapeJ) +
        '&order=horodatage.desc&limit=' + limiteJ;
      var telJ = (paramDe(req, 'tel') || '').replace(/\D/g, '');
      if (telJ) paramsJ += '&detail->>tel=eq.' + encodeURIComponent(telJ);
      var depuisJ = paramDe(req, 'depuis');
      if (depuisJ) paramsJ += '&horodatage=gte.' + encodeURIComponent(depuisJ);
      var jusquaJ = paramDe(req, 'jusqua');
      if (jusquaJ) paramsJ += '&horodatage=lte.' + encodeURIComponent(jusquaJ);
      var rJ = await fetch(urlSupabase('journal', paramsJ), {
        method: 'GET',
        headers: {
          'apikey': env('SUPABASE_SERVICE_KEY'),
          'Authorization': 'Bearer ' + env('SUPABASE_SERVICE_KEY'),
          'Accept-Profile': SCHEMA
        }
      });
      var cJ = '';
      try { cJ = await rJ.text(); } catch (e) { cJ = ''; }
      if (!rJ.ok) {
        return res.status(500).json({ ok: false, erreur: 'Supabase journal ' + rJ.status + ' — ' + cJ.substring(0, 300) });
      }
      var lignesJ = cJ ? JSON.parse(cJ) : [];
      return res.status(200).json({
        ok: true, brique: 'C4', version: VERSION, mode: 'journal',
        etape: etapeJ, trouves: lignesJ.length, lignes: lignesJ
      });
    } catch (e) {
      return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
    }
  }

  // Historique d'un numéro précis
  var tel = paramDe(req, 'tel');
  if (tel) {
    var d = tel.replace(/\D/g, '');
    try {
      var fil = await supabaseGetAvecC2(
        'select=SELECT&wa_id=eq.' + encodeURIComponent(d) +
        '&order=recu_a.asc&limit=1000');
      return res.status(200).json({
        ok: true, brique: 'C4', version: VERSION, tel: d, trouves: fil.length, messages: fil
      });
    } catch (e) {
      return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
    }
  }

  // Derniers messages (toutes conversations) — le canvas regroupe par wa_id
  if (paramDe(req, 'liste') === '1') {
    var limite = parseInt(paramDe(req, 'limite'), 10) || 1000;
    if (limite < 1) limite = 1;
    if (limite > 5000) limite = 5000;
    // C4-INCR-1 : depuis_id > 0 → chargement INCRÉMENTAL (id > depuis_id, ordre
    // croissant) + statuts des sortants récents (48 h) pour rafraîchir ✓/✓✓
    // (le PATCH de statut ne change pas l'id de la ligne).
    var depuisId = parseInt(paramDe(req, 'depuis_id'), 10) || 0;
    try {
      // fenêtre des N plus récents, renvoyés en ordre chronologique croissant
      // v112 (Disk IO) : order=id.desc (PK indexée) au lieu de recu_a.desc
      // (pas d'index sur recu_a seul → seq scan + sort à chaque appel)
      var derniers, mode = 'complet';
      if (depuisId > 0) {
        derniers = await supabaseGetAvecC2(
          'select=SELECT&id=gt.' + depuisId + '&order=id.asc&limit=' + limite);
        mode = 'incremental';
      } else {
        derniers = await supabaseGetAvecC2(
          'select=SELECT&order=id.desc&limit=' + limite);
        derniers.reverse();
      }
      var parTel = {};
      derniers.forEach(function(m) { parTel[m.wa_id] = (parTel[m.wa_id] || 0) + 1; });
      var corpsRep = {
        ok: true, brique: 'C4', version: VERSION, limite: limite, mode: mode,
        depuis_id: depuisId,
        dernier_id: derniers.length ? (derniers[derniers.length - 1].id || 0) : depuisId,
        messages: derniers, conversations: Object.keys(parTel).length,
        total: derniers.length
      };
      if (depuisId > 0) {
        var ilYa48h = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
        corpsRep.statuts = await supabaseGetAvecC2(
          'select=wamid,wa_id,statut_reception&sens=eq.sortant&recu_a=gte.' +
          encodeURIComponent(ilYa48h) + '&order=id.desc&limit=400');
      }
      return res.status(200).json(corpsRep);
    } catch (e) {
      return res.status(500).json({ ok: false, erreur: String((e && e.message) || e) });
    }
  }

  return res.status(200).json({
    ok: true, brique: 'C4', version: VERSION,
    role: 'lecture des messages WhatsApp (recus par /api/whatsapp-webhook + envoyes par /api/whatsapp-send) + médias (brut->_media) + journal (C4-JOURNAL-1)',
    liste: 'GET ?liste=1&limite=1000 — derniers messages (canvas : regroupe par telephone)',
    tel: 'GET ?tel=33620476040 — historique chronologique d un numero',
    journal: 'GET ?journal=1[&etape=wa_send][&tel=…][&depuis=ISO][&jusqua=ISO] — logs du journal'
  });
};

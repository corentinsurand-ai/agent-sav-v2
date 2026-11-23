// C1.4 déployé — dédup téléphone: fiche ACTIVE prioritaire
// ============================================================================
// Agent SAV U'mob v2 — B2.2 : synchro Sheet « Infos Service Client » → Supabase
//
// v134 : l'onglet lu est désormais « Clients Complets » (1 ligne / scooter,
// infos client agrégées) à la place de « Client_contacts_risq_contr_prod »
// (1 ligne / contact × produit). La clé de agent_sav.clients reste le
// TÉLÉPHONE : on émet UN client par téléphone trouvé chez le client Sheet
// (mobile principal + téléphones parsés dans « Autres contacts »), pour que
// les conversations WhatsApp des contacts secondaires restent rattachées à
// la bonne enseigne.
//
// Portages fidèles du prod v2.20.136 :
//   - normaliserEnTetes / trouverColonne / trouverLigneEnTetes : lecture PAR
//     EN-TÊTES, aucune colonne lue par index en dur (scan des 10 1ères lignes).
//   - lecture COLONNE PAR COLONNE (plages A:A, D:D…) : une requête
//     multi-colonnes dépasserait les limites de taille de réponse de l'API.
//
// ÉCRITURES : uniquement agent_sav.clients (Supabase). Le Sheet et respond.io
// ne sont JAMAIS modifiés.
// ============================================================================

var google = require('./google.js');

var SCHEMA = 'agent_sav';
var ONGLET_DEFAUT = 'Clients Complets';
var TAILLE_LOT = 500;               // upsert par lots de 500 clients

function env(nom) { return process.env[nom] || ''; }

// ----------------------------------------------------------------------------
// Lecture par en-têtes (portage v136) — normalise : trim + minuscules + sans
// accents (« Code Client » → « code client »)
// ----------------------------------------------------------------------------
function normaliserEnTetes(ligne) {
  return (ligne || []).map(function(h) {
    return String(h).trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
  });
}

// Index de la 1ère colonne dont l'en-tête matche un des motifs, par priorité
function trouverColonne(entetes, motifs) {
  for (var j = 0; j < motifs.length; j++) {
    for (var i = 0; i < entetes.length; i++) {
      if (new RegExp(motifs[j]).test(entetes[i])) return i;
    }
  }
  return -1;
}

// Ligne d'en-têtes = première des 10 premières lignes contenant « immat »
function trouverLigneEnTetes(v, motifs) {
  for (var i = 0; i < Math.min(10, v.length); i++) {
    if (trouverColonne(normaliserEnTetes(v[i]), motifs) !== -1) return i;
  }
  return -1;
}

// Index de colonne → lettre A1 (0→A, 25→Z, 26→AA…)
function lettreColonne(idx) {
  var s = '';
  var n = idx + 1;
  while (n > 0) {
    var r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ----------------------------------------------------------------------------
// Téléphone → forme canonique chiffres avec indicatif (« 06 12 34 56 78 » →
// « 33612345678 »). Un numéro étranger est conservé tel quel (chiffres seuls).
// ----------------------------------------------------------------------------
function normaliserTelephone(s) {
  var d = String(s || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.slice(0, 4) === '0033') return '33' + d.slice(4);
  if (d.charAt(0) === '0' && d.length === 10) return '33' + d.slice(1);
  if (d.length === 9 && (d.charAt(0) === '6' || d.charAt(0) === '7')) return '33' + d;
  return d;
}

// Plaque → forme canonique : « aa-123-bb » → « AA123BB »
function normaliserImmat(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ----------------------------------------------------------------------------
// « Autres contacts » (texte libre, 1 contact par ligne) :
//   « Marin CHATARD - Manager Riom - 06 61 31 76 80 - marinchatard5@gmail.com »
//   « Compta - Compta - compta2@fpsgroupe.fr [livraison] [facturation] »
// → [{ nom, fonction, tel, email, tags }]
// ----------------------------------------------------------------------------
function parseAutresContacts(txt) {
  var out = [];
  String(txt || '').split('\n').forEach(function(line) {
    line = line.trim();
    if (!line) return;
    var p = line.split(' - ');
    var tags = (p[p.length - 1].match(/\[[^\]]*\]/g) || []).join(' ');
    var email = '';
    var tel = '';
    p.forEach(function(x) {
      var t = String(x).trim();
      if (!email && t.indexOf('@') !== -1) email = t;
      else if (!tel && /^\+?0?\d[\d .-]{7,}$/.test(t) && t.replace(/\D/g, '').length >= 9) tel = t;
    });
    var fonction = String(p[1] || '').trim();
    // C46-CONTACTS : un champ « - » qui est un numéro de téléphone n'est PAS une fonction
    if (/^\+?\d[\d .-]{7,}$/.test(fonction) && fonction.replace(/\D/g, '').length >= 9) fonction = '';
    out.push({ nom: String(p[0] || '').trim(), fonction: fonction, tel: tel, email: email, tags: tags });
  });
  return out;
}

// Vrai si la liste des colonnes demandées contient un téléphone
function colonneTelPresente(demandeuses) {
  for (var i = 0; i < demandeuses.length; i++) {
    if (demandeuses[i].cle === 'mobile' || demandeuses[i].cle === 'tel_fixe') return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// Colonnes utiles de l'onglet « Clients Complets » (v134) — motifs adaptés aux
// nouveaux en-têtes ; le téléphone retenu par ligne = Mobile, repli Téléphone.
// ----------------------------------------------------------------------------
var COLONNES = [
  { cle: 'immat',              motifs: ['immat'] },
  { cle: 'code_client',       motifs: ['^code\\s*client'] },
  { cle: 'nom_client',        motifs: ['^nom\\s*client', 'libelle client'] },
  { cle: 'statut_client',     motifs: ['^statut\\s*client'] },
  { cle: 'source',            motifs: ['^source$'] },
  { cle: 'siren',             motifs: ['^siren$'] },
  { cle: 'risque',            motifs: ['^risque$'] },
  { cle: 'impayes',           motifs: ['impay'] },
  { cle: 'procedure_collective', motifs: ['procedure'] },
  { cle: 'transfert',         motifs: ['transfert'] },
  { cle: 'resiliation',       motifs: ['resiliation'] },
  { cle: 'adresse_livraison', motifs: ['livraison'] },
  { cle: 'adresse_facturation', motifs: ['facturation'] },
  { cle: 'tous_sites',        motifs: ['tous les sites'] },
  { cle: 'contact_principal', motifs: ['contact principal'] },
  { cle: 'fonction',          motifs: ['^fonction$'] },
  { cle: 'mobile',            motifs: ['^mobile$'] },
  { cle: 'tel_fixe',          motifs: ['^tel'] },
  { cle: 'email',             motifs: ['e-?mail'] },
  { cle: 'autres_contacts',   motifs: ['autres contacts'] },
  { cle: 'produit',           motifs: ['libell.*produit'] },
  { cle: 'adresse_produit',   motifs: ['adresse du produit'] },
  { cle: 'dossier',           motifs: ['dossier'] },
  { cle: 'contrat_num',       motifs: ['^n.{0,2}contrat'] },
  { cle: 'contrat_libelle',   motifs: ['libell.*contrat'] },
  { cle: 'pack',              motifs: ['^pack$'] },
  { cle: 'contrat_debut',     motifs: ['date\\s*debut'] },
  { cle: 'contrat_fin',       motifs: ['date\\s*fin'] },
  { cle: 'contrat_etat',      motifs: ['^etat'] },
  { cle: 'en_cours',          motifs: ['en cours'] }
];

// Plage A1 d'une colonne entière : « 'Onglet'!D:D »
function plageColonne(onglet, idx) {
  var l = lettreColonne(idx);
  return "'" + onglet + "'!" + l + ':' + l;
}

// ----------------------------------------------------------------------------
// LECTURE : onglet « Clients Complets » → lignes regroupées PAR CODE CLIENT,
// puis UN client émis PAR TÉLÉPHONE (mobile principal + contacts parsés).
// Renvoie { ligne_entetes, colonnes, lignes_lues, clients }.
// ----------------------------------------------------------------------------
async function lireClients(sheetId, onglet) {
  onglet = onglet || ONGLET_DEFAUT;

  // 1) les 10 premières lignes pour trouver les en-têtes
  var tete = await google.lirePlage(sheetId, "'" + onglet + "'!1:10");
  var iEnt = trouverLigneEnTetes(tete, ['immat']);
  if (iEnt === -1) {
    throw new Error('Colonne Immatriculation introuvable dans les 10 premières lignes de « ' + onglet + ' » — vérifier le fichier client');
  }
  var entetes = normaliserEnTetes(tete[iEnt]);
  var titres = tete[iEnt] || [];

  // 2) colonnes utiles détectées → lecture colonne par colonne (parallèle)
  var demandeuses = [];
  var colonnes = {};
  for (var c = 0; c < COLONNES.length; c++) {
    var idx = trouverColonne(entetes, COLONNES[c].motifs);
    if (idx !== -1) {
      colonnes[COLONNES[c].cle] = String(titres[idx] || COLONNES[c].cle);
      demandeuses.push({ cle: COLONNES[c].cle, idx: idx });
    }
  }
  if (!colonneTelPresente(demandeuses)) {
    throw new Error('Colonne mobile/téléphone introuvable dans « ' + onglet + ' » — vérifier le fichier client');
  }
  var lectures = demandeuses.map(function(d) {
    return google.lirePlage(sheetId, plageColonne(onglet, d.idx));
  });
  var vecteurs = await Promise.all(lectures);

  // 3) assemblage : la plage « D:D » renvoie TOUTE la colonne depuis la
  // ligne 1 → la valeur de la ligne feuille r est vecteur[r-1]
  var debut = iEnt + 1;                        // 0-based : première ligne de DONNÉES
  var profondeur = 0;
  for (var v = 0; v < vecteurs.length; v++) {
    if (vecteurs[v].length > profondeur) profondeur = vecteurs[v].length;
  }

  var lignesLues = 0;
  var ignoreesSansClient = 0;
  var parCode = {};                            // code_client → groupe
  var ordreCodes = [];

  for (var r = debut; r < profondeur; r++) {
    var ligne = {};
    var nonVide = false;
    for (var k = 0; k < demandeuses.length; k++) {
      var vec = vecteurs[k] || [];
      var brut = (r < vec.length && vec[r] !== undefined && vec[r] !== null) ? vec[r] : '';
      var val = String(brut).trim();
      if (val !== '') nonVide = true;
      ligne[demandeuses[k].cle] = val;
    }
    if (!nonVide) continue;                    // ligne totalement vide
    lignesLues++;
    ligne.immat = normaliserImmat(ligne.immat);
    var telLigne = normaliserTelephone(ligne.mobile || ligne.tel_fixe);
    ligne.telephone = telLigne;                // téléphone retenu pour la ligne
    if (!ligne.code_client) { ignoreesSansClient++; continue; }

    ligne.contrat = (ligne.contrat_num || ligne.contrat_libelle || ligne.contrat_debut ||
      ligne.contrat_fin || ligne.contrat_etat)
      ? [ligne.contrat_libelle,
         ligne.contrat_num ? ('n° ' + ligne.contrat_num) : '',
         ligne.contrat_debut ? ('du ' + ligne.contrat_debut) : '',
         ligne.contrat_fin ? ('au ' + ligne.contrat_fin) : '',
         ligne.contrat_etat ? ('état : ' + ligne.contrat_etat) : ''].filter(String).join(' ')
      : '';
    ligne.adresse_complete = ligne.adresse_livraison || '';

    if (!parCode[ligne.code_client]) {
      parCode[ligne.code_client] = { lignes: [] };
      ordreCodes.push(ligne.code_client);
    }
    parCode[ligne.code_client].lignes.push(ligne);
  }

  // 4) un client émis PAR TÉLÉPHONE : mobile principal du groupe + téléphones
  //    parsés dans « Autres contacts » (contacts secondaires WhatsApp)
  var clients = [];
  ordreCodes.forEach(function(code) {
    var lignes = parCode[code].lignes;
    var c0 = lignes[0];
    var telPrincipal = '';
    lignes.forEach(function(l) {
      if (!telPrincipal && l.telephone) telPrincipal = l.telephone;
    });
    var contacts = parseAutresContacts(c0.autres_contacts || '');
    // C46-CONTACTS : dédup des contacts parsés par téléphone (garde le plus riche :
    // email / fonction / tags / nom) — évite les doublons au même numéro
    var vusC = {}, contactsN = [];
    contacts.forEach(function(ct) {
      var d = normaliserTelephone(ct.tel);
      if (d && vusC[d]) {
        var ex = vusC[d];
        if (!ex.email && ct.email) ex.email = ct.email;
        if (!ex.fonction && ct.fonction) ex.fonction = ct.fonction;
        if (!ex.tags && ct.tags) ex.tags = ct.tags;
        if (!ex.nom && ct.nom) ex.nom = ct.nom;
        return;
      }
      if (d) vusC[d] = ct;
      contactsN.push(ct);
    });
    contacts = contactsN;
    // C47-NOM-PRINCIPAL : nom principal de l'enseigne = le plus long des
    // contact_principal des lignes (ex. « Radoine BEN DAHMANE »)
    var principalNom = String(c0.contact_principal || '').trim();
    lignes.forEach(function(l) {
      var cp = String(l.contact_principal || '').trim();
      if (cp.length > principalNom.length) principalNom = cp;
    });
    var principal = {
      nom: principalNom || c0.contact_principal || '',
      fonction: c0.fonction || '',
      tel: telPrincipal,
      email: c0.email || ''
    };
    // C47-NOM-PRINCIPAL : un contact parsé dont le nom est une initiale (R)
    // ou un n° de tel reprend le nom du contact principal si l'initiale
    // ou la partie locale de l'email correspondent
    contacts.forEach(function(ct) {
      var n = String(ct.nom || '').trim();
      var digits = n.replace(/\D/g, '');
      var estInitiale = n.length <= 1;
      var estTel = digits.length >= 9 && /^\+?[\d .-]+$/.test(n);
      if (!estInitiale && !estTel) return;
      var pn = String(principal.nom || '').trim();
      var matchInitiale = estInitiale && n.length === 1 && pn && pn.charAt(0).toUpperCase() === n.toUpperCase();
      var mel = String(ct.email || '').split('@')[0] || '';
      var pmel = String(principal.email || '').split('@')[0] || '';
      var matchEmail = !!(mel && pmel && mel.toLowerCase() === pmel.toLowerCase());
      if (pn && (matchInitiale || matchEmail)) ct.nom = pn;
    });
    var parTel = {};
    var ordreTel = [];
    function ajoutTel(tel, contact) {
      if (!tel) return;
      if (!parTel[tel]) { parTel[tel] = contact || principal; ordreTel.push(tel); }
      else if (contact && !parTel[tel].nom && contact.nom) parTel[tel] = contact;
    }
    ajoutTel(telPrincipal, principal);
    contacts.forEach(function(ct) { ajoutTel(normaliserTelephone(ct.tel), ct); });

    var plaques = [];
    lignes.forEach(function(l) { if (l.immat && plaques.indexOf(l.immat) === -1) plaques.push(l.immat); });

    var brutClient = {
      code_client: code,
      nom_client: c0.nom_client || '',
      statut_client: c0.statut_client || '',
      source: c0.source || '',
      adresse_livraison: c0.adresse_livraison || '',
      adresse_facturation: c0.adresse_facturation || '',
      tous_sites: c0.tous_sites || '',
      contact_principal: principal.nom,
      fonction: principal.fonction,
      email: principal.email,
      contacts: contacts
    };

    ordreTel.forEach(function(tel) {
      clients.push({
        telephone: tel,
        plaque: plaques.join(' / '),
        enseigne: c0.nom_client || '',
        statut_risque: c0.risque || '',
        contact: parTel[tel],
        brut: { client: brutClient, lignes: lignes }
      });
    });
  });

  return {
    ligne_entetes: iEnt + 1,
    colonnes: colonnes,
    lignes_lues: lignesLues,
    lignes_ignorees_sans_code_client: ignoreesSansClient,
    clients: clients
  };
}

// ----------------------------------------------------------------------------
// ÉCRITURE : upsert par lots dans agent_sav.clients (PostgREST,
// on_conflict=telephone + merge-duplicates — idempotent, rejouable).
// ----------------------------------------------------------------------------
async function ecrireClients(clients) {
  var base = env('SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  var url = base + '/rest/v1/clients?on_conflict=telephone';
  var cle = env('SUPABASE_SERVICE_KEY');
  if (!cle) {
    throw new Error('SUPABASE_SERVICE_KEY manquant dans les variables d\'environnement Vercel');
  }
  var ecrites = 0;
  var maintenant = new Date().toISOString();
  // C1.4: un meme telephone peut apparaitre sous plusieurs codes client
  // (contact partage entre deux enseignes, ex. MNB (PIZZA SERVIZIO) « Bloque »
  // et JRD (PIZZA SERVIZIO) « Actif » sur le meme 06 35 44 59 18) — PostgREST
  // refuse qu'un meme lot contienne deux lignes en conflit sur la cle : on
  // garde la fiche ACTIVE (statut_client « Actif »), pas la 1ere occurrence,
  // pour qu'une enseigne bloquee/radiée ne masque pas l'enseigne active.
  function statutDe(c) {
    return String((c.brut && c.brut.client && c.brut.client.statut_client) || '').trim().toLowerCase();
  }
  function estActif(c) { return statutDe(c) === 'actif'; }
  var parTel = {};
  var uniques = [];
  clients.forEach(function(c) {
    if (!c.telephone) return;
    var ex = parTel[c.telephone];
    if (!ex) { parTel[c.telephone] = c; uniques.push(c); return; }
    // v158 : même téléphone sous PLUSIEURS enseignes (contact partagé entre
    // sociétés, ex. JDC / JDF Planet Sushi sur le 06 50 97 26 26) → on garde
    // UNE ligne par téléphone (clé de la table, la fiche ACTIVE prioritaire)
    // mais on FUSIONNE toutes les sociétés dans brut.societes : le front
    // déroule ensuite chaque enseigne en fiche propre (tout est importé).
    var winner = (estActif(c) && !estActif(ex)) ? c : ex;
    var loser = (winner === c) ? ex : c;
    if (winner !== ex) {
      var idx = uniques.indexOf(ex);
      if (idx !== -1) uniques[idx] = winner;
      parTel[c.telephone] = winner;
      // v161 : l'ancien winner peut déjà avoir des societes fusionnées
      // (ex. un client « Bloqué » arrivé avant l' « Actif ») — on les
      // reporte sur le nouveau winner, sinon elles sont perdues
      if (ex.brut && Array.isArray(ex.brut.societes) && ex.brut.societes.length) {
        winner.brut = winner.brut || {};
        var socEx = winner.brut.societes || (winner.brut.societes = []);
        ex.brut.societes.forEach(function(s) {
          var codeEx = s.client && s.client.code_client;
          if (!socEx.some(function(x) { return x.client && x.client.code_client === codeEx; })) socEx.push(s);
        });
      }
    }
    winner.brut = winner.brut || {};
    var soc = winner.brut.societes || (winner.brut.societes = []);
    [winner, loser].forEach(function(cl) {
      var code = cl && cl.brut && cl.brut.client && cl.brut.client.code_client;
      var deja = soc.some(function(s) { return s.client && s.client.code_client === code; });
      if (!deja) soc.push({ client: cl.brut.client, lignes: cl.brut.lignes });
    });
  });
  clients = uniques;
  for (var i = 0; i < clients.length; i += TAILLE_LOT) {
    var lot = clients.slice(i, i + TAILLE_LOT).map(function(c) {
      return {
        telephone: c.telephone,
        plaque: c.plaque || null,
        enseigne: c.enseigne || null,
        statut_risque: c.statut_risque || null,
        brut: Object.assign({}, c.brut, { contact: c.contact || null }),
        maj_a: maintenant
      };
    });
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': cle,
        'Authorization': 'Bearer ' + cle,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
        'Content-Profile': SCHEMA
      },
      body: JSON.stringify(lot)
    });
    if (res.status >= 400) {
      var corps = '';
      try { corps = (await res.text()).substring(0, 300); } catch (e) { corps = ''; }
      throw new Error('Supabase clients ' + res.status + ' (lot ' + (i / TAILLE_LOT + 1) + ') — ' + corps);
    }
    ecrites += lot.length;
  }
  return ecrites;
}

module.exports = {
  ONGLET_DEFAUT: ONGLET_DEFAUT,
  normaliserEnTetes: normaliserEnTetes,
  trouverColonne: trouverColonne,
  trouverLigneEnTetes: trouverLigneEnTetes,
  lettreColonne: lettreColonne,
  normaliserTelephone: normaliserTelephone,
  normaliserImmat: normaliserImmat,
  parseAutresContacts: parseAutresContacts,
  lireClients: lireClients,
  ecrireClients: ecrireClients
};

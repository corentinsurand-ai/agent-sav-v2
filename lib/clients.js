// ============================================================================
// Agent SAV U'mob v2 — B2.2 : synchro Sheet « Infos Service Client » → Supabase
//
// RÔLE : lire l'onglet fusionné « Client_contacts_risq_contr_prod » du Sheet
// (fichier clients U'mob — même source de vérité que l'ancien système),
// regrouper les lignes PAR TÉLÉPHONE (clé de agent_sav.clients, décision
// Corentin 22/10) et écrire le miroir dans la table Supabase agent_sav.clients
// (upsert : la synchro peut être rejouée à l'infini sans doublon).
//
// Portages fidèles du prod v2.20.136 :
//   - normaliserEnTetes / trouverColonne / trouverLigneEnTetes : lecture PAR
//     EN-TÊTES, aucune colonne n'est lue par index en dur (Nicolas décale les
//     lignes de titre — en-têtes réels ligne 4 pour l'onglet fusionné, le scan
//     des 10 premières lignes reste robuste s'il les redécale encore).
//   - remplirDepuisFusion : mêmes motifs regex par colonne.
// La lecture est faite COLONNE PAR COLONNE (plages entières A:A, D:D…) :
// l'onglet fait ~36 500 lignes — une seule requête multi-colonnes dépasserait
// les limites de taille de réponse de l'API Google.
//
// ÉCRITURES : uniquement agent_sav.clients (Supabase). Le Sheet et respond.io
// ne sont JAMAIS modifiés.
// ============================================================================

var google = require('./google.js');

var SCHEMA = 'agent_sav';
var ONGLET_DEFAUT = 'Client_contacts_risq_contr_prod';
var TAILLE_LOT = 500;               // upsert par lots de 500 clients

function env(nom) { return process.env[nom] || ''; }

// ----------------------------------------------------------------------------
// Lecture par en-têtes (portage v136) — normalise : trim + minuscules + sans
// accents (« Code Client » → « code client »)
// ----------------------------------------------------------------------------
function normaliserEnTetes(ligne) {
  return (ligne || []).map(function(h) {
    return String(h).trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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
// (l'onglet fusionné a des lignes de titre au-dessus, ligne 4 constatée)
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
// Téléphone → forme canonique chiffres seulement avec indicatif (respond.io
// stocke les numéros français en +33…) : « 06 12 34 56 78 » → « 33612345678 ».
// Un numéro étranger est conservé tel quel (chiffres uniquement).
// ----------------------------------------------------------------------------
function normaliserTelephone(s) {
  var d = String(s || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.slice(0, 4) === '0033') return '33' + d.slice(4);
  if (d.charAt(0) === '0' && d.length === 10) return '33' + d.slice(1);
  if (d.length === 9 && (d.charAt(0) === '6' || d.charAt(0) === '7')) return '33' + d;
  return d;
}

// Plaque → forme canonique (portage v136 normaliserImmat) :
// « aa-123-bb » → « AA123BB »
function normaliserImmat(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Vrai si la liste des colonnes demandées contient le téléphone
function colonneTelPresente(demandeuses) {
  for (var i = 0; i < demandeuses.length; i++) {
    if (demandeuses[i].cle === 'telephone') return true;
  }
  return false;
}

// Colonnes utiles de l'onglet fusionné — motifs portés de remplirDepuisFusion
// (v136) + téléphone (clé de la table clients)
var COLONNES = [
  { cle: 'immat',              motifs: ['immat'] },
  { cle: 'code_client',       motifs: ['^code\\s*client'] },
  { cle: 'nom_client',        motifs: ['^nom\\s*client', 'libelle client'] },
  { cle: 'adresse',           motifs: ['adresse', 'dresse'] },      // tolère « Addresse »
  { cle: 'cp',                motifs: ['code postal', '^cp$'] },
  { cle: 'ville',             motifs: ['ville'] },
  { cle: 'produit',           motifs: ['libell.*produit', 'produit'] },
  { cle: 'prenom',            motifs: ['^prenom'] },
  { cle: 'nom_contact',       motifs: ['^nom\\s*contact'] },
  { cle: 'fonction',          motifs: ['fonction'] },
  { cle: 'telephone',         motifs: ['mobile', '^tel'] },        // Mobile facturation
  { cle: 'email',             motifs: ['email'] },
  { cle: 'contrat_num',       motifs: ['^n.{0,2}contrat', 'numero contrat', '^no.{0,2}contrat'] },
  { cle: 'contrat_libelle',   motifs: ['libell.*contrat'] },
  { cle: 'contrat_debut',     motifs: ['date\\s*debut'] },
  { cle: 'contrat_fin',       motifs: ['date\\s*fin'] },
  { cle: 'contrat_etat',      motifs: ['etat'] },
  { cle: 'risque',            motifs: ['risque'] },
  { cle: 'impayes',           motifs: ['impay'] },
  { cle: 'procedure_collective', motifs: ['procedure', 'collective'] },
  { cle: 'transfert',         motifs: ['transfert'] },
  { cle: 'resiliation',       motifs: ['resiliation'] }
];

// Plage A1 d'une colonne entière : « 'Onglet'!D:D »
function plageColonne(onglet, idx) {
  var l = lettreColonne(idx);
  return "'" + onglet + "'!" + l + ':' + l;
}

// ----------------------------------------------------------------------------
// LECTURE : onglet → clients regroupés par téléphone
// Renvoie { ligne_entetes, colonnes:{cle→titre}, lignes_lues,
//           lignes_ignorees, clients:[{telephone, plaque, enseigne,
//           statut_risque, brut}] } — JETTE une erreur explicite si la
// colonne immat est introuvable (même garde-fou que le prod v136).
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
    // La clé de la table est le téléphone : sans colonne détectée, la synchro
    // n'aurait AUCUN client — on le dit clairement plutôt que d'écrire vide.
    throw new Error('Colonne téléphone/mobile introuvable dans « ' + onglet + ' » — vérifier le fichier client');
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
  var ignoreesSansTel = 0;
  var ignoreesVides = 0;
  var parTelephone = {};
  var ordre = [];                              // ordre d'apparition (upsert stable)

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
    var tel = normaliserTelephone(ligne.telephone);
    if (!tel) { ignoreesSansTel++; continue; } // sans téléphone : clé impossible

    ligne.contrat = (ligne.contrat_num || ligne.contrat_libelle || ligne.contrat_debut ||
      ligne.contrat_fin || ligne.contrat_etat)
      ? [ligne.contrat_libelle,
         ligne.contrat_num ? ('n° ' + ligne.contrat_num) : '',
         ligne.contrat_debut ? ('du ' + ligne.contrat_debut) : '',
         ligne.contrat_fin ? ('au ' + ligne.contrat_fin) : '',
         ligne.contrat_etat ? ('état : ' + ligne.contrat_etat) : ''].filter(String).join(' ')
      : '';
    ligne.adresse_complete = [ligne.adresse, ligne.cp, ligne.ville].filter(String).join(' ');

    if (!parTelephone[tel]) {
      parTelephone[tel] = {
        telephone: tel,
        plaque: '',
        enseigne: ligne.nom_client || '',
        statut_risque: ligne.risque || '',
        brut: { lignes: [] }
      };
      ordre.push(tel);
    }
    var client = parTelephone[tel];
    var plaques = client.plaque ? client.plaque.split(' / ') : [];
    if (ligne.immat && plaques.indexOf(ligne.immat) === -1) plaques.push(ligne.immat);
    client.plaque = plaques.join(' / ');
    if (!client.enseigne && ligne.nom_client) client.enseigne = ligne.nom_client;
    if (!client.statut_risque && ligne.risque) client.statut_risque = ligne.risque;
    client.brut.lignes.push(ligne);
  }

  var clients = ordre.map(function(t) { return parTelephone[t]; });
  return {
    ligne_entetes: iEnt + 1,
    colonnes: colonnes,
    lignes_lues: lignesLues,
    lignes_ignorees_sans_telephone: ignoreesSansTel,
    lignes_vides: ignoreesVides,
    clients: clients
  };
}

// ----------------------------------------------------------------------------
// ÉCRITURE : upsert par lots dans agent_sav.clients (PostgREST,
// on_conflict=telephone + merge-duplicates — idempotent, rejouable).
// Renvoie le nombre de lignes écrites.
// ----------------------------------------------------------------------------
async function ecrireClients(clients) {
  // Base Supabase normalisée : le code ajoute /rest/v1 LUI-MÊME. Piège
  // constaté en prod réelle (PGRST125 « Invalid path ») : SUPABASE_URL collée
  // avec « /rest/v1 » en fin → /rest/v1/rest/v1/clients. Tolérant au
  // copier-coller, comme pour la clé privée Google.
  var base = env('SUPABASE_URL').replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  var url = base + '/rest/v1/clients?on_conflict=telephone';
  var cle = env('SUPABASE_SERVICE_KEY');
  if (!cle) {
    throw new Error('SUPABASE_SERVICE_KEY manquant dans les variables d\'environnement Vercel');
  }
  var ecrites = 0;
  var maintenant = new Date().toISOString();
  for (var i = 0; i < clients.length; i += TAILLE_LOT) {
    var lot = clients.slice(i, i + TAILLE_LOT).map(function(c) {
      return {
        telephone: c.telephone,
        plaque: c.plaque || null,
        enseigne: c.enseigne || null,
        statut_risque: c.statut_risque || null,
        brut: c.brut,
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
  lireClients: lireClients,
  ecrireClients: ecrireClients
};

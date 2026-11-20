// ============================================================================
// Agent SAV U'mob v2 — C1.3 — lib/clients.js — lecture Sheet + miroir clients
//
// Le Google Sheet « Infos Service Client » est la source de vérité métier
// (mêmes colonnes que l'ancien fichier Excel suivi SAV). Ce module :
//   1. lit l'onglet fusionné via l'API Sheets (service account, zéro scrape),
//   2. APLATIT les lignes par client : une fiche client = toutes ses lignes
//      (1 ligne = 1 produit loué) regroupées sous le n° de téléphone du
//      contact principal (clé unique du miroir Supabase) — l'app front lit
//      ensuite ce miroir (table agent_sav.clients) à chaque chargement.
//
// Pourquoi un miroir et pas le Sheet en direct à chaque message :
//   - le Sheet fait ~10 830 lignes / ~5 Mo : illisible à chaque événement ;
//   - Supabase indexe par téléphone → le cerveau retrouve la fiche client
//     en <10 ms quand un message WhatsApp arrive.
// ============================================================================

var google = require('./google.js');

var VERSION = 'C1.4';
var ONGLET_DEFAUT = 'Clients Complets';

// En-têtes reconnus (noms exacts de l'onglet fusionné) → clé interne.
// L'onglet a été enrichi (C1.1) : statut client, risque, adresses, contacts.
var COLONNES = {
  immat: 'Immatriculation',
  code_client: 'Code client',
  nom_client: 'Nom client',
  statut_client: 'Statut client',
  source: 'Source',
  siren: 'SIREN',
  risque: 'Risque',
  impayes: 'Impayés',
  procedure_collective: 'Procédure collective / radiation',
  transfert: 'Demande de transfert',
  resiliation: 'Demande de résiliation',
  adresse_livraison: 'Adresse de livraison principale',
  adresse_facturation: 'Adresse de facturation principale',
  tous_sites: 'Tous les sites',
  contact_principal: 'Contact principal',
  fonction: 'Fonction',
  mobile: 'Mobile',
  tel_fixe: 'Téléphone',
  email: 'E-mail',
  autres_contacts: 'Autres contacts',
  produit: 'Libellé produit',
  adresse_produit: 'Adresse du produit',
  dossier: 'N° dossier LOCAM / RTS',
  contrat_num: 'N° contrat',
  contrat_libelle: 'Libellé contrat',
  pack: 'Pack',
  contrat_debut: 'Date début contrat',
  contrat_fin: 'Date fin contrat',
  contrat_etat: 'État contrat',
  en_cours: 'Contrat en cours'
};

function normCle(t) {
  return String(t || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// "06 12 34 56 78", "+33612345678", "0033 6..." → "33612345678" (chiffres nus
// avec indicatif) — même normalisation que le cerveau pour matcher un wa_id.
function normaliserTelephone(t) {
  var d = String(t || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.slice(0, 4) === '0033') return d.slice(4);
  if (d.slice(0, 2) === '33') return d;
  if (d.charAt(0) === '0' && d.length === 10) return '33' + d.slice(1);
  if (d.length === 9) return '33' + d;
  return d;
}

// "Autres contacts" : lignes "Nom - fonction - tél - email" séparées par des
// sauts de ligne ; le tél/email peuvent manquer. Ne JAMAIS confondre avec un
// n° de tel isolé.
function parseAutresContacts(txt) {
  return String(txt || '').split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean).map(function(l) {
    var p = l.split('-').map(function(x) { return x.trim(); });
    var tel = '', email = '', fonction = '', nom = p[0] || '';
    p.slice(1).forEach(function(x) {
      if (!x) return;
      if (x.indexOf('@') !== -1 && !email) email = x;
      else if (/\d/.test(x) && x.replace(/\D/g, '').length >= 8 && !tel) tel = x;
      else if (!fonction) fonction = x;
    });
    return { nom: nom, fonction: fonction, tel: tel, email: email };
  }).filter(function(c) { return c.nom || c.tel || c.email; });
}

// Lit tout l'onglet et aplati par client (regroupé par téléphone du contact).
async function lireClients(sheetId, onglet) {
  var brut = await google.lireOnglet(sheetId, onglet || ONGLET_DEFAUT);
  var lignes = brut.lignes || [];
  var ligneEntetes = brut.ligne_entetes || 1;
  if (!lignes.length) return { colonnes: {}, ligne_entetes: ligneEntetes, lignes_lues: 0, lignes_ignorees_sans_telephone: 0, clients: [] };

  // index colonnes : en-tête -> position
  var entetes = lignes[0].map(normCle);
  var col = {};
  Object.keys(COLONNES).forEach(function(k) {
    var idx = entetes.indexOf(normCle(COLONNES[k]));
    if (idx !== -1) col[k] = idx;
  });

  var parTel = {}, ordre = [], ignoreesSansTel = 0;
  lignes.slice(1).forEach(function(l) {
    function v(k) { return col[k] !== undefined ? String(l[col[k]] || '').trim() : ''; }
    var tel = normaliserTelephone(v('mobile') || v('tel_fixe') || v('telephone'));
    if (!tel) { ignoreesSansTel++; return; }   // ligne sans aucun tél contact → non adressable
    if (!parTel[tel]) { parTel[tel] = { telephone: tel, lignes: [] }; ordre.push(tel); }
    parTel[tel].lignes.push({
      code_client: v('code_client'), immat: v('immat'), produit: v('produit'),
      adresse_produit: v('adresse_produit'), contrat: v('contrat_libelle') || v('contrat_num'),
      contrat_num: v('contrat_num'), pack: v('pack'), contrat_debut: v('contrat_debut'),
      contrat_fin: v('contrat_fin'), en_cours: v('en_cours'), dossier: v('dossier'),
      adresse_complete: v('adresse_livraison') || v('adresse_facturation'),
      siren: v('siren'), impayes: v('impayes'), procedure_collective: v('procedure_collective'),
      transfert: v('transfert'), resiliation: v('resiliation'),
      statut_client: v('statut_client'), risque: v('risque'),
      contact_principal: v('contact_principal'), fonction: v('fonction'),
      mobile: v('mobile'), tel_fixe: v('tel_fixe'), email: v('email'),
      autres_contacts: v('autres_contacts'),
      // téléphone normalisé de la ligne = mobile, sinon fixe (miroir)
      telephone: tel
    });
  });

  var clients = ordre.map(function(tel) {
    var g = parTel[tel];
    /* C1.4 : un même téléphone peut apparaître sous PLUSIEURS enseignes dans
       le Sheet (ex. MNB (PIZZA SERVIZIO) « Bloqué » et JRD (PIZZA SERVIZIO)
       « Actif » partagent le 06 35 44 59 18) : les lignes sont regroupées par
       tél, donc on choisit comme ligne représentative la 1re ligne ACTIVE —
       une enseigne bloquée/radiée ne doit pas masquer l'enseigne active. */
    var c0 = g.lignes.filter(function(l) { return /^\s*actif\s*$/i.test(String(l.statut_client || '')); })[0] || g.lignes[0];
    var contacts = parseAutresContacts(c0.autres_contacts);
    // le contact principal de la fiche (1re ligne du groupe)
    var telPrincipal = normaliserTelephone(c0.mobile || c0.tel_fixe || c0.telephone);
    var principal = { nom: c0.contact_principal || '', fonction: c0.fonction || '', tel: telPrincipal, email: c0.email || '' };
    // index par tel pour retrouver le contact principal dans le Sheet
    var parTelContact = {};
    function ajoutTel(t, ct) { if (t) parTelContact[t] = ct; }
    ajoutTel(telPrincipal, principal);
    contacts.forEach(function(ct) { ajoutTel(normaliserTelephone(ct.tel), ct); });
    var brutClient = {
      nom_client: c0.nom_client || parTel[tel].lignes.map(function(l){return l.code_client;}).filter(Boolean)[0] || '',
      enseigne: c0.nom_client || '',
      statut_client: c0.statut_client || '',
      source: c0.source || '',
      siren: c0.siren || '',
      risque: c0.risque || '',
      impayes: c0.impayes || '',
      procedure_collective: c0.procedure_collective || '',
      transfert: c0.transfert || '',
      resiliation: c0.resiliation || '',
      adresse_livraison: c0.adresse_livraison || '',
      adresse_facturation: c0.adresse_facturation || '',
      tous_sites: c0.tous_sites || '',
      email: c0.email || '',
      contact_principal: c0.contact_principal || '',
      fonction: c0.fonction || '',
      mobile: c0.mobile || '',
      tel_fixe: c0.tel_fixe || '',
      autres_contacts: c0.autres_contacts || '',
      contacts: contacts,
      lignes: g.lignes
    };
    // contact principal du client = entrée du Sheet correspondant au tél
    var contact = parTelContact[tel] || principal;
    return {
      telephone: tel,
      plaque: g.lignes.map(function(l) { return l.immat; }).filter(Boolean).join(' / '),
      enseigne: brutClient.enseigne,
      statut: brutClient.statut_client,
      brut: Object.assign({}, brutClient, { contact: contact, client: brutClient })
    };
  });

  return {
    colonnes: col,
    ligne_entetes: ligneEntetes,
    lignes_lues: lignes.length - 1,
    lignes_ignorees_sans_telephone: ignoreesSansTel,
    clients: clients
  };
}

// Écrit le miroir Supabase agent_sav.clients (upsert par téléphone).
async function ecrireClients(clients) {
  var supa = require('./supabase.js');
  /* v-C1.3 : doublons de téléphone — on garde la fiche ACTIVE (statut_client
     « Actif ») plutôt que la 1re occurrence : une enseigne bloquée/radiée ne
     doit pas masquer l'enseigne active partageant le même contact
     (ex. MNB (PIZZA SERVIZIO) bloqué vs JRD (PIZZA SERVIZIO) actif, même tél). */
  function estActif(c) { return /^\s*actif\s*$/i.test(String(c.statut || '')); }
  var parTel = {}, uniques = [];
  clients.forEach(function(c) {
    var t = String(c.telephone || '').replace(/\D/g, '');
    if (!t) { uniques.push(c); return; }
    var ex = parTel[t];
    if (!ex) { parTel[t] = c; uniques.push(c); return; }
    if (estActif(c) && !estActif(ex)) {
      var idx = uniques.indexOf(ex);
      if (idx !== -1) uniques[idx] = c;
      parTel[t] = c;
    }
  });
  var ecrits = 0;
  for (var i = 0; i < uniques.length; i++) {
    var c = uniques[i];
    var ligne = {
      telephone: String(c.telephone || '').replace(/\D/g, ''),
      plaque: c.plaque || null,
      enseigne: c.enseigne || null,
      statut_risque: c.statut || null,
      brut: c.brut || null,
      maj_a: new Date().toISOString()
    };
    var ok = await supa.upsert('clients', 'telephone', ligne);
    if (ok) ecrits++;
  }
  return ecrits;
}

module.exports = { VERSION: VERSION, ONGLET_DEFAUT: ONGLET_DEFAUT, COLONNES: COLONNES, normaliserTelephone: normaliserTelephone, lireClients: lireClients, ecrireClients: ecrireClients };

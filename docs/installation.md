# Installation pas à pas

Ce guide part de zéro : aucun projet Google Cloud, aucune clé. Compte 20 à 30 minutes pour Google,
5 minutes pour Bing. Chaque source est facultative : configure seulement celles dont tu as besoin.

- [1. Google Cloud : projet et API](#1-google-cloud--projet-et-api)
- [2. Écran de consentement OAuth](#2-écran-de-consentement-oauth)
- [3. Client OAuth « Application de bureau »](#3-client-oauth--application-de-bureau-)
- [4. Remplir `.env` pour Google](#4-remplir-env-pour-google)
- [5. Autoriser ton compte Google](#5-autoriser-ton-compte-google)
- [6. Google Ads : accès Explorer](#6-google-ads--accès-explorer)
- [7. Bing Webmaster Tools](#7-bing-webmaster-tools)
- [8. Brancher le serveur dans Claude](#8-brancher-le-serveur-dans-claude)

---

## 1. Google Cloud : projet et API

1. Ouvre https://console.cloud.google.com avec le compte qui a accès à Search Console et Google Ads.
2. Sélecteur de projet → **Nouveau projet** → nomme-le `marketing-mcp` → **Créer**.
3. **API et services → Bibliothèque**, puis active :
   - **Google Search Console API**
   - **Google Ads API** (si tu veux Google Ads)

## 2. Écran de consentement OAuth

Menu **Google Auth Platform** (ou **API et services → Écran de consentement OAuth**), bouton
**Premiers pas** :

1. **Informations sur l'application** : nom `marketing-mcp`, ton e-mail d'assistance.
2. **Audience** :
   - **Interne** si ton compte appartient à une organisation Google Workspace : pas d'utilisateurs
     test à gérer, et le jeton n'expire pas au bout de 7 jours ;
   - sinon **Externe**.
3. **Coordonnées** : ton e-mail.
4. Accepte le règlement sur les données utilisateur, puis **Créer**.

Ensuite, dans le menu de gauche :

- **Audience** (si Externe) → **Utilisateurs test** → ajoute ton adresse Google.
- **Accès aux données** → **Ajouter ou supprimer des champs d'application** → coche
  `https://www.googleapis.com/auth/webmasters.readonly` et, pour Google Ads,
  `https://www.googleapis.com/auth/adwords` → **Mettre à jour** → **Enregistrer**.

## 3. Client OAuth « Application de bureau »

1. **Clients → Créer un client**.
2. Type d'application : **Application de bureau**. Nom : `marketing-mcp-local`.
3. Laisse « Use this client for an AI-powered agent » décoché : le serveur utilise le flux OAuth
   classique d'une application de bureau.
4. **Créer**. Copie tout de suite le **Client ID** et le **Client secret** (ou télécharge le JSON) :
   Google n'affiche plus le secret une fois la fenêtre fermée.

Le nouveau client peut mettre de quelques minutes à quelques heures à être actif.

## 4. Remplir `.env` pour Google

```bash
cp .env.example .env
```

```
GOOGLE_CLIENT_ID=1234567890-xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
GSC_SITE_URLS=https://www.exemple.fr/,sc-domain:exemple.es
```

`GSC_SITE_URLS` doit reprendre **exactement** l'écriture de Search Console :

- propriété « préfixe d'URL » : `https://www.exemple.fr/` (avec la barre oblique finale) ;
- propriété « domaine » : `sc-domain:exemple.fr`.

Une propriété Search Console déclarée à la racine (`https://www.exemple.fr/`) couvre aussi ses
sous-dossiers (`/fr/`, `/nl/`…) : pour isoler une langue, interroge la racine avec un filtre sur la
page (`page contains /nl/`). Après l'étape 5, l'outil `gsc_list_sites` affiche l'écriture exacte de
chaque propriété de ton compte.

## 5. Autoriser ton compte Google

```bash
npm run auth:google
```

Le navigateur s'ouvre. Choisis ton compte, **coche tous les accès demandés** (Google permet de les
décocher un par un) et valide. Si Google affiche « Application non validée », clique sur
**Paramètres avancés → Accéder à marketing-mcp** : c'est normal pour ta propre application en mode
Test. Le terminal affiche « Autorisation enregistrée », et le refresh token est écrit dans
`data/google-token.json`.

En mode Test (audience Externe), Google invalide ce jeton après 7 jours : relance la commande.

## 6. Google Ads : accès Explorer

Depuis le 9 septembre 2026, Google Ads n'utilise plus de developer token : l'accès dépend du
projet Google Cloud qui porte le client OAuth.

1. Activer « Google Ads API » donne l'accès **Test**, limité aux comptes de test.
2. Pour lire tes vrais comptes, demande l'accès **Explorer** sur
   https://console.cloud.google.com/google/ads-apis/overview (2 880 opérations par jour sur les
   comptes de production).
3. Si tes comptes sont gérés depuis un compte administrateur (MCC), renseigne
   `GOOGLE_ADS_LOGIN_CUSTOMER_ID` dans `.env`. L'outil `gads_list_customers` affiche tes comptes et
   le MCC dont chacun dépend.
4. Facultatif : `GOOGLE_ADS_CUSTOMER_IDS` limite les comptes interrogeables.

## 7. Bing Webmaster Tools

Pas d'OAuth : une clé API suffit.

1. Connecte-toi à https://www.bing.com/webmasters avec le compte qui gère tes sites.
2. **Paramètres** (roue dentée) → **Accès API** → **Clé API** → **Générer**.
3. Ajoute-la dans `.env` :
   ```
   BING_API_KEY=ta_cle
   BING_SITE_URLS=https://www.exemple.fr/
   ```
   `BING_SITE_URLS` est facultatif ; vide, tous les sites du compte sont accessibles.

La clé donne accès à tous les sites du compte. Bing fournit environ 16 mois d'historique ; les
statistiques par requête et par page sont hebdomadaires, et Bing ne renvoie plus la position moyenne
des clics (seule la position moyenne des impressions est fournie).

## 8. Brancher le serveur dans Claude

`.mcp.json`, à la racine du dépôt, déclare le serveur pour les sessions Claude Code ouvertes dans ce
dossier. Ouvre Claude Code dans `marketing-mcp` et accepte de faire confiance au serveur du projet.

Pour l'avoir partout :

```bash
claude mcp add marketing-mcp --scope user -- node /chemin/vers/marketing-mcp/node_modules/tsx/dist/cli.mjs /chemin/vers/marketing-mcp/src/index.ts
```

Après toute modification de `.env` ou une nouvelle autorisation, ouvre une nouvelle session pour
recharger le serveur. Vérifie avec : « Quelles sources marketing sont disponibles ? »

---
name: seo-opportunites
description: Traite une opportunité SEO détectée dans Search Console — CTR faible (réécrire title et meta description), page 2 (enrichir le contenu et le maillage), cannibalisation (plusieurs pages sur une requête) ou page en déclin. Arguments - meta|contenu|cannibalisation|declin, puis l'URL ou le site, puis la requête entre guillemets. Utiliser quand une commande vient de l'onglet Opportunités du dashboard Pilote SEO.
---

# Traiter une opportunité SEO

Arguments reçus : `$ARGUMENTS` → `<type> <url ou site> "<requête>"`.

## 0. Contexte (toujours)

- Search Console via `gsc_search_analytics` sur 28 jours (fin = aujourd'hui − 3 j) :
  - pour l'URL : dimensions `query`, filtre `page equals <url>`, 50 lignes ;
  - pour la requête : dimensions `page`, filtre `query equals <requête>`.
- Lire la page en ligne (title, meta, H1–H3, intro, FAQ, liens internes) avec `firecrawl scrape <url> --formats markdown` ou, à défaut, WebFetch.

## meta — CTR faible alors que la page est bien classée

1. Récupérer la SERP : `firecrawl search "<requête>" --limit 5` (pays France). Noter les titles et descriptions qui entourent la page : promesse, chiffres, année, prix, format (« guide », « comparatif »).
2. Diagnostiquer en une phrase pourquoi on clique ailleurs (title générique, pas de bénéfice, réécrit par Google, date absente, intention mal servie…).
3. Proposer **3 couples title / meta** :
   - title ≤ 60 caractères, requête au début, bénéfice concret, pas de majuscules abusives ni de clickbait ;
   - meta 140–155 caractères, réponse + preuve (tarif, distance, nombre de places…) + incitation ;
   - indiquer pour chacun la longueur en caractères.
4. **Attendre le choix d'Abdoul**, puis mettre à jour (Yoast : `_yoast_wpseo_title`, `_yoast_wpseo_metadesc` via le connecteur WordPress, ou l'outil du site).
5. `npm.cmd run indexnow -- <url>` et noter la date de modification : on mesure le CTR 14 et 28 jours après.

## contenu — page 2 (positions 11–20)

1. Lancer la skill `seo-concurrents` sur la requête (top 3 seulement) ou relire `data/concurrents/<site>.json` s'il date de moins de 30 jours.
2. Lister les écarts qui comptent : sous-sujets absents, questions de la FAQ des concurrents, données chiffrées, fraîcheur, profondeur, données structurées, médias.
3. Proposer un plan de modifications (sections à ajouter / réécrire, FAQ, tableau, maillage entrant : 3 à 9 pages du même site à faire pointer vers elle, avec ancres).
4. Après validation : rédiger les blocs, les publier en brouillon / révision, puis appliquer les liens entrants (skill `seo-maillage`).

## cannibalisation

1. Pour chaque page en concurrence : clics, impressions, position sur la requête et sur l'ensemble de ses requêtes (pour ne rien casser).
2. Recommander une seule issue : **fusionner** (301 de la plus faible vers la plus forte), **différencier** (réorienter la plus faible sur une intention voisine) ou **canonical** (variantes quasi identiques).
3. Après validation : modifications de contenu, liens internes repointés vers la page principale, redirection si fusion (à faire par Abdoul ou via le plugin de redirection du site).

## declin

1. Comparer période / période précédente par requête pour cette page : quelles requêtes ont perdu des clics, des impressions ou des positions ?
2. Vérifier : page toujours indexable (`npm.cmd run discover -- <url>` donne aussi HTTP et noindex), changements récents, nouveaux concurrents dans la SERP (`firecrawl search`), saisonnalité (même période l'an dernier).
3. Conclure par la cause la plus probable et 1 à 3 actions.

## Fin

Mettre à jour le suivi si un article est modifié :
`npm.cmd run suivi -- --site <site> --slug <slug> titre="…" requete="<requête>" etapes.redige=true`.

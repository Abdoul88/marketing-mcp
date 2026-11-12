---
name: seo-article-complet
description: Crée ou réécrit un article SEO de bout en bout pour un des sites d'Abdoul - brief à partir des concurrents (Firecrawl), rédaction optimisée, visuel aux couleurs du site, publication (WordPress, okooltrip, Strapi), post Facebook et vérification Google Discover. Arguments - le site puis le sujet ou la requête entre guillemets ; « discover <site> » lance seulement l'audit Discover.
---

# Article complet : du brief au post Facebook

Arguments : `$ARGUMENTS` → `<site> "<sujet ou requête>"` ou `discover <site>`.

Chaque étape se termine par un point de validation d'Abdoul. Ne jamais enchaîner deux publications sans « ok ».
Slug = slug de l'article ; `<site>` = URL du site (ex. `https://blog.indigoneo.fr/`).

## 1. Cadrage

- Search Console : la requête a-t-elle déjà une page sur le site ? (`gsc_search_analytics`, filtre `query contains`). Si oui, passer en mode **optimisation** de cette page.
- Volume et intention : impressions Search Console des requêtes proches ; si le compte Google Ads est lié, termes de recherche convertissants (`gads_performance` niveau `search_term`).
- `npm.cmd run suivi -- --site <site> --slug <slug> titre="…" requete="<requête>" etapes.brief=false`

## 2. Brief (validation)

Pour Indigo neo, utiliser la skill `indigo-neo-seo-nlp` si elle est disponible. Sinon :
`firecrawl search "<requête>" --limit 5`, scraper le top 3, puis produire : intention, angle différenciant, plan H2/H3, questions de FAQ, entités et lexique, données à citer (sources), liens internes entrants et sortants, CTA.
→ `etapes.brief=true`

## 3. Rédaction (validation)

- Title ≤ 60 car., meta 140–155 car., H1, chapô qui répond en 2 phrases, sections, tableau si comparatif, FAQ (schéma FAQPage), CTA, 3 à 6 liens internes, sources citées.
- Ton de la marque, faits vérifiés (tarifs et adresses à partir des pages officielles, jamais inventés), auteur identifié et date (E-E-A-T, Discover).
- Titre fidèle au contenu : pas de clickbait (Google Discover le pénalise).
→ `etapes.redige=true`

## 4. Visuel aux couleurs du site

1. Charte : si `data/charte/<hôte>.json` n'existe pas, `npm.cmd run charte -- <site>` et montrer couleurs, police et logo à Abdoul (il peut corriger le fichier).
2. `npm.cmd run visuel -- --site <site> --titre "<titre court, ≤ 70 car.>" --surtitre "<rubrique>" --slug <slug>` ; ajouter `--photo <chemin>` si Abdoul fournit une photo (une vraie photo donne de meilleurs résultats dans Discover qu'un visuel typographique).
3. Montrer les 3 images (`data/visuels/<hôte>/<slug>-discover.png`, `-facebook.png`, `-carre.png`).
→ `npm.cmd run suivi -- … visuel=visuels/<hôte>/<slug>-discover.png etapes.visuel=true`

## 5. Publication (validation obligatoire)

- Créer l'article **en brouillon** avec l'outil du site (voir la skill `seo-pilotage`), title et meta Yoast compris, catégorie, données structurées Article (auteur, datePublished, image).
- Image à la une : `npm.cmd run wordpress -- --site <site> --image data\visuels\<hôte>\<slug>-discover.png --alt "<alt>" --article <id>` (WordPress), ou l'outil du site.
- Donner le lien d'aperçu ; publier seulement après « ok ».
- `npm.cmd run indexnow -- <url>` ; liens entrants depuis 3 à 9 articles existants (skill `seo-maillage`).
→ `etapes.publie=true url=<url>`

## 6. Facebook (validation obligatoire)

1. Rédiger 2 propositions de post : accroche (question ou bénéfice), 2–3 lignes utiles, lien, 1 à 3 hashtags maximum, pas de lien raccourci.
2. Aperçu : `npm.cmd run facebook -- --lien <url> --message "<texte>"` (l'aperçu Facebook reprend l'og:image, donc le visuel 1200×630 si l'image à la une est bien définie).
   Variante visuel carré : `--image data\visuels\<hôte>\<slug>-carre.png --message "<texte avec le lien>"`.
3. Après « ok » : même commande avec `--publier`.
→ `etapes.facebook=true facebook=<url du post>`

## 7. Discover

`npm.cmd run discover -- <url>` : tout doit être ✅ (image ≥ 1200 px, max-image-preview:large, Article + auteur + date, indexable). Corriger ce qui manque.
→ `etapes.discover=true`

Rappel à donner à Abdoul si besoin : on ne peut pas « pousser » un article dans Discover. Google le propose de lui-même aux mobinautes intéressés ; on maximise les chances (sujet frais, grande image, titre honnête, expertise) et on mesure dans l'onglet Discover du dashboard.

## Mode `discover <site>`

1. `gsc_search_analytics` type `discover`, dimensions `page`, 90 jours : quelles pages sortent, avec quels sujets et quels visuels.
2. Lire `data/audits/<hôte>.json` (codes `discover_image`, `discover_preview`) ; lancer `npm.cmd run discover` sur les 10 pages les plus récentes.
3. Restituer : conditions techniques manquantes (avec correction), types de sujets qui marchent, et 5 idées d'articles adaptées à Discover (actualité du secteur, saison, guides visuels).

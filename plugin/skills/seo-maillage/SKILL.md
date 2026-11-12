---
name: seo-maillage
description: Planifie et applique le maillage interne d'un site - liens entrants vers les pages à pousser (page 2, pages stratégiques), pages orphelines, ancres variées, blocs « À lire aussi ». Argument - le site, et éventuellement les URL cibles.
---

# Maillage interne

Argument : `$ARGUMENTS` → `<site> [url-cible …]`.

Méthode déjà éprouvée sur blog.indigoneo.fr (novembre 2026, `exports/seo-2026/maillage/` : `crawl.mjs`, `plan-9.mjs`, `rapport-9.mjs`) : la réutiliser plutôt que repartir de zéro.

1. **Cibles** : celles fournies, sinon les pages en page 2 et les pages qui convertissent (Search Console + onglet Opportunités du dashboard). 15 cibles maximum par passe.
2. **Inventaire** : exporter les contenus publiés (API REST WordPress `wp-json/wp/v2/posts?_fields=id,slug,link,title,content`, ou le connecteur du site) et compter les liens entrants actuels de chaque cible.
3. **Sources pertinentes** : pour chaque cible, les pages du même thème, de la même ville ou de la même intention, qui ont elles-mêmes des impressions (une source sans trafic transmet peu).
4. **Plan** : objectif 9 sources différentes par cible, 4 liens ajoutés maximum par page source, ancres descriptives et variées (pas toujours la requête exacte), lien placé dans un paragraphe pertinent de préférence, sinon un bloc « À lire aussi » en fin d'article.
5. Présenter le plan (tableau source → cible → ancre → emplacement) et **attendre la validation**.
6. Appliquer via le connecteur du site en remplaçant un passage précis (jamais de réécriture complète d'un article pour ajouter un lien), sauvegarder l'original dans `exports/<site>/maillage/`.
7. Vérifier : recompter les liens entrants, puis `npm.cmd run indexnow -- <sources modifiées>`.

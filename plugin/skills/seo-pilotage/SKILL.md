---
name: seo-pilotage
description: Point d'entrée du pilotage SEO multi-sites d'Abdoul (blog.indigoneo.fr, okooltrip.fr, fegn-seo.com, abdoul-doro-seo-confirme.fr…). Utiliser pour toute question de performance SEO/SEA d'un site, pour choisir quoi optimiser en priorité, ou quand une commande copiée depuis le dashboard « Pilote SEO » arrive. Oriente vers la bonne skill (opportunités, concurrents, technique, maillage, article complet).
---

# Pilote SEO

Le projet `marketing-mcp` réunit trois briques gratuites :

| Brique | Rôle | Où |
|---|---|---|
| Serveur MCP `marketing-mcp` | Lit Search Console, Google Ads et Bing Webmaster (lecture seule) | outils `gsc_*`, `gads_*`, `bing_*` |
| Dashboard local | Visualise et priorise ; chaque ligne donne une commande à coller ici | `npm.cmd run dashboard` → http://127.0.0.1:4321 |
| Scripts | Charte, visuels, WordPress, Facebook, Discover, IndexNow, suivi | `npm.cmd run <script>` (voir [references/scripts.md](references/scripts.md)) |

Les commandes se lancent depuis le dossier du projet (`C:\Users\adiallo3\marketing-mcp`). Sous Windows, toujours `npm.cmd`, jamais `npm`.

## Choisir la skill

| Demande | Skill |
|---|---|
| CTR faible, page 2, cannibalisation, page en déclin | `seo-opportunites` |
| « Que font mieux les concurrents ? », comparaison title/meta/Hn/contenu | `seo-concurrents` |
| Erreurs 4xx/5xx, noindex, titles, canonical, vitesse, Discover technique | `seo-technique` |
| Liens internes, pages orphelines | `seo-maillage` |
| Créer ou réécrire un article, visuel, Facebook, Discover | `seo-article-complet` |

Pour une question ouverte (« où en est okooltrip ? ») : interroge d'abord les données (`gsc_search_analytics` période vs période précédente, `bing_traffic`, éventuellement `gads_performance`), résume en 5 lignes, puis propose les 3 actions au meilleur rapport gain/effort.

## Règles

1. **Les chiffres viennent des outils**, jamais de la mémoire. Les 2–3 derniers jours de Search Console sont incomplets : arrête les périodes 3 jours avant aujourd'hui.
2. **Rien n'est publié sans validation explicite d'Abdoul** : article, meta, lien interne, image à la une, post Facebook. Montre l'avant / après, puis attends « ok ».
3. **Pas de service payant.** Firecrawl : offre gratuite, donc limiter les scrapes (top 3 de la SERP, pas plus) et réutiliser ce qui est déjà dans `exports/` ou `data/`.
4. **Une page = une intention.** Avant de créer un contenu, vérifier dans Search Console qu'aucune page du site ne cible déjà la requête (sinon : optimiser celle-ci).
5. Pour **Indigo neo**, si la skill `indigo-neo-seo-nlp` est disponible, l'utiliser pour le brief et la rédaction (elle impose sa validation étape par étape).
6. Tenir le suivi à jour (`npm.cmd run suivi …`) : c'est ce qu'affiche l'onglet « Contenu & social » du dashboard.

## Publier selon le site

| Site | Outil de publication |
|---|---|
| blog.indigoneo.fr | connecteur WordPress du blog (outils `wp_*`), sinon `npm.cmd run wordpress` pour les images |
| okooltrip.fr | connecteur « Rédaction okooltrip » (`create_article_draft`, `update_article_draft`…) |
| fegn-seo.com (Strapi) | script `exports/fegn/publish.mjs` (sauvegarde `backup-*.json` avant toute modification) |
| abdoul-doro-seo-confirme.fr | connecteur WordPress de ce site |

Toujours publier en **brouillon** d'abord quand l'outil le permet, et donner le lien d'aperçu.

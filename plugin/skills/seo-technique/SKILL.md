---
name: seo-technique
description: Corrige les problèmes techniques SEO relevés par l'audit du dashboard Pilote SEO ou par Bing Webmaster (erreurs HTTP, redirections dans le sitemap, noindex, title et meta manquants ou trop longs, H1, canonical, contenu mince, alt d'images, conditions Discover, lenteur). Arguments - le site puis le code du problème (ex. title_long, discover_preview).
---

# Corriger un problème technique

Arguments : `$ARGUMENTS` → `<site> <code>`.

1. Lire `data/audits/<site>.json` (hôte sans www) : prendre le problème `<code>` et sa liste d'URL. Si l'audit a plus de 7 jours, le signaler et proposer de le relancer depuis le dashboard.
2. Compléter avec Bing : `bing_crawl_stats` (tendance 4xx/5xx, pages bloquées par robots.txt).
3. Grouper les URL par cause (même gabarit, même catégorie, même plugin) : souvent une seule correction de modèle règle des dizaines de pages.
4. Proposer la correction, page par page ou au niveau du modèle :

| Code | Correction type |
|---|---|
| `erreur_http` | Restaurer la page, ou 301 vers la page la plus proche, et la retirer du sitemap |
| `redirection` | Mettre l'URL finale dans le sitemap et dans les liens internes |
| `noindex` | Vérifier que c'est volontaire ; sinon retirer le noindex (Yoast → Avancé) |
| `title_*`, `meta_*` | Réécrire (≤ 60 et 140–155 caractères), voir la skill `seo-opportunites` mode meta pour les pages qui ont du trafic |
| `title_duplique` | Différencier chaque title selon l'intention de la page |
| `h1` | Un seul H1, proche du title |
| `canonical` | Canonical auto-référente, sauf variante voulue |
| `contenu_mince` | Enrichir, fusionner ou passer en noindex selon la valeur de la page (vérifier ses clics dans Search Console) |
| `maillage_faible` | Skill `seo-maillage` |
| `images_alt` | Rédiger des alt descriptifs (pas de bourrage de mots-clés) |
| `discover_preview` | Ajouter `max-image-preview:large` à la balise robots (Yoast le fait par défaut ; sinon dans le thème) |
| `discover_image` | Définir une image à la une ≥ 1200 px : `npm.cmd run visuel` puis `npm.cmd run wordpress` |
| `lenteur` | Cache de page, images WebP, scripts différés ; mesurer avec PageSpeed Insights (gratuit) |
| `sitemap` | Activer le sitemap (Yoast / WordPress) et le déclarer dans robots.txt et Search Console |

5. **Appliquer seulement après validation**, en brouillon ou révision quand l'outil le permet. Les modifications de thème, de serveur ou de redirection sont rédigées comme une consigne pour Abdoul ou le développeur.
6. Relancer l'audit dans le dashboard pour vérifier, puis `npm.cmd run indexnow -- <urls corrigées>`.

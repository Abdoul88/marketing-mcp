---
name: seo-concurrents
description: Compare les pages d'un site à celles du top 3 Google sur ses requêtes principales avec Firecrawl (offre gratuite) - title, meta description, Hn, longueur, FAQ, données structurées, liens internes, fraîcheur - et enregistre le résultat pour l'onglet Concurrents du dashboard. Argument - le site (et éventuellement une requête).
---

# Analyse concurrentielle

Argument : `$ARGUMENTS` → `<site> ["requête"]`.

## 1. Choisir les requêtes (5 à 10)

Sans requête fournie : `gsc_search_analytics` sur 28 jours, dimensions `query` + `page`, puis garder les requêtes à fort potentiel : impressions élevées et position entre 3 et 20, une requête par page. Les présenter à Abdoul avant de consommer des crédits Firecrawl.

## 2. Collecter (économiser les crédits)

Pour chaque requête :
- `firecrawl search "<requête>" --limit 5` → garder les 3 premiers résultats organiques qui ne sont pas le site lui-même (ignorer annuaires et forums sauf s'ils dominent la SERP) ;
- `firecrawl scrape <url> --formats markdown,links` pour ces 3 pages et pour la page du site ;
- enregistrer les fichiers bruts dans `exports/<site>/serp/` pour ne pas rescraper.

## 3. Comparer

Pour chaque requête, mesurer chez soi et chez chacun des 3 :
title (longueur, requête présente, promesse), meta description, H1, liste des H2/H3, nombre de mots, FAQ (et schéma FAQPage), tableaux / chiffres, images, données structurées, date de mise à jour visible, nombre de liens internes, angle et intention.

En déduire les **écarts actionnables** (5 maximum par requête), formulés comme des actions : « Ajouter une section tarifs avec tableau (3/3 concurrents) », « Title sans bénéfice ni année », « Aucun lien vers la page abonnement »…

## 4. Enregistrer pour le dashboard

Écrire `data/concurrents/<site>.json` (`<site>` = hôte sans www) :

```json
{
  "date": "2026-11-12T10:00:00.000Z",
  "site": "https://blog.indigoneo.fr/",
  "requetes": [
    {
      "requete": "parking gare de lyon",
      "maPage": "https://blog.indigoneo.fr/parking-gare-de-lyon/",
      "maPosition": 6.3,
      "mesMots": 1200,
      "motsTop3": 2100,
      "concurrents": [{ "url": "https://…", "title": "…", "mots": 2300 }],
      "ecarts": ["…", "…"]
    }
  ]
}
```

`motsTop3` = moyenne des 3 concurrents. Puis résumer à Abdoul les 3 requêtes où l'écart est le plus facile à combler, avec la commande `/seo-pilote:seo-opportunites contenu <url> "<requête>"`.

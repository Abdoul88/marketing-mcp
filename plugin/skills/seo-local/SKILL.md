---
name: seo-local
description: Met à jour la visibilité locale du dashboard Pilote SEO à partir du MCP Yext (fiches Google Business Profile) - vues, itinéraires, appels, clics vers le site par mois, état des fiches Google, fiches sans page de destination - et l'enregistre dans data/yext/<site>.json. Argument - le site (ex. https://www.indigoneo.fr/).
---

# Visibilité locale (Yext → dashboard)

Le dashboard lit `data/yext/<domaine>.json` (onglet « Visibilité locale ») et rapproche chaque fiche de sa page
par l'URL : toute URL avec un paramètre `utm_` vient d'une fiche Google, ce que Search Console isole page par page ; ces URL sont exclues des analyses organiques.

## Étapes

1. `accounts__listAccounts` → `accountUid` (compte Indigo Group : 100004577).
2. `listings_insights__GetListingsInsights` avec `insight_names: ["GOOGLE_ENGAGEMENT_IMPRESSIONS", "GOOGLE_ENGAGEMENT_CLICKS_BY_ACTION_OVER_TIME"]`
   et `filter.date_range` sur les 13 derniers mois complets → une ligne par mois : impressions, `Driving Directions`
   (itinéraires), `Website` (clics site), `Tap to Call` (appels).
3. `listings__listListings` avec `publisherIds: "GOOGLEMYBUSINESS"` et `limit: 1`, une fois avec `statuses: "LIVE"`,
   une fois avec les autres statuts : lire seulement `response.count`.
4. `entities__listEntities` avec `entityTypes: "location"`, `limit: 1`, `fields: "meta.id"` et les filtres
   `c_status = ACTIVE`, puis `ACTIVE` sans `landingPageUrl`, puis `ACTIVE` sans `googlePlaceId` : lire `count`.
5. Fiches sans page : même requête avec `limit: 50` et `fields: "name,address"` ; garder les parkings (pas les
   « Borne de Recharge »), avec `id`, `nom`, `ville`.
6. Écrire le fichier au format existant (`source`, `date`, `fiches`, `google`, `utm`, `mensuel`, `fichesSansPage`, `note`),
   puis rafraîchir le dashboard.

Ne jamais modifier les fiches : ce skill ne fait que lire.

## Classement local (Yext Scout)

7. `scout__GetBusinessWeekIds` → dernière semaine scannée.
8. `scout__GetMetricsByBrandName` avec `include_me: true`, `limit: 3` et les métriques
   `GOOGLE_PROFILE_RANK_WITH_UNRANKED`, `GOOGLE_PROFILE_RANK_WITHOUT_UNRANKED`, `GOOGLE_PROFILE_UNIQUE_SEARCH_APPEARANCE_COUNT`,
   `GOOGLE_PROFILE_UNIQUE_SEARCH_COUNT`, `UNIQUE_LOCATION_COUNT`, `GOOGLE_PROFILE_RATING_ALL_TIME`, `GOOGLE_CORE_PROFILE_COMPLETENESS`
   → bloc `scout.marque` (ligne « INDIGO Group »). Ne pas reprendre le classement des marques concurrentes : il mélange
   des enseignes sans rapport.
9. `scout__GetMetricOverTime` (`GOOGLE_PROFILE_RANK_WITH_UNRANKED`, `MONTHS`, sans benchmark) → `scout.rangMensuel`.
10. `scout__GetMarketWinRates` avec `dimensions: ["MARKET_WIN_RATE_DIMENSION_MONTH"]` → `scout.tauxVictoire`
    (`serpWinRate`, `aiWinRate`, `overallWinRate`, `locationCount`).
11. `scout__GetLocationMetrics` (`ONLY_ME`, tri `GOOGLE_PROFILE_RANK_WITH_UNRANKED` décroissant, `limit: 25`) → garder les
    parkings (pas les bornes) au rang 41, puis `entities__listEntities` filtré sur leurs noms (`fields: "name,landingPageUrl"`)
    pour l'URL → `scout.parkingsAbsents`. Signaler une URL de destination qui n'est pas une page parking.

## Actions par éditeur (vue d'ensemble de la visibilité locale)

La vue « Visibilité locale » repose sur les actions Yext, pas sur Search Console. Pour le dernier mois complet et le
même mois N-1 :

12. `GetListingsInsights` avec `insight_names: ["ACTIONS_BY_PUBLISHER", "IMPRESSIONS_BY_PUBLISHER"]` et `date_range` →
    actions et vues par éditeur (Google Business Profile, Apple, Bing, annuaires).
13. Même appel `ACTIONS_BY_PUBLISHER` avec `filter.action` = `["DRIVING_DIRECTIONS"]`, puis `["WEBSITE"]`, puis
    `["TAP_TO_CALL"]` → itinéraires, clics site et appels par éditeur.
14. Apple : `APPLE_ENGAGEMENT_IMPRESSIONS` (vues de la fiche Plans, une ligne par jour) à additionner sur le mois.
15. Écrire `parEditeur` : `{ mois, moisN1, remarque, editeurs: [{ nom, vues, vuesN1, itineraires, itinerairesN1,
    siteWeb, siteWebN1, appels, appelsN1, actions, actionsN1 }] }` avec Google, Apple Plans, Bing et « Autres annuaires »
    (somme des annuaires).

Le MCP Yext ne fournit pas la répartition Google Search / Google Maps des vues (filtres SEARCH, MAPS, DESKTOP_MAPS…
sans résultat) : Google reste agrégé. Éviter les insights au jour (`TOTAL_ENGAGEMENT_CLICKS_BY_ACTION`) : réponses très lourdes.

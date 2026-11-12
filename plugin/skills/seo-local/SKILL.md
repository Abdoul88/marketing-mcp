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

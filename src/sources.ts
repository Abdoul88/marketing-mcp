// Catalogue des sources prises en charge.
// Une source reste "not_configured" tant que son connecteur n'est pas
// implémenté ET testé avec un vrai compte : on ne prétend jamais le contraire.
// Search Console et Google Ads passent à "configured" dans server.ts une fois un compte autorisé,
// Bing Webmaster une fois sa clé API renseignée.

export const SOURCE_IDS = [
  "google_search_console",
  "ga4",
  "google_ads",
  "meta_ads",
  "bing_webmaster",
] as const;

export type SourceId = (typeof SOURCE_IDS)[number];

export type SourceStatus = "not_configured" | "configured" | "error";

export interface SourceInfo {
  id: SourceId;
  name: string;
  status: SourceStatus;
  auth: string;
  access: string;
  documentationUrl: string;
}

export const SOURCES: readonly SourceInfo[] = [
  {
    id: "google_search_console",
    name: "Google Search Console",
    status: "not_configured",
    auth: "OAuth 2.0 Google (scope webmasters.readonly)",
    access: "API gratuite, dans les limites de quota.",
    documentationUrl:
      "https://developers.google.com/webmaster-tools/v1/searchanalytics/query",
  },
  {
    id: "ga4",
    name: "Google Analytics 4",
    status: "not_configured",
    auth: "OAuth 2.0 Google (scope analytics.readonly)",
    access: "API gratuite, dans les limites de quota par propriété.",
    documentationUrl:
      "https://developers.google.com/analytics/devguides/reporting/data/v1",
  },
  {
    id: "google_ads",
    name: "Google Ads",
    status: "not_configured",
    auth: "OAuth 2.0 Google (scope adwords ; lecture seule garantie par le serveur)",
    access:
      "API sans frais ; le projet Google Cloud doit avoir l'accès Explorer (ou plus) pour lire les comptes réels.",
    documentationUrl: "https://developers.google.com/google-ads/api/docs/start",
  },
  {
    id: "meta_ads",
    name: "Meta Ads",
    status: "not_configured",
    auth: "Application Meta + jeton d'accès (permission ads_read)",
    access:
      "API sans frais ; permissions et éventuelle revue d'application Meta.",
    documentationUrl:
      "https://developers.facebook.com/docs/marketing-api/insights",
  },
  {
    id: "bing_webmaster",
    name: "Bing Webmaster Tools",
    status: "not_configured",
    auth: "Clé API Bing Webmaster (BING_API_KEY)",
    access: "API gratuite ; la clé se génère dans Bing Webmaster → Paramètres → Accès API.",
    documentationUrl:
      "https://learn.microsoft.com/en-us/bingwebmaster/getting-access",
  },
];

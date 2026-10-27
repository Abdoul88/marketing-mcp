# Outils MCP

Tous les outils sont en lecture seule. Chacun renvoie un résultat structuré (`structuredContent`)
et le même contenu en JSON texte. En cas d'erreur, le message explique la marche à suivre.

## `marketing_list_sources`

Liste les sources prises en charge et leur état. N'appelle aucune API externe.

- Entrée : aucune
- Sortie : `sources[]` avec `id`, `name`, `status` (`configured` / `not_configured` / `error`),
  `auth`, `access`, `documentationUrl`

Une source passe à `configured` seulement quand un compte réel l'a autorisée (refresh token
enregistré avec le bon scope).

---

## Google Search Console

### `gsc_list_sites`

Liste les propriétés accessibles au compte Google autorisé.

- Entrée : aucune
- Sortie : `sites[]` avec `siteUrl`, `permissionLevel`, `allowed` (présente dans `GSC_SITE_URLS`)

### `gsc_search_analytics`

Clics, impressions, CTR et position moyenne d'une propriété sur une période.

| Paramètre | Obligatoire | Description |
|---|---|---|
| `siteUrl` | oui | Propriété exactement comme dans Search Console (`https://www.exemple.fr/`, `sc-domain:exemple.fr`) |
| `startDate`, `endDate` | oui | `AAAA-MM-JJ`, bornes incluses |
| `dimensions` | non | `date`, `query`, `page`, `country`, `device`, `searchAppearance`. Vide = totaux de la période |
| `type` | non | `web` (défaut), `image`, `video`, `news`, `discover`, `googleNews` |
| `filters` | non | Liste de `{ dimension, operator, expression }`, combinés en ET. Dimensions : `query`, `page`, `country`, `device`. Opérateurs : `equals`, `notEquals`, `contains`, `notContains`, `includingRegex`, `excludingRegex` |
| `rowLimit` | non | 1 à 25 000, défaut 100 |
| `startRow` | non | Pagination, défaut 0 |

Sortie : `siteUrl`, `rowCount`, `rows[]` avec `keys` (valeurs des dimensions), `clicks`,
`impressions`, `ctr` (0 à 1), `position`.

Les 2 à 3 derniers jours peuvent être incomplets.

Exemple — top 10 des requêtes en France sur mobile :

```json
{
  "siteUrl": "https://www.exemple.fr/",
  "startDate": "2026-09-01",
  "endDate": "2026-09-30",
  "dimensions": ["query"],
  "filters": [
    { "dimension": "country", "operator": "equals", "expression": "fra" },
    { "dimension": "device", "operator": "equals", "expression": "MOBILE" }
  ],
  "rowLimit": 10
}
```

---

## Google Ads

Les IDs de compte s'écrivent avec ou sans tirets (`123-456-7890` ou `1234567890`).
`loginCustomerId` (facultatif partout) est l'ID du compte administrateur (MCC) par lequel passer ;
à défaut, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`.

### `gads_list_customers`

Liste les comptes accessibles, plus les comptes clients directs de chaque MCC.

- Entrée : aucune
- Sortie : `customers[]` avec `customerId`, `name`, `currency`, `timeZone`, `manager`,
  `testAccount`, `status`, `managerId` (MCC à passer en `loginCustomerId` pour ce compte),
  `allowed` (présent dans `GOOGLE_ADS_CUSTOMER_IDS`), `error` (si ce compte n'a pas pu être lu)

Coût : 1 à 2 opérations API par compte accessible.

### `gads_performance`

Rapport prêt à l'emploi : impressions, clics, coût, conversions, valeur de conversion, CTR et
CPC moyen.

| Paramètre | Obligatoire | Description |
|---|---|---|
| `customerId` | oui | Compte à interroger |
| `startDate`, `endDate` | oui | `AAAA-MM-JJ`, bornes incluses |
| `level` | non | `account`, `campaign` (défaut), `ad_group`, `keyword`, `search_term` |
| `segmentByDate` | non | Une ligne par jour, défaut `false` |
| `limit` | non | 1 à 10 000, défaut 100 |
| `loginCustomerId` | non | MCC par lequel passer |

Sortie : `customerId`, `level`, `currency`, `rowCount`, `truncated` (d'autres lignes existent
au-delà de `limit`), `rows[]` avec :

- `dimensions` : selon le niveau — `accountId`/`account` ; `campaignId`/`campaign`/`campaignStatus`/`channel` ;
  `campaign`/`adGroupId`/`adGroup`/`adGroupStatus` ; `campaign`/`adGroup`/`keyword`/`matchType` ;
  `campaign`/`adGroup`/`searchTerm` ; plus `date` si `segmentByDate`
- `impressions`, `clicks`, `cost` (devise du compte), `conversions`, `conversionsValue`,
  `ctr` (0 à 1), `averageCpc`

Seules les lignes avec des impressions sont renvoyées, triées par coût décroissant.

Exemple — 50 termes de recherche les plus coûteux du mois :

```json
{
  "customerId": "123-456-7890",
  "startDate": "2026-09-01",
  "endDate": "2026-09-30",
  "level": "search_term",
  "limit": 50
}
```

### `gads_search`

Requête GAQL libre (Google Ads Query Language) pour tout ce que `gads_performance` ne couvre pas.

| Paramètre | Obligatoire | Description |
|---|---|---|
| `customerId` | oui | Compte à interroger |
| `query` | oui | Requête GAQL, `SELECT` uniquement |
| `maxRows` | non | 1 à 50 000, défaut 1 000 |
| `loginCustomerId` | non | MCC par lequel passer |

Sortie : `customerId`, `rowCount`, `truncated`, `rows[]` aplaties en camelCase
(`campaign.name`, `metrics.costMicros`…). Les entiers 64 bits arrivent en chaînes ;
`costMicros` = coût × 1 000 000.

Référence des champs : https://developers.google.com/google-ads/api/fields/

Exemple — budget quotidien et stratégie d'enchères des campagnes actives :

```json
{
  "customerId": "123-456-7890",
  "query": "SELECT campaign.name, campaign_budget.amount_micros, campaign.bidding_strategy_type FROM campaign WHERE campaign.status = 'ENABLED'"
}
```

---

## Bing Webmaster Tools

Authentification par clé API (`BING_API_KEY`). `BING_SITE_URLS` restreint les sites accessibles ;
un site absent de la liste est refusé sans appel à l'API. Bing fournit environ 16 mois d'historique (constaté le 2026-10-27). Bing ne fournit plus la position moyenne des clics (toujours `-1`) : `avgClickPosition` vaut donc `null` ; `avgImpressionPosition` reste fiable.

### `bing_list_sites`

- Entrée : aucune
- Sortie : `sites[]` avec `siteUrl`, `verified`, `allowed` (présent dans `BING_SITE_URLS`)

### `bing_traffic`

Clics et impressions Bing par jour, avec les totaux de la période.

| Paramètre | Obligatoire | Description |
|---|---|---|
| `siteUrl` | oui | Site exactement comme dans Bing Webmaster |
| `startDate`, `endDate` | non | `AAAA-MM-JJ`, bornes incluses ; défaut : tout l'historique |

Sortie : `totals` (`clicks`, `impressions`, `ctr`), `firstDate`, `lastDate`, `rows[]` (`date`, `clicks`, `impressions`).

### `bing_top`

Requêtes ou pages, cumulées sur la période (Bing les fournit par semaine).

| Paramètre | Obligatoire | Description |
|---|---|---|
| `siteUrl` | oui | Site exactement comme dans Bing Webmaster |
| `kind` | non | `query` (défaut) ou `page` |
| `startDate`, `endDate` | non | Appliquées au début de chaque semaine |
| `contains` | non | Texte à chercher dans la requête ou l'URL (sans casse) |
| `limit` | non | 1 à 5 000, défaut 100 |

Sortie : `rows[]` triées par clics avec `key`, `clicks`, `impressions`, `ctr`, `avgClickPosition`,
`avgImpressionPosition` (moyennes pondérées ; `null` sans clic ou sans impression), `weeks`.

### `bing_crawl_stats`

Exploration par jour : `crawledPages`, `crawlErrors`, `inIndex`, `inLinks`, `blockedByRobotsTxt`,
`code4xx`, `code5xx`. Paramètres : `siteUrl`, `startDate`, `endDate` (facultatives).

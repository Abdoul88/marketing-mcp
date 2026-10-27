import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { aggregateKeyStats, type BingWebmasterClient } from "./bing.js";
import { normalizeCustomerId, type BingConfig, type GoogleAdsConfig, type GoogleConfig } from "./config.js";
import {
  buildPerformanceQuery,
  GADS_LEVELS,
  toPerformanceRows,
  type FlatRow,
  type GoogleAdsClient,
} from "./google-ads.js";
import { AUTH_COMMAND, GOOGLE_ADS_SCOPE, type GoogleAuth } from "./google-auth.js";
import {
  GSC_DIMENSIONS,
  GSC_FILTER_OPERATORS,
  GSC_SEARCH_TYPES,
  type SearchConsoleClient,
} from "./gsc.js";
import { SOURCE_IDS, SOURCES, type SourceInfo } from "./sources.js";

const sourceSchema = z.object({
  id: z.enum(SOURCE_IDS),
  name: z.string(),
  status: z.enum(["not_configured", "configured", "error"]),
  auth: z.string(),
  access: z.string(),
  documentationUrl: z.string(),
});

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Format attendu : AAAA-MM-JJ");

const gscRowSchema = z.object({
  keys: z.array(z.string()).optional(),
  clicks: z.number(),
  impressions: z.number(),
  ctr: z.number(),
  position: z.number(),
});

export interface ServerDeps {
  google?: {
    config: GoogleConfig;
    auth: GoogleAuth;
    gsc: SearchConsoleClient;
    adsConfig: GoogleAdsConfig;
    ads: GoogleAdsClient;
  };
  bing?: {
    config: BingConfig;
    client: BingWebmasterClient;
  };
}

const bingSiteInput = z
  .string()
  .describe("Site exactement comme dans Bing Webmaster, ex. https://www.exemple.fr/ (voir bing_list_sites)");
const optionalDate = (what: string) => isoDate.optional().describe(`${what} (AAAA-MM-JJ) ; défaut : tout l'historique fourni par Bing`);

const customerIdInput = z
  .string()
  .describe("ID du compte Google Ads, avec ou sans tirets (ex. 123-456-7890)");
const loginCustomerIdInput = z
  .string()
  .optional()
  .describe(
    "ID du compte administrateur (MCC) par lequel passer, si le compte en dépend. " +
      "Défaut : GOOGLE_ADS_LOGIN_CUSTOMER_ID (.env). gads_list_customers l'indique (managerId).",
  );

const CUSTOMER_QUERY =
  "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, " +
  "customer.manager, customer.test_account FROM customer";
const CHILD_QUERY =
  "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, " +
  "customer_client.time_zone, customer_client.manager, customer_client.test_account, " +
  "customer_client.status FROM customer_client WHERE customer_client.level = 1";

interface CustomerEntry {
  customerId: string;
  name?: string;
  currency?: string;
  timeZone?: string;
  manager?: boolean;
  testAccount?: boolean;
  status?: string;
  managerId?: string;
  allowed: boolean;
  error?: string;
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const server = new McpServer({ name: "marketing-mcp", version: "0.1.0" });

  function requireGoogle(): NonNullable<ServerDeps["google"]> {
    if (!deps.google) {
      throw new Error(
        "Google n'est pas configuré : ajoute GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env.",
      );
    }
    return deps.google;
  }

  // Vérifié avant tout appel : une autorisation faite pour Search Console seule
  // n'inclut pas Google Ads, et Google répondrait par une erreur peu lisible.
  async function requireAds(): Promise<NonNullable<ServerDeps["google"]>> {
    const google = requireGoogle();
    if (!(await google.auth.hasRefreshToken())) {
      throw new Error(`Compte Google non autorisé. Lance « ${AUTH_COMMAND} » dans le dossier du projet.`);
    }
    if (!(await google.auth.hasScope(GOOGLE_ADS_SCOPE))) {
      throw new Error(
        `L'autorisation Google actuelle n'inclut pas Google Ads. Relance « ${AUTH_COMMAND} » ` +
          "et coche l'accès Google Ads, puis redémarre la session.",
      );
    }
    return google;
  }

  function resolveCustomer(google: NonNullable<ServerDeps["google"]>, raw: string): string {
    const id = normalizeCustomerId(raw);
    if (!id) throw new Error(`ID de compte Google Ads invalide : « ${raw} » (10 chiffres attendus).`);
    if (!isAllowedCustomer(google.adsConfig, id)) {
      throw new Error(
        `Compte Google Ads non autorisé : ${id}. Comptes autorisés (GOOGLE_ADS_CUSTOMER_IDS) : ` +
          google.adsConfig.customerIds.join(", "),
      );
    }
    return id;
  }

  function resolveLogin(raw: string | undefined): string | undefined {
    if (raw === undefined || raw.trim() === "") return undefined;
    const id = normalizeCustomerId(raw);
    if (!id) throw new Error(`loginCustomerId invalide : « ${raw} » (10 chiffres attendus).`);
    return id;
  }

  // Une source est « configured » seulement si les identifiants sont présents
  // ET qu'un compte Google réel l'a autorisée (refresh token avec le bon scope).
  async function listSources(): Promise<SourceInfo[]> {
    const gscReady = deps.google
      ? await deps.google.auth.hasRefreshToken()
      : false;
    const adsReady = deps.google
      ? await deps.google.auth.hasScope(GOOGLE_ADS_SCOPE)
      : false;
    const bingReady = deps.bing !== undefined;
    return SOURCES.map((s) =>
      (s.id === "google_search_console" && gscReady) ||
      (s.id === "google_ads" && adsReady) ||
      (s.id === "bing_webmaster" && bingReady)
        ? { ...s, status: "configured" }
        : { ...s },
    );
  }

  function requireBing(siteUrl?: string): NonNullable<ServerDeps["bing"]> {
    if (!deps.bing) {
      throw new Error(
        "Bing Webmaster n'est pas configuré : ajoute BING_API_KEY dans .env " +
          "(Bing Webmaster → Paramètres → Accès API → Générer), puis redémarre la session.",
      );
    }
    if (siteUrl !== undefined && !isAllowedBingSite(deps.bing.config, siteUrl)) {
      throw new Error(
        `Site non autorisé : ${siteUrl}. Sites autorisés (BING_SITE_URLS) : ` +
          deps.bing.config.siteUrls.join(", "),
      );
    }
    return deps.bing;
  }

  function checkRange(startDate?: string, endDate?: string): (date: string) => boolean {
    if (startDate && endDate && startDate > endDate) throw new Error("startDate doit précéder endDate.");
    return (date) => (!startDate || date >= startDate) && (!endDate || date <= endDate);
  }

  server.registerTool(
    "marketing_list_sources",
    {
      title: "Lister les sources marketing",
      description:
        "Liste les sources de données prises en charge et leur état de configuration. " +
        "N'appelle aucune API externe.",
      inputSchema: z.object({}),
      outputSchema: z.object({ sources: z.array(sourceSchema) }),
    },
    async () => {
      const output = { sources: await listSources() };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "gsc_list_sites",
    {
      title: "Search Console : lister les propriétés",
      description:
        "Liste les propriétés Search Console accessibles au compte Google autorisé. " +
        "« allowed » indique si la propriété figure dans GSC_SITE_URLS (.env).",
      inputSchema: z.object({}),
      outputSchema: z.object({
        sites: z.array(
          z.object({
            siteUrl: z.string(),
            permissionLevel: z.string(),
            allowed: z.boolean(),
          }),
        ),
      }),
    },
    async () => {
      const google = requireGoogle();
      const sites = (await google.gsc.listSites()).map((s) => ({
        siteUrl: s.siteUrl,
        permissionLevel: s.permissionLevel,
        allowed: isAllowedSite(google.config, s.siteUrl),
      }));
      const output = { sites };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "gsc_search_analytics",
    {
      title: "Search Console : performances de recherche",
      description:
        "Interroge les performances Search Console (clics, impressions, CTR, position) " +
        "d'une propriété sur une période, avec dimensions et filtres optionnels. " +
        "Les données récentes (2-3 derniers jours) peuvent être incomplètes.",
      inputSchema: z.object({
        siteUrl: z
          .string()
          .describe(
            "Propriété exactement comme dans Search Console, ex. https://www.exemple.fr/ ou sc-domain:exemple.fr",
          ),
        startDate: isoDate.describe("Date de début incluse (AAAA-MM-JJ)"),
        endDate: isoDate.describe("Date de fin incluse (AAAA-MM-JJ)"),
        dimensions: z
          .array(z.enum(GSC_DIMENSIONS))
          .optional()
          .describe("Regroupement des lignes ; vide = totaux de la période"),
        type: z.enum(GSC_SEARCH_TYPES).optional().describe("Défaut : web"),
        filters: z
          .array(
            z.object({
              dimension: z.enum(["query", "page", "country", "device"]),
              operator: z.enum(GSC_FILTER_OPERATORS),
              expression: z.string(),
            }),
          )
          .optional()
          .describe("Filtres combinés en ET"),
        rowLimit: z.number().int().min(1).max(25_000).optional().describe("Défaut : 100"),
        startRow: z.number().int().min(0).optional().describe("Pagination, défaut : 0"),
      }),
      outputSchema: z.object({
        siteUrl: z.string(),
        rowCount: z.number(),
        rows: z.array(gscRowSchema),
      }),
    },
    async ({ siteUrl, ...query }) => {
      const google = requireGoogle();
      if (!isAllowedSite(google.config, siteUrl)) {
        throw new Error(
          `Propriété non autorisée : ${siteUrl}. Propriétés autorisées (GSC_SITE_URLS) : ` +
            (google.config.siteUrls.join(", ") || "aucune"),
        );
      }
      const rows = await google.gsc.query(siteUrl, query);
      const output = { siteUrl, rowCount: rows.length, rows };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "gads_list_customers",
    {
      title: "Google Ads : lister les comptes",
      description:
        "Liste les comptes Google Ads accessibles au compte Google autorisé, avec les comptes " +
        "clients des comptes administrateurs (MCC). « managerId » est l'ID à passer en " +
        "loginCustomerId pour interroger un compte client. « allowed » indique si le compte " +
        "figure dans GOOGLE_ADS_CUSTOMER_IDS (.env).",
      inputSchema: z.object({}),
      outputSchema: z.object({
        customers: z.array(
          z.object({
            customerId: z.string(),
            name: z.string().optional(),
            currency: z.string().optional(),
            timeZone: z.string().optional(),
            manager: z.boolean().optional(),
            testAccount: z.boolean().optional(),
            status: z.string().optional(),
            managerId: z.string().optional(),
            allowed: z.boolean(),
            error: z.string().optional(),
          }),
        ),
      }),
    },
    async () => {
      const google = await requireAds();
      const customers: CustomerEntry[] = [];
      const seen = new Set<string>();
      for (const id of await google.ads.listAccessibleCustomers()) {
        if (seen.has(id)) continue;
        seen.add(id);
        const allowed = isAllowedCustomer(google.adsConfig, id);
        try {
          // Accès direct : le compte sert lui-même de login-customer-id.
          const { rows } = await google.ads.search(id, CUSTOMER_QUERY, { maxRows: 1, loginCustomerId: id });
          const row = rows[0] ?? {};
          const entry: CustomerEntry = {
            customerId: id,
            name: str(row["customer.descriptiveName"]),
            currency: str(row["customer.currencyCode"]),
            timeZone: str(row["customer.timeZone"]),
            manager: row["customer.manager"] === true,
            testAccount: row["customer.testAccount"] === true,
            allowed,
          };
          customers.push(entry);
          if (!entry.manager) continue;
          const children = await google.ads.search(id, CHILD_QUERY, { maxRows: 10_000, loginCustomerId: id });
          for (const child of children.rows) {
            const childId = String(child["customerClient.id"] ?? "");
            if (!childId || seen.has(childId)) continue;
            seen.add(childId);
            customers.push({
              customerId: childId,
              name: str(child["customerClient.descriptiveName"]),
              currency: str(child["customerClient.currencyCode"]),
              timeZone: str(child["customerClient.timeZone"]),
              manager: child["customerClient.manager"] === true,
              testAccount: child["customerClient.testAccount"] === true,
              status: str(child["customerClient.status"]),
              managerId: id,
              allowed: isAllowedCustomer(google.adsConfig, childId),
            });
          }
        } catch (err) {
          // Un compte fermé ou inaccessible ne doit pas masquer les autres.
          customers.push({ customerId: id, allowed, error: (err as Error).message });
        }
      }
      const output = { customers };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "gads_performance",
    {
      title: "Google Ads : performances",
      description:
        "Performances Google Ads (impressions, clics, coût, conversions, valeur, CTR, CPC moyen) " +
        "d'un compte sur une période, par compte, campagne, groupe d'annonces, mot-clé ou terme " +
        "de recherche. Coûts dans la devise du compte. Lignes triées par coût décroissant, " +
        "uniquement celles avec des impressions.",
      inputSchema: z.object({
        customerId: customerIdInput,
        startDate: isoDate.describe("Date de début incluse (AAAA-MM-JJ)"),
        endDate: isoDate.describe("Date de fin incluse (AAAA-MM-JJ)"),
        level: z.enum(GADS_LEVELS).optional().describe("Défaut : campaign"),
        segmentByDate: z.boolean().optional().describe("Une ligne par jour ; défaut : false"),
        limit: z.number().int().min(1).max(10_000).optional().describe("Défaut : 100"),
        loginCustomerId: loginCustomerIdInput,
      }),
      outputSchema: z.object({
        customerId: z.string(),
        level: z.enum(GADS_LEVELS),
        currency: z.string().optional(),
        rowCount: z.number(),
        truncated: z.boolean(),
        rows: z.array(
          z.object({
            dimensions: z.record(z.string(), z.string()),
            impressions: z.number(),
            clicks: z.number(),
            cost: z.number(),
            conversions: z.number(),
            conversionsValue: z.number(),
            ctr: z.number(),
            averageCpc: z.number(),
          }),
        ),
      }),
    },
    async ({ customerId, startDate, endDate, level = "campaign", segmentByDate, limit = 100, loginCustomerId }) => {
      const google = await requireAds();
      const id = resolveCustomer(google, customerId);
      if (startDate > endDate) throw new Error("startDate doit précéder endDate.");
      // Une ligne de plus que demandé : sa présence indique que le résultat est tronqué.
      const query = buildPerformanceQuery({ level, startDate, endDate, segmentByDate, limit: limit + 1 });
      const { rows } = await google.ads.search(id, query, {
        maxRows: limit + 1,
        loginCustomerId: resolveLogin(loginCustomerId),
      });
      const perf = toPerformanceRows(level, rows.slice(0, limit), segmentByDate);
      const output = {
        customerId: id,
        level,
        currency: perf.currency,
        rowCount: perf.rows.length,
        truncated: rows.length > limit,
        rows: perf.rows,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "gads_search",
    {
      title: "Google Ads : requête GAQL",
      description:
        "Exécute une requête GAQL (Google Ads Query Language, SELECT uniquement, lecture seule) " +
        "sur un compte. Champs renvoyés aplatis en camelCase (ex. « metrics.costMicros ») ; " +
        "les entiers 64 bits arrivent en chaînes ; costMicros = coût × 1 000 000. " +
        "Référence : https://developers.google.com/google-ads/api/fields/",
      inputSchema: z.object({
        customerId: customerIdInput,
        query: z
          .string()
          .describe("Ex. SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_30_DAYS"),
        maxRows: z.number().int().min(1).max(50_000).optional().describe("Défaut : 1000"),
        loginCustomerId: loginCustomerIdInput,
      }),
      outputSchema: z.object({
        customerId: z.string(),
        rowCount: z.number(),
        truncated: z.boolean(),
        rows: z.array(z.record(z.string(), z.unknown())),
      }),
    },
    async ({ customerId, query, maxRows = 1000, loginCustomerId }) => {
      const google = await requireAds();
      const id = resolveCustomer(google, customerId);
      if (!/^\s*SELECT\s/i.test(query)) {
        throw new Error("Seules les requêtes GAQL SELECT sont acceptées.");
      }
      const result = await google.ads.search(id, query, {
        maxRows,
        loginCustomerId: resolveLogin(loginCustomerId),
      });
      const output: { customerId: string; rowCount: number; truncated: boolean; rows: FlatRow[] } = {
        customerId: id,
        rowCount: result.rows.length,
        truncated: result.truncated,
        rows: result.rows,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "bing_list_sites",
    {
      title: "Bing Webmaster : lister les sites",
      description:
        "Liste les sites du compte Bing Webmaster lié à la clé API. « allowed » indique si le site " +
        "figure dans BING_SITE_URLS (.env).",
      inputSchema: z.object({}),
      outputSchema: z.object({
        sites: z.array(z.object({ siteUrl: z.string(), verified: z.boolean(), allowed: z.boolean() })),
      }),
    },
    async () => {
      const bing = requireBing();
      const sites = (await bing.client.listSites()).map((s) => ({
        siteUrl: s.url,
        verified: s.verified,
        allowed: isAllowedBingSite(bing.config, s.url),
      }));
      const output = { sites };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "bing_traffic",
    {
      title: "Bing Webmaster : trafic par jour",
      description:
        "Clics et impressions Bing par jour pour un site, avec les totaux de la période. " +
        "Bing fournit environ 16 mois d’historique.",
      inputSchema: z.object({
        siteUrl: bingSiteInput,
        startDate: optionalDate("Date de début incluse"),
        endDate: optionalDate("Date de fin incluse"),
      }),
      outputSchema: z.object({
        siteUrl: z.string(),
        totals: z.object({ clicks: z.number(), impressions: z.number(), ctr: z.number() }),
        firstDate: z.string().optional(),
        lastDate: z.string().optional(),
        rows: z.array(z.object({ date: z.string(), clicks: z.number(), impressions: z.number() })),
      }),
    },
    async ({ siteUrl, startDate, endDate }) => {
      const bing = requireBing(siteUrl);
      const inRange = checkRange(startDate, endDate);
      const rows = (await bing.client.trafficStats(siteUrl)).filter((r) => inRange(r.date));
      const clicks = rows.reduce((s, r) => s + r.clicks, 0);
      const impressions = rows.reduce((s, r) => s + r.impressions, 0);
      const output = {
        siteUrl,
        totals: { clicks, impressions, ctr: impressions ? Math.round((clicks / impressions) * 10_000) / 10_000 : 0 },
        firstDate: rows[0]?.date,
        lastDate: rows.at(-1)?.date,
        rows,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "bing_top",
    {
      title: "Bing Webmaster : requêtes et pages",
      description:
        "Requêtes (kind « query ») ou pages (kind « page ») d'un site sur Bing : clics, impressions, " +
        "CTR et positions moyennes, cumulés sur la période. Bing fournit des données hebdomadaires " +
        "sur environ 16 mois ; les bornes de dates s'appliquent au début de chaque semaine. " +
        "Bing ne fournit plus la position des clics : avgClickPosition est toujours null.",
      inputSchema: z.object({
        siteUrl: bingSiteInput,
        kind: z.enum(["query", "page"]).optional().describe("Défaut : query"),
        startDate: optionalDate("Date de début incluse"),
        endDate: optionalDate("Date de fin incluse"),
        contains: z.string().optional().describe("Ne garde que les requêtes ou pages contenant ce texte (sans casse)"),
        limit: z.number().int().min(1).max(5_000).optional().describe("Défaut : 100"),
      }),
      outputSchema: z.object({
        siteUrl: z.string(),
        kind: z.enum(["query", "page"]),
        rowCount: z.number(),
        truncated: z.boolean(),
        rows: z.array(
          z.object({
            key: z.string(),
            clicks: z.number(),
            impressions: z.number(),
            ctr: z.number(),
            avgClickPosition: z.number().nullable(),
            avgImpressionPosition: z.number().nullable(),
            weeks: z.number(),
          }),
        ),
      }),
    },
    async ({ siteUrl, kind = "query", startDate, endDate, contains, limit = 100 }) => {
      const bing = requireBing(siteUrl);
      const inRange = checkRange(startDate, endDate);
      const needle = contains?.toLowerCase();
      const weekly = (await bing.client.keyStats(siteUrl, kind)).filter(
        (r) => inRange(r.date) && (!needle || r.key.toLowerCase().includes(needle)),
      );
      const all = aggregateKeyStats(weekly);
      const output = { siteUrl, kind, rowCount: Math.min(all.length, limit), truncated: all.length > limit, rows: all.slice(0, limit) };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "bing_crawl_stats",
    {
      title: "Bing Webmaster : exploration et index",
      description:
        "Statistiques d'exploration Bing par jour pour un site : pages explorées, erreurs, pages " +
        "dans l'index, liens entrants, pages bloquées par robots.txt, réponses 4xx et 5xx.",
      inputSchema: z.object({
        siteUrl: bingSiteInput,
        startDate: optionalDate("Date de début incluse"),
        endDate: optionalDate("Date de fin incluse"),
      }),
      outputSchema: z.object({
        siteUrl: z.string(),
        rows: z.array(
          z.object({
            date: z.string(),
            crawledPages: z.number(),
            crawlErrors: z.number(),
            inIndex: z.number(),
            inLinks: z.number(),
            blockedByRobotsTxt: z.number(),
            code4xx: z.number(),
            code5xx: z.number(),
          }),
        ),
      }),
    },
    async ({ siteUrl, startDate, endDate }) => {
      const bing = requireBing(siteUrl);
      const inRange = checkRange(startDate, endDate);
      const output = { siteUrl, rows: (await bing.client.crawlStats(siteUrl)).filter((r) => inRange(r.date)) };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  return server;
}

// Même règle pour les sites Bing Webmaster.
function isAllowedBingSite(config: BingConfig, siteUrl: string): boolean {
  return config.siteUrls.length === 0 || config.siteUrls.includes(siteUrl);
}

// Sans liste dans .env, toutes les propriétés du compte sont autorisées.
function isAllowedSite(config: GoogleConfig, siteUrl: string): boolean {
  return config.siteUrls.length === 0 || config.siteUrls.includes(siteUrl);
}

// Même règle pour les comptes Google Ads.
function isAllowedCustomer(config: GoogleAdsConfig, customerId: string): boolean {
  return config.customerIds.length === 0 || config.customerIds.includes(customerId);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

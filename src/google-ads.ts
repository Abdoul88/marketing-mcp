import type { GoogleAdsConfig } from "./config.js";
import { AUTH_COMMAND, type FetchFn, type GoogleAuth } from "./google-auth.js";

const API_HOST = "https://googleads.googleapis.com";
const ADS_API_OVERVIEW_URL = "https://console.cloud.google.com/google/ads-apis/overview";

export type FlatRow = Record<string, unknown>;

export class GoogleAdsApiError extends Error {
  constructor(
    readonly status: number,
    readonly codes: string[],
    message: string,
  ) {
    super(message);
    this.name = "GoogleAdsApiError";
  }
}

export interface SearchResult {
  rows: FlatRow[];
  // Vrai si d'autres lignes existaient au-delà de maxRows.
  truncated: boolean;
}

export class GoogleAdsClient {
  constructor(
    private readonly auth: GoogleAuth,
    private readonly config: GoogleAdsConfig,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  get apiVersion(): string {
    return this.config.apiVersion;
  }

  /** IDs des comptes auxquels l'utilisateur autorisé a un accès direct. */
  async listAccessibleCustomers(): Promise<string[]> {
    const json = (await this.request("GET", "/customers:listAccessibleCustomers")) as {
      resourceNames?: string[];
    };
    return (json.resourceNames ?? []).map((name) => name.replace("customers/", ""));
  }

  /**
   * Exécute une requête GAQL (lecture seule par construction : googleAds:search
   * ne peut rien modifier). Pages de 10 000 lignes fixées par Google.
   */
  async search(
    customerId: string,
    query: string,
    options: { maxRows: number; loginCustomerId?: string },
  ): Promise<SearchResult> {
    const rows: FlatRow[] = [];
    let pageToken: string | undefined;
    do {
      const json = (await this.request(
        "POST",
        `/customers/${customerId}/googleAds:search`,
        { query, ...(pageToken ? { pageToken } : {}) },
        options.loginCustomerId,
      )) as { results?: Record<string, unknown>[]; nextPageToken?: string };
      for (const result of json.results ?? []) rows.push(flatten(result));
      pageToken = json.nextPageToken;
    } while (pageToken && rows.length < options.maxRows);
    return {
      rows: rows.slice(0, options.maxRows),
      truncated: rows.length > options.maxRows || pageToken !== undefined,
    };
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    loginCustomerId = this.config.loginCustomerId,
  ): Promise<unknown> {
    const token = await this.auth.getAccessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body) headers["Content-Type"] = "application/json";
    if (loginCustomerId) headers["login-customer-id"] = loginCustomerId;
    if (this.config.developerToken) headers["developer-token"] = this.config.developerToken;

    const res = await this.fetchImpl(`${API_HOST}/${this.config.apiVersion}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) throw toApiError(res.status, json, this.config.apiVersion);
    return json;
  }
}

/** { campaign: { name: "x" }, metrics: { clicks: "3" } } → { "campaign.name": "x", "metrics.clicks": "3" } */
export function flatten(value: Record<string, unknown>, prefix = ""): FlatRow {
  const out: FlatRow = {};
  for (const [key, v] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(out, flatten(v as Record<string, unknown>, path));
    } else {
      out[path] = v;
    }
  }
  return out;
}

// Les erreurs Google Ads détaillent un code par erreur (GoogleAdsFailure) :
// on les remonte et on ajoute la marche à suivre pour les cas courants.
function toApiError(status: number, json: unknown, apiVersion: string): GoogleAdsApiError {
  const error = (json as { error?: { message?: string; details?: unknown[] } }).error;
  const codes: string[] = [];
  const messages: string[] = [];
  for (const detail of error?.details ?? []) {
    const d = detail as {
      errors?: Array<{ errorCode?: Record<string, string>; message?: string }>;
      reason?: string;
    };
    for (const e of d.errors ?? []) {
      codes.push(...Object.values(e.errorCode ?? {}));
      if (e.message) messages.push(e.message);
    }
    if (d.reason) codes.push(d.reason);
  }
  const raw = JSON.stringify(json);
  const has = (code: string) => codes.includes(code) || raw.includes(code);

  let hint = "";
  if (
    has("CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION") ||
    has("DEVELOPER_TOKEN_NOT_APPROVED") ||
    has("ACTION_NOT_PERMITTED")
  ) {
    hint =
      "Le projet Google Cloud de l'application OAuth n'a que l'accès « Test » (comptes de test uniquement). " +
      `Demande l'accès Explorer sur ${ADS_API_OVERVIEW_URL}.`;
  } else if (has("SERVICE_DISABLED") || raw.includes("has not been used in project")) {
    hint = "Active « Google Ads API » dans le projet Google Cloud de l'application OAuth.";
  } else if (has("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
    hint = `L'autorisation Google n'inclut pas Google Ads : relance « ${AUTH_COMMAND} ».`;
  } else if (has("USER_PERMISSION_DENIED")) {
    hint =
      "Ce compte est sans doute géré via un compte administrateur (MCC) : " +
      "renseigne loginCustomerId (ou GOOGLE_ADS_LOGIN_CUSTOMER_ID dans .env).";
  } else if (has("UNSUPPORTED_VERSION") || status === 404) {
    hint = `Version d'API ${apiVersion} peut-être retirée : mets à jour GOOGLE_ADS_API_VERSION dans .env.`;
  }

  const detail = messages.join(" ; ") || error?.message || "erreur inconnue";
  return new GoogleAdsApiError(
    status,
    codes,
    `Google Ads API (HTTP ${status}) : ${detail}` + (hint ? `\n${hint}` : ""),
  );
}

// --- Rapport de performances prêt à l'emploi ---

export const GADS_LEVELS = ["account", "campaign", "ad_group", "keyword", "search_term"] as const;
export type GadsLevel = (typeof GADS_LEVELS)[number];

// Pour chaque niveau : ressource GAQL et dimensions (nom lisible → champ GAQL).
const LEVELS: Record<GadsLevel, { from: string; dimensions: Record<string, string> }> = {
  account: {
    from: "customer",
    dimensions: { accountId: "customer.id", account: "customer.descriptive_name" },
  },
  campaign: {
    from: "campaign",
    dimensions: {
      campaignId: "campaign.id",
      campaign: "campaign.name",
      campaignStatus: "campaign.status",
      channel: "campaign.advertising_channel_type",
    },
  },
  ad_group: {
    from: "ad_group",
    dimensions: {
      campaign: "campaign.name",
      adGroupId: "ad_group.id",
      adGroup: "ad_group.name",
      adGroupStatus: "ad_group.status",
    },
  },
  keyword: {
    from: "keyword_view",
    dimensions: {
      campaign: "campaign.name",
      adGroup: "ad_group.name",
      keyword: "ad_group_criterion.keyword.text",
      matchType: "ad_group_criterion.keyword.match_type",
    },
  },
  search_term: {
    from: "search_term_view",
    dimensions: {
      campaign: "campaign.name",
      adGroup: "ad_group.name",
      searchTerm: "search_term_view.search_term",
    },
  },
};

const METRICS = [
  "metrics.impressions",
  "metrics.clicks",
  "metrics.cost_micros",
  "metrics.conversions",
  "metrics.conversions_value",
] as const;

export interface PerformanceQuery {
  level: GadsLevel;
  startDate: string;
  endDate: string;
  segmentByDate?: boolean;
  limit: number;
}

export function buildPerformanceQuery(q: PerformanceQuery): string {
  const level = LEVELS[q.level];
  const fields = [
    ...(q.segmentByDate ? ["segments.date"] : []),
    ...Object.values(level.dimensions),
    "customer.currency_code",
    ...METRICS,
  ];
  return (
    `SELECT ${fields.join(", ")} FROM ${level.from} ` +
    `WHERE segments.date BETWEEN '${q.startDate}' AND '${q.endDate}' AND metrics.impressions > 0 ` +
    `ORDER BY metrics.cost_micros DESC LIMIT ${q.limit}`
  );
}

export interface PerformanceRow {
  dimensions: Record<string, string>;
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  conversionsValue: number;
  ctr: number;
  averageCpc: number;
}

// Le JSON REST est en camelCase (metrics.costMicros) et les int64 arrivent en chaînes.
function field(row: FlatRow, gaqlField: string): unknown {
  return row[gaqlField.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
}

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function toPerformanceRows(
  level: GadsLevel,
  rows: FlatRow[],
  segmentByDate = false,
): { currency?: string; rows: PerformanceRow[] } {
  const dims = {
    ...(segmentByDate ? { date: "segments.date" } : {}),
    ...LEVELS[level].dimensions,
  };
  const currency = rows.length ? String(field(rows[0]!, "customer.currency_code") ?? "") : "";
  return {
    currency: currency || undefined,
    rows: rows.map((row) => {
      const impressions = num(field(row, "metrics.impressions"));
      const clicks = num(field(row, "metrics.clicks"));
      const cost = num(field(row, "metrics.cost_micros")) / 1_000_000;
      return {
        dimensions: Object.fromEntries(
          Object.entries(dims).map(([name, f]) => [name, String(field(row, f) ?? "")]),
        ),
        impressions,
        clicks,
        cost: round(cost, 2),
        conversions: round(num(field(row, "metrics.conversions")), 2),
        conversionsValue: round(num(field(row, "metrics.conversions_value")), 2),
        ctr: impressions ? round(clicks / impressions, 4) : 0,
        averageCpc: clicks ? round(cost / clicks, 2) : 0,
      };
    }),
  };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

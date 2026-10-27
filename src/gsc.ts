import type { FetchFn, GoogleAuth } from "./google-auth.js";

const API_BASE = "https://www.googleapis.com/webmasters/v3";

export const GSC_DIMENSIONS = [
  "date",
  "query",
  "page",
  "country",
  "device",
  "searchAppearance",
] as const;

export const GSC_SEARCH_TYPES = [
  "web",
  "image",
  "video",
  "news",
  "discover",
  "googleNews",
] as const;

export const GSC_FILTER_OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "includingRegex",
  "excludingRegex",
] as const;

export interface GscSite {
  siteUrl: string;
  permissionLevel: string;
}

export interface GscQuery {
  startDate: string;
  endDate: string;
  dimensions?: Array<(typeof GSC_DIMENSIONS)[number]>;
  type?: (typeof GSC_SEARCH_TYPES)[number];
  filters?: Array<{
    dimension: Exclude<(typeof GSC_DIMENSIONS)[number], "date" | "searchAppearance">;
    operator: (typeof GSC_FILTER_OPERATORS)[number];
    expression: string;
  }>;
  rowLimit?: number;
  startRow?: number;
}

export interface GscRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export class GscApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GscApiError";
  }
}

export class SearchConsoleClient {
  constructor(
    private readonly auth: GoogleAuth,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  async listSites(): Promise<GscSite[]> {
    const json = (await this.request("GET", "/sites")) as {
      siteEntry?: GscSite[];
    };
    return json.siteEntry ?? [];
  }

  async query(siteUrl: string, query: GscQuery): Promise<GscRow[]> {
    const body: Record<string, unknown> = {
      startDate: query.startDate,
      endDate: query.endDate,
      dimensions: query.dimensions ?? [],
      type: query.type ?? "web",
      rowLimit: query.rowLimit ?? 100,
      startRow: query.startRow ?? 0,
    };
    if (query.filters?.length) {
      body.dimensionFilterGroups = [{ groupType: "and", filters: query.filters }];
    }
    const json = (await this.request(
      "POST",
      `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      body,
    )) as { rows?: GscRow[] };
    return json.rows ?? [];
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const token = await this.auth.getAccessToken();
    const res = await this.fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new GscApiError(
        res.status,
        `Search Console API (HTTP ${res.status}) : ${json.error?.message ?? "erreur inconnue"}`,
      );
    }
    return json;
  }
}

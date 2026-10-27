import type { BingConfig } from "./config.js";
import type { FetchFn } from "./google-auth.js";

// API JSON de Bing Webmaster Tools : chaque méthode est un GET authentifié par la clé API.
// Le client n'appelle que des méthodes Get* : il ne peut rien modifier sur le compte.
const API_BASE = "https://ssl.bing.com/webmaster/api.svc/json";

export interface BingSite {
  url: string;
  verified: boolean;
}

export interface BingTrafficRow {
  date: string;
  clicks: number;
  impressions: number;
}

export interface BingStatRow {
  date: string;
  key: string;
  clicks: number;
  impressions: number;
  avgClickPosition: number | null;
  avgImpressionPosition: number | null;
}

export interface BingCrawlRow {
  date: string;
  crawledPages: number;
  crawlErrors: number;
  inIndex: number;
  inLinks: number;
  blockedByRobotsTxt: number;
  code4xx: number;
  code5xx: number;
}

export class BingApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BingApiError";
  }
}

/** « /Date(1695772800000-0700)/ » → « 2023-09-27 » (jour UTC de l'horodatage). */
export function parseBingDate(value: unknown): string {
  const match = /\/Date\((-?\d+)/.exec(String(value ?? ""));
  if (!match) return "";
  return new Date(Number(match[1])).toISOString().slice(0, 10);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Bing renvoie -1 (ou 0) quand la position n'a pas de sens, par exemple sans clic.
function position(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export class BingWebmasterClient {
  constructor(
    private readonly config: BingConfig,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  async listSites(): Promise<BingSite[]> {
    const rows = await this.request("GetUserSites");
    return rows.map((r) => ({ url: String(r.Url ?? ""), verified: r.IsVerified === true }));
  }

  /** Clics et impressions par jour (environ 16 mois d’historique, constaté le 2026-10-27). */
  async trafficStats(siteUrl: string): Promise<BingTrafficRow[]> {
    const rows = await this.request("GetRankAndTrafficStats", { siteUrl });
    return rows
      .map((r) => ({ date: parseBingDate(r.Date), clicks: num(r.Clicks), impressions: num(r.Impressions) }))
      .filter((r) => r.date)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Statistiques par requête (kind « query ») ou par page (kind « page »), une ligne par semaine. */
  async keyStats(siteUrl: string, kind: "query" | "page"): Promise<BingStatRow[]> {
    const rows = await this.request(kind === "query" ? "GetQueryStats" : "GetPageStats", { siteUrl });
    return rows
      .map((r) => ({
        date: parseBingDate(r.Date),
        key: String(r.Query ?? ""),
        clicks: num(r.Clicks),
        impressions: num(r.Impressions),
        avgClickPosition: position(r.AvgClickPosition),
        avgImpressionPosition: position(r.AvgImpressionPosition),
      }))
      .filter((r) => r.date && r.key);
  }

  async crawlStats(siteUrl: string): Promise<BingCrawlRow[]> {
    const rows = await this.request("GetCrawlStats", { siteUrl });
    return rows
      .map((r) => ({
        date: parseBingDate(r.Date),
        crawledPages: num(r.CrawledPages),
        crawlErrors: num(r.CrawlErrors),
        inIndex: num(r.InIndex),
        inLinks: num(r.InLinks),
        blockedByRobotsTxt: num(r.BlockedByRobotsTxt),
        code4xx: num(r.Code4xx),
        code5xx: num(r.Code5xx),
      }))
      .filter((r) => r.date)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  private async request(method: string, params: Record<string, string> = {}): Promise<Record<string, unknown>[]> {
    const url = new URL(`${API_BASE}/${method}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("apikey", this.config.apiKey);
    const res = await this.fetchImpl(url.toString(), { headers: { Accept: "application/json" } });
    const json = (await res.json().catch(() => ({}))) as { d?: unknown; Message?: string; ErrorCode?: number };
    if (!res.ok) {
      // L'URL contient la clé API : elle n'apparaît jamais dans les messages d'erreur.
      const hint =
        res.status === 401 || res.status === 403
          ? " Vérifie BING_API_KEY dans .env (Bing Webmaster → Paramètres → Accès API)."
          : "";
      throw new BingApiError(
        res.status,
        `Bing Webmaster API (HTTP ${res.status}, ${method}) : ${json.Message ?? "erreur inconnue"}.${hint}`,
      );
    }
    return Array.isArray(json.d) ? (json.d as Record<string, unknown>[]) : [];
  }
}

export interface BingKeyAggregate {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  avgClickPosition: number | null;
  avgImpressionPosition: number | null;
  weeks: number;
}

/** Cumule les lignes hebdomadaires par requête ou page ; positions moyennes pondérées. */
export function aggregateKeyStats(rows: BingStatRow[]): BingKeyAggregate[] {
  const byKey = new Map<string, { clicks: number; impressions: number; clickPos: number; impPos: number; weeks: number }>();
  for (const r of rows) {
    const a = byKey.get(r.key) ?? { clicks: 0, impressions: 0, clickPos: 0, impPos: 0, weeks: 0 };
    a.clicks += r.clicks;
    a.impressions += r.impressions;
    if (r.avgClickPosition != null) a.clickPos += r.avgClickPosition * r.clicks;
    if (r.avgImpressionPosition != null) a.impPos += r.avgImpressionPosition * r.impressions;
    a.weeks += 1;
    byKey.set(r.key, a);
  }
  const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
  return [...byKey.entries()]
    .map(([key, a]) => ({
      key,
      clicks: a.clicks,
      impressions: a.impressions,
      ctr: a.impressions ? round(a.clicks / a.impressions, 4) : 0,
      avgClickPosition: a.clicks && a.clickPos ? round(a.clickPos / a.clicks, 1) : null,
      avgImpressionPosition: a.impressions && a.impPos ? round(a.impPos / a.impressions, 1) : null,
      weeks: a.weeks,
    }))
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

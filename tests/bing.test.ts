import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateKeyStats, BingWebmasterClient, parseBingDate } from "../src/bing.js";
import { readBingConfig, type BingConfig } from "../src/config.js";
import type { FetchFn } from "../src/google-auth.js";
import { createServer } from "../src/server.js";

const config: BingConfig = { apiKey: "cle-secrete", siteUrls: ["https://www.exemple.fr/"] };

// 2026-09-01 et 2026-09-08 à minuit UTC, au format WCF de Bing.
const D1 = "/Date(1788220800000)/";
const D2 = "/Date(1788825600000-0700)/";

// Faux fetch : API JSON Bing Webmaster, sans réseau.
function fakeFetch(options: { status?: number } = {}) {
  const urls: string[] = [];
  const fn: FetchFn = async (input) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    if (options.status) return Response.json({ ErrorCode: 14, Message: "NotAuthorized" }, { status: options.status });
    const method = url.pathname.split("/").at(-1);
    if (method === "GetUserSites") {
      return Response.json({ d: [
        { Url: "https://www.exemple.fr/", IsVerified: true },
        { Url: "https://autre.fr/", IsVerified: false },
      ] });
    }
    if (method === "GetRankAndTrafficStats") {
      return Response.json({ d: [
        { Date: D2, Clicks: 5, Impressions: 50 },
        { Date: D1, Clicks: 10, Impressions: 100 },
      ] });
    }
    if (method === "GetQueryStats") {
      return Response.json({ d: [
        { Date: D1, Query: "parking tours", Clicks: 4, Impressions: 40, AvgClickPosition: 2, AvgImpressionPosition: 3 },
        { Date: D2, Query: "parking tours", Clicks: 6, Impressions: 60, AvgClickPosition: 4, AvgImpressionPosition: 5 },
        { Date: D2, Query: "marque", Clicks: 0, Impressions: 10, AvgClickPosition: -1, AvgImpressionPosition: 7 },
      ] });
    }
    if (method === "GetCrawlStats") {
      return Response.json({ d: [{ Date: D1, CrawledPages: 120, CrawlErrors: 2, InIndex: 900, InLinks: 40, BlockedByRobotsTxt: 1, Code4xx: 2, Code5xx: 0 }] });
    }
    return Response.json({ Message: "inconnue" }, { status: 404 });
  };
  return { fn, urls };
}

async function connect(fetchImpl?: FetchFn) {
  const deps = fetchImpl ? { bing: { config, client: new BingWebmasterClient(config, fetchImpl) } } : {};
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("Bing : utilitaires", () => {
  it("lit les dates WCF de Bing", () => {
    expect(parseBingDate(D1)).toBe("2026-09-01");
    expect(parseBingDate(D2)).toBe("2026-09-08");
    expect(parseBingDate("n'importe quoi")).toBe("");
  });

  it("lit la clé et la liste de sites", () => {
    expect(readBingConfig({ BING_API_KEY: " k ", BING_SITE_URLS: "https://a.fr/, https://b.fr/," })).toEqual({
      apiKey: "k",
      siteUrls: ["https://a.fr/", "https://b.fr/"],
    });
    expect(readBingConfig({})).toBeUndefined();
  });

  it("cumule les semaines avec des positions pondérées", () => {
    const [top] = aggregateKeyStats([
      { date: "2026-09-01", key: "q", clicks: 4, impressions: 40, avgClickPosition: 2, avgImpressionPosition: 3 },
      { date: "2026-09-08", key: "q", clicks: 6, impressions: 60, avgClickPosition: 4, avgImpressionPosition: 5 },
    ]);
    expect(top).toEqual({ key: "q", clicks: 10, impressions: 100, ctr: 0.1, avgClickPosition: 3.2, avgImpressionPosition: 4.2, weeks: 2 });
  });
});

describe("outils Bing Webmaster", () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("Bing passe à configured quand la clé est renseignée", async () => {
    client = await connect(fakeFetch().fn);
    const result = await client.callTool({ name: "marketing_list_sources", arguments: {} });
    const { sources } = result.structuredContent as { sources: Array<{ id: string; status: string }> };
    expect(sources.find((s) => s.id === "bing_webmaster")?.status).toBe("configured");
  });

  it("bing_list_sites marque les sites autorisés et envoie la clé", async () => {
    const { fn, urls } = fakeFetch();
    client = await connect(fn);
    const result = await client.callTool({ name: "bing_list_sites", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      sites: [
        { siteUrl: "https://www.exemple.fr/", verified: true, allowed: true },
        { siteUrl: "https://autre.fr/", verified: false, allowed: false },
      ],
    });
    expect(urls[0]).toBe("https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=cle-secrete");
  });

  it("bing_traffic trie par date, filtre la période et calcule les totaux", async () => {
    const { fn, urls } = fakeFetch();
    client = await connect(fn);
    const result = await client.callTool({
      name: "bing_traffic",
      arguments: { siteUrl: "https://www.exemple.fr/", startDate: "2026-09-01", endDate: "2026-09-05" },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      siteUrl: "https://www.exemple.fr/",
      totals: { clicks: 10, impressions: 100, ctr: 0.1 },
      firstDate: "2026-09-01",
      lastDate: "2026-09-01",
      rows: [{ date: "2026-09-01", clicks: 10, impressions: 100 }],
    });
    expect(new URL(urls[0]!).searchParams.get("siteUrl")).toBe("https://www.exemple.fr/");
  });

  it("bing_top cumule les requêtes et ignore les positions -1", async () => {
    client = await connect(fakeFetch().fn);
    const result = await client.callTool({ name: "bing_top", arguments: { siteUrl: "https://www.exemple.fr/" } });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { rowCount: number; rows: Array<{ key: string; avgClickPosition: number | null }> };
    expect(out.rowCount).toBe(2);
    expect(out.rows[0]).toMatchObject({ key: "parking tours", clicks: 10, avgClickPosition: 3.2 });
    expect(out.rows[1]).toMatchObject({ key: "marque", clicks: 0, avgClickPosition: null, avgImpressionPosition: 7 });
  });

  it("bing_top filtre par texte", async () => {
    client = await connect(fakeFetch().fn);
    const result = await client.callTool({ name: "bing_top", arguments: { siteUrl: "https://www.exemple.fr/", contains: "MARQUE" } });
    expect((result.structuredContent as { rows: Array<{ key: string }> }).rows.map((r) => r.key)).toEqual(["marque"]);
  });

  it("bing_crawl_stats renvoie les statistiques d'exploration", async () => {
    client = await connect(fakeFetch().fn);
    const result = await client.callTool({ name: "bing_crawl_stats", arguments: { siteUrl: "https://www.exemple.fr/" } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { rows: unknown[] }).rows[0]).toMatchObject({ date: "2026-09-01", crawledPages: 120, inIndex: 900 });
  });

  it("refuse un site absent de BING_SITE_URLS sans appeler l'API", async () => {
    const { fn, urls } = fakeFetch();
    client = await connect(fn);
    const result = await client.callTool({ name: "bing_traffic", arguments: { siteUrl: "https://autre.fr/" } });
    expect(result.isError).toBe(true);
    expect(urls).toHaveLength(0);
  });

  it("n'expose jamais la clé API dans une erreur", async () => {
    client = await connect(fakeFetch({ status: 401 }).fn);
    const result = await client.callTool({ name: "bing_list_sites", arguments: {} });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("BING_API_KEY");
    expect(text).not.toContain("cle-secrete");
  });

  it("explique comment configurer Bing sans clé", async () => {
    client = await connect();
    const result = await client.callTool({ name: "bing_list_sites", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("Accès API");
  });
});

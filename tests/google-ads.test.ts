import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { readGoogleAdsConfig, type GoogleAdsConfig, type GoogleConfig } from "../src/config.js";
import { buildPerformanceQuery, GoogleAdsClient, toPerformanceRows } from "../src/google-ads.js";
import {
  GoogleAuth,
  type FetchFn,
  type StoredToken,
  type TokenStore,
} from "../src/google-auth.js";
import { SearchConsoleClient } from "../src/gsc.js";
import { createServer } from "../src/server.js";

const config: GoogleConfig = { clientId: "client-id", clientSecret: "client-secret", siteUrls: [] };

const BOTH_SCOPES =
  "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/adwords";

function memoryStore(scope = BOTH_SCOPES): TokenStore {
  const token: StoredToken = { refreshToken: "refresh-1", scope, obtainedAt: "2026-10-26T00:00:00.000Z" };
  return { read: async () => token, write: async () => {} };
}

interface Call {
  url: string;
  init: RequestInit | undefined;
}

const MANAGER = "1112223333";
const CLIENT = "4445556666";

// Faux fetch : Google OAuth + Google Ads API, sans réseau.
function fakeFetch(options: { searchError?: unknown } = {}) {
  const calls: Call[] = [];
  const fn: FetchFn = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access-1", expires_in: 3600 });
    }
    if (url.endsWith("/customers:listAccessibleCustomers")) {
      return Response.json({ resourceNames: [`customers/${MANAGER}`] });
    }
    if (url.endsWith("/googleAds:search")) {
      if (options.searchError) return Response.json(options.searchError, { status: 403 });
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.includes("FROM customer_client")) {
        return Response.json({
          results: [
            {
              customerClient: {
                id: CLIENT,
                descriptiveName: "Client FR",
                currencyCode: "EUR",
                timeZone: "Europe/Paris",
                manager: false,
                testAccount: false,
                status: "ENABLED",
              },
            },
          ],
        });
      }
      if (/FROM customer$/.test(query)) {
        return Response.json({
          results: [
            {
              customer: {
                id: MANAGER,
                descriptiveName: "MCC",
                currencyCode: "EUR",
                timeZone: "Europe/Paris",
                manager: true,
                testAccount: false,
              },
            },
          ],
        });
      }
      return Response.json({
        results: [
          {
            customer: { currencyCode: "EUR" },
            campaign: { id: "1", name: "Marque", status: "ENABLED", advertisingChannelType: "SEARCH" },
            metrics: {
              impressions: "1000",
              clicks: "50",
              costMicros: "25000000",
              conversions: 5,
              conversionsValue: 150.5,
            },
          },
          {
            customer: { currencyCode: "EUR" },
            campaign: { id: "2", name: "Générique", status: "PAUSED", advertisingChannelType: "SEARCH" },
            metrics: { impressions: "10", clicks: "0", costMicros: "0" },
          },
        ],
      });
    }
    return Response.json({ error: { message: "introuvable" } }, { status: 404 });
  };
  return { fn, calls };
}

function deps(fetchImpl: FetchFn, options: { scope?: string; ads?: Partial<GoogleAdsConfig> } = {}) {
  const auth = new GoogleAuth(config, memoryStore(options.scope), fetchImpl);
  const adsConfig = { ...readGoogleAdsConfig({}), ...options.ads };
  return {
    google: {
      config,
      auth,
      gsc: new SearchConsoleClient(auth, fetchImpl),
      adsConfig,
      ads: new GoogleAdsClient(auth, adsConfig, fetchImpl),
    },
  };
}

async function connect(d: Parameters<typeof createServer>[0]) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(d).connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("readGoogleAdsConfig", () => {
  it("normalise les IDs et applique la version par défaut", () => {
    expect(
      readGoogleAdsConfig({
        GOOGLE_ADS_CUSTOMER_IDS: "123-456-7890, 0987654321",
        GOOGLE_ADS_LOGIN_CUSTOMER_ID: "111-222-3333",
      }),
    ).toEqual({
      apiVersion: "v26",
      loginCustomerId: "1112223333",
      customerIds: ["1234567890", "0987654321"],
      developerToken: undefined,
    });
  });

  it("refuse un ID mal formé", () => {
    expect(() => readGoogleAdsConfig({ GOOGLE_ADS_CUSTOMER_IDS: "12345" })).toThrow("ID invalide");
  });
});

describe("rapport de performances", () => {
  it("construit la requête GAQL du niveau demandé", () => {
    expect(
      buildPerformanceQuery({
        level: "keyword",
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        segmentByDate: true,
        limit: 50,
      }),
    ).toBe(
      "SELECT segments.date, campaign.name, ad_group.name, ad_group_criterion.keyword.text, " +
        "ad_group_criterion.keyword.match_type, customer.currency_code, metrics.impressions, " +
        "metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value " +
        "FROM keyword_view WHERE segments.date BETWEEN '2026-09-01' AND '2026-09-30' " +
        "AND metrics.impressions > 0 ORDER BY metrics.cost_micros DESC LIMIT 50",
    );
  });

  it("convertit les micros et calcule CTR et CPC", () => {
    const perf = toPerformanceRows("ad_group", [
      {
        "customer.currencyCode": "EUR",
        "campaign.name": "C",
        "adGroup.id": "9",
        "adGroup.name": "G",
        "adGroup.status": "ENABLED",
        "metrics.impressions": "200",
        "metrics.clicks": "8",
        "metrics.costMicros": "4000000",
      },
    ]);
    expect(perf).toEqual({
      currency: "EUR",
      rows: [
        {
          dimensions: { campaign: "C", adGroupId: "9", adGroup: "G", adGroupStatus: "ENABLED" },
          impressions: 200,
          clicks: 8,
          cost: 4,
          conversions: 0,
          conversionsValue: 0,
          ctr: 0.04,
          averageCpc: 0.5,
        },
      ],
    });
  });
});

describe("outils Google Ads", () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("Google Ads passe à configured quand l'autorisation inclut le scope adwords", async () => {
    client = await connect(deps(fakeFetch().fn));
    const result = await client.callTool({ name: "marketing_list_sources", arguments: {} });
    const { sources } = result.structuredContent as { sources: Array<{ id: string; status: string }> };
    expect(sources.find((s) => s.id === "google_ads")?.status).toBe("configured");
  });

  it("demande de relancer l'autorisation si le scope adwords manque, sans appeler l'API", async () => {
    const { fn, calls } = fakeFetch();
    client = await connect(deps(fn, { scope: "https://www.googleapis.com/auth/webmasters.readonly" }));
    const result = await client.callTool({ name: "gads_list_customers", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("auth:google");
    expect(calls).toHaveLength(0);
  });

  it("gads_list_customers liste le MCC et ses comptes clients", async () => {
    const { fn, calls } = fakeFetch();
    client = await connect(deps(fn, { ads: { customerIds: [CLIENT] } }));
    const result = await client.callTool({ name: "gads_list_customers", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      customers: [
        {
          customerId: MANAGER,
          name: "MCC",
          currency: "EUR",
          timeZone: "Europe/Paris",
          manager: true,
          testAccount: false,
          allowed: false,
        },
        {
          customerId: CLIENT,
          name: "Client FR",
          currency: "EUR",
          timeZone: "Europe/Paris",
          manager: false,
          testAccount: false,
          status: "ENABLED",
          managerId: MANAGER,
          allowed: true,
        },
      ],
    });
    const list = calls.find((c) => c.url.endsWith("/customers:listAccessibleCustomers"));
    expect(list?.url).toBe("https://googleads.googleapis.com/v26/customers:listAccessibleCustomers");
    const search = calls.find((c) => c.url.endsWith("/googleAds:search"));
    const headers = new Headers(search?.init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer access-1");
    expect(headers.get("login-customer-id")).toBe(MANAGER);
    // Facultatif et ignoré par Google depuis septembre 2026 : non envoyé s'il n'est pas configuré.
    expect(headers.get("developer-token")).toBeNull();
  });

  it("gads_performance interroge le compte et renvoie des coûts en devise", async () => {
    const { fn, calls } = fakeFetch();
    client = await connect(deps(fn));
    const result = await client.callTool({
      name: "gads_performance",
      arguments: {
        customerId: "444-555-6666",
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        limit: 1,
        loginCustomerId: "111-222-3333",
      },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      customerId: CLIENT,
      level: "campaign",
      currency: "EUR",
      rowCount: 1,
      truncated: true,
      rows: [
        {
          dimensions: { campaignId: "1", campaign: "Marque", campaignStatus: "ENABLED", channel: "SEARCH" },
          impressions: 1000,
          clicks: 50,
          cost: 25,
          conversions: 5,
          conversionsValue: 150.5,
          ctr: 0.05,
          averageCpc: 0.5,
        },
      ],
    });
    const search = calls.find((c) => c.url.endsWith("/googleAds:search"));
    expect(search?.url).toBe(`https://googleads.googleapis.com/v26/customers/${CLIENT}/googleAds:search`);
    expect(new Headers(search?.init?.headers).get("login-customer-id")).toBe(MANAGER);
    const { query } = JSON.parse(String(search?.init?.body)) as { query: string };
    expect(query).toContain("FROM campaign WHERE segments.date BETWEEN '2026-09-01' AND '2026-09-30'");
    expect(query).toMatch(/LIMIT 2$/);
  });

  it("gads_search aplatit les lignes", async () => {
    const { fn } = fakeFetch();
    client = await connect(deps(fn));
    const result = await client.callTool({
      name: "gads_search",
      arguments: { customerId: CLIENT, query: "SELECT campaign.name FROM campaign" },
    });
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as { rowCount: number; rows: Array<Record<string, unknown>> };
    expect(out.rowCount).toBe(2);
    expect(out.rows[0]).toMatchObject({ "campaign.name": "Marque", "metrics.costMicros": "25000000" });
  });

  it("gads_search refuse autre chose qu'un SELECT", async () => {
    const { fn, calls } = fakeFetch();
    client = await connect(deps(fn));
    const result = await client.callTool({
      name: "gads_search",
      arguments: { customerId: CLIENT, query: "DELETE FROM campaign" },
    });
    expect(result.isError).toBe(true);
    expect(calls.filter((c) => c.url.includes("googleads"))).toHaveLength(0);
  });

  it("refuse un compte absent de GOOGLE_ADS_CUSTOMER_IDS sans appeler l'API", async () => {
    const { fn, calls } = fakeFetch();
    client = await connect(deps(fn, { ads: { customerIds: [MANAGER] } }));
    const result = await client.callTool({
      name: "gads_performance",
      arguments: { customerId: CLIENT, startDate: "2026-09-01", endDate: "2026-09-30" },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("non autorisé");
    expect(calls.filter((c) => c.url.includes("googleads"))).toHaveLength(0);
  });

  it("explique comment obtenir l'accès Explorer quand le projet n'a que l'accès Test", async () => {
    const { fn } = fakeFetch({
      searchError: {
        error: {
          code: 403,
          message: "The caller does not have permission",
          status: "PERMISSION_DENIED",
          details: [
            {
              "@type": "type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
              errors: [
                {
                  errorCode: { authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" },
                  message: "The Google Cloud project is not approved for production access.",
                },
              ],
            },
          ],
        },
      },
    });
    client = await connect(deps(fn));
    const result = await client.callTool({
      name: "gads_performance",
      arguments: { customerId: CLIENT, startDate: "2026-09-01", endDate: "2026-09-30" },
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("not approved for production");
    expect(text).toContain("Explorer");
  });
});

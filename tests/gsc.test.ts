import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { readGoogleAdsConfig, readGoogleConfig, type GoogleConfig } from "../src/config.js";
import { GoogleAdsClient } from "../src/google-ads.js";
import {
  buildAuthUrl,
  GoogleAuth,
  type FetchFn,
  type StoredToken,
  type TokenStore,
} from "../src/google-auth.js";
import { SearchConsoleClient } from "../src/gsc.js";
import { createServer } from "../src/server.js";

const config: GoogleConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  siteUrls: ["https://www.exemple.fr/", "sc-domain:exemple.es"],
};

function memoryStore(token?: StoredToken): TokenStore {
  let current = token;
  return {
    read: async () => current,
    write: async (t) => {
      current = t;
    },
  };
}

const storedToken: StoredToken = {
  refreshToken: "refresh-1",
  scope: "https://www.googleapis.com/auth/webmasters.readonly",
  obtainedAt: "2026-10-26T00:00:00.000Z",
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

// Faux fetch : Google OAuth + Search Console, sans réseau.
function fakeFetch(options: { refreshError?: string } = {}) {
  const calls: Call[] = [];
  const fn: FetchFn = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") {
      if (options.refreshError) {
        return Response.json({ error: options.refreshError }, { status: 400 });
      }
      return Response.json({ access_token: "access-1", expires_in: 3600 });
    }
    if (url.endsWith("/webmasters/v3/sites")) {
      return Response.json({
        siteEntry: [
          { siteUrl: "https://www.exemple.fr/", permissionLevel: "siteOwner" },
          { siteUrl: "https://autre.fr/", permissionLevel: "siteFullUser" },
        ],
      });
    }
    if (url.includes("/searchAnalytics/query")) {
      return Response.json({
        rows: [
          { keys: ["parking"], clicks: 10, impressions: 200, ctr: 0.05, position: 3.2 },
        ],
      });
    }
    return Response.json({ error: { message: "introuvable" } }, { status: 404 });
  };
  return { fn, calls };
}

async function connect(deps: Parameters<typeof createServer>[0]) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function googleDeps(store: TokenStore, fetchImpl: FetchFn) {
  const auth = new GoogleAuth(config, store, fetchImpl);
  const adsConfig = readGoogleAdsConfig({});
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

describe("readGoogleConfig", () => {
  it("lit les identifiants et la liste de propriétés", () => {
    expect(
      readGoogleConfig({
        GOOGLE_CLIENT_ID: " id ",
        GOOGLE_CLIENT_SECRET: "secret",
        GSC_SITE_URLS: "https://a.fr/, sc-domain:b.fr ,",
      }),
    ).toEqual({
      clientId: "id",
      clientSecret: "secret",
      siteUrls: ["https://a.fr/", "sc-domain:b.fr"],
    });
  });

  it("renvoie undefined sans identifiants", () => {
    expect(readGoogleConfig({ GOOGLE_CLIENT_ID: "id" })).toBeUndefined();
  });
});

describe("buildAuthUrl", () => {
  it("demande le scope lecture seule, un accès hors ligne et PKCE", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "id",
        redirectUri: "http://127.0.0.1:1234/callback",
        codeChallenge: "challenge",
        state: "state",
      }),
    );
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/webmasters.readonly https://www.googleapis.com/auth/adwords",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("outils Search Console", () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("Search Console reste non configurée tant qu'aucun compte n'est autorisé", async () => {
    client = await connect(googleDeps(memoryStore(), fakeFetch().fn));
    const result = await client.callTool({ name: "marketing_list_sources", arguments: {} });
    const { sources } = result.structuredContent as {
      sources: Array<{ id: string; status: string }>;
    };
    expect(sources.find((s) => s.id === "google_search_console")?.status).toBe(
      "not_configured",
    );
  });

  it("Search Console passe à configured une fois le compte autorisé", async () => {
    client = await connect(googleDeps(memoryStore(storedToken), fakeFetch().fn));
    const result = await client.callTool({ name: "marketing_list_sources", arguments: {} });
    const { sources } = result.structuredContent as {
      sources: Array<{ id: string; status: string }>;
    };
    expect(sources.find((s) => s.id === "google_search_console")?.status).toBe("configured");
    expect(
      sources.filter((s) => s.id !== "google_search_console").every((s) => s.status === "not_configured"),
    ).toBe(true);
  });

  it("gsc_list_sites marque les propriétés autorisées", async () => {
    const { fn, calls } = fakeFetch();
    client = await connect(googleDeps(memoryStore(storedToken), fn));
    const result = await client.callTool({ name: "gsc_list_sites", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      sites: [
        { siteUrl: "https://www.exemple.fr/", permissionLevel: "siteOwner", allowed: true },
        { siteUrl: "https://autre.fr/", permissionLevel: "siteFullUser", allowed: false },
      ],
    });
    const apiCall = calls.find((c) => c.url.endsWith("/sites"));
    expect(new Headers(apiCall?.init?.headers).get("Authorization")).toBe("Bearer access-1");
  });

  it("gsc_search_analytics envoie la requête et renvoie les lignes", async () => {
    const { fn, calls } = fakeFetch();
    client = await connect(googleDeps(memoryStore(storedToken), fn));
    const result = await client.callTool({
      name: "gsc_search_analytics",
      arguments: {
        siteUrl: "sc-domain:exemple.es",
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        dimensions: ["query"],
        filters: [{ dimension: "country", operator: "equals", expression: "esp" }],
        rowLimit: 10,
      },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ siteUrl: "sc-domain:exemple.es", rowCount: 1 });

    const apiCall = calls.find((c) => c.url.includes("/searchAnalytics/query"));
    expect(apiCall?.url).toBe(
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexemple.es/searchAnalytics/query",
    );
    expect(JSON.parse(String(apiCall?.init?.body))).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      dimensions: ["query"],
      type: "web",
      rowLimit: 10,
      startRow: 0,
      dimensionFilterGroups: [
        { groupType: "and", filters: [{ dimension: "country", operator: "equals", expression: "esp" }] },
      ],
    });
  });

  it("refuse une propriété absente de GSC_SITE_URLS sans appeler l'API", async () => {
    const { fn, calls } = fakeFetch();
    client = await connect(googleDeps(memoryStore(storedToken), fn));
    const result = await client.callTool({
      name: "gsc_search_analytics",
      arguments: { siteUrl: "https://autre.fr/", startDate: "2026-09-01", endDate: "2026-09-30" },
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("explique comment autoriser le compte quand il n'y a pas de jeton", async () => {
    client = await connect(googleDeps(memoryStore(), fakeFetch().fn));
    const result = await client.callTool({ name: "gsc_list_sites", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("auth:google");
  });

  it("explique comment relancer l'autorisation quand le jeton est expiré", async () => {
    client = await connect(
      googleDeps(memoryStore(storedToken), fakeFetch({ refreshError: "invalid_grant" }).fn),
    );
    const result = await client.callTool({ name: "gsc_list_sites", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("expirée ou révoquée");
  });

  it("signale que Google n'est pas configuré", async () => {
    client = await connect({});
    const result = await client.callTool({ name: "gsc_list_sites", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("GOOGLE_CLIENT_ID");
  });
});

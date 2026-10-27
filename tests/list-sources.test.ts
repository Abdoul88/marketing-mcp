import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { SOURCE_IDS } from "../src/sources.js";

describe("marketing_list_sources", () => {
  let client: Client;

  beforeEach(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
  });

  it("est exposé par le serveur", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("marketing_list_sources");
  });

  it("renvoie les 5 sources, toutes non configurées", async () => {
    const result = await client.callTool({
      name: "marketing_list_sources",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const { sources } = result.structuredContent as {
      sources: Array<{ id: string; status: string }>;
    };
    expect(sources.map((s) => s.id)).toEqual([...SOURCE_IDS]);
    expect(sources.every((s) => s.status === "not_configured")).toBe(true);
  });
});

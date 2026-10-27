import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

// Lance le serveur exactement comme Claude Code le fera, à partir de .mcp.json.
const config = JSON.parse(
  readFileSync(new URL("../.mcp.json", import.meta.url), "utf8"),
) as { mcpServers: Record<string, { command: string; args: string[] }> };
const entry = config.mcpServers["marketing-mcp"];

describe("serveur stdio lancé depuis .mcp.json", () => {
  it("répond à marketing_list_sources", async () => {
    expect(entry).toBeDefined();
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({ command: entry!.command, args: entry!.args }),
    );
    try {
      const result = await client.callTool({
        name: "marketing_list_sources",
        arguments: {},
      });
      const { sources } = result.structuredContent as {
        sources: unknown[];
      };
      expect(sources).toHaveLength(5);
    } finally {
      await client.close();
    }
  }, 30_000);
});

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  GOOGLE_TOKEN_PATH,
  loadEnvFile,
  readBingConfig,
  readGoogleAdsConfig,
  readGoogleConfig,
} from "./config.js";
import { BingWebmasterClient } from "./bing.js";
import { GoogleAdsClient } from "./google-ads.js";
import { fileTokenStore, GoogleAuth } from "./google-auth.js";
import { SearchConsoleClient } from "./gsc.js";
import { createServer, type ServerDeps } from "./server.js";

loadEnvFile();
const deps: ServerDeps = {};
const googleConfig = readGoogleConfig();
if (googleConfig) {
  const auth = new GoogleAuth(googleConfig, fileTokenStore(GOOGLE_TOKEN_PATH));
  const adsConfig = readGoogleAdsConfig();
  deps.google = {
    config: googleConfig,
    auth,
    gsc: new SearchConsoleClient(auth),
    adsConfig,
    ads: new GoogleAdsClient(auth, adsConfig),
  };
}
const bingConfig = readBingConfig();
if (bingConfig) {
  deps.bing = { config: bingConfig, client: new BingWebmasterClient(bingConfig) };
}

// En stdio, stdout est réservé au protocole MCP : les messages vont sur stderr.
const server = createServer(deps);
await server.connect(new StdioServerTransport());
console.error("marketing-mcp démarré (stdio)");

// Autorisation Google à lancer une fois : npm.cmd run auth:google
// Ouvre le navigateur, reçoit le code sur 127.0.0.1 puis enregistre le
// refresh token dans data/google-token.json (ignoré par Git).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  GOOGLE_TOKEN_PATH,
  loadEnvFile,
  readGoogleConfig,
} from "./config.js";
import {
  buildAuthUrl,
  createPkcePair,
  exchangeCode,
  fileTokenStore,
  GOOGLE_SCOPES,
} from "./google-auth.js";

const TIMEOUT_MS = 5 * 60_000;

loadEnvFile();
const config = readGoogleConfig();
if (!config) {
  console.error(
    "GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET doivent être définis dans .env.",
  );
  process.exit(1);
}

const pkce = createPkcePair();
const state = randomBytes(16).toString("hex");

const server = createServer();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;
const redirectUri = `http://127.0.0.1:${port}/callback`;

const code = await new Promise<string>((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("Délai dépassé (5 minutes) sans autorisation.")),
    TIMEOUT_MS,
  );
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const received = url.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (url.searchParams.get("state") !== state) {
      res.end("<p>Réponse refusée (state invalide).</p>");
      return;
    }
    if (error || !received) {
      res.end(`<p>Autorisation refusée : ${error ?? "code manquant"}.</p>`);
      clearTimeout(timer);
      reject(new Error(`Autorisation refusée : ${error ?? "code manquant"}`));
      return;
    }
    res.end("<p>Autorisation reçue. Tu peux fermer cet onglet.</p>");
    clearTimeout(timer);
    resolve(received);
  });

  const authUrl = buildAuthUrl({
    clientId: config.clientId,
    redirectUri,
    codeChallenge: pkce.challenge,
    state,
  });
  console.error("Ouvre cette adresse si le navigateur ne s'ouvre pas :");
  console.error(authUrl);
  // rundll32 transmet l'URL telle quelle (cmd /c start couperait aux « & »).
  if (process.platform === "win32") {
    spawn("rundll32", ["url.dll,FileProtocolHandler", authUrl], {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
}).finally(() => server.close());

const token = await exchangeCode(config, {
  code,
  redirectUri,
  codeVerifier: pkce.verifier,
});
await fileTokenStore(GOOGLE_TOKEN_PATH).write(token);
console.error(`Autorisation enregistrée dans ${GOOGLE_TOKEN_PATH}`);
// Google laisse décocher chaque accès sur l'écran de consentement.
const granted = token.scope.split(" ");
const missing = GOOGLE_SCOPES.filter((s) => !granted.includes(s));
if (missing.length) {
  console.error(`Accès non accordés : ${missing.join(", ")}. Relance la commande et coche-les.`);
}

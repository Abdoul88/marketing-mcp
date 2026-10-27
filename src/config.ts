import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Racine du projet : les chemins ne dépendent pas du dossier depuis lequel
// le serveur est lancé (Claude Code peut le démarrer de n'importe où).
export const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));
// data/ est ignoré par Git : le refresh token n'y entre jamais dans le dépôt.
export const GOOGLE_TOKEN_PATH = fileURLToPath(
  new URL("../data/google-token.json", import.meta.url),
);

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  // Propriétés Search Console autorisées, écrites exactement comme dans Search Console.
  siteUrls: string[];
}

export interface GoogleAdsConfig {
  // Version de l'API dans l'URL (ex. v26) ; Google retire chaque version après ~1 an.
  apiVersion: string;
  // Compte administrateur (MCC) par lequel passer pour lire ses comptes clients.
  loginCustomerId?: string;
  // Comptes interrogeables (10 chiffres, sans tirets) ; vide = tous ceux du compte.
  customerIds: string[];
  // Facultatif depuis le 9 septembre 2026 : Google l'ignore, l'accès dépend du projet Cloud.
  developerToken?: string;
}

export const GOOGLE_ADS_DEFAULT_API_VERSION = "v26";

/** « 123-456-7890 » → « 1234567890 » ; undefined si ce n'est pas un ID Google Ads. */
export function normalizeCustomerId(value: string): string | undefined {
  const id = value.replace(/[\s-]/g, "");
  return /^\d{10}$/.test(id) ? id : undefined;
}

export function readGoogleAdsConfig(
  env: NodeJS.ProcessEnv = process.env,
): GoogleAdsConfig {
  const rawIds = (env.GOOGLE_ADS_CUSTOMER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const customerIds = rawIds.map((raw) => {
    const id = normalizeCustomerId(raw);
    if (!id) throw new Error(`GOOGLE_ADS_CUSTOMER_IDS : ID invalide « ${raw} » (10 chiffres attendus).`);
    return id;
  });
  const rawLogin = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim();
  const loginCustomerId = rawLogin ? normalizeCustomerId(rawLogin) : undefined;
  if (rawLogin && !loginCustomerId) {
    throw new Error(`GOOGLE_ADS_LOGIN_CUSTOMER_ID : ID invalide « ${rawLogin} » (10 chiffres attendus).`);
  }
  return {
    apiVersion: env.GOOGLE_ADS_API_VERSION?.trim() || GOOGLE_ADS_DEFAULT_API_VERSION,
    loginCustomerId,
    customerIds,
    developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() || undefined,
  };
}

export interface BingConfig {
  apiKey: string;
  // Sites interrogeables, écrits exactement comme dans Bing Webmaster ; vide = tous ceux du compte.
  siteUrls: string[];
}

export function readBingConfig(env: NodeJS.ProcessEnv = process.env): BingConfig | undefined {
  const apiKey = env.BING_API_KEY?.trim();
  if (!apiKey) return undefined;
  const siteUrls = (env.BING_SITE_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { apiKey, siteUrls };
}

/** Charge .env dans process.env (sans écraser les variables déjà définies). */
export function loadEnvFile(path = ENV_PATH): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

export function readGoogleConfig(
  env: NodeJS.ProcessEnv = process.env,
): GoogleConfig | undefined {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return undefined;
  const siteUrls = (env.GSC_SITE_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { clientId, clientSecret, siteUrls };
}

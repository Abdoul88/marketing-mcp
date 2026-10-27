import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { GoogleConfig } from "./config.js";

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
// Google Ads n'a pas de scope lecture seule : la lecture seule est garantie par le
// serveur, qui n'appelle que les points d'accès de recherche (aucune modification possible).
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

export const GOOGLE_SCOPES = [GSC_SCOPE, GOOGLE_ADS_SCOPE] as const;

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type FetchFn = typeof fetch;

export interface StoredToken {
  refreshToken: string;
  scope: string;
  obtainedAt: string;
}

export interface TokenStore {
  read(): Promise<StoredToken | undefined>;
  write(token: StoredToken): Promise<void>;
}

export function fileTokenStore(path: string): TokenStore {
  return {
    async read() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as StoredToken;
        return parsed.refreshToken ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    async write(token) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(token, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
    },
  };
}

// --- Flux OAuth « application de bureau » (boucle locale + PKCE) ---

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    // offline + consent : Google renvoie un refresh token à chaque autorisation.
    access_type: "offline",
    prompt: "consent",
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    state: params.state,
  }).toString();
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function postToken(
  body: Record<string, string>,
  fetchImpl: FetchFn,
): Promise<TokenResponse> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error) {
    throw new GoogleAuthError(
      json.error ?? `http_${res.status}`,
      json.error_description ?? `Réponse HTTP ${res.status} de Google OAuth`,
    );
  }
  return json;
}

export class GoogleAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

export async function exchangeCode(
  config: GoogleConfig,
  params: { code: string; redirectUri: string; codeVerifier: string },
  fetchImpl: FetchFn = fetch,
): Promise<StoredToken> {
  const json = await postToken(
    {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: params.code,
      code_verifier: params.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: params.redirectUri,
    },
    fetchImpl,
  );
  if (!json.refresh_token) {
    throw new GoogleAuthError(
      "no_refresh_token",
      "Google n'a pas renvoyé de refresh token.",
    );
  }
  return {
    refreshToken: json.refresh_token,
    scope: json.scope ?? GOOGLE_SCOPES.join(" "),
    obtainedAt: new Date().toISOString(),
  };
}

// --- Jeton d'accès pour les appels API ---

export const AUTH_COMMAND = "npm.cmd run auth:google";

export class GoogleAuth {
  private cached: { token: string; expiresAt: number } | undefined;

  constructor(
    private readonly config: GoogleConfig,
    private readonly store: TokenStore,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  async hasRefreshToken(): Promise<boolean> {
    return (await this.store.read()) !== undefined;
  }

  /** Vrai si le compte autorisé a accordé ce scope (une autorisation antérieure peut ne pas l'inclure). */
  async hasScope(scope: string): Promise<boolean> {
    const stored = await this.store.read();
    return stored?.scope.split(" ").includes(scope) ?? false;
  }

  async getAccessToken(): Promise<string> {
    // Marge d'une minute pour ne pas envoyer un jeton sur le point d'expirer.
    if (this.cached && this.cached.expiresAt - 60_000 > Date.now()) {
      return this.cached.token;
    }
    const stored = await this.store.read();
    if (!stored) {
      throw new GoogleAuthError(
        "not_authorized",
        `Compte Google non autorisé. Lance « ${AUTH_COMMAND} » dans le dossier du projet.`,
      );
    }
    let json: TokenResponse;
    try {
      json = await postToken(
        {
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: stored.refreshToken,
          grant_type: "refresh_token",
        },
        this.fetchImpl,
      );
    } catch (err) {
      if (err instanceof GoogleAuthError && err.code === "invalid_grant") {
        // Cas typique : application OAuth en mode « Test » (jeton valable 7 jours) ou accès révoqué.
        throw new GoogleAuthError(
          "invalid_grant",
          `Autorisation Google expirée ou révoquée. Relance « ${AUTH_COMMAND} ».`,
        );
      }
      throw err;
    }
    if (!json.access_token) {
      throw new GoogleAuthError(
        "no_access_token",
        "Google n'a pas renvoyé de jeton d'accès.",
      );
    }
    this.cached = {
      token: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    return json.access_token;
  }
}

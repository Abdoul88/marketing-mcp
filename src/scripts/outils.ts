// Petits utilitaires partagés par les scripts (arguments, chemins, fichiers de données).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEnvFile, PROJECT_ROOT } from "../config.js";
import { hostKey } from "../dashboard/analyse.js";

loadEnvFile();
export const DATA = join(PROJECT_ROOT, "data");
export { hostKey };

/** --cle valeur, --drapeau, et arguments libres. */
export function args(argv = process.argv.slice(2)): { libres: string[]; opts: Record<string, string | true> } {
  const libres: string[] = [];
  const opts: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const suivant = argv[i + 1];
      if (suivant !== undefined && !suivant.startsWith("--")) { opts[a.slice(2)] = suivant; i++; }
      else opts[a.slice(2)] = true;
    } else libres.push(a);
  }
  return { libres, opts };
}

export function lireJson<T>(chemin: string, defaut: T): T {
  return existsSync(chemin) ? (JSON.parse(readFileSync(chemin, "utf8")) as T) : defaut;
}

export function ecrireJson(chemin: string, valeur: unknown): void {
  mkdirSync(dirname(chemin), { recursive: true });
  writeFileSync(chemin, JSON.stringify(valeur, null, 2));
}

export function slugifier(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

export function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

export const UA = "Mozilla/5.0 (compatible; marketing-mcp/1.0)";

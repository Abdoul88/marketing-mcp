// Extrait la charte graphique d'un site (couleurs, police, logo) → data/charte/<site>.json
// Usage : npm.cmd run charte -- https://blog.indigoneo.fr/
// Le fichier produit peut être corrigé à la main : les visuels relisent toujours ce fichier.
import { join } from "node:path";
import { args, DATA, ecrireJson, hostKey, stop, UA } from "./outils.js";

export interface Charte {
  site: string;
  nom: string;
  couleurs: string[]; // la première est la couleur principale
  fond: string;
  texte: string;
  police: string;
  logo: string | null;
  source: string;
  date: string;
}

const hex = (h: string) => {
  let s = h.toLowerCase().replace("#", "");
  if (s.length === 3) s = [...s].map((c) => c + c).join("");
  return "#" + s.slice(0, 6);
};
function rgbVersHex(r: number, g: number, b: number) {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}
function luminance(h: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function saturation(h: string) {
  const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const max = Math.max(...v), min = Math.min(...v);
  return max === 0 ? 0 : (max - min) / max;
}

export function extraireCouleurs(css: string): Array<{ couleur: string; n: number }> {
  const compte = new Map<string, number>();
  const add = (c: string, poids = 1) => compte.set(c, (compte.get(c) ?? 0) + poids);
  for (const m of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) add(hex(m[0]));
  for (const m of css.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi)) add(rgbVersHex(+m[1]!, +m[2]!, +m[3]!));
  // Les variables CSS « primary / brand / accent » pèsent plus lourd.
  for (const m of css.matchAll(/--[\w-]*(primary|brand|accent|main|secondary)[\w-]*\s*:\s*(#[0-9a-f]{3,6})/gi)) add(hex(m[2]!), 25);
  return [...compte.entries()].map(([couleur, n]) => ({ couleur, n })).sort((a, b) => b.n - a.n);
}

export function extrairePolice(css: string): string {
  const compte = new Map<string, number>();
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const premiere = m[1]!.split(",")[0]!.replace(/["']/g, "").trim();
    if (!premiere || /^(inherit|initial|var\(|-apple-system|system-ui|sans-serif|serif|monospace|dashicons|fontawesome|font awesome|icomoon|star)/i.test(premiere)) continue;
    compte.set(premiere, (compte.get(premiere) ?? 0) + 1);
  }
  return [...compte.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Arial";
}

async function main() {
  const { libres } = args();
  const site = libres[0] ?? stop("Usage : npm.cmd run charte -- https://www.exemple.fr/");
  const url = site.startsWith("sc-domain:") ? `https://${site.slice(10)}/` : site;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) stop(`Impossible de lire ${url} (HTTP ${res.status}).`);
  const html = await res.text();

  let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  css += [...html.matchAll(/style=["']([^"']+)["']/gi)].map((m) => m[1]).join(";");
  const feuilles = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/gi)].map((m) => new URL(m[1]!, url).toString());
  for (const f of feuilles.filter((f) => !/fonts\.googleapis|dashicons|font-?awesome|block-library/i.test(f)).slice(0, 8)) {
    try { css += "\n" + (await (await fetch(f, { headers: { "User-Agent": UA } })).text()); } catch { /* feuille illisible */ }
  }

  const theme = /<meta[^>]+name=["']theme-color["'][^>]*content=["'](#[0-9a-f]{3,6})["']/i.exec(html)?.[1];
  const couleurs = extraireCouleurs(css)
    .map((c) => c.couleur)
    .filter((c) => saturation(c) > 0.25 && luminance(c) > 0.08 && luminance(c) < 0.9);
  const marque = [...new Set([...(theme ? [hex(theme)] : []), ...couleurs])].slice(0, 6);
  const neutres = extraireCouleurs(css).map((c) => c.couleur).filter((c) => saturation(c) <= 0.25);

  const logo =
    /<img[^>]+(?:class|id|alt|src)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<img[^>]+src=["']([^"']*logo[^"']*)["']/i.exec(html)?.[1] ??
    /<link[^>]+rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1] ??
    null;
  const nom =
    /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ??
    new URL(url).hostname.replace(/^www\./, "");

  const charte: Charte = {
    site,
    nom,
    couleurs: marque.length ? marque : ["#2f5bd3"],
    fond: neutres.find((c) => luminance(c) > 0.92) ?? "#ffffff",
    texte: neutres.find((c) => luminance(c) < 0.2) ?? "#14181f",
    police: extrairePolice(css),
    logo: logo ? new URL(logo, url).toString() : null,
    source: url,
    date: new Date().toISOString(),
  };
  const chemin = join(DATA, "charte", `${hostKey(site)}.json`);
  ecrireJson(chemin, charte);
  console.log(JSON.stringify(charte, null, 2));
  console.log(`\nCharte enregistrée dans ${chemin}. Corrige-la à la main si une couleur ou le logo ne conviennent pas.`);
}

if (/charte\.ts$/.test(process.argv[1] ?? "")) await main();

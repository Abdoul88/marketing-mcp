// Crawl du site : Firecrawl (si FIRECRAWL_API_KEY est renseignée) ou crawler interne gratuit.
// Les deux produisent les mêmes pages ; l'analyse (codes HTTP, profondeur, liens internes,
// liens cassés, orphelines, métadonnées, volume de mots) est commune.
import { analyserHtml, problemes, type PageAudit, type Probleme } from "./audit.js";

type FetchFn = typeof fetch;
const UA = "Mozilla/5.0 (compatible; marketing-mcp-crawl/1.0)";
const NON_HTML = /\.(jpe?g|png|gif|webp|svg|avif|ico|pdf|zip|rar|mp4|mp3|webm|css|js|json|xml|txt|docx?|xlsx?|pptx?|woff2?|ttf)$/i;

export interface PageCrawl extends PageAudit {
  profondeur: number | null; // clics depuis l'accueil ; null = jamais atteinte par les liens
  liens: string[]; // liens internes sortants (URL absolues normalisées)
  liensEntrants: number;
  redirection?: string;
  h2: number;
  h3: number;
  schemas: string[];
  hreflang: number;
  lang: string;
  indexable: boolean;
  raisonNonIndexable?: string;
  dansSitemap: boolean;
}

export interface ResultatCrawl {
  site: string;
  date: string;
  moteur: "firecrawl" | "interne";
  depart: string;
  urlsSitemap: number;
  complet?: boolean;
  pages: PageCrawl[];
  synthese: SyntheseCrawl;
  problemes: Probleme[];
}

export interface SyntheseCrawl {
  total: number;
  parClasse: Record<"2xx" | "3xx" | "4xx" | "5xx" | "erreur", number>;
  parCode: Record<string, number>;
  indexables: number;
  nonIndexables: Record<string, number>;
  profondeurs: Array<{ profondeur: string; pages: number }>;
  profondeurMoyenne: number;
  mots: { median: number; moyenne: number; tranches: Array<{ tranche: string; pages: number }> };
  liensCasses: Array<{ source: string; cible: string; status: number }>;
  liensVersRedirections: Array<{ source: string; cible: string; finale: string }>;
  orphelines: string[]; // dans le sitemap mais sans lien interne entrant
  horsSitemap: string[]; // indexables trouvées par les liens mais absentes du sitemap
  peuDeLiensEntrants: string[];
  metaDupliquees: Array<{ meta: string; urls: string[] }>;
}

// --- utilitaires ---
export function normaliserUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|gclid|fbclid|mc_)/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return null;
  }
}

const memeHote = (a: string, b: string) => {
  try {
    return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, "");
  } catch {
    return false;
  }
};

export function liensInternes(html: string, url: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
    if (/\brel=["'][^"']*nofollow/i.test(m[0])) continue;
    const u = normaliserUrl(m[1]!, url);
    if (u && memeHote(u, url) && !NON_HTML.test(new URL(u).pathname)) out.add(u);
  }
  return [...out];
}

/** Informations supplémentaires pour le crawl : Hn, données structurées, hreflang, langue. */
export function enrichir(html: string) {
  const schemas = new Set<string>();
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const t of m[1]!.matchAll(/"@type"\s*:\s*(\[[^\]]*\]|"[^"]+")/g)) {
      for (const v of t[1]!.matchAll(/"([^"]+)"/g)) schemas.add(v[1]!);
    }
  }
  return {
    h2: (html.match(/<h2\b/gi) ?? []).length,
    h3: (html.match(/<h3\b/gi) ?? []).length,
    schemas: [...schemas],
    hreflang: (html.match(/<link[^>]+hreflang=/gi) ?? []).length,
    lang: /<html[^>]*\blang=["']([^"']+)["']/i.exec(html)?.[1] ?? "",
  };
}

function indexabilite(p: PageAudit): { indexable: boolean; raison?: string } {
  if (p.status === 0) return { indexable: false, raison: "injoignable" };
  if (p.status >= 300 && p.status < 400) return { indexable: false, raison: "redirection" };
  if (p.status >= 400) return { indexable: false, raison: `HTTP ${p.status}` };
  if (/noindex/i.test(p.robots)) return { indexable: false, raison: "noindex" };
  if (p.canonical) {
    const c = normaliserUrl(p.canonical, p.url);
    if (c && c.replace(/\/$/, "") !== p.url.replace(/\/$/, "")) return { indexable: false, raison: "canonical ailleurs" };
  }
  return { indexable: true };
}

function pageDepuisHtml(url: string, html: string, status: number, tempsMs: number, redirection?: string): PageCrawl {
  const a = analyserHtml(url, html, status, redirection ?? url, tempsMs);
  const idx = indexabilite(a);
  return {
    ...a, ...enrichir(html),
    profondeur: null, liens: html ? liensInternes(html, url) : [], liensEntrants: 0, redirection,
    indexable: idx.indexable, raisonNonIndexable: idx.raison, dansSitemap: false,
  };
}

// --- robots.txt et sitemap ---
export function reglesRobots(txt: string): string[] {
  const interdits: string[] = [];
  let concerne = false;
  for (const ligne of txt.split(/\r?\n/)) {
    const [k, ...v] = ligne.split(":");
    const cle = k?.trim().toLowerCase(), val = v.join(":").trim();
    if (cle === "user-agent") concerne = val === "*";
    else if (concerne && cle === "disallow" && val) interdits.push(val);
  }
  return interdits;
}

function autorise(url: string, interdits: string[]): boolean {
  const chemin = new URL(url).pathname + new URL(url).search;
  return !interdits.some((r) => {
    const re = new RegExp("^" + r.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
    return re.test(chemin);
  });
}

async function lireTexte(fetchImpl: FetchFn, url: string): Promise<string> {
  const r = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
  return r.ok ? r.text() : "";
}

export async function urlsSitemap(base: string, robots: string, fetchImpl: FetchFn): Promise<string[]> {
  const declares = [...robots.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]!);
  const defauts = [new URL("/sitemap_index.xml", base).toString(), new URL("/sitemap.xml", base).toString(), new URL("/wp-sitemap.xml", base).toString()];
  const vus = new Set<string>();
  const lire = async (depart: string[]) => {
    const urls = new Set<string>();
    const file = [...depart];
    while (file.length && vus.size < 60) {
      const s = file.shift()!;
      if (vus.has(s)) continue;
      vus.add(s);
      const xml = await lireTexte(fetchImpl, s).catch(() => "");
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
      if (/<sitemapindex/i.test(xml)) file.push(...locs);
      else for (const l of locs) if (!NON_HTML.test(l)) urls.add(l);
    }
    return urls;
  };
  const viaRobots = await lire(declares);
  if (viaRobots.size) return [...viaRobots];
  for (const d of defauts) {
    const u = await lire([d]);
    if (u.size) return [...u];
  }
  return [];
}

// --- crawler interne ---
export interface OptionsCrawl {
  maxPages?: number;
  maxProfondeur?: number;
  concurrence?: number;
  fetchImpl?: FetchFn;
  onProgres?: (fait: number, total: number) => void;
}

export async function crawlerInterne(siteUrl: string, opts: OptionsCrawl = {}): Promise<{ pages: PageCrawl[]; sitemap: string[]; depart: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const max = opts.maxPages ?? 500;
  const maxProf = opts.maxProfondeur ?? 10;
  const depart = siteUrl.startsWith("sc-domain:") ? `https://${siteUrl.slice(10)}/` : siteUrl;
  const robots = await lireTexte(fetchImpl, new URL("/robots.txt", depart).toString()).catch(() => "");
  const interdits = reglesRobots(robots);
  const sitemap = await urlsSitemap(depart, robots, fetchImpl).catch(() => [] as string[]);

  const pages = new Map<string, PageCrawl>();
  const prof = new Map<string, number>([[depart, 0]]);
  const file: string[] = [depart];
  const enFile = new Set(file);
  let actifs = 0;

  const ajouter = (u: string, p: number) => {
    if (enFile.has(u) || p > maxProf || !memeHote(u, depart) || !autorise(u, interdits)) return;
    if (enFile.size >= max) return;
    enFile.add(u);
    prof.set(u, p);
    file.push(u);
  };

  const traiter = async (url: string) => {
    const t0 = Date.now();
    let page: PageCrawl;
    try {
      const res = await fetchImpl(url, { headers: { "User-Agent": UA }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
      if (res.status >= 300 && res.status < 400) {
        const loc = normaliserUrl(res.headers.get("location") ?? "", url) ?? undefined;
        page = pageDepuisHtml(url, "", res.status, Date.now() - t0, loc);
        if (loc) ajouter(loc, prof.get(url)!);
      } else {
        const html = (res.headers.get("content-type") ?? "").includes("html") ? await res.text() : "";
        page = pageDepuisHtml(url, html, res.status, Date.now() - t0);
      }
    } catch {
      page = pageDepuisHtml(url, "", 0, Date.now() - t0);
    }
    page.profondeur = prof.get(url) ?? null;
    pages.set(url, page);
    for (const l of page.liens) ajouter(l, (prof.get(url) ?? 0) + 1);
  };

  await new Promise<void>((fin) => {
    const pomper = () => {
      while (actifs < (opts.concurrence ?? 6) && file.length) {
        const u = file.shift()!;
        actifs++;
        void traiter(u).finally(() => {
          actifs--;
          opts.onProgres?.(pages.size, Math.max(enFile.size, pages.size));
          if (!file.length && !actifs) {
            // Les URL du sitemap jamais atteintes par les liens sont crawlées ensuite (profondeur inconnue).
            const reste = sitemap.filter((s) => !enFile.has(s) && autorise(s, interdits)).slice(0, Math.max(0, max - enFile.size));
            if (reste.length) {
              for (const s of reste) { enFile.add(s); file.push(s); }
              pomper();
            } else fin();
          } else pomper();
        });
      }
    };
    pomper();
  });
  return { pages: [...pages.values()], sitemap, depart };
}

// --- Firecrawl ---
interface DocFirecrawl { rawHtml?: string; html?: string; links?: string[]; metadata?: Record<string, unknown> }

export async function crawlerFirecrawl(siteUrl: string, cle: string, opts: OptionsCrawl = {}): Promise<{ pages: PageCrawl[]; sitemap: string[]; depart: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const depart = siteUrl.startsWith("sc-domain:") ? `https://${siteUrl.slice(10)}/` : siteUrl;
  const h = { Authorization: `Bearer ${cle}`, "Content-Type": "application/json" };
  const r = await fetchImpl("https://api.firecrawl.dev/v2/crawl", {
    method: "POST", headers: h,
    body: JSON.stringify({
      url: depart, limit: opts.maxPages ?? 500, maxDiscoveryDepth: opts.maxProfondeur ?? 10, sitemap: "include",
      ignoreQueryParameters: true,
      scrapeOptions: { formats: ["rawHtml", "links"], onlyMainContent: false, blockAds: true },
    }),
  });
  const j = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!r.ok || !j.id) throw new Error(`Firecrawl (HTTP ${r.status}) : ${j.error ?? "crawl refusé"}`);

  const docs: DocFirecrawl[] = [];
  let suivant: string | undefined = `https://api.firecrawl.dev/v2/crawl/${j.id}`;
  for (let essai = 0; essai < 720; essai++) {
    const s = (await (await fetchImpl(`https://api.firecrawl.dev/v2/crawl/${j.id}`, { headers: h })).json()) as { status: string; completed?: number; total?: number; error?: string };
    opts.onProgres?.(s.completed ?? 0, s.total ?? 0);
    if (s.status === "completed") break;
    if (s.status === "failed" || s.status === "cancelled") throw new Error(`Firecrawl : crawl ${s.status} ${s.error ?? ""}`);
    await new Promise((ok) => setTimeout(ok, 5000));
  }
  while (suivant) {
    const p = (await (await fetchImpl(suivant, { headers: h })).json()) as { data?: DocFirecrawl[]; next?: string };
    docs.push(...(p.data ?? []));
    suivant = p.next;
  }

  const pages: PageCrawl[] = [];
  for (const d of docs) {
    const m = d.metadata ?? {};
    const url = String(m.sourceURL ?? m.url ?? "");
    if (!url) continue;
    const finale = String(m.url ?? url);
    const status = Number(m.statusCode ?? 0);
    const page = pageDepuisHtml(url, d.rawHtml ?? d.html ?? "", status, 0, finale !== url ? finale : undefined);
    if (d.links?.length) page.liens = [...new Set(d.links.map((l) => normaliserUrl(l, url)).filter((l): l is string => !!l && memeHote(l, url) && !NON_HTML.test(new URL(l).pathname)))];
    pages.push(page);
  }
  const robots = await lireTexte(fetchImpl, new URL("/robots.txt", depart).toString()).catch(() => "");
  const sitemap = await urlsSitemap(depart, robots, fetchImpl).catch(() => [] as string[]);
  return { pages, sitemap, depart };
}

// --- analyse ---
const sansSlash = (u: string) => u.replace(/\/$/, "");

/** Calcule profondeur (BFS depuis l'accueil), liens entrants, liens cassés, orphelines et synthèse. */
export function analyserCrawl(site: string, moteur: "firecrawl" | "interne", depart: string, pages: PageCrawl[], sitemap: string[]): ResultatCrawl {
  const parUrl = new Map<string, PageCrawl>();
  for (const p of pages) parUrl.set(sansSlash(p.url), p);
  const trouver = (u: string) => parUrl.get(sansSlash(u));
  const enSitemap = new Set(sitemap.map(sansSlash));
  for (const p of pages) p.dansSitemap = enSitemap.has(sansSlash(p.url));

  // Liens entrants (une source compte une fois par cible).
  for (const p of pages) p.liensEntrants = 0;
  for (const p of pages) for (const l of p.liens) { const c = trouver(l); if (c && c !== p) c.liensEntrants++; }

  // Profondeur par parcours en largeur (Firecrawl ne la fournit pas ; on la recalcule pour les deux moteurs).
  for (const p of pages) p.profondeur = null;
  const racine = trouver(depart) ?? pages[0];
  if (racine) {
    // Parcours 0-1 : un lien coûte un clic, une redirection (ex. / → /fr) n'en coûte pas.
    racine.profondeur = 0;
    const file = [racine];
    while (file.length) {
      const p = file.shift()!;
      if (p.redirection) {
        const c = trouver(p.redirection);
        if (c && (c.profondeur == null || c.profondeur > p.profondeur!)) { c.profondeur = p.profondeur!; file.unshift(c); }
      }
      for (const l of p.liens) {
        const c = trouver(l);
        if (c && (c.profondeur == null || c.profondeur > p.profondeur! + 1)) { c.profondeur = p.profondeur! + 1; file.push(c); }
      }
    }
  }

  const liensCasses: SyntheseCrawl["liensCasses"] = [];
  const liensVersRedirections: SyntheseCrawl["liensVersRedirections"] = [];
  for (const p of pages) {
    for (const l of p.liens) {
      const c = trouver(l);
      if (!c) continue;
      if (c.status >= 400 || c.status === 0) liensCasses.push({ source: p.url, cible: c.url, status: c.status });
      else if (c.status >= 300 && c.redirection) liensVersRedirections.push({ source: p.url, cible: c.url, finale: c.redirection });
    }
  }

  const classe = (s: number) => (s === 0 ? "erreur" : s < 300 ? "2xx" : s < 400 ? "3xx" : s < 500 ? "4xx" : "5xx") as keyof SyntheseCrawl["parClasse"];
  const parClasse = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, erreur: 0 };
  const parCode: Record<string, number> = {};
  const nonIndexables: Record<string, number> = {};
  for (const p of pages) {
    parClasse[classe(p.status)]++;
    parCode[String(p.status)] = (parCode[String(p.status)] ?? 0) + 1;
    if (!p.indexable && p.raisonNonIndexable) nonIndexables[p.raisonNonIndexable] = (nonIndexables[p.raisonNonIndexable] ?? 0) + 1;
  }
  const html200 = pages.filter((p) => p.status >= 200 && p.status < 300);
  const prof = new Map<string, number>();
  for (const p of html200) {
    const k = p.profondeur == null ? "non reliée" : p.profondeur >= 5 ? "5 et +" : String(p.profondeur);
    prof.set(k, (prof.get(k) ?? 0) + 1);
  }
  const ordreProf = ["0", "1", "2", "3", "4", "5 et +", "non reliée"];
  const reliees = html200.filter((p) => p.profondeur != null);
  const mots = html200.filter((p) => p.indexable).map((p) => p.wordCount).sort((a, b) => a - b);
  const tranchesMots = [["< 300", 0, 299], ["300 – 799", 300, 799], ["800 – 1 499", 800, 1499], ["1 500 et +", 1500, Infinity]] as const;
  const metas = new Map<string, string[]>();
  for (const p of html200) if (p.indexable && p.metaDescription) metas.set(p.metaDescription, [...(metas.get(p.metaDescription) ?? []), p.url]);

  const synthese: SyntheseCrawl = {
    total: pages.length, parClasse, parCode, indexables: pages.filter((p) => p.indexable).length, nonIndexables,
    profondeurs: ordreProf.filter((k) => prof.has(k)).map((k) => ({ profondeur: k, pages: prof.get(k)! })),
    profondeurMoyenne: reliees.length ? Math.round((reliees.reduce((s, p) => s + p.profondeur!, 0) / reliees.length) * 10) / 10 : 0,
    mots: {
      median: mots.length ? mots[Math.floor(mots.length / 2)]! : 0,
      moyenne: mots.length ? Math.round(mots.reduce((a, b) => a + b, 0) / mots.length) : 0,
      tranches: tranchesMots.map(([t, a, b]) => ({ tranche: t, pages: mots.filter((m) => m >= a && m <= b).length })),
    },
    liensCasses: liensCasses.slice(0, 500),
    liensVersRedirections: liensVersRedirections.slice(0, 500),
    orphelines: html200.filter((p) => p.dansSitemap && p.liensEntrants === 0 && sansSlash(p.url) !== sansSlash(depart)).map((p) => p.url),
    horsSitemap: sitemap.length ? html200.filter((p) => p.indexable && !p.dansSitemap).map((p) => p.url) : [],
    peuDeLiensEntrants: html200.filter((p) => p.indexable && p.liensEntrants > 0 && p.liensEntrants < 3).map((p) => p.url),
    metaDupliquees: [...metas.entries()].filter(([, l]) => l.length > 1).map(([meta, urls]) => ({ meta, urls })).slice(0, 100),
  };

  // Problèmes : ceux de l'audit (sur les pages 200), plus ceux propres au crawl.
  const pbs = problemes(html200, sitemap.length ? "sitemap" : null).filter((p) => p.code !== "erreur_http" && p.code !== "redirection");
  const add = (gravite: Probleme["gravite"], code: string, message: string, urls: string[]) => { if (urls.length) pbs.push({ gravite, code, message, urls }); };
  add("critique", "liens_casses", "Liens internes vers des pages en erreur (4xx, 5xx) : corriger le lien ou rediriger la cible.", [...new Set(liensCasses.map((l) => l.cible))]);
  add("important", "liens_redirection", "Liens internes vers des URL qui redirigent : pointer directement vers l'URL finale.", [...new Set(liensVersRedirections.map((l) => l.cible))]);
  add("important", "orphelines", "Pages du sitemap sans aucun lien interne entrant (orphelines).", synthese.orphelines);
  add("important", "profondeur", "Pages à 4 clics ou plus de l'accueil : les remonter dans le maillage.", html200.filter((p) => p.indexable && (p.profondeur ?? 0) >= 4).map((p) => p.url));
  add("mineur", "hors_sitemap", "Pages indexables absentes du sitemap.", synthese.horsSitemap);
  add("mineur", "meta_dupliquee", "Meta descriptions identiques sur plusieurs pages.", synthese.metaDupliquees.flatMap((m) => m.urls));
  add("mineur", "sans_schema", "Pages indexables sans données structurées (JSON-LD).", html200.filter((p) => p.indexable && !p.schemas.length).map((p) => p.url));
  const ordre = { critique: 0, important: 1, mineur: 2 };
  pbs.sort((a, b) => ordre[a.gravite] - ordre[b.gravite] || b.urls.length - a.urls.length);

  return { site, date: new Date().toISOString(), moteur, depart, urlsSitemap: sitemap.length, pages: pages.sort((a, b) => (a.profondeur ?? 99) - (b.profondeur ?? 99) || a.url.localeCompare(b.url)), synthese, problemes: pbs };
}

export async function crawler(siteUrl: string, opts: OptionsCrawl & { cleFirecrawl?: string } = {}): Promise<ResultatCrawl> {
  const moteur = opts.cleFirecrawl ? "firecrawl" : "interne";
  const r = opts.cleFirecrawl ? await crawlerFirecrawl(siteUrl, opts.cleFirecrawl, opts) : await crawlerInterne(siteUrl, opts);
  const res = analyserCrawl(siteUrl, moteur, r.depart, r.pages, r.sitemap);
  // Crawl tronqué si la limite de pages est atteinte : on ne peut alors rien conclure des pages non vues.
  res.complet = r.pages.length < (opts.maxPages ?? 500);
  return res;
}

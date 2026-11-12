// Audit technique gratuit : lit le sitemap du site, télécharge un échantillon de pages
// et relève les problèmes courants (sans Firecrawl ni service payant).

export interface PageAudit {
  url: string;
  status: number;
  finalUrl: string;
  title: string;
  titleLength: number;
  metaDescription: string;
  metaLength: number;
  h1: string[];
  canonical: string;
  robots: string;
  ogImage: string;
  maxImagePreviewLarge: boolean;
  datePublished: boolean;
  wordCount: number;
  internalLinks: number;
  imagesSansAlt: number;
  tempsMs: number;
}

export interface Probleme {
  gravite: "critique" | "important" | "mineur";
  code: string;
  message: string;
  urls: string[];
}

export interface ResultatAudit {
  site: string;
  date: string;
  sitemap: string | null;
  urlsSitemap: number;
  pages: PageAudit[];
  problemes: Probleme[];
}

type FetchFn = typeof fetch;
const UA = "Mozilla/5.0 (compatible; marketing-mcp-audit/1.0)";

function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&rsquo;|&#8217;/g, "'")
    .replace(/&nbsp;|&#160;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function meta(html: string, attr: "name" | "property", value: string): string {
  const re1 = new RegExp(`<meta[^>]+${attr}=["']${value}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${value}["']`, "i");
  return decode(re1.exec(html)?.[1] ?? re2.exec(html)?.[1] ?? "");
}

export function analyserHtml(url: string, html: string, status: number, finalUrl: string, tempsMs: number): PageAudit {
  const host = new URL(finalUrl || url).hostname.replace(/^www\./, "");
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ") ?? "");
  const metaDescription = meta(html, "name", "description");
  const h1 = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => decode(m[1]!.replace(/<[^>]+>/g, "")));
  const canonical = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(html)?.[1]
    ?? /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i.exec(html)?.[1] ?? "";
  const robots = meta(html, "name", "robots");
  const ogImage = meta(html, "property", "og:image");
  const corps = (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html)
    .replace(/<(script|style|nav|header|footer|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  const wordCount = decode(corps).split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
  let internalLinks = 0;
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    try {
      const h = new URL(m[1]!, finalUrl || url).hostname.replace(/^www\./, "");
      if (h === host) internalLinks++;
    } catch { /* lien invalide */ }
  }
  const imagesSansAlt = [...html.matchAll(/<img\b[^>]*>/gi)].filter((m) => !/\balt=["'][^"']+["']/i.test(m[0])).length;
  return {
    url, status, finalUrl, title, titleLength: title.length, metaDescription, metaLength: metaDescription.length,
    h1, canonical, robots, ogImage,
    maxImagePreviewLarge: /max-image-preview\s*:\s*large/i.test(robots) || /max-image-preview:large/i.test(html),
    datePublished: /"datePublished"|article:published_time/i.test(html),
    wordCount, internalLinks, imagesSansAlt, tempsMs,
  };
}

async function lireSitemap(base: string, fetchImpl: FetchFn): Promise<{ sitemap: string | null; urls: string[] }> {
  const candidats: string[] = [];
  try {
    const robots = await (await fetchImpl(new URL("/robots.txt", base), { headers: { "User-Agent": UA } })).text();
    for (const m of robots.matchAll(/^sitemap:\s*(\S+)/gim)) candidats.push(m[1]!);
  } catch { /* pas de robots.txt */ }
  candidats.push(new URL("/sitemap_index.xml", base).toString(), new URL("/sitemap.xml", base).toString(), new URL("/wp-sitemap.xml", base).toString());
  for (const sitemap of candidats) {
    try {
      const res = await fetchImpl(sitemap, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const xml = await res.text();
      const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]!));
      if (!locs.length) continue;
      if (/<sitemapindex/i.test(xml)) {
        const urls: string[] = [];
        // On privilégie les sitemaps d'articles et de pages, dans la limite de 10.
        const enfants = [...locs].sort((a, b) => Number(/post|page|article/i.test(b)) - Number(/post|page|article/i.test(a))).slice(0, 10);
        for (const enfant of enfants) {
          try {
            const x = await (await fetchImpl(enfant, { headers: { "User-Agent": UA } })).text();
            urls.push(...[...x.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]!)));
          } catch { /* sitemap enfant illisible */ }
        }
        return { sitemap, urls: [...new Set(urls)].filter((u) => !/\.(xml|jpe?g|png|webp|gif|pdf)$/i.test(u)) };
      }
      return { sitemap, urls: [...new Set(locs)] };
    } catch { /* candidat suivant */ }
  }
  return { sitemap: null, urls: [] };
}

export async function auditer(
  siteUrl: string,
  options: { maxPages?: number; fetchImpl?: FetchFn; urls?: string[] } = {},
): Promise<ResultatAudit> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxPages = options.maxPages ?? 50;
  const base = siteUrl.startsWith("sc-domain:") ? `https://${siteUrl.slice(10)}/` : siteUrl;
  const { sitemap, urls } = options.urls ? { sitemap: null, urls: options.urls } : await lireSitemap(base, fetchImpl);
  const cible = (urls.length ? urls : [base]).slice(0, maxPages);

  const pages: PageAudit[] = [];
  const file = [...cible];
  const travail = async () => {
    for (let url = file.shift(); url; url = file.shift()) {
      const t0 = Date.now();
      try {
        const res = await fetchImpl(url, { headers: { "User-Agent": UA }, redirect: "follow" });
        const html = (res.headers.get("content-type") ?? "").includes("html") ? await res.text() : "";
        pages.push(analyserHtml(url, html, res.status, res.url || url, Date.now() - t0));
      } catch {
        pages.push(analyserHtml(url, "", 0, url, Date.now() - t0));
      }
    }
  };
  await Promise.all([travail(), travail(), travail(), travail()]);
  pages.sort((a, b) => a.url.localeCompare(b.url));
  return { site: siteUrl, date: new Date().toISOString(), sitemap, urlsSitemap: urls.length, pages, problemes: problemes(pages, sitemap) };
}

export function problemes(pages: PageAudit[], sitemap: string | null): Probleme[] {
  const out: Probleme[] = [];
  const add = (gravite: Probleme["gravite"], code: string, message: string, liste: PageAudit[]) => {
    if (liste.length) out.push({ gravite, code, message, urls: liste.map((p) => p.url) });
  };
  if (!sitemap) out.push({ gravite: "important", code: "sitemap", message: "Aucun sitemap trouvé (robots.txt, /sitemap.xml, /sitemap_index.xml).", urls: [] });
  const ok = pages.filter((p) => p.status >= 200 && p.status < 300);
  add("critique", "erreur_http", "Pages du sitemap en erreur (4xx, 5xx ou injoignables) : à corriger ou retirer du sitemap.", pages.filter((p) => p.status === 0 || p.status >= 400));
  add("important", "redirection", "Pages du sitemap qui redirigent : mettre l'URL finale dans le sitemap.", ok.filter((p) => p.finalUrl && p.finalUrl.replace(/\/$/, "") !== p.url.replace(/\/$/, "")));
  add("critique", "noindex", "Pages du sitemap en noindex.", ok.filter((p) => /noindex/i.test(p.robots)));
  add("important", "title_absent", "Title absent.", ok.filter((p) => !p.title));
  add("mineur", "title_long", "Title de plus de 60 caractères (tronqué dans Google).", ok.filter((p) => p.titleLength > 60));
  add("mineur", "title_court", "Title de moins de 30 caractères.", ok.filter((p) => p.title && p.titleLength < 30));
  add("important", "meta_absente", "Meta description absente.", ok.filter((p) => !p.metaDescription));
  add("mineur", "meta_longue", "Meta description de plus de 160 caractères.", ok.filter((p) => p.metaLength > 160));
  add("important", "h1", "Aucun H1 ou plusieurs H1.", ok.filter((p) => p.h1.length !== 1));
  add("mineur", "canonical", "Canonical absente ou pointant vers une autre URL.", ok.filter((p) => !p.canonical || p.canonical.replace(/\/$/, "") !== (p.finalUrl || p.url).replace(/\/$/, "")));
  add("important", "contenu_mince", "Moins de 300 mots de contenu.", ok.filter((p) => p.wordCount < 300));
  add("mineur", "maillage_faible", "Moins de 5 liens internes dans la page.", ok.filter((p) => p.internalLinks < 5));
  add("mineur", "images_alt", "Images sans attribut alt.", ok.filter((p) => p.imagesSansAlt > 0));
  add("important", "discover_image", "Pas d'og:image : la page ne peut pas sortir avec une grande image dans Discover.", ok.filter((p) => !p.ogImage));
  add("important", "discover_preview", "Pas de max-image-preview:large : Discover affichera une petite vignette.", ok.filter((p) => !p.maxImagePreviewLarge));
  add("mineur", "lenteur", "Réponse HTML de plus de 2 secondes.", ok.filter((p) => p.tempsMs > 2000));
  const parTitle = new Map<string, PageAudit[]>();
  for (const p of ok) if (p.title) parTitle.set(p.title, [...(parTitle.get(p.title) ?? []), p]);
  add("important", "title_duplique", "Titles identiques sur plusieurs pages.", [...parTitle.values()].filter((l) => l.length > 1).flat());
  const ordre = { critique: 0, important: 1, mineur: 2 };
  return out.sort((a, b) => ordre[a.gravite] - ordre[b.gravite] || b.urls.length - a.urls.length);
}

// Benchmark d'une page face au top 3 Google d'une requête : SERP et scrape via Firecrawl
// (FIRECRAWL_API_KEY), puis comparaison de la structure (mots, Hn, FAQ, schémas, liens, médias).
import { analyserHtml } from "./audit.js";
import { enrichir } from "./crawl.js";
import { tokens } from "./mots-cles.js";

type FetchFn = typeof fetch;

export interface ProfilPage {
  url: string;
  position?: number;
  title: string;
  metaDescription: string;
  mots: number;
  h1: number; h2: number; h3: number;
  faq: boolean;
  schemas: string[];
  liensInternes: number;
  images: number;
  tableaux: number;
  listes: number;
  requeteDansTitle: boolean;
  annee: boolean;
  couverture: number; // part des termes fréquents du top 3 présents dans la page
}

export interface ResultatBenchmark {
  requete: string;
  date: string;
  maPage: ProfilPage | null;
  concurrents: ProfilPage[];
  mediane: Partial<ProfilPage>;
  termesManquants: string[];
  ecarts: string[];
}

const mediane = (l: number[]) => { const s = [...l].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };

function texteVisible(html: string): string {
  return (/<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html)
    .replace(/<(script|style|nav|header|footer|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
}

export function profiler(url: string, html: string, requete: string, position?: number): ProfilPage {
  const a = analyserHtml(url, html, 200, url, 0);
  const e = enrichir(html);
  const qt = tokens(requete);
  const tt = new Set(tokens(a.title));
  return {
    url, position, title: a.title, metaDescription: a.metaDescription, mots: a.wordCount,
    h1: a.h1.length, h2: e.h2, h3: e.h3,
    faq: e.schemas.includes("FAQPage") || /<h[23][^>]*>[^<]*(faq|questions fréquentes|preguntas frecuentes)/i.test(html) || (html.match(/<h[23][^>]*>[^<]*\?\s*<\/h[23]>/gi) ?? []).length >= 3,
    schemas: e.schemas, liensInternes: a.internalLinks,
    images: (html.match(/<img\b/gi) ?? []).length, tableaux: (html.match(/<table\b/gi) ?? []).length, listes: (html.match(/<(ul|ol)\b/gi) ?? []).length,
    requeteDansTitle: qt.length > 0 && qt.every((t) => tt.has(t)),
    annee: /\b20\d\d\b/.test(a.title), couverture: 0,
  };
}

/** Termes présents dans au moins 2 pages du top 3 : le lexique attendu par Google sur la requête. */
export function termesAttendus(textes: string[], requete: string): string[] {
  const exclus = new Set(tokens(requete));
  const df = new Map<string, number>();
  for (const t of textes) for (const m of new Set(tokens(t))) if (m.length > 3 && !exclus.has(m) && !/^\d+$/.test(m)) df.set(m, (df.get(m) ?? 0) + 1);
  const tf = new Map<string, number>();
  for (const t of textes) for (const m of tokens(t)) if (df.has(m)) tf.set(m, (tf.get(m) ?? 0) + 1);
  return [...df.entries()].filter(([, n]) => n >= Math.min(2, textes.length)).map(([m]) => m).sort((a, b) => (tf.get(b) ?? 0) - (tf.get(a) ?? 0)).slice(0, 60);
}

export function comparer(requete: string, maPage: ProfilPage | null, monTexte: string, concurrents: Array<{ profil: ProfilPage; texte: string }>): ResultatBenchmark {
  const attendus = termesAttendus(concurrents.map((c) => c.texte), requete);
  const couv = (texte: string) => { const t = new Set(tokens(texte)); return attendus.length ? Math.round((attendus.filter((m) => t.has(m)).length / attendus.length) * 100) / 100 : 0; };
  for (const c of concurrents) c.profil.couverture = couv(c.texte);
  if (maPage) maPage.couverture = couv(monTexte);
  const P = concurrents.map((c) => c.profil);
  const med: Partial<ProfilPage> = {
    mots: mediane(P.map((p) => p.mots)), h2: mediane(P.map((p) => p.h2)), h3: mediane(P.map((p) => p.h3)),
    images: mediane(P.map((p) => p.images)), liensInternes: mediane(P.map((p) => p.liensInternes)), couverture: mediane(P.map((p) => p.couverture)),
  };
  const ecarts: string[] = [];
  const manquants = maPage ? attendus.filter((m) => !new Set(tokens(monTexte)).has(m)).slice(0, 25) : attendus.slice(0, 25);
  if (maPage) {
    if (maPage.mots < (med.mots ?? 0) * 0.7) ecarts.push(`Contenu plus court : ${maPage.mots} mots contre ${med.mots} en médiane dans le top 3.`);
    if (maPage.h2 < (med.h2 ?? 0) - 1) ecarts.push(`Moins de sections : ${maPage.h2} H2 contre ${med.h2}.`);
    if (!maPage.faq && P.filter((p) => p.faq).length >= 2) ecarts.push("Pas de FAQ alors que la plupart des concurrents en ont une.");
    const schemasConc = new Map<string, number>();
    for (const p of P) for (const s of p.schemas) schemasConc.set(s, (schemasConc.get(s) ?? 0) + 1);
    const manqueSchema = [...schemasConc.entries()].filter(([s, n]) => n >= 2 && !maPage.schemas.includes(s)).map(([s]) => s);
    if (manqueSchema.length) ecarts.push(`Données structurées utilisées par les concurrents et absentes ici : ${manqueSchema.join(", ")}.`);
    if (!maPage.requeteDansTitle && P.filter((p) => p.requeteDansTitle).length >= 2) ecarts.push(`Le title ne contient pas la requête « ${requete} », contrairement au top 3.`);
    if (!maPage.annee && P.filter((p) => p.annee).length >= 2) ecarts.push("Les concurrents datent leur title (année) : signal de fraîcheur à ajouter.");
    if (maPage.images < (med.images ?? 0) / 2) ecarts.push(`Peu de visuels : ${maPage.images} images contre ${med.images}.`);
    if (P.filter((p) => p.tableaux > 0).length >= 2 && !maPage.tableaux) ecarts.push("Pas de tableau comparatif (prix, horaires, distances) alors que le top 3 en utilise.");
    if (maPage.couverture < (med.couverture ?? 0) - 0.15) ecarts.push(`Couverture sémantique ${Math.round(maPage.couverture * 100)} % contre ${Math.round((med.couverture ?? 0) * 100)} % : intégrer les termes manquants.`);
  }
  return { requete, date: new Date().toISOString(), maPage, concurrents: P, mediane: med, termesManquants: manquants, ecarts };
}

export async function benchmarker(
  requete: string,
  maPageUrl: string | undefined,
  opts: { cle: string; pays?: string; langue?: string; fetchImpl?: FetchFn },
): Promise<ResultatBenchmark> {
  const f = opts.fetchImpl ?? fetch;
  const r = await f("https://api.firecrawl.dev/v2/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.cle}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: requete, limit: 6, location: opts.pays ?? "France", scrapeOptions: { formats: ["rawHtml"], onlyMainContent: false } }),
  });
  const j = (await r.json().catch(() => ({}))) as { data?: { web?: Array<{ url: string; rawHtml?: string; html?: string }> } | Array<{ url: string; rawHtml?: string }>; error?: string };
  if (!r.ok) throw new Error(`Firecrawl (HTTP ${r.status}) : ${j.error ?? "recherche refusée"}`);
  const res = Array.isArray(j.data) ? j.data : (j.data?.web ?? []);
  const hote = maPageUrl ? new URL(maPageUrl).hostname.replace(/^www\./, "") : "";
  const conc = res
    .map((x, i) => ({ ...x, position: i + 1 }))
    .filter((x) => !hote || !new URL(x.url).hostname.endsWith(hote))
    .filter((x) => x.rawHtml)
    .slice(0, 3)
    .map((x) => ({ profil: profiler(x.url, x.rawHtml!, requete, x.position), texte: texteVisible(x.rawHtml!) }));
  let maPage: ProfilPage | null = null, monTexte = "";
  if (maPageUrl) {
    const html = await (await f(maPageUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; marketing-mcp-benchmark/1.0)" } })).text().catch(() => "");
    if (html) { maPage = profiler(maPageUrl, html, requete); monTexte = texteVisible(html); }
  }
  return comparer(requete, maPage, monTexte, conc);
}

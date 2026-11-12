// Core Web Vitals via l'API PageSpeed Insights v5 (gratuite ; clé facultative PAGESPEED_API_KEY
// pour un quota plus large). Données terrain (CrUX, 28 jours d'utilisateurs Chrome) + labo (Lighthouse).

type FetchFn = typeof fetch;
export type Strategie = "mobile" | "desktop";
export type Note = "bon" | "a_ameliorer" | "mauvais";

export interface Metrique { p75: number; note: Note }
export interface Terrain { lcp?: Metrique; inp?: Metrique; cls?: Metrique; fcp?: Metrique; ttfb?: Metrique; global?: Note }

export interface ResultatPsi {
  url: string;
  strategie: Strategie;
  date: string;
  score: number | null; // performance Lighthouse sur 100
  labo: { lcp: number | null; cls: number | null; tbt: number | null; fcp: number | null; si: number | null };
  terrainPage: Terrain | null;
  terrainOrigine: Terrain | null;
  opportunites: Array<{ id: string; titre: string; gainMs: number }>;
  erreur?: string;
}

// Seuils officiels (web.dev) : bon ≤ s1, mauvais > s2.
export const SEUILS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], fcp: [1800, 3000], ttfb: [800, 1800] } as const;

export function noter(metrique: keyof typeof SEUILS, valeur: number): Note {
  const [a, b] = SEUILS[metrique];
  return valeur <= a ? "bon" : valeur <= b ? "a_ameliorer" : "mauvais";
}

const CLES: Record<string, keyof typeof SEUILS> = {
  LARGEST_CONTENTFUL_PAINT_MS: "lcp",
  INTERACTION_TO_NEXT_PAINT: "inp",
  CUMULATIVE_LAYOUT_SHIFT_SCORE: "cls",
  FIRST_CONTENTFUL_PAINT_MS: "fcp",
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: "ttfb",
};

export function lireTerrain(exp: { metrics?: Record<string, { percentile?: number }>; overall_category?: string } | undefined): Terrain | null {
  if (!exp?.metrics || !Object.keys(exp.metrics).length) return null;
  const t: Terrain = {};
  for (const [k, m] of Object.entries(exp.metrics)) {
    const cle = CLES[k];
    if (!cle || m.percentile == null) continue;
    const v = cle === "cls" ? m.percentile / 100 : m.percentile; // CrUX donne le CLS × 100
    t[cle] = { p75: v, note: noter(cle, v) };
  }
  // Les Core Web Vitals sont validés si LCP, INP et CLS sont « bons » au 75e centile.
  const cwv = [t.lcp, t.inp, t.cls].filter(Boolean) as Metrique[];
  if (cwv.length) t.global = cwv.some((m) => m.note === "mauvais") ? "mauvais" : cwv.every((m) => m.note === "bon") ? "bon" : "a_ameliorer";
  return t;
}

export async function analyserPsi(url: string, strategie: Strategie, cle?: string, fetchImpl: FetchFn = fetch): Promise<ResultatPsi> {
  const u = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  u.searchParams.set("url", url);
  u.searchParams.set("strategy", strategie);
  u.searchParams.set("category", "performance");
  if (cle) u.searchParams.set("key", cle);
  const base: ResultatPsi = { url, strategie, date: new Date().toISOString(), score: null, labo: { lcp: null, cls: null, tbt: null, fcp: null, si: null }, terrainPage: null, terrainOrigine: null, opportunites: [] };
  try {
    const r = await fetchImpl(u, { signal: AbortSignal.timeout(120_000) });
    const j = (await r.json()) as {
      error?: { message?: string };
      loadingExperience?: Parameters<typeof lireTerrain>[0] & { origin_fallback?: boolean };
      originLoadingExperience?: Parameters<typeof lireTerrain>[0];
      lighthouseResult?: {
        categories?: { performance?: { score?: number } };
        audits?: Record<string, { title?: string; numericValue?: number; details?: { type?: string; overallSavingsMs?: number } }>;
      };
    };
    if (!r.ok) return { ...base, erreur: `PageSpeed (HTTP ${r.status}) : ${j.error?.message ?? "erreur"}` };
    const a = j.lighthouseResult?.audits ?? {};
    const num = (k: string) => (a[k]?.numericValue != null ? Math.round(a[k]!.numericValue! * (k === "cumulative-layout-shift" ? 1000 : 1)) / (k === "cumulative-layout-shift" ? 1000 : 1) : null);
    return {
      ...base,
      score: j.lighthouseResult?.categories?.performance?.score != null ? Math.round(j.lighthouseResult.categories.performance.score * 100) : null,
      labo: { lcp: num("largest-contentful-paint"), cls: num("cumulative-layout-shift"), tbt: num("total-blocking-time"), fcp: num("first-contentful-paint"), si: num("speed-index") },
      // Si la page n'a pas assez de trafic, Google renvoie les données de l'origine : on ne les attribue pas à la page.
      terrainPage: j.loadingExperience?.origin_fallback ? null : lireTerrain(j.loadingExperience),
      terrainOrigine: lireTerrain(j.originLoadingExperience),
      opportunites: Object.entries(a)
        .filter(([, x]) => x.details?.type === "opportunity" && (x.details.overallSavingsMs ?? 0) >= 100)
        .map(([id, x]) => ({ id, titre: x.title ?? id, gainMs: Math.round(x.details!.overallSavingsMs!) }))
        .sort((x, y) => y.gainMs - x.gainMs)
        .slice(0, 6),
    };
  } catch (e) {
    return { ...base, erreur: (e as Error).message };
  }
}

export async function analyserPages(
  urls: string[],
  strategies: Strategie[],
  opts: { cle?: string; fetchImpl?: FetchFn; onProgres?: (fait: number, total: number) => void } = {},
): Promise<ResultatPsi[]> {
  const taches = urls.flatMap((url) => strategies.map((s) => ({ url, s })));
  const out: ResultatPsi[] = [];
  const file = [...taches];
  // 2 analyses en parallèle : PageSpeed est lent (10 à 30 s) et limite le débit sans clé.
  await Promise.all([0, 1].map(async () => {
    for (let t = file.shift(); t; t = file.shift()) {
      out.push(await analyserPsi(t.url, t.s, opts.cle, opts.fetchImpl));
      opts.onProgres?.(out.length, taches.length);
    }
  }));
  return out;
}

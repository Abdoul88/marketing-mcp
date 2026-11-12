// Visibilité locale : API Analytics de Yext (lecture seule, YEXT_API_KEY).
// Vues Google Search / Maps, vues Apple et Bing, actions (itinéraires, clics site, appels) par éditeur,
// mois par mois, pour un dossier Yext (pays, bornes de recharge…) ou pour tout le compte.

type FetchFn = typeof fetch;

export interface Segment { id: string; nom: string; dossiers?: string[]; moins?: string }

/** Dossiers Yext d'INDIGO (identifiants externes) ; un dossier inclut ses sous-dossiers. */
export const SEGMENTS: Segment[] = [
  { id: "tous", nom: "Tous les pays" },
  { id: "fr", nom: "France", dossiers: ["fR"] },
  { id: "fr-parkings", nom: "France · parkings", dossiers: ["fR"], moins: "fr-bornes" },
  { id: "fr-bornes", nom: "France · bornes de recharge", dossiers: ["eVStations", "ouestEV"] },
  { id: "be", nom: "Belgique", dossiers: ["bE"] },
  { id: "be-bornes", nom: "Belgique · bornes", dossiers: ["bEEV"] },
  { id: "es", nom: "Espagne", dossiers: ["eS"] },
  { id: "ca", nom: "Canada", dossiers: ["cA"] },
  { id: "ch", nom: "Suisse", dossiers: ["cH"] },
  { id: "lu", nom: "Luxembourg", dossiers: ["lU"] },
  { id: "ad", nom: "Andorre", dossiers: ["aD"] },
  { id: "br", nom: "Brésil", dossiers: ["bR"] },
];

/** Identifiants d'éditeur (dimension SITES) : Google et Apple, le reste est regroupé. */
const EDITEURS: Record<string, string> = { "715": "Google", "950": "Apple Plans" };

export interface ActionsMois { itineraires: number; siteWeb: number; appels: number; autres: number; total: number }
export interface Mois {
  mois: string;
  googleSearch: number;
  googleMaps: number;
  appleVues: number;
  bingVues: number;
  google: ActionsMois;
  apple: ActionsMois;
  autresEditeurs: ActionsMois;
}

const vide = (): ActionsMois => ({ itineraires: 0, siteWeb: 0, appels: 0, autres: 0, total: 0 });

function ajouterAction(a: ActionsMois, action: string, n: number) {
  const x = action.toLowerCase();
  if (x.startsWith("driving")) a.itineraires += n;
  else if (x === "website") a.siteWeb += n;
  else if (x.includes("call")) a.appels += n;
  else a.autres += n;
  a.total += n;
}

const moisDe = (v: unknown) => String(v ?? "").slice(0, 7);

export class YextClient {
  constructor(
    private readonly cle: string,
    private readonly base = "https://api.eu.yext.com",
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  async rapport(metrics: string[], dimensions: string[], filtres: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const r = await this.fetchImpl(`${this.base}/v2/accounts/me/analytics/reports?api_key=${encodeURIComponent(this.cle)}&v=20250101`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metrics, dimensions, filters: filtres }),
      signal: AbortSignal.timeout(120_000),
    });
    const j = (await r.json().catch(() => ({}))) as { response?: { data?: Array<Record<string, unknown>> }; meta?: { errors?: Array<{ message?: string }> } };
    if (!r.ok) throw new Error(`Yext Analytics (HTTP ${r.status}) : ${j.meta?.errors?.[0]?.message ?? "erreur"}`);
    return j.response?.data ?? [];
  }

  /** Séries mensuelles d'un segment (dossiers Yext), du mois `debut` au mois `fin` inclus. */
  async series(dossiers: string[] | undefined, debut: string, fin: string): Promise<Mois[]> {
    const finJour = new Date(Date.UTC(Number(fin.slice(0, 4)), Number(fin.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const f: Record<string, unknown> = { startDate: `${debut}-01`, endDate: finJour, ...(dossiers ? { folderIds: dossiers } : {}) };
    const [vuesGoogle, actionsEditeurs, apple, bing] = await Promise.all([
      this.rapport(["LISTINGS_IMPRESSIONS"], ["MONTHS", "APP"], f),
      this.rapport(["TOTAL_LISTINGS_ACTIONS"], ["MONTHS", "SITES", "ACTION"], f),
      this.rapport(["APPLE_PLACE_CARD_VIEWS"], ["MONTHS"], f).catch(() => []),
      this.rapport(["BING_SEARCHES"], ["WEEKS"], f).catch(() => []),
    ]);
    const parMois = new Map<string, Mois>();
    const m = (k: string) => {
      if (!parMois.has(k)) parMois.set(k, { mois: k, googleSearch: 0, googleMaps: 0, appleVues: 0, bingVues: 0, google: vide(), apple: vide(), autresEditeurs: vide() });
      return parMois.get(k)!;
    };
    for (const r of vuesGoogle) {
      const x = m(moisDe(r.MONTHS));
      const n = Number(r.LISTINGS_IMPRESSIONS ?? 0);
      if (String(r.APP).toLowerCase() === "maps") x.googleMaps += n; else x.googleSearch += n;
    }
    for (const r of actionsEditeurs) {
      const x = m(moisDe(r.MONTHS));
      const ed = EDITEURS[String(r.SITES)];
      const cible = ed === "Google" ? x.google : ed === "Apple Plans" ? x.apple : x.autresEditeurs;
      ajouterAction(cible, String(r.ACTION ?? ""), Number(r.TOTAL_LISTINGS_ACTIONS ?? 0));
    }
    for (const r of apple) m(moisDe(r.MONTHS)).appleVues += Number(r.APPLE_PLACE_CARD_VIEWS ?? 0);
    // Bing : données hebdomadaires, rattachées au mois du début de semaine.
    for (const r of bing) {
      const k = moisDe(r.WEEKS);
      if (k >= debut && k <= fin) m(k).bingVues += Number(r["Bing Searches"] ?? r.BING_SEARCHES ?? 0);
    }
    return [...parMois.values()].filter((x) => x.mois >= debut && x.mois <= fin).sort((a, b) => a.mois.localeCompare(b.mois));
  }
}

/** Différence de deux séries (ex. France − bornes = France parkings). */
export function soustraire(a: Mois[], b: Mois[]): Mois[] {
  const parB = new Map(b.map((x) => [x.mois, x]));
  const moinsA = (p: ActionsMois, q?: ActionsMois): ActionsMois => ({
    itineraires: p.itineraires - (q?.itineraires ?? 0), siteWeb: p.siteWeb - (q?.siteWeb ?? 0), appels: p.appels - (q?.appels ?? 0),
    autres: p.autres - (q?.autres ?? 0), total: p.total - (q?.total ?? 0),
  });
  return a.map((x) => {
    const y = parB.get(x.mois);
    return {
      mois: x.mois, googleSearch: x.googleSearch - (y?.googleSearch ?? 0), googleMaps: x.googleMaps - (y?.googleMaps ?? 0),
      appleVues: x.appleVues - (y?.appleVues ?? 0), bingVues: x.bingVues - (y?.bingVues ?? 0),
      google: moinsA(x.google, y?.google), apple: moinsA(x.apple, y?.apple), autresEditeurs: moinsA(x.autresEditeurs, y?.autresEditeurs),
    };
  });
}

/** 13 derniers mois complets (le mois en cours est exclu : données Yext incomplètes). */
export function fenetre(aujourdhui = new Date()): { debut: string; fin: string } {
  const fin = new Date(Date.UTC(aujourdhui.getUTCFullYear(), aujourdhui.getUTCMonth() - 1, 1));
  const debut = new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth() - 12, 1));
  return { debut: debut.toISOString().slice(0, 7), fin: fin.toISOString().slice(0, 7) };
}

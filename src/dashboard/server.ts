// Dashboard SEO local : http://127.0.0.1:4321
// Lance : npm.cmd run dashboard
// Réutilise les clients du serveur MCP (Search Console, Bing Webmaster, Google Ads) : mêmes .env,
// même jeton Google, mêmes listes blanches. Lecture seule ; le seul fichier écrit est le résultat
// de l'audit technique dans data/audits/.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { aggregateKeyStats, BingWebmasterClient, type BingStatRow } from "../bing.js";
import {
  GOOGLE_TOKEN_PATH, loadEnvFile, normalizeCustomerId, PROJECT_ROOT,
  readBingConfig, readGoogleAdsConfig, readGoogleConfig,
} from "../config.js";
import { buildPerformanceQuery, GoogleAdsClient, toPerformanceRows } from "../google-ads.js";
import { fileTokenStore, GOOGLE_ADS_SCOPE, GoogleAuth } from "../google-auth.js";
import { SearchConsoleClient } from "../gsc.js";
import { hostKey, opportunites, periode, seoVsSea, totaux, variation, type Row } from "./analyse.js";
import { auditer } from "./audit.js";
import { benchmarker, type ResultatBenchmark } from "./benchmark.js";
import { crawler, pagerankInterne, type ResultatCrawl } from "./crawl.js";
import {
  alertes, clustersParPage, clustersParTheme, distributionPositions, enrichirPages, enrichirRequetes,
  longueTraine, marqueParDefaut, mouvements, parIntention, parRepertoire, segmentMarque,
} from "./mots-cles.js";
import { analyserPages, type ResultatPsi, type Strategie } from "./pagespeed.js";
import { backlog, fusionnerPages } from "./pages.js";
import { BAREME, CATEGORIES_DEFAUT, mesurer, moisEntre, proposerPanier, regexPanier, type Mesure, type Panier } from "./visibilite.js";

loadEnvFile();
const PORT = Number(process.env.DASHBOARD_PORT ?? 4321);
const DATA = join(PROJECT_ROOT, "data");
const PUBLIC = join(PROJECT_ROOT, "dashboard", "index.html");

const googleConfig = readGoogleConfig();
const auth = googleConfig ? new GoogleAuth(googleConfig, fileTokenStore(GOOGLE_TOKEN_PATH)) : undefined;
const gsc = auth ? new SearchConsoleClient(auth) : undefined;
const adsConfig = readGoogleAdsConfig();
const ads = auth ? new GoogleAdsClient(auth, adsConfig) : undefined;
const bingConfig = readBingConfig();
const bing = bingConfig ? new BingWebmasterClient(bingConfig) : undefined;

// --- cache mémoire (15 min) pour ménager les quotas des API ---
const cache = new Map<string, { t: number; v: unknown }>();
async function cached<T>(cle: string, frais: boolean, f: () => Promise<T>): Promise<T> {
  const c = cache.get(cle);
  if (!frais && c && Date.now() - c.t < 15 * 60_000) return c.v as T;
  const v = await f();
  cache.set(cle, { t: Date.now(), v });
  return v;
}

function autoriseGsc(site: string) {
  if (!gsc) throw new Error("Search Console n'est pas configurée : renseigne GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET dans .env puis lance npm.cmd run auth:google.");
  if (googleConfig!.siteUrls.length && !googleConfig!.siteUrls.includes(site)) {
    throw new Error(`Propriété non autorisée : ${site}. Ajoute-la à GSC_SITE_URLS dans .env.`);
  }
  return gsc;
}

async function bingSitePour(site: string): Promise<string | undefined> {
  if (!bing) return undefined;
  const sites = await cached("bing:sites", false, () => bing.listSites());
  const cle = hostKey(site);
  const s = sites.find((x) => hostKey(x.url) === cle && (!bingConfig!.siteUrls.length || bingConfig!.siteUrls.includes(x.url)));
  return s?.url;
}

function lireJson(chemin: string): unknown {
  return existsSync(chemin) ? JSON.parse(readFileSync(chemin, "utf8")) : null;
}
function ecrireJson(dossier: string, fichier: string, v: unknown) {
  mkdirSync(join(DATA, dossier), { recursive: true });
  writeFileSync(join(DATA, dossier, fichier), JSON.stringify(v));
}

// --- tâches longues (crawl, PageSpeed) : lancées en fond, suivies par /api/tache ---
interface Tache { id: string; type: string; site: string; etat: "en_cours" | "termine" | "erreur"; fait: number; total: number; message?: string; debut: string }
const taches = new Map<string, Tache>();
function lancerTache(type: string, site: string, f: (t: Tache) => Promise<void>): Tache {
  const enCours = [...taches.values()].find((t) => t.type === type && t.site === site && t.etat === "en_cours");
  if (enCours) return enCours;
  const t: Tache = { id: `${type}-${Date.now()}`, type, site, etat: "en_cours", fait: 0, total: 0, debut: new Date().toISOString() };
  taches.set(t.id, t);
  f(t).then(() => { t.etat = "termine"; }, (e: Error) => { t.etat = "erreur"; t.message = e.message; });
  return t;
}

/** Search Console renvoie au plus 25 000 lignes par appel : on pagine. */
async function toutes(site: string, q: Parameters<SearchConsoleClient["query"]>[1], max = 100_000): Promise<Row[]> {
  const c = autoriseGsc(site);
  const out: Row[] = [];
  for (let start = 0; start < max; start += 25_000) {
    const r = await c.query(site, { ...q, rowLimit: 25_000, startRow: start });
    out.push(...(r as Row[]));
    if (r.length < 25_000) break;
  }
  return out;
}

const lireCrawl = (site: string) => lireJson(join(DATA, "crawls", `${hostKey(site)}.json`)) as ResultatCrawl | null;
const lirePsi = (site: string) => (lireJson(join(DATA, "pagespeed", `${hostKey(site)}.json`)) as { date: string; resultats: ResultatPsi[] } | null);
const marquePour = (site: string, p: Params) => {
  const saisie = (p.get("marque") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return saisie.length ? saisie : marqueParDefaut(site);
};

type Moteur = "google" | "bing";
const moteurDe = (p: Params): Moteur => (p.get("moteur") === "bing" ? "bing" : "google");

/** Lignes hebdomadaires Bing (requête ou page) cumulées sur une période, au format Search Console. */
function bingVersRows(rows: BingStatRow[], debut: string, fin: string): Row[] {
  return aggregateKeyStats(rows.filter((r) => r.date >= debut && r.date <= fin)).map((a) => ({
    keys: [a.key], clicks: a.clicks, impressions: a.impressions, ctr: a.ctr, position: a.avgImpressionPosition ?? 0,
  }));
}

/** Données Bing Webmaster au même format que Search Console (requête × page et appareils non fournis par Bing). */
async function brutBing(site: string, per: ReturnType<typeof periode>, frais: boolean) {
  const bs = await bingSitePour(site);
  if (!bs || !bing) throw new Error("Ce site n'est pas dans Bing Webmaster Tools (ou BING_API_KEY est absente) : choisis le moteur Google.");
  const [trafic, qStats, pStats] = await Promise.all([
    cached(`bing:trafic:${bs}`, frais, () => bing.trafficStats(bs)),
    cached(`bing:q:${bs}`, frais, () => bing.keyStats(bs, "query")),
    cached(`bing:p:${bs}`, frais, () => bing.keyStats(bs, "page")),
  ]);
  const debutSerie = new Date(per.debut); debutSerie.setUTCDate(debutSerie.getUTCDate() - 28);
  const jour = (r: { date: string; clicks: number; impressions: number }): Row => ({ keys: [r.date], clicks: r.clicks, impressions: r.impressions, ctr: r.impressions ? r.clicks / r.impressions : 0, position: 0 });
  const dedans = (d: string, a: string, b: string) => d >= a && d <= b;
  return {
    serie: trafic.filter((r) => dedans(r.date, debutSerie.toISOString().slice(0, 10), per.fin)).sort((a, b) => a.date.localeCompare(b.date)).map(jour),
    prevSerie: trafic.filter((r) => dedans(r.date, per.debutPrec, per.finPrec)).sort((a, b) => a.date.localeCompare(b.date)).map(jour),
    q: bingVersRows(qStats, per.debut, per.fin), qPrev: bingVersRows(qStats, per.debutPrec, per.finPrec),
    qp: [] as Row[],
    pages: bingVersRows(pStats, per.debut, per.fin), pagesPrev: bingVersRows(pStats, per.debutPrec, per.finPrec),
    device: [] as Row[], devicePrev: [] as Row[], pays: [] as Row[],
    bingSite: bs,
  };
}

/** Une URL avec un paramètre utm_ est le lien « site web » d'une fiche Google (GMB, géré dans Yext). */
const estUrlFiche = (u: string) => /[?&]utm_/i.test(u);

// --- KR de visibilité : mesures mensuelles ---
const lirePanier = (site: string) => lireJson(join(DATA, "visibilite", `${hostKey(site)}.json`)) as Panier | null;
const empreinte = (pa: Panier) => { let h = 0; for (const c of pa.requetes.map((q) => q.requete).sort().join("|")) h = (h * 31 + c.charCodeAt(0)) | 0; return String(h); };

/** Search Console, mois par mois, filtrée exactement sur les requêtes du panier. Mois complets gardés sur disque. */
async function mesuresGoogle(site: string, panier: Panier, frais: boolean): Promise<Mesure[]> {
  const fichier = join(DATA, "visibilite", `${hostKey(site)}-google-mois.json`);
  const disque = (lireJson(fichier) as { empreinte: string; mois: Record<string, Row[]> } | null) ?? { empreinte: "", mois: {} };
  if (disque.empreinte !== empreinte(panier)) { disque.empreinte = empreinte(panier); disque.mois = {}; }
  const aujourdhui = new Date();
  const debut = new Date(Date.UTC(aujourdhui.getUTCFullYear(), aujourdhui.getUTCMonth() - 13, 1)).toISOString().slice(0, 7);
  const finDonnees = new Date(aujourdhui); finDonnees.setUTCDate(finDonnees.getUTCDate() - 3);
  const liste = moisEntre(debut, finDonnees);
  const regex = regexPanier(panier.requetes.map((q) => q.requete));
  const lire = async (mois: string) => {
    const d = new Date(`${mois}-01T00:00:00Z`);
    const fin = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const partiel = fin > finDonnees;
    if (!partiel && !frais && disque.mois[mois]) return { mois, partiel, rows: disque.mois[mois]! };
    const rows: Row[] = [];
    for (const expression of regex) {
      rows.push(...(await toutes(site, { startDate: `${mois}-01`, endDate: (partiel ? finDonnees : fin).toISOString().slice(0, 10), dimensions: ["query"], filters: [{ dimension: "query", operator: "includingRegex", expression }] }, 25_000)));
    }
    if (!partiel) disque.mois[mois] = rows;
    return { mois, partiel, rows };
  };
  const res: Array<{ mois: string; partiel: boolean; rows: Row[] }> = [];
  const file = [...liste];
  await Promise.all([0, 1, 2].map(async () => { for (let m = file.shift(); m; m = file.shift()) res.push(await lire(m)); }));
  ecrireJson("visibilite", `${hostKey(site)}-google-mois.json`, disque);
  return res.sort((a, b) => a.mois.localeCompare(b.mois)).map((r) => mesurer(panier, r.mois, r.rows, r.partiel));
}

/** Bing Webmaster : statistiques hebdomadaires par requête (≈ 6 mois d'historique), regroupées par mois. */
async function mesuresBing(site: string, panier: Panier, frais: boolean): Promise<Mesure[]> {
  const bs = await bingSitePour(site);
  if (!bs || !bing) throw new Error("Site absent de Bing Webmaster Tools.");
  const q = await cached(`bing:q:${bs}`, frais, () => bing.keyStats(bs, "query"));
  const moisCourant = new Date().toISOString().slice(0, 7);
  const mois = [...new Set(q.map((r) => r.date.slice(0, 7)))].sort();
  return mois.map((m) => mesurer(panier, m, bingVersRows(q, `${m}-01`, `${m}-31`), m === moisCourant));
}

/** Toutes les données d'une analyse (Search Console ou Bing), lues une fois puis partagées par les vues. */
async function donnees(site: string, jours: number, marque: string[], frais: boolean, moteur: Moteur = "google") {
  const per = periode(jours);
  let brut = moteur === "bing" ? await brutBing(site, per, frais) : await cached(`gsc-complet:${site}:${jours}`, frais, async () => {
    // Série quotidienne avec 28 jours d'historique en plus pour la détection d'anomalies.
    const debutSerie = new Date(per.debut); debutSerie.setUTCDate(debutSerie.getUTCDate() - 28);
    const [serie, prevSerie, q, qPrev, qp, pages, pagesPrev, device, devicePrev, pays] = await Promise.all([
      toutes(site, { startDate: debutSerie.toISOString().slice(0, 10), endDate: per.fin, dimensions: ["date"] }),
      toutes(site, { startDate: per.debutPrec, endDate: per.finPrec, dimensions: ["date"] }),
      toutes(site, { startDate: per.debut, endDate: per.fin, dimensions: ["query"] }),
      toutes(site, { startDate: per.debutPrec, endDate: per.finPrec, dimensions: ["query"] }),
      toutes(site, { startDate: per.debut, endDate: per.fin, dimensions: ["query", "page"] }),
      toutes(site, { startDate: per.debut, endDate: per.fin, dimensions: ["page"] }),
      toutes(site, { startDate: per.debutPrec, endDate: per.finPrec, dimensions: ["page"] }),
      toutes(site, { startDate: per.debut, endDate: per.fin, dimensions: ["device"] }),
      toutes(site, { startDate: per.debutPrec, endDate: per.finPrec, dimensions: ["device"] }),
      toutes(site, { startDate: per.debut, endDate: per.fin, dimensions: ["country"] }, 25_000),
    ]);
    return { serie, prevSerie, q, qPrev, qp, pages, pagesPrev, device, devicePrev, pays };
  });
  // Toute URL avec un paramètre utm_ vient d'une fiche Google (GMB/Yext) : elle relève de la vue Visibilité locale,
  // pas des analyses organiques (pages, backlog, cannibalisation, déclin).
  const sansUtm = (rows: Row[], i: number) => rows.filter((r) => !estUrlFiche(r.keys?.[i] ?? ""));
  brut = { ...brut, qp: sansUtm(brut.qp, 1), pages: sansUtm(brut.pages, 0), pagesPrev: sansUtm(brut.pagesPrev, 0) };
  const requetes = enrichirRequetes(brut.q, brut.qPrev, brut.qp, marque);
  const pagesGsc = enrichirPages(brut.pages, brut.pagesPrev);
  const serieComplete = brut.serie.map((r) => ({ date: r.keys![0]!, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
  const serie = serieComplete.filter((r) => r.date >= per.debut);
  return { per, brut, requetes, pagesGsc, serie, serieComplete };
}

// --- routes ---
type Params = URLSearchParams;
const routes: Record<string, (p: Params, frais: boolean) => Promise<unknown>> = {
  async "GET /api/sites"(_p, frais) {
    const [sitesGsc, sitesBing, clients] = await Promise.all([
      gsc ? cached("gsc:sites", frais, () => gsc.listSites()).catch((e: Error) => ({ erreur: e.message })) : null,
      bing ? cached("bing:sites", frais, () => bing.listSites()).catch((e: Error) => ({ erreur: e.message })) : null,
      ads && auth && (await auth.hasScope(GOOGLE_ADS_SCOPE).catch(() => false))
        ? cached("ads:clients", frais, async () => {
            const ids = adsConfig.customerIds.length ? adsConfig.customerIds : await ads.listAccessibleCustomers();
            const out = [];
            for (const id of ids) {
              try {
                const r = await ads.search(id, "SELECT customer.id, customer.descriptive_name, customer.manager FROM customer", { maxRows: 1, loginCustomerId: adsConfig.loginCustomerId });
                const row = r.rows[0] ?? {};
                if (row["customer.manager"] === true) continue;
                out.push({ id, nom: String(row["customer.descriptiveName"] ?? id) });
              } catch (e) {
                out.push({ id, nom: id, erreur: (e as Error).message });
              }
            }
            return out;
          }).catch((e: Error) => ({ erreur: e.message }))
        : null,
    ]);
    const liste = Array.isArray(sitesGsc)
      ? sitesGsc
          .filter((s) => !googleConfig!.siteUrls.length || googleConfig!.siteUrls.includes(s.siteUrl))
          .map((s) => ({ siteUrl: s.siteUrl, cle: hostKey(s.siteUrl) }))
      : [];
    return {
      sources: { searchConsole: !!gsc, bing: !!bing, googleAds: Array.isArray(clients) },
      sites: liste,
      erreurGsc: sitesGsc && !Array.isArray(sitesGsc) ? sitesGsc.erreur : undefined,
      sitesBing: Array.isArray(sitesBing) ? sitesBing.map((s) => s.url) : [],
      erreurBing: sitesBing && !Array.isArray(sitesBing) ? sitesBing.erreur : undefined,
      clientsAds: Array.isArray(clients) ? clients : [],
      erreurAds: clients && !Array.isArray(clients) ? clients.erreur : undefined,
    };
  },

  async "GET /api/performance"(p, frais) {
    const site = p.get("site")!;
    const jours = Number(p.get("jours") ?? 28);
    const c = autoriseGsc(site);
    const per = periode(jours);
    return cached(`perf:${site}:${jours}`, frais, async () => {
      const [cur, prev, pages, requetes, bingSite] = await Promise.all([
        c.query(site, { startDate: per.debut, endDate: per.fin, dimensions: ["date"], rowLimit: 1000 }),
        c.query(site, { startDate: per.debutPrec, endDate: per.finPrec, dimensions: ["date"], rowLimit: 1000 }),
        c.query(site, { startDate: per.debut, endDate: per.fin, dimensions: ["page"], rowLimit: 20 }),
        c.query(site, { startDate: per.debut, endDate: per.fin, dimensions: ["query"], rowLimit: 20 }),
        bingSitePour(site),
      ]);
      let bingData = null;
      if (bingSite && bing) {
        const rows = await bing.trafficStats(bingSite).catch(() => []);
        const dans = (d: string, a: string, b: string) => d >= a && d <= b;
        const bc = rows.filter((r) => dans(r.date, per.debut, per.fin));
        const bp = rows.filter((r) => dans(r.date, per.debutPrec, per.finPrec));
        const s = (l: typeof rows, k: "clicks" | "impressions") => l.reduce((x, r) => x + r[k], 0);
        bingData = {
          site: bingSite,
          clicks: s(bc, "clicks"), impressions: s(bc, "impressions"),
          varClicks: variation(s(bc, "clicks"), s(bp, "clicks")),
          varImpressions: variation(s(bc, "impressions"), s(bp, "impressions")),
          serie: bc,
        };
      }
      const t = totaux(cur), tp = totaux(prev);
      return {
        periode: per,
        google: {
          ...t,
          varClicks: variation(t.clicks, tp.clicks), varImpressions: variation(t.impressions, tp.impressions),
          varCtr: variation(t.ctr, tp.ctr), deltaPosition: tp.position ? Math.round((t.position - tp.position) * 10) / 10 : null,
          serie: cur.map((r) => ({ date: r.keys![0], clicks: r.clicks, impressions: r.impressions })),
          seriePrecedente: prev.map((r) => ({ date: r.keys![0], clicks: r.clicks, impressions: r.impressions })),
        },
        bing: bingData,
        topPages: pages.map((r) => ({ page: r.keys![0], ...pick(r) })),
        topRequetes: requetes.map((r) => ({ requete: r.keys![0], ...pick(r) })),
      };
    });
  },

  async "GET /api/opportunites"(p, frais) {
    const site = p.get("site")!;
    const jours = Number(p.get("jours") ?? 28);
    const c = autoriseGsc(site);
    const per = periode(jours);
    return cached(`opp:${site}:${jours}`, frais, async () => {
      const [rp, prec] = await Promise.all([
        c.query(site, { startDate: per.debut, endDate: per.fin, dimensions: ["query", "page"], rowLimit: 25000 }),
        c.query(site, { startDate: per.debutPrec, endDate: per.finPrec, dimensions: ["page"], rowLimit: 5000 }),
      ]);
      const liste = opportunites(rp as Row[], prec as Row[], site, { minImpressions: Number(p.get("min") ?? 100) });
      const compte = (t: string) => liste.filter((o) => o.type === t).length;
      return {
        periode: per,
        resume: { ctr_faible: compte("ctr_faible"), page_2: compte("page_2"), cannibalisation: compte("cannibalisation"), declin: compte("declin") },
        gainEstime: liste.reduce((s, o) => s + o.priorite, 0),
        opportunites: liste.slice(0, 300),
      };
    });
  },

  async "GET /api/discover"(p, frais) {
    const site = p.get("site")!;
    const jours = Number(p.get("jours") ?? 28);
    const c = autoriseGsc(site);
    const per = periode(jours);
    return cached(`disc:${site}:${jours}`, frais, async () => {
      const [serie, pages, prec] = await Promise.all([
        c.query(site, { startDate: per.debut, endDate: per.fin, dimensions: ["date"], type: "discover", rowLimit: 1000 }),
        c.query(site, { startDate: per.debut, endDate: per.fin, dimensions: ["page"], type: "discover", rowLimit: 100 }),
        c.query(site, { startDate: per.debutPrec, endDate: per.finPrec, dimensions: ["date"], type: "discover", rowLimit: 1000 }),
      ]);
      const t = totaux(serie), tp = totaux(prec);
      return {
        periode: per,
        clicks: t.clicks, impressions: t.impressions, ctr: t.ctr,
        varClicks: variation(t.clicks, tp.clicks),
        serie: serie.map((r) => ({ date: r.keys![0], clicks: r.clicks, impressions: r.impressions })),
        pages: pages.map((r) => ({ page: r.keys![0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr })),
      };
    });
  },

  async "GET /api/technique"(p, frais) {
    const site = p.get("site")!;
    const cle = hostKey(site);
    const bingSite = await bingSitePour(site);
    let crawl = null;
    if (bingSite && bing) {
      const rows = await cached(`bingcrawl:${bingSite}`, frais, () => bing.crawlStats(bingSite)).catch(() => []);
      const der = rows.slice(-30);
      const dernier = der.at(-1);
      crawl = {
        site: bingSite,
        dernier,
        sur30jours: {
          pagesExplorees: der.reduce((s, r) => s + r.crawledPages, 0),
          erreurs: der.reduce((s, r) => s + r.crawlErrors, 0),
          code4xx: der.reduce((s, r) => s + r.code4xx, 0),
          code5xx: der.reduce((s, r) => s + r.code5xx, 0),
          bloqueesRobots: dernier?.blockedByRobotsTxt ?? 0,
        },
        serie: der,
      };
    }
    return { crawlBing: crawl, audit: lireJson(join(DATA, "audits", `${cle}.json`)) };
  },

  async "POST /api/audit"(p) {
    const site = p.get("site")!;
    const resultat = await auditer(site, { maxPages: Math.min(Number(p.get("max") ?? 50), 500) });
    mkdirSync(join(DATA, "audits"), { recursive: true });
    writeFileSync(join(DATA, "audits", `${hostKey(site)}.json`), JSON.stringify(resultat, null, 2));
    return resultat;
  },

  async "GET /api/concurrents"(p) {
    return lireJson(join(DATA, "concurrents", `${hostKey(p.get("site")!)}.json`));
  },

  async "GET /api/contenu"(p) {
    const dossier = join(DATA, "contenu", hostKey(p.get("site")!));
    if (!existsSync(dossier)) return { articles: [] };
    const articles = readdirSync(dossier)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ fichier: f, ...(lireJson(join(dossier, f)) as object), maj: statSync(join(dossier, f)).mtime.toISOString() }))
      .sort((a, b) => b.maj.localeCompare(a.maj));
    return { articles, charte: lireJson(join(DATA, "charte", `${hostKey(p.get("site")!)}.json`)) };
  },

  // --- Cockpit : ce qui a changé, où est la valeur, quoi faire maintenant ---
  async "GET /api/cockpit"(p, frais) {
    const site = p.get("site")!;
    const jours = Number(p.get("jours") ?? 28);
    const marque = marquePour(site, p);
    const d = await donnees(site, jours, marque, frais, moteurDe(p));
    const t = totaux(d.serie.map((r) => ({ ...r, keys: [r.date] }))), tp = totaux(d.brut.prevSerie);
    const seg = segmentMarque(d.requetes);
    const dist = distributionPositions(d.requetes, d.brut.qPrev);
    const crawl = lireCrawl(site), psi = lirePsi(site);
    const lignes = fusionnerPages(d.pagesGsc, d.requetes, crawl, psi?.resultats ?? []);
    const actions = backlog(site, opportunites(d.brut.qp, d.brut.pagesPrev, site, { minImpressions: 100 }), lignes, marque);
    const al = alertes({ serie: d.serieComplete, requetes: d.requetes, pages: d.pagesGsc, prevRequetes: d.brut.qPrev });
    const top = (k: "top3" | "top10") => dist.filter((x) => x.tranche === "top3" || (k === "top10" && x.tranche === "top10"));
    const somme = (l: typeof dist, cle: "nb" | "nbPrec") => l.reduce((s, x) => s + x[cle], 0);
    // Résumé Bing à côté de Google (part de Bing dans les clics organiques des deux moteurs).
    let bingResume = null;
    if (moteurDe(p) === "google") {
      try {
        const b = await brutBing(site, d.per, frais);
        const cur = d.serie.length ? b.serie.filter((r) => r.keys![0]! >= d.per.debut) : [];
        const bc = totaux(cur), bp = totaux(b.prevSerie);
        bingResume = { site: b.bingSite, clicks: bc.clicks, impressions: bc.impressions, varClicks: variation(bc.clicks, bp.clicks), varImpressions: variation(bc.impressions, bp.impressions), part: bc.clicks + t.clicks ? bc.clicks / (bc.clicks + t.clicks) : 0, serie: cur.map((r) => r.clicks) };
      } catch { /* site absent de Bing */ }
    }
    const gainTop20 = actions.slice(0, 20).reduce((s, a) => s + a.gain, 0);
    return {
      periode: d.per, marque, moteur: moteurDe(p), bing: bingResume, gainTop20,
      kpis: {
        clicks: t.clicks, varClicks: variation(t.clicks, tp.clicks),
        impressions: t.impressions, varImpressions: variation(t.impressions, tp.impressions),
        ctr: t.ctr, varCtr: variation(t.ctr, tp.ctr),
        position: t.position, deltaPosition: tp.position ? Math.round((t.position - tp.position) * 10) / 10 : null,
        horsMarque: seg.horsMarque, marque: seg.marque,
        top3: somme(top("top3"), "nb"), deltaTop3: somme(top("top3"), "nb") - somme(top("top3"), "nbPrec"),
        top10: somme(top("top10"), "nb"), deltaTop10: somme(top("top10"), "nb") - somme(top("top10"), "nbPrec"),
        requetes: d.requetes.length,
      },
      serie: d.serie, seriePrecedente: d.brut.prevSerie.map((r) => ({ date: r.keys![0], clicks: r.clicks, impressions: r.impressions })),
      distribution: dist,
      alertes: al.slice(0, 12), nbAlertes: al.length,
      clusters: clustersParTheme(d.requetes).slice(0, 14),
      actions: actions.slice(0, 12), nbActions: actions.length, gainTotal: actions.reduce((s, a) => s + a.gain, 0),
      sources: {
        crawl: crawl ? { date: crawl.date, pages: crawl.pages.length, moteur: crawl.moteur } : null,
        pagespeed: psi ? { date: psi.date, analyses: psi.resultats.length } : null,
        firecrawl: !!process.env.FIRECRAWL_API_KEY, cleePagespeed: !!process.env.PAGESPEED_API_KEY,
      },
    };
  },

  // --- Visibilité locale : fiches Google Business Profile (Yext) rapprochées des pages par URL ---
  async "GET /api/local"(p, frais) {
    const site = p.get("site")!;
    const jours = Number(p.get("jours") ?? 28);
    const per = periode(jours);
    const yext = lireJson(join(DATA, "yext", `${hostKey(site)}.json`));
    // Toute URL avec un paramètre utm_ vient d'une fiche Google (yextgmb, yext, gmb…) : Search Console isole donc le trafic local par URL.
    const filtre = [{ dimension: "page" as const, operator: "contains" as const, expression: "utm_" }];
    const [locCur, locPrev, locReq, orgCur] = await Promise.all([
      cached(`local:p:${site}:${jours}`, frais, () => toutes(site, { startDate: per.debut, endDate: per.fin, dimensions: ["page"], filters: filtre }, 25_000)),
      cached(`local:pp:${site}:${jours}`, frais, () => toutes(site, { startDate: per.debutPrec, endDate: per.finPrec, dimensions: ["page"], filters: filtre }, 25_000)),
      cached(`local:q:${site}:${jours}`, frais, () => toutes(site, { startDate: per.debut, endDate: per.fin, dimensions: ["query", "page"], filters: filtre }, 50_000)),
      donnees(site, jours, marquePour(site, p), frais).then((d) => d.pagesGsc),
    ]);
    const canon = (u: string) => { try { const x = new URL(u); x.search = ""; x.hash = ""; return x.toString().replace(/\/$/, ""); } catch { return u; } };
    const agreger = (rows: Row[]) => {
      const m = new Map<string, { clicks: number; impressions: number; pos: number }>();
      for (const r of rows) { const k = canon(r.keys![0]!); const a = m.get(k) ?? { clicks: 0, impressions: 0, pos: 0 }; a.clicks += r.clicks; a.impressions += r.impressions; a.pos += r.position * r.impressions; m.set(k, a); }
      return m;
    };
    const cur = agreger(locCur), prev = agreger(locPrev);
    const org = new Map<string, { clicks: number; impressions: number; position: number }>();
    for (const g of orgCur) { if (estUrlFiche(g.page)) continue; const k = canon(g.page); const a = org.get(k) ?? { clicks: 0, impressions: 0, position: 0 }; a.clicks += g.clicks; a.impressions += g.impressions; a.position = a.position || g.position; org.set(k, a); }
    const crawl = lireCrawl(site);
    const parCrawl = new Map((crawl?.pages ?? []).map((x) => [canon(x.url), x]));
    const lignes = [...cur.entries()].map(([url, a]) => {
      const pr = prev.get(url), o = org.get(url), c = parCrawl.get(url);
      return {
        url, clicsLocal: a.clicks, impressionsLocal: a.impressions, positionLocal: a.impressions ? Math.round((a.pos / a.impressions) * 10) / 10 : null,
        clicsLocalPrec: pr?.clicks ?? 0, varLocal: variation(a.clicks, pr?.clicks ?? 0),
        clicsOrganique: o?.clicks ?? 0, impressionsOrganique: o?.impressions ?? 0, positionOrganique: o?.position ?? null,
        partLocal: a.clicks + (o?.clicks ?? 0) ? a.clicks / (a.clicks + (o?.clicks ?? 0)) : 0,
        status: c?.status, liensEntrants: c?.liensEntrants, mots: c?.wordCount,
      };
    }).sort((x, y) => y.clicsLocal - x.clicsLocal || y.impressionsLocal - x.impressionsLocal);
    const t = (rows: Row[]) => totaux(rows);
    const tc = t(locCur), tp = t(locPrev);
    // Requêtes qui déclenchent l'affichage des fiches (Local Pack, fiche d'établissement).
    const parReq = new Map<string, Row>();
    for (const r of locReq) { const q = r.keys![0]!; const a = parReq.get(q); if (!a || r.impressions > a.impressions) parReq.set(q, { ...r, keys: [q, r.keys![1]!] }); }
    const requetes = [...parReq.values()].sort((a, b) => b.impressions - a.impressions).slice(0, 500)
      .map((r) => ({ requete: r.keys![0]!, page: canon(r.keys![1]!), clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: Math.round(r.position * 10) / 10 }));
    // Visibilité locale sur le panier du KR : même barème, appliqué aux positions des liens des fiches.
    const panier = lirePanier(site);
    const qLoc = [...new Map(locReq.map((r) => [r.keys![0]!, r])).values()].map((r) => ({ ...r, keys: [r.keys![0]!] }));
    const visibiliteLocale = panier ? mesurer(panier, `${per.debut} → ${per.fin}`, qLoc) : null;
    const pagesOrganiquesSansFiche = [...org.entries()].filter(([u, o]) => /\/parkings\/\d+/.test(u) && !cur.has(u) && o.clicks >= 20).sort((a, b) => b[1].clicks - a[1].clicks).slice(0, 200).map(([url, o]) => ({ url, clicks: o.clicks, impressions: o.impressions }));
    return {
      periode: per, yext,
      totaux: { clicks: tc.clicks, impressions: tc.impressions, ctr: tc.ctr, position: tc.position, varClicks: variation(tc.clicks, tp.clicks), varImpressions: variation(tc.impressions, tp.impressions), pages: cur.size },
      visibiliteLocale: visibiliteLocale && { part: visibiliteLocale.part, parCategorie: visibiliteLocale.parCategorie, top3: visibiliteLocale.top3, top10: visibiliteLocale.top10, requetes: visibiliteLocale.requetes.length },
      lignes: lignes.slice(0, 2000), requetes, pagesOrganiquesSansFiche,
    };
  },

  // --- Maillage interne : liens entrants / sortants par URL, PageRank interne ---
  async "GET /api/maillage"(p, frais) {
    const site = p.get("site")!;
    const crawl = lireCrawl(site);
    if (!crawl) return null;
    const pr = pagerankInterne(crawl.pages);
    const cle = (u: string) => u.replace(/\/$/, "");
    let gsc = new Map<string, { clicks: number; impressions: number; position: number }>();
    try {
      const d = await donnees(site, Number(p.get("jours") ?? 28), marquePour(site, p), frais);
      gsc = new Map(d.pagesGsc.map((g) => [cle(g.page), { clicks: g.clicks, impressions: g.impressions, position: g.position }]));
    } catch { /* sans Search Console : maillage seul */ }
    const pages = crawl.pages.filter((x) => x.status >= 200 && x.status < 300).map((x) => {
      const g = gsc.get(cle(x.url));
      return { url: x.url, entrants: x.liensEntrants, sortants: x.liens.length, profondeur: x.profondeur, pagerank: pr.get(x.url) ?? 0, indexable: x.indexable, clicks: g?.clicks ?? 0, impressions: g?.impressions ?? 0, position: g?.position ?? null, mots: x.wordCount };
    });
    const med = (l: number[]) => { const s = [...l].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : 0; };
    const idx = pages.filter((x) => x.indexable);
    return {
      date: crawl.date, total: pages.length,
      stats: {
        entrantsMedian: med(idx.map((x) => x.entrants)), sortantsMedian: med(idx.map((x) => x.sortants)),
        sansLien: idx.filter((x) => x.entrants === 0).length, moinsDe3: idx.filter((x) => x.entrants < 3).length,
        trop: idx.filter((x) => x.sortants > 150).length,
      },
      // Pages qui rapportent du trafic mais que le maillage pousse peu : les meilleures cibles de liens.
      aRenforcer: idx.filter((x) => x.impressions >= 500 && x.pagerank < 40).sort((a, b) => b.impressions - a.impressions).slice(0, 100),
      // Pages très poussées par le maillage sans trafic : popularité « gaspillée ».
      gaspillage: idx.filter((x) => x.pagerank >= 60 && x.clicks === 0).sort((a, b) => b.pagerank - a.pagerank).slice(0, 100),
      pages: pages.sort((a, b) => b.entrants - a.entrants),
    };
  },

  async "GET /api/maillage/page"(p) {
    const crawl = lireCrawl(p.get("site")!);
    const url = p.get("url") ?? "";
    if (!crawl) return null;
    const cle = (u: string) => u.replace(/\/$/, "");
    const page = crawl.pages.find((x) => cle(x.url) === cle(url));
    return {
      url,
      entrants: crawl.pages.filter((x) => x.liens.some((l) => cle(l) === cle(url))).map((x) => x.url),
      sortants: page?.liens ?? [],
    };
  },

  // --- KR Organic Search Visibility (panier fixe de requêtes stratégiques hors marque) ---
  async "GET /api/visibilite"(p, frais) {
    const site = p.get("site")!;
    const panier = lirePanier(site);
    if (!panier) return { panier: null, bareme: BAREME, categories: CATEGORIES_DEFAUT };
    const [google, bingM] = await Promise.all([
      mesuresGoogle(site, panier, frais).catch((e: Error) => ({ erreur: e.message })),
      mesuresBing(site, panier, frais).catch((e: Error) => ({ erreur: e.message })),
    ]);
    // Les détails par requête ne sont renvoyés que pour le dernier mois complet et la baseline.
    const alleger = (l: Mesure[] | { erreur: string }) => {
      if (!Array.isArray(l)) return l;
      const dernier = [...l].reverse().find((m) => !m.partiel)?.mois;
      const base = panier.baseline ?? l.find((m) => !m.partiel)?.mois;
      return l.map((m) => (m.mois === dernier || m.mois === base || m.partiel ? m : { ...m, requetes: [] }));
    };
    return { panier: { ...panier, nbRequetes: panier.requetes.length }, bareme: BAREME, google: alleger(google), bing: alleger(bingM) };
  },

  async "POST /api/visibilite/panier"(p) {
    const site = p.get("site")!;
    const taille = Math.min(Math.max(Number(p.get("taille") ?? 400), 50), 1500);
    // Période source : les 3 derniers mois complets, pour lisser la saisonnalité.
    const fin = new Date(); fin.setUTCDate(0);
    const debut = new Date(fin); debut.setUTCMonth(debut.getUTCMonth() - 2); debut.setUTCDate(1);
    const per = { debut: debut.toISOString().slice(0, 10), fin: fin.toISOString().slice(0, 10) };
    const rows = await toutes(site, { startDate: per.debut, endDate: per.fin, dimensions: ["query"] }, 100_000);
    const ancien = lirePanier(site);
    const panier = proposerPanier(site, rows, { marque: marquePour(site, p), taille, periode: per });
    if (ancien) { panier.baseline = ancien.baseline; panier.cible = ancien.cible; panier.echeance = ancien.echeance; }
    ecrireJson("visibilite", `${hostKey(site)}.json`, panier);
    return { ...panier, nbRequetes: panier.requetes.length };
  },

  async "POST /api/visibilite/reglages"(p) {
    const site = p.get("site")!;
    const panier = lirePanier(site);
    if (!panier) throw new Error("Crée d'abord le panier de requêtes.");
    if (p.has("baseline")) panier.baseline = p.get("baseline") || undefined;
    if (p.has("cible")) panier.cible = p.get("cible") ? Number(p.get("cible")) / 100 : undefined;
    if (p.has("echeance")) panier.echeance = p.get("echeance") || undefined;
    ecrireJson("visibilite", `${hostKey(site)}.json`, panier);
    return { ok: true };
  },

  async "GET /api/mots-cles"(p, frais) {
    const site = p.get("site")!;
    const d = await donnees(site, Number(p.get("jours") ?? 28), marquePour(site, p), frais, moteurDe(p));
    const devPrec = new Map(d.brut.devicePrev.map((r) => [r.keys![0], r]));
    return {
      periode: d.per, marque: marquePour(site, p),
      distribution: distributionPositions(d.requetes, d.brut.qPrev),
      mouvements: mouvements(d.requetes, d.brut.qPrev),
      segments: segmentMarque(d.requetes),
      intentions: parIntention(d.requetes),
      longueTraine: longueTraine(d.requetes),
      clustersTheme: clustersParTheme(d.requetes).slice(0, 300),
      clustersPage: clustersParPage(d.requetes).slice(0, 300),
      appareils: d.brut.device.map((r) => ({ appareil: r.keys![0], clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: Math.round(r.position * 10) / 10, varClicks: variation(r.clicks, devPrec.get(r.keys![0])?.clicks ?? 0) })),
      pays: d.brut.pays.sort((a, b) => b.clicks - a.clicks).slice(0, 15).map((r) => ({ pays: r.keys![0], clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 })),
      requetes: [...d.requetes].sort((a, b) => b.impressions - a.impressions).slice(0, 3000),
      total: d.requetes.length,
    };
  },

  async "GET /api/pages"(p, frais) {
    const site = p.get("site")!;
    const d = await donnees(site, Number(p.get("jours") ?? 28), marquePour(site, p), frais, moteurDe(p));
    const crawl = lireCrawl(site), psi = lirePsi(site);
    const lignes = fusionnerPages(d.pagesGsc, d.requetes, crawl, psi?.resultats ?? []);
    const actions = backlog(site, opportunites(d.brut.qp, d.brut.pagesPrev, site, { minImpressions: Number(p.get("min") ?? 100) }), lignes, marquePour(site, p));
    const comptes: Record<string, number> = {};
    for (const l of lignes) for (const f of l.drapeaux) comptes[f] = (comptes[f] ?? 0) + 1;
    return {
      periode: d.per, crawl: crawl ? { date: crawl.date, moteur: crawl.moteur } : null, pagespeed: psi?.date ?? null,
      repertoires: parRepertoire(d.pagesGsc).slice(0, 100),
      clusters: clustersParPage(d.requetes).slice(0, 200),
      lignes: lignes.slice(0, 3000), totalLignes: lignes.length, drapeaux: comptes,
      actions: actions.slice(0, 500), gainTotal: actions.reduce((s, a) => s + a.gain, 0),
    };
  },

  async "GET /api/alertes"(p, frais) {
    const site = p.get("site")!;
    const d = await donnees(site, Number(p.get("jours") ?? 28), marquePour(site, p), frais, moteurDe(p));
    const al = alertes({ serie: d.serieComplete, requetes: d.requetes, pages: d.pagesGsc, prevRequetes: d.brut.qPrev }, {
      baisseGlobale: Number(p.get("baisseGlobale") ?? 0.1), baissePage: Number(p.get("baissePage") ?? 0.3),
      minClicsPage: Number(p.get("minClics") ?? 20), reculPosition: Number(p.get("recul") ?? 3), minImpressions: Number(p.get("min") ?? 100),
    });
    // Alertes techniques croisées : pages en erreur ou non indexables qui ont du trafic, CWV mauvais.
    const crawl = lireCrawl(site), psi = lirePsi(site);
    const lignes = fusionnerPages(d.pagesGsc, d.requetes, crawl, psi?.resultats ?? []);
    for (const l of lignes) {
      if (l.status != null && l.status >= 400 && (l.clicks || l.clicksPrec)) al.unshift({ gravite: "critique", type: "erreur_trafic", titre: `Page en HTTP ${l.status} avec du trafic`, detail: `${Math.max(l.clicks, l.clicksPrec)} clics sur la période : rediriger en 301.`, cible: l.url });
      else if (l.indexable === false && l.status != null && l.status < 300 && l.clicks >= 10) al.unshift({ gravite: "critique", type: "noindex_trafic", titre: `Page non indexable (${l.raisonNonIndexable}) avec du trafic`, detail: `${l.clicks} clics : vérifier que c'est voulu.`, cible: l.url });
      if (l.cwv === "mauvais" && l.clicks >= 50) al.push({ gravite: "important", type: "cwv", titre: "Core Web Vitals mauvais sur une page à trafic", detail: `${l.clicks} clics, LCP ${l.lcp ? Math.round(l.lcp / 100) / 10 + " s" : "—"}.`, cible: l.url });
    }
    return { periode: d.per, alertes: al.slice(0, 500), total: al.length };
  },

  async "POST /api/crawl"(p) {
    const site = p.get("site")!;
    const max = Math.min(Number(p.get("max") ?? 500), 5000);
    const prof = Number(p.get("profondeur") ?? 10);
    const moteur = p.get("moteur") === "interne" ? "interne" : process.env.FIRECRAWL_API_KEY ? "firecrawl" : "interne";
    return lancerTache("crawl", site, async (t) => {
      const r = await crawler(site, {
        maxPages: max, maxProfondeur: prof, cleFirecrawl: moteur === "firecrawl" ? process.env.FIRECRAWL_API_KEY : undefined,
        onProgres: (fait, total) => { t.fait = fait; t.total = total; },
      });
      ecrireJson("crawls", `${hostKey(site)}.json`, r);
      t.message = `${r.pages.length} URL crawlées (${r.moteur})`;
    });
  },

  async "GET /api/crawl"(p) {
    const r = lireCrawl(p.get("site")!);
    if (!r) return null;
    return { ...r, pages: r.pages.map(({ liens, ...x }) => ({ ...x, liensSortants: liens.length })) };
  },

  async "POST /api/pagespeed"(p) {
    const site = p.get("site")!;
    const n = Math.min(Number(p.get("n") ?? 10), 50);
    const strategies = (p.get("strategies") ?? "mobile").split(",").filter((s): s is Strategie => s === "mobile" || s === "desktop");
    return lancerTache("pagespeed", site, async (t) => {
      const per = periode(28);
      const pages = (await toutes(site, { startDate: per.debut, endDate: per.fin, dimensions: ["page"] }, 25_000)).sort((a, b) => b.clicks - a.clicks);
      const accueil = site.startsWith("sc-domain:") ? `https://${site.slice(10)}/` : site;
      const urls = [...new Set([accueil, ...pages.map((r) => r.keys![0]!)])].slice(0, n);
      const resultats = await analyserPages(urls, strategies.length ? strategies : ["mobile"], {
        cle: process.env.PAGESPEED_API_KEY, onProgres: (fait, total) => { t.fait = fait; t.total = total; },
      });
      ecrireJson("pagespeed", `${hostKey(site)}.json`, { date: new Date().toISOString(), resultats });
      const err = resultats.filter((r) => r.erreur).length;
      t.message = `${resultats.length - err} analyses réussies${err ? `, ${err} en erreur (${resultats.find((r) => r.erreur)?.erreur})` : ""}`;
    });
  },

  async "GET /api/pagespeed"(p) {
    return lirePsi(p.get("site")!);
  },

  async "GET /api/tache"(p) {
    const t = taches.get(p.get("id") ?? "");
    if (!t) throw new Error("Tâche inconnue (le serveur a peut-être redémarré).");
    return t;
  },

  async "POST /api/benchmark"(p) {
    const site = p.get("site")!;
    const requete = (p.get("requete") ?? "").trim();
    if (!requete) throw new Error("Indique une requête.");
    const cle = process.env.FIRECRAWL_API_KEY;
    if (!cle) throw new Error("Le benchmark utilise l'API Firecrawl : ajoute FIRECRAWL_API_KEY dans .env (clé gratuite sur firecrawl.dev), ou lance /seo-pilote:seo-concurrents dans Claude Code.");
    const tld = hostKey(site).split(".").pop();
    const pays = ({ fr: "France", es: "Spain", be: "Belgium", sn: "Senegal", ch: "Switzerland", it: "Italy", de: "Germany", uk: "United Kingdom" } as Record<string, string>)[tld ?? ""] ?? "France";
    const r = await benchmarker(requete, p.get("page") || undefined, { cle, pays });
    const chemin = join(DATA, "benchmarks", `${hostKey(site)}.json`);
    const tous = ((lireJson(chemin) as Record<string, ResultatBenchmark> | null) ?? {});
    tous[requete] = r;
    ecrireJson("benchmarks", `${hostKey(site)}.json`, tous);
    return r;
  },

  async "GET /api/benchmarks"(p) {
    const tous = (lireJson(join(DATA, "benchmarks", `${hostKey(p.get("site")!)}.json`)) as Record<string, ResultatBenchmark> | null) ?? {};
    return Object.values(tous).sort((a, b) => b.date.localeCompare(a.date));
  },

  async "GET /api/sea"(p, frais) {
    if (!ads) throw new Error("Google Ads n'est pas configuré (voir docs/installation.md).");
    const client = normalizeCustomerId(p.get("client") ?? "");
    if (!client) throw new Error("Choisis un compte Google Ads.");
    const site = p.get("site");
    const jours = Number(p.get("jours") ?? 28);
    const per = periode(jours);
    return cached(`sea:${client}:${site}:${jours}`, frais, async () => {
      const opts = { loginCustomerId: adsConfig.loginCustomerId };
      const [camp, termes] = await Promise.all([
        ads.search(client, buildPerformanceQuery({ level: "campaign", startDate: per.debut, endDate: per.fin, limit: 200 }), { maxRows: 200, ...opts }),
        ads.search(client, buildPerformanceQuery({ level: "search_term", startDate: per.debut, endDate: per.fin, limit: 5000 }), { maxRows: 5000, ...opts }),
      ]);
      const campagnes = toPerformanceRows("campaign", camp.rows);
      const t = toPerformanceRows("search_term", termes.rows);
      let croisement = null;
      if (site && gsc) {
        const q = await autoriseGsc(site).query(site, { startDate: per.debut, endDate: per.fin, dimensions: ["query"], rowLimit: 25000 });
        croisement = seoVsSea(
          t.rows.map((r) => ({ terme: r.dimensions.searchTerm ?? "", cost: r.cost, clicks: r.clicks, conversions: r.conversions })),
          q as Row[],
        );
      }
      const somme = (k: "cost" | "clicks" | "conversions" | "impressions") => Math.round(campagnes.rows.reduce((s, r) => s + r[k], 0) * 100) / 100;
      return {
        periode: per, devise: campagnes.currency,
        totaux: { cost: somme("cost"), clicks: somme("clicks"), impressions: somme("impressions"), conversions: somme("conversions") },
        campagnes: campagnes.rows,
        croisement,
      };
    });
  },
};

function pick(r: { clicks: number; impressions: number; ctr: number; position: number }) {
  return { clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: Math.round(r.position * 10) / 10 };
}

const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".json": "application/json" };

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const send = (status: number, body: string | Buffer, type = "application/json; charset=utf-8") => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  };
  if (url.pathname === "/" && req.method === "GET") return send(200, readFileSync(PUBLIC), "text/html; charset=utf-8");
  // Visuels générés (data/visuels) affichés dans l'onglet Contenu.
  if (url.pathname.startsWith("/fichiers/") && req.method === "GET") {
    const rel = normalize(decodeURIComponent(url.pathname.slice("/fichiers/".length))).replace(/^(\.\.[\\/])+/, "");
    const chemin = join(DATA, rel);
    if (!chemin.startsWith(join(DATA, "visuels")) || !existsSync(chemin)) return send(404, "{}");
    return send(200, readFileSync(chemin), TYPES[extname(chemin).toLowerCase()] ?? "application/octet-stream");
  }
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return send(404, JSON.stringify({ erreur: "Route inconnue" }));
  try {
    const data = await route(url.searchParams, url.searchParams.get("rafraichir") === "1");
    send(200, JSON.stringify(data));
  } catch (e) {
    send(500, JSON.stringify({ erreur: (e as Error).message }));
  }
}

createServer((req, res) => void handle(req, res)).listen(PORT, "127.0.0.1", () => {
  console.log(`Dashboard SEO : http://127.0.0.1:${PORT}`);
});

// Vue page par page : Search Console × crawl × PageSpeed, et backlog d'actions priorisées.
// score = gain (clics / période) × confiance ÷ effort — même formule pour toutes les actions.
import { ctrAttendu, type Opportunite } from "./analyse.js";
import type { PageCrawl, ResultatCrawl } from "./crawl.js";
import type { PageGsc, Requete } from "./mots-cles.js";
import { estMarque, tokens } from "./mots-cles.js";
import type { ResultatPsi } from "./pagespeed.js";

const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
const cleUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").toLowerCase();

export type TypeAction =
  | "meta" | "contenu" | "maillage" | "cannibalisation" | "declin" | "technique" | "indexation" | "vitesse" | "profondeur" | "title";

export interface Action {
  id: string;
  type: TypeAction;
  titre: string;
  page?: string;
  requete?: string;
  gain: number;
  confiance: number;
  effort: 1 | 2 | 3;
  score: number;
  detail: string;
  calcul?: { impressions: number; ctrActuel: number; ctrCible: number; positionVisee?: number };
  sources: string[];
  commande: string;
}

export interface LignePage {
  url: string;
  repertoire?: string;
  clicks: number; impressions: number; ctr: number; position: number | null; varClicks: number | null; clicksPrec: number;
  requetePrincipale?: string; nbRequetes: number; top3: number; top10: number;
  status?: number; indexable?: boolean; raisonNonIndexable?: string; profondeur?: number | null; liensEntrants?: number;
  mots?: number; title?: string; titleLength?: number; metaLength?: number; h1?: number; h2?: number; schemas?: string[];
  cwv?: string; scorePerf?: number | null; lcp?: number | null;
  drapeaux: string[];
}

function action(a: Omit<Action, "score" | "id">): Action {
  const score = round((a.gain * a.confiance) / a.effort);
  return { ...a, score, id: `${a.type}:${a.page ?? ""}:${a.requete ?? ""}` };
}

export function fusionnerPages(
  pagesGsc: PageGsc[],
  requetes: Requete[],
  crawl: ResultatCrawl | null,
  psi: ResultatPsi[],
): LignePage[] {
  const parCrawl = new Map<string, PageCrawl>((crawl?.pages ?? []).map((p) => [cleUrl(p.url), p]));
  const parPsi = new Map<string, ResultatPsi>();
  for (const r of psi) if (r.strategie === "mobile" || !parPsi.has(cleUrl(r.url))) parPsi.set(cleUrl(r.url), r);
  const reqParPage = new Map<string, Requete[]>();
  for (const r of requetes) if (r.page) reqParPage.set(cleUrl(r.page), [...(reqParPage.get(cleUrl(r.page)) ?? []), r]);

  const lignes = new Map<string, LignePage>();
  for (const g of pagesGsc) {
    const k = cleUrl(g.page);
    const rq = (reqParPage.get(k) ?? []).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
    lignes.set(k, {
      url: g.page, repertoire: g.repertoire, clicks: g.clicks, impressions: g.impressions, ctr: g.ctr, position: g.position,
      varClicks: g.varClicks, clicksPrec: g.clicksPrec, requetePrincipale: rq[0]?.requete, nbRequetes: rq.length,
      top3: rq.filter((r) => r.tranche === "top3").length, top10: rq.filter((r) => r.tranche === "top3" || r.tranche === "top10").length,
      drapeaux: [],
    });
  }
  for (const [k, p] of parCrawl) {
    if (p.status >= 300 && p.status < 400) continue;
    if (!lignes.has(k)) lignes.set(k, { url: p.url, clicks: 0, impressions: 0, ctr: 0, position: null, varClicks: null, clicksPrec: 0, nbRequetes: 0, top3: 0, top10: 0, drapeaux: [] });
  }
  for (const [k, l] of lignes) {
    const c = parCrawl.get(k);
    if (c) {
      Object.assign(l, {
        status: c.status, indexable: c.indexable, raisonNonIndexable: c.raisonNonIndexable, profondeur: c.profondeur, liensEntrants: c.liensEntrants,
        mots: c.wordCount, title: c.title, titleLength: c.titleLength, metaLength: c.metaLength, h1: c.h1.length, h2: c.h2, schemas: c.schemas,
      });
    }
    const s = parPsi.get(k);
    if (s && !s.erreur) Object.assign(l, { cwv: (s.terrainPage ?? s.terrainOrigine)?.global, scorePerf: s.score, lcp: s.terrainPage?.lcp?.p75 ?? s.labo.lcp });
    const d = l.drapeaux;
    // « Hors crawl » n'a de sens que si le crawl a couvert tout le sitemap.
    if (crawl?.complet && !c && l.clicks >= 10) d.push("non atteinte par les liens");
    if (c && c.status >= 400) d.push(`HTTP ${c.status}`);
    if (c && !c.indexable && c.status < 300) d.push(c.raisonNonIndexable ?? "non indexable");
    if (c && c.indexable && l.impressions === 0) d.push("zombie");
    if (c && c.liensEntrants === 0 && (c.profondeur ?? 0) !== 0) d.push("orpheline");
    if (c && (c.profondeur ?? 0) >= 4) d.push("profonde");
    if (c && c.indexable && c.wordCount < 300) d.push("contenu mince");
    if (l.cwv === "mauvais") d.push("CWV mauvais");
    if (l.varClicks != null && l.varClicks <= -0.3 && l.clicksPrec >= 20) d.push("en déclin");
  }
  return [...lignes.values()].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

/** Construit le backlog : opportunités Search Console + constats du crawl et de PageSpeed. */
export function backlog(site: string, opps: Opportunite[], lignes: LignePage[], marque: string[] = []): Action[] {
  const out: Action[] = [];
  const parUrl = new Map(lignes.map((l) => [cleUrl(l.url), l]));

  for (const o of opps) {
    // Requêtes de marque : un CTR « faible » vient des liens annexes et des pages secondaires, pas d'un défaut SEO.
    if (o.requete && estMarque(o.requete, marque)) continue;
    const l = o.page ? parUrl.get(cleUrl(o.page)) : undefined;
    if (o.type === "ctr_faible") {
      out.push(action({
        type: "meta", titre: `Réécrire title et meta description`, page: o.page, requete: o.requete,
        gain: o.priorite, confiance: 0.6, effort: 1, detail: o.action,
        calcul: { impressions: o.impressions, ctrActuel: o.ctr, ctrCible: ctrAttendu(o.position), positionVisee: Math.round(o.position) },
        sources: ["Search Console · requête × page"], commande: o.commande,
      }));
    } else if (o.type === "page_2") {
      const mince = (l?.mots ?? 1000) < 600;
      const peuDeLiens = (l?.liensEntrants ?? 10) < 5;
      out.push(action({
        type: "contenu", titre: `Passer en page 1${mince ? " : enrichir le contenu" : ""}${peuDeLiens ? " + maillage" : ""}`, page: o.page, requete: o.requete,
        gain: o.priorite, confiance: o.position <= 13 ? 0.45 : 0.3, effort: mince ? 3 : 2,
        detail: `${o.action}${l?.mots != null ? ` La page fait ${l.mots} mots` : ""}${l?.liensEntrants != null ? ` et reçoit ${l.liensEntrants} liens internes.` : ""}`,
        calcul: { impressions: o.impressions, ctrActuel: o.ctr, ctrCible: ctrAttendu(5), positionVisee: 5 },
        sources: ["Search Console · requête × page", ...(l?.mots != null ? ["Crawl"] : [])], commande: o.commande,
      }));
    } else if (o.type === "cannibalisation") {
      out.push(action({
        type: "cannibalisation", titre: `Résoudre la cannibalisation`, requete: o.requete, page: o.pages?.[0],
        gain: o.priorite, confiance: 0.4, effort: 2, detail: `${o.action} Pages : ${(o.pages ?? []).join(", ")}`,
        calcul: { impressions: o.impressions, ctrActuel: o.ctr, ctrCible: ctrAttendu(3), positionVisee: 3 },
        sources: ["Search Console · requête × page"], commande: o.commande,
      }));
    } else if (o.type === "declin") {
      out.push(action({
        type: "declin", titre: `Enrayer le déclin`, page: o.page, gain: o.priorite, confiance: 0.5, effort: 2, detail: o.action,
        sources: ["Search Console · page, période précédente"], commande: o.commande,
      }));
    }
  }

  for (const l of lignes) {
    const cmd = (type: string) => `/seo-pilote:seo-technique ${site} ${type} ${l.url}`;
    // Page en erreur qui recevait du trafic ou des liens.
    if (l.status != null && l.status >= 400 && (l.clicksPrec > 0 || l.clicks > 0 || (l.liensEntrants ?? 0) > 0)) {
      out.push(action({
        type: "technique", titre: `Rediriger en 301 (HTTP ${l.status})`, page: l.url, gain: Math.max(l.clicksPrec, l.clicks, (l.liensEntrants ?? 0) * 2),
        confiance: 0.8, effort: 1, detail: `La page répond ${l.status} mais ${l.clicksPrec || l.clicks ? `faisait ${Math.max(l.clicksPrec, l.clicks)} clics` : `reçoit ${l.liensEntrants} liens internes`} : rediriger vers la page équivalente et corriger les liens.`,
        sources: ["Crawl", "Search Console"], commande: cmd("erreur_http"),
      }));
    }
    if (l.indexable === false && l.status != null && l.status < 300 && l.impressions > 0) {
      out.push(action({
        type: "indexation", titre: `Vérifier « ${l.raisonNonIndexable} »`, page: l.url, gain: Math.max(l.clicks, Math.round(l.impressions * 0.01)),
        confiance: 0.6, effort: 1, detail: `La page a encore ${l.impressions} impressions mais n'est plus indexable (${l.raisonNonIndexable}) : confirmer que c'est voulu.`,
        sources: ["Crawl", "Search Console"], commande: cmd("noindex"),
      }));
    }
    // Maillage : page en position 4–20 avec peu de liens entrants.
    if (l.position != null && l.position > 3 && l.position <= 20 && l.liensEntrants != null && l.liensEntrants < 5 && l.impressions >= 200) {
      const cible = ctrAttendu(Math.max(1, l.position - 3));
      const gain = Math.round(Math.max(0, cible - l.ctr) * l.impressions);
      if (gain > 0) out.push(action({
        type: "maillage", titre: `Renforcer le maillage interne`, page: l.url, requete: l.requetePrincipale, gain, confiance: 0.4, effort: 1,
        detail: `${l.liensEntrants} lien(s) interne(s) entrant(s) pour une page en position ${l.position} : ajouter 5 à 10 liens contextuels depuis les pages fortes du même cluster.`,
        calcul: { impressions: l.impressions, ctrActuel: l.ctr, ctrCible: cible, positionVisee: Math.max(1, Math.round(l.position - 3)) },
        sources: ["Crawl · graphe des liens", "Search Console"], commande: `/seo-pilote:seo-maillage ${site} ${l.url}`,
      }));
    }
    if ((l.profondeur ?? 0) >= 4 && l.impressions >= 100) {
      out.push(action({
        type: "profondeur", titre: `Remonter la page (profondeur ${l.profondeur})`, page: l.url, gain: Math.round(l.clicks * 0.15 + l.impressions * 0.002),
        confiance: 0.35, effort: 1, detail: `À ${l.profondeur} clics de l'accueil : la lier depuis une page de niveau 1 ou 2 (catégorie, hub, menu).`,
        sources: ["Crawl"], commande: `/seo-pilote:seo-maillage ${site} ${l.url}`,
      }));
    }
    // Title qui ne contient pas la requête principale.
    if (l.title && l.requetePrincipale && l.impressions >= 300) {
      const t = new Set(tokens(l.title));
      const q = tokens(l.requetePrincipale);
      const manquants = q.filter((x) => !t.has(x));
      if (q.length && manquants.length / q.length >= 0.5) {
        out.push(action({
          type: "title", titre: `Aligner le title sur « ${l.requetePrincipale} »`, page: l.url, requete: l.requetePrincipale,
          gain: Math.round(Math.max(0, ctrAttendu(l.position ?? 10) - l.ctr) * l.impressions * 0.5 + l.impressions * 0.003), confiance: 0.45, effort: 1,
          detail: `Le title (« ${l.title} ») ne reprend pas « ${manquants.join(", ")} », alors que c'est la requête qui amène le plus de trafic.`,
          sources: ["Crawl · title", "Search Console"], commande: `/seo-pilote:seo-opportunites meta ${l.url} "${l.requetePrincipale}"`,
        }));
      }
    }
    if (l.cwv === "mauvais" && l.clicks >= 50) {
      out.push(action({
        type: "vitesse", titre: `Corriger les Core Web Vitals`, page: l.url, gain: Math.round(l.clicks * 0.05), confiance: 0.3, effort: 3,
        detail: `Core Web Vitals « mauvais » sur mobile${l.lcp ? ` (LCP ${round(l.lcp / 1000, 1)} s)` : ""} : voir l'onglet Vitesse pour les optimisations.`,
        sources: ["PageSpeed Insights · CrUX"], commande: cmd("vitesse"),
      }));
    }
  }

  // Une seule action par (type, page, requête), la plus forte.
  const uniques = new Map<string, Action>();
  for (const a of out) if (!uniques.has(a.id) || uniques.get(a.id)!.score < a.score) uniques.set(a.id, a);
  return [...uniques.values()].filter((a) => a.gain > 0).sort((a, b) => b.score - a.score);
}

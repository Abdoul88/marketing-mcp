import { describe, expect, it } from "vitest";
import { comparer, profiler } from "../src/dashboard/benchmark.js";
import { analyserCrawl, liensInternes, reglesRobots, crawlerInterne, type PageCrawl } from "../src/dashboard/crawl.js";
import {
  alertes, anomalies, clustersParPage, clustersParTheme, distributionPositions, enrichirPages, enrichirRequetes,
  estMarque, intention, marqueParDefaut, mouvements, repertoire, tranche,
} from "../src/dashboard/mots-cles.js";
import { lireTerrain, noter } from "../src/dashboard/pagespeed.js";
import { backlog, fusionnerPages } from "../src/dashboard/pages.js";

const r = (k: string[], clicks: number, impressions: number, position: number) => ({ keys: k, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position });

describe("mots-clés", () => {
  it("classe les positions par tranche", () => {
    expect([1, 3.4, 4, 10.4, 15, 30, 80].map(tranche)).toEqual(["top3", "top3", "top10", "top10", "top20", "top50", "au_dela"]);
  });

  it("détecte la marque et l'intention", () => {
    expect(marqueParDefaut("sc-domain:indigoneo.fr")).toContain("indigo");
    expect(marqueParDefaut("https://okooltrip.sn/")).toEqual(["okooltrip"]);
    expect(estMarque("parking indigo gare de lyon", marqueParDefaut("https://www.indigoneo.fr/"))).toBe(true);
    expect(estMarque("Indigo Neo parking", ["indigoneo"])).toBe(true);
    expect(estMarque("parking orly", ["indigoneo"])).toBe(false);
    expect(intention("prix parking orly", false)).toBe("transactionnelle");
    expect(intention("comment se garer à lyon", false)).toBe("informationnelle");
    expect(intention("parking près de la gare", false)).toBe("locale");
    expect(intention("indigo", true)).toBe("marque");
  });

  const cur = [r(["parking orly"], 100, 1000, 2), r(["parking orly pas cher"], 10, 500, 8), r(["parking lyon part dieu"], 50, 800, 4), r(["parking nice aeroport"], 0, 300, 25)];
  const prev = [r(["parking orly"], 150, 1000, 4), r(["parking lyon part dieu"], 60, 800, 2), r(["parking marseille"], 40, 500, 5)];
  const qp = [r(["parking orly", "https://s.fr/orly"], 100, 1000, 2), r(["parking orly pas cher", "https://s.fr/orly"], 10, 500, 8), r(["parking lyon part dieu", "https://s.fr/lyon"], 50, 800, 4), r(["parking nice aeroport", "https://s.fr/nice"], 0, 300, 25)];
  const req = enrichirRequetes(cur, prev, qp, ["indigoneo"]);

  it("compare les tranches et les mouvements avec la période précédente", () => {
    const d = distributionPositions(req, prev);
    expect(d.find((x) => x.tranche === "top3")!.nb).toBe(1);
    expect(d.find((x) => x.tranche === "top3")!.nbPrec).toBe(1);
    const m = mouvements(req, prev);
    expect(m.entreesTop3.map((x) => x.requete)).toEqual(["parking orly"]);
    expect(m.sortiesTop3.map((x) => x.requete)).toEqual(["parking lyon part dieu"]);
    expect(m.perdues.map((x) => x.requete)).toEqual(["parking marseille"]);
    expect(m.nouvelles.length).toBe(2);
  });

  it("clusterise par page et par thème", () => {
    const parPage = clustersParPage(req);
    expect(parPage[0]!.page).toBe("https://s.fr/orly");
    expect(parPage[0]!.requetes).toBe(2);
    const themes = clustersParTheme(req).map((c) => c.nom);
    expect(themes).toContain("orly");
  });

  it("regroupe les pages par répertoire", () => {
    expect(repertoire("https://s.fr/parking/lyon/")).toBe("/parking/");
    expect(repertoire("https://s.fr/fr/blog/article")).toBe("/fr/blog/");
    expect(repertoire("https://s.fr/")).toBe("/");
  });

  it("lève des alertes de baisse, de sortie du top 3 et de requête perdue", () => {
    const pages = enrichirPages([r(["https://s.fr/lyon"], 10, 800, 4)], [r(["https://s.fr/lyon"], 100, 800, 2)]);
    const al = alertes({ serie: [], requetes: req, pages, prevRequetes: prev });
    const types = al.map((a) => a.type);
    expect(types).toContain("page_baisse");
    expect(types).toContain("sortie_top3");
    expect(types).toContain("requete_perdue");
  });

  it("détecte une anomalie à plus de 2 écarts-types", () => {
    const serie = Array.from({ length: 35 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, clicks: i === 34 ? 20 : 100 + (i % 2 ? 5 : -5) }));
    expect(anomalies(serie).map((a) => a.clicks)).toEqual([20]);
  });
});

describe("crawl", () => {
  const html = (liens: string[], extra = "") => `<html lang="fr"><head><title>Page de test assez longue pour passer</title><meta name="description" content="d"></head><body><h1>T</h1>${extra}${liens.map((l) => `<a href="${l}">x</a>`).join("")}</body></html>`;

  it("extrait les liens internes et ignore nofollow, ancres et médias", () => {
    expect(liensInternes(`<a href="/a#x">a</a><a href="https://www.s.fr/b?utm_source=x">b</a><a rel="nofollow" href="/c">c</a><a href="/d.pdf">d</a><a href="https://autre.fr/">e</a>`, "https://s.fr/"))
      .toEqual(["https://s.fr/a", "https://www.s.fr/b"]);
    expect(reglesRobots("User-agent: Googlebot\nDisallow: /x\nUser-agent: *\nDisallow: /admin\n")).toEqual(["/admin"]);
  });

  it("crawle depuis l'accueil, suit les redirections et repère liens cassés et orphelines", async () => {
    const site: Record<string, { status: number; body?: string; location?: string }> = {
      "https://s.fr/": { status: 200, body: html(["/a", "/ancienne", "/casse"]) },
      "https://s.fr/a": { status: 200, body: html(["/b"]) },
      "https://s.fr/b": { status: 200, body: html([]) },
      "https://s.fr/ancienne": { status: 301, location: "/a" },
      "https://s.fr/casse": { status: 404, body: "" },
      "https://s.fr/orpheline": { status: 200, body: html([]) },
      "https://s.fr/robots.txt": { status: 200, body: "User-agent: *\nSitemap: https://s.fr/sitemap.xml" },
      "https://s.fr/sitemap.xml": { status: 200, body: "<urlset><url><loc>https://s.fr/</loc></url><url><loc>https://s.fr/orpheline</loc></url></urlset>" },
    };
    const fetchImpl = (async (u: string | URL) => {
      const p = site[String(u)] ?? { status: 404, body: "" };
      return new Response(p.status >= 300 && p.status < 400 ? null : (p.body ?? ""), { status: p.status, headers: { "content-type": "text/html", ...(p.location ? { location: p.location } : {}) } });
    }) as typeof fetch;
    const c = await crawlerInterne("https://s.fr/", { fetchImpl });
    const res = analyserCrawl("https://s.fr/", "interne", c.depart, c.pages, c.sitemap);
    const prof = Object.fromEntries(res.pages.map((p) => [p.url, p.profondeur]));
    expect(prof["https://s.fr/b"]).toBe(2);
    expect(res.synthese.parClasse).toMatchObject({ "2xx": 4, "3xx": 1, "4xx": 1 });
    expect(res.synthese.liensCasses.map((l) => l.cible)).toEqual(["https://s.fr/casse"]);
    expect(res.synthese.liensVersRedirections.map((l) => l.cible)).toEqual(["https://s.fr/ancienne"]);
    expect(res.synthese.orphelines).toEqual(["https://s.fr/orpheline"]);
    expect(res.problemes.map((p) => p.code)).toContain("liens_casses");
  });
});

describe("pages et backlog", () => {
  it("croise Search Console et crawl et priorise les actions", () => {
    const pages = enrichirPages([r(["https://s.fr/a"], 5, 2000, 9), r(["https://s.fr/morte"], 0, 10, 40)], [r(["https://s.fr/morte"], 80, 900, 5)]);
    const req = enrichirRequetes([r(["parking orly"], 5, 2000, 9)], [], [r(["parking orly", "https://s.fr/a"], 5, 2000, 9)], ["x"]);
    const base = { status: 200, finalUrl: "", title: "Accueil", titleLength: 7, metaDescription: "", metaLength: 0, h1: ["x"], canonical: "", robots: "", ogImage: "", maxImagePreviewLarge: false, datePublished: false, wordCount: 200, internalLinks: 1, imagesSansAlt: 0, tempsMs: 0, profondeur: 5, liens: [], liensEntrants: 1, h2: 0, h3: 0, schemas: [], hreflang: 0, lang: "fr", indexable: true, dansSitemap: true } satisfies Omit<PageCrawl, "url">;
    const crawl = { site: "s", date: "", moteur: "interne" as const, depart: "https://s.fr/", urlsSitemap: 0, synthese: {} as never, problemes: [],
      pages: [{ ...base, url: "https://s.fr/a" }, { ...base, url: "https://s.fr/morte", status: 404, indexable: false }, { ...base, url: "https://s.fr/zombie", wordCount: 900 }] };
    const lignes = fusionnerPages(pages, req, crawl, []);
    expect(lignes.find((l) => l.url === "https://s.fr/zombie")!.drapeaux).toContain("zombie");
    expect(lignes.find((l) => l.url === "https://s.fr/a")!.drapeaux).toEqual(expect.arrayContaining(["profonde", "contenu mince"]));
    const a = backlog("https://s.fr/", [], lignes);
    const types = a.map((x) => x.type);
    expect(types).toEqual(expect.arrayContaining(["technique", "maillage", "profondeur", "title"]));
    for (const x of a) expect(x.score).toBe(Math.round((x.gain * x.confiance) / x.effort));
    expect(a[0]!.score).toBeGreaterThanOrEqual(a.at(-1)!.score);
  });
});

describe("PageSpeed et benchmark", () => {
  it("note les Core Web Vitals selon les seuils officiels", () => {
    expect(noter("lcp", 2400)).toBe("bon");
    expect(noter("inp", 300)).toBe("a_ameliorer");
    expect(noter("cls", 0.3)).toBe("mauvais");
    const t = lireTerrain({ metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 2000 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 30 }, INTERACTION_TO_NEXT_PAINT: { percentile: 150 } } });
    expect(t!.cls!.p75).toBe(0.3);
    expect(t!.global).toBe("mauvais");
  });

  it("compare une page au top 3", () => {
    const long = (n: number, extra: string) => `<html><head><title>Parking Orly 2026 : tarifs</title><script type="application/ld+json">{"@type":"FAQPage"}</script></head><body><h1>x</h1><h2>a</h2><h2>b</h2><h2>c</h2><table></table>${"navette tarif réservation terminal ".repeat(n)}${extra}</body></html>`;
    const conc = [1, 2, 3].map((i) => ({ profil: profiler(`https://c${i}.fr/`, long(300, ""), "parking orly", i), texte: "navette tarif réservation terminal ".repeat(300) }));
    const moi = profiler("https://s.fr/a", "<html><head><title>Garer sa voiture</title></head><body><h1>x</h1>court texte</body></html>", "parking orly");
    const b = comparer("parking orly", moi, "court texte", conc);
    expect(b.mediane.mots).toBeGreaterThan(1000);
    expect(b.termesManquants).toContain("navette");
    expect(b.ecarts.join(" ")).toMatch(/plus court/);
    expect(b.ecarts.join(" ")).toMatch(/FAQPage/);
  });
});

import { categoriser, CATEGORIES_DEFAUT, mesurer, poids, proposerPanier, regexPanier, scorePosition, type Panier } from "../src/dashboard/visibilite.js";

describe("KR Organic Search Visibility", () => {
  it("applique le barème de positions", () => {
    expect([1, 2, 3, 4, 5, 6, 10, 11, 20, 21, null].map(scorePosition)).toEqual([100, 85, 70, 50, 50, 25, 25, 10, 10, 0, 0]);
  });

  it("reproduit l'exemple de calcul : 1 275 / 2 000 = 63,75 %", () => {
    const panier: Panier = {
      site: "s", creeLe: "", periodeSource: { debut: "", fin: "" }, marque: [], univers: "", categories: CATEGORIES_DEFAUT,
      requetes: [
        { requete: "parking paris", categorie: "ville", poids: 10 },
        { requete: "parking gare de lyon", categorie: "gare", poids: 5 },
        { requete: "parking bercy", categorie: "poi", poids: 3 },
        { requete: "parking accor arena", categorie: "evenement", poids: 2 },
      ],
    };
    const m = mesurer(panier, "2027-01", [r(["parking paris"], 1, 10, 3), r(["parking gare de lyon"], 1, 10, 1), r(["Parking Bercy"], 1, 10, 6)]);
    expect(m.part).toBe(0.6375);
    expect(m.absentes).toBe(1);
    expect(m.parCategorie.find((c) => c.id === "gare")!.part).toBe(1);
  });

  it("propose un panier hors marque, réparti par typologie et pondéré", () => {
    expect(categoriser("parking aéroport orly", CATEGORIES_DEFAUT)).toBe("aeroport");
    expect(categoriser("parking gare montparnasse", CATEGORIES_DEFAUT)).toBe("gare");
    expect(categoriser("parking lyon", CATEGORIES_DEFAUT)).toBe("ville");
    expect(poids(0)).toBe(1);
    expect(poids(1_000_000)).toBe(10);
    const p = proposerPanier("s", [r(["parking indigo orly"], 1, 9000, 1), r(["parking orly"], 1, 5000, 2), r(["parking"], 1, 99999, 2), r(["restaurant lyon"], 1, 9000, 2), r(["parking gare de lyon"], 1, 300, 4)],
      { marque: ["indigo"], periode: { debut: "", fin: "" } });
    expect(p.requetes.map((q) => q.requete)).toEqual(["parking orly", "parking gare de lyon"]);
  });

  it("découpe le panier en expressions régulières exactes", () => {
    const rx = regexPanier(["parking (paris)", "parking orly"], 20);
    expect(rx.length).toBe(2);
    expect(new RegExp(rx[0]!).test("parking (paris)")).toBe(true);
    expect(new RegExp(rx[0]!).test("parking (paris) pas cher")).toBe(false);
  });
});

import { pagerankInterne } from "../src/dashboard/crawl.js";

describe("maillage", () => {
  it("donne le PageRank interne le plus haut à la page la plus liée", () => {
    const p = (url: string, liens: string[]) => ({ url, liens, status: 200 });
    const pr = pagerankInterne([p("https://s.fr/", ["https://s.fr/a", "https://s.fr/b"]), p("https://s.fr/a", ["https://s.fr/b"]), p("https://s.fr/b", ["https://s.fr/"]), p("https://s.fr/c", ["https://s.fr/b"])]);
    expect(pr.get("https://s.fr/b")).toBe(100);
    expect(pr.get("https://s.fr/c")).toBe(0);
  });
});

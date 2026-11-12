import { describe, expect, it } from "vitest";
import { ctrAttendu, hostKey, opportunites, periode, seoVsSea, totaux } from "../src/dashboard/analyse.js";
import { analyserHtml, problemes } from "../src/dashboard/audit.js";
import { dimensions } from "../src/scripts/discover.js";

describe("analyse", () => {
  it("rapproche les propriétés Search Console et Bing", () => {
    expect(hostKey("sc-domain:okooltrip.fr")).toBe("okooltrip.fr");
    expect(hostKey("https://www.okooltrip.fr/")).toBe("okooltrip.fr");
    expect(hostKey("https://blog.indigoneo.fr/")).toBe("blog.indigoneo.fr");
  });

  it("arrête la période 3 jours avant aujourd'hui et calcule la précédente", () => {
    const p = periode(28, new Date("2026-11-12T10:00:00Z"));
    expect(p).toEqual({ debut: "2026-10-13", fin: "2026-11-09", debutPrec: "2026-09-15", finPrec: "2026-10-12" });
  });

  it("pondère la position par les impressions", () => {
    const t = totaux([
      { clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
      { clicks: 0, impressions: 300, ctr: 0, position: 10 },
    ]);
    expect(t).toEqual({ clicks: 10, impressions: 400, ctr: 0.025, position: 8 });
  });

  it("détecte CTR faible, page 2, cannibalisation et déclin", () => {
    const rows = [
      { keys: ["parking orly", "https://s.fr/a"], clicks: 5, impressions: 1000, ctr: 0.005, position: 2 },
      { keys: ["parking nice", "https://s.fr/b"], clicks: 2, impressions: 800, ctr: 0.0025, position: 14 },
      { keys: ["parking lyon", "https://s.fr/c"], clicks: 20, impressions: 500, ctr: 0.04, position: 6 },
      { keys: ["parking lyon", "https://s.fr/d"], clicks: 5, impressions: 400, ctr: 0.0125, position: 9 },
    ];
    const prec = [{ keys: ["https://s.fr/c"], clicks: 200, impressions: 3000, ctr: 0.07, position: 4 }];
    const o = opportunites(rows, prec, "https://s.fr/");
    const types = o.map((x) => x.type);
    expect(types).toContain("ctr_faible");
    expect(types).toContain("page_2");
    expect(types).toContain("cannibalisation");
    expect(types).toContain("declin");
    expect(o[0]!.priorite).toBeGreaterThanOrEqual(o.at(-1)!.priorite);
    expect(o.find((x) => x.type === "ctr_faible")!.commande).toContain("seo-opportunites meta https://s.fr/a");
    expect(ctrAttendu(1)).toBeGreaterThan(ctrAttendu(10));
  });

  it("croise termes Google Ads et requêtes Search Console", () => {
    const r = seoVsSea(
      [{ terme: "Parking Orly", cost: 100, clicks: 50, conversions: 3 }, { terme: "parking nice", cost: 80, clicks: 20, conversions: 4 }],
      [{ keys: ["parking orly"], clicks: 300, impressions: 3000, ctr: 0.1, position: 1.5 }],
    );
    expect(r.doublons.map((d) => d.terme)).toEqual(["Parking Orly"]);
    expect(r.aRenforcerSeo.map((d) => d.terme)).toEqual(["parking nice"]);
  });
});

describe("audit technique", () => {
  const html = `<html><head><title>Parking</title><meta name="robots" content="noindex">
    <link rel="canonical" href="https://s.fr/autre"></head><body><h1>A</h1><h1>B</h1><img src="x.png"></body></html>`;
  it("relève les problèmes d'une page", () => {
    const p = analyserHtml("https://s.fr/a", html, 200, "https://s.fr/a", 100);
    expect(p.h1).toEqual(["A", "B"]);
    const codes = problemes([p], null).map((x) => x.code);
    for (const c of ["sitemap", "noindex", "meta_absente", "h1", "canonical", "contenu_mince", "images_alt", "discover_image", "discover_preview", "title_court"]) {
      expect(codes).toContain(c);
    }
  });
});

describe("discover", () => {
  it("lit les dimensions d'un PNG", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47]);
    new DataView(png.buffer).setUint32(16, 1600);
    new DataView(png.buffer).setUint32(20, 900);
    expect(dimensions(png)).toEqual({ w: 1600, h: 900 });
  });
});

// Calculs du dashboard SEO : fonctions pures, sans appel réseau (testables avec des données simulées).

export interface Row {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** CTR moyen observé par position organique (ordre de grandeur, desktop + mobile confondus). */
export const CTR_ATTENDU: Record<number, number> = {
  1: 0.28, 2: 0.15, 3: 0.1, 4: 0.07, 5: 0.05, 6: 0.04, 7: 0.03, 8: 0.025, 9: 0.02, 10: 0.018,
};

export function ctrAttendu(position: number): number {
  const p = Math.max(1, Math.round(position));
  if (p <= 10) return CTR_ATTENDU[p]!;
  if (p <= 20) return 0.01;
  return 0.003;
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Clé de rapprochement entre GSC (sc-domain:x.fr, https://www.x.fr/) et Bing (https://www.x.fr/). */
export function hostKey(siteUrl: string): string {
  return siteUrl
    .replace(/^sc-domain:/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/:/g, "_")
    .toLowerCase();
}

export function periode(jours: number, aujourdHui = new Date()): {
  debut: string; fin: string; debutPrec: string; finPrec: string;
} {
  // Search Console a 2 à 3 jours de retard : la période s'arrête 3 jours avant aujourd'hui.
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const fin = new Date(aujourdHui); fin.setUTCDate(fin.getUTCDate() - 3);
  const debut = new Date(fin); debut.setUTCDate(debut.getUTCDate() - (jours - 1));
  const finPrec = new Date(debut); finPrec.setUTCDate(finPrec.getUTCDate() - 1);
  const debutPrec = new Date(finPrec); debutPrec.setUTCDate(debutPrec.getUTCDate() - (jours - 1));
  return { debut: iso(debut), fin: iso(fin), debutPrec: iso(debutPrec), finPrec: iso(finPrec) };
}

export interface Totaux { clicks: number; impressions: number; ctr: number; position: number }

export function totaux(rows: Row[]): Totaux {
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const posPond = rows.reduce((s, r) => s + r.position * r.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: impressions ? round(clicks / impressions, 4) : 0,
    position: impressions ? round(posPond / impressions, 1) : 0,
  };
}

export function variation(actuel: number, precedent: number): number | null {
  if (!precedent) return null;
  return round((actuel - precedent) / precedent, 3);
}

export type TypeOpportunite = "ctr_faible" | "page_2" | "cannibalisation" | "declin";

export interface Opportunite {
  type: TypeOpportunite;
  priorite: number; // clics supplémentaires estimés par période
  requete?: string;
  page?: string;
  pages?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  action: string;
  commande: string; // commande à coller dans Claude Code
}

/**
 * Détecte les opportunités à partir des lignes GSC [query, page] de la période
 * et des lignes [page] de la période précédente.
 */
export function opportunites(
  requetePage: Row[],
  pagesPrecedentes: Row[],
  siteUrl: string,
  options: { minImpressions?: number } = {},
): Opportunite[] {
  const minImp = options.minImpressions ?? 100;
  const out: Opportunite[] = [];
  const site = JSON.stringify(siteUrl);

  for (const r of requetePage) {
    const [requete = "", page = ""] = r.keys ?? [];
    if (r.impressions < minImp) continue;
    // 1. Bien positionné mais peu cliqué : le title et la meta description ne donnent pas envie.
    if (r.position <= 10) {
      const attendu = ctrAttendu(r.position);
      if (r.ctr < attendu * 0.6) {
        out.push({
          type: "ctr_faible",
          priorite: Math.round((attendu - r.ctr) * r.impressions),
          requete, page, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: round(r.position, 1),
          action: `CTR ${pct(r.ctr)} au lieu de ~${pct(attendu)} attendu en position ${round(r.position, 1).toLocaleString("fr-FR")} : réécrire le title et la meta description.`,
          commande: `/seo-pilote:seo-opportunites meta ${page} "${requete}"`,
        });
      }
    } else if (r.position <= 20) {
      // 2. Page 2 : le contenu et le maillage peuvent la faire passer en page 1.
      const gain = Math.round((ctrAttendu(5) - r.ctr) * r.impressions);
      out.push({
        type: "page_2",
        priorite: gain,
        requete, page, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: round(r.position, 1),
        action: `Position ${round(r.position, 1).toLocaleString("fr-FR")} : enrichir le contenu face aux concurrents et ajouter des liens internes vers cette page.`,
        commande: `/seo-pilote:seo-opportunites contenu ${page} "${requete}"`,
      });
    }
  }

  // 3. Cannibalisation : plusieurs pages du site se partagent la même requête.
  const parRequete = new Map<string, Row[]>();
  for (const r of requetePage) {
    const q = r.keys?.[0];
    if (!q) continue;
    parRequete.set(q, [...(parRequete.get(q) ?? []), r]);
  }
  for (const [requete, rows] of parRequete) {
    const total = rows.reduce((s, r) => s + r.impressions, 0);
    if (total < minImp) continue;
    const fortes = rows.filter((r) => r.impressions >= total * 0.15 && r.position <= 30);
    if (fortes.length < 2) continue;
    const t = totaux(rows);
    out.push({
      type: "cannibalisation",
      priorite: Math.round((ctrAttendu(3) - t.ctr) * total * 0.5),
      requete,
      pages: fortes.map((r) => r.keys?.[1] ?? ""),
      clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position,
      action: `${fortes.length} pages se partagent « ${requete} » : choisir une page principale, fusionner ou différencier, et pointer les liens internes vers elle.`,
      commande: `/seo-pilote:seo-opportunites cannibalisation ${site} "${requete}"`,
    });
  }

  // 4. Pages en déclin par rapport à la période précédente.
  const pagesActuelles = new Map<string, Row>();
  for (const r of requetePage) {
    const page = r.keys?.[1];
    if (!page) continue;
    const a = pagesActuelles.get(page) ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    pagesActuelles.set(page, { clicks: a.clicks + r.clicks, impressions: a.impressions + r.impressions, ctr: 0, position: 0 });
  }
  for (const p of pagesPrecedentes) {
    const page = p.keys?.[0];
    if (!page) continue;
    const actuel = pagesActuelles.get(page)?.clicks ?? 0;
    const perte = p.clicks - actuel;
    if (perte >= 20 && actuel <= p.clicks * 0.7) {
      out.push({
        type: "declin",
        priorite: perte,
        page,
        clicks: actuel, impressions: pagesActuelles.get(page)?.impressions ?? 0, ctr: 0, position: p.position,
        action: `${perte} clics perdus (${p.clicks} → ${actuel}) : vérifier l'indexation, la fraîcheur du contenu et les concurrents qui sont passés devant.`,
        commande: `/seo-pilote:seo-opportunites declin ${page}`,
      });
    }
  }

  return out.filter((o) => o.priorite > 0).sort((a, b) => b.priorite - a.priorite);
}

export function pct(n: number): string {
  return `${round(n * 100, 1).toLocaleString("fr-FR")} %`;
}

/** Requêtes payées sur Google Ads alors que le site est déjà dans le top 3 organique, et l'inverse. */
export function seoVsSea(
  termesAds: Array<{ terme: string; cost: number; clicks: number; conversions: number }>,
  requetesGsc: Row[],
): {
  doublons: Array<{ terme: string; cost: number; clicksAds: number; position: number; clicksSeo: number }>;
  aRenforcerSeo: Array<{ terme: string; cost: number; conversions: number; position: number | null }>;
} {
  const gsc = new Map<string, Row>();
  for (const r of requetesGsc) {
    const q = r.keys?.[0]?.toLowerCase().trim();
    if (q) gsc.set(q, r);
  }
  const doublons = [];
  const aRenforcerSeo = [];
  for (const t of termesAds) {
    const g = gsc.get(t.terme.toLowerCase().trim());
    if (g && g.position <= 3 && t.cost > 0) {
      doublons.push({ terme: t.terme, cost: t.cost, clicksAds: t.clicks, position: round(g.position, 1), clicksSeo: g.clicks });
    } else if (t.conversions > 0 && (!g || g.position > 10)) {
      aRenforcerSeo.push({ terme: t.terme, cost: t.cost, conversions: t.conversions, position: g ? round(g.position, 1) : null });
    }
  }
  doublons.sort((a, b) => b.cost - a.cost);
  aRenforcerSeo.sort((a, b) => b.conversions - a.conversions);
  return { doublons: doublons.slice(0, 100), aRenforcerSeo: aRenforcerSeo.slice(0, 100) };
}

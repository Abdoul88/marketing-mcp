// Analyse avancée des requêtes et des pages Search Console : tranches de positions (Top 3, Top 10…),
// marque / hors marque, intentions, clusters (par page et par thème), répertoires, évolutions et alertes.
// Fonctions pures, sans appel réseau.
import { ctrAttendu, totaux, variation, type Row } from "./analyse.js";

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// --- normalisation du texte ---
const MOTS_VIDES = new Set(
  ("a au aux avec ce ces dans de des du en et la le les leur lui ma mais me mes mon ne nos notre ou par pas pour qu que qui sa se ses son sur ta te tes ton un une vos votre y d l s c j n m t " +
    "el los las del al lo un una unos unas por para con sin en y o que se su sus es " +
    "the of and for to in on at by with from is are or an")
    .split(" "),
);

export function normaliser(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Racine légère : retire le pluriel (« parkings » → « parking », « aéroports » → « aeroport »). */
// Noms propres qui finissent par s ou x : ne pas les « dépluraliser » (paris ≠ pari).
const INVARIABLES = new Set(
  ("paris nantes rennes reims tours versailles cannes lens angers nimes vannes thionville avignon calais lyonnais sevres ivry vincennes " +
    "invalides halles champs elysees lilas mans sables arras gonesse roissy brest chartres valenciennes clamecy amboise bruxelles anvers " +
    "luxembourg ardennes landes vosges alpes pyrenees charentes marseillais francais anglais thermes jours mois fois prix temps bus taxis plus moins")
    .split(" "),
);

function racine(t: string): string {
  return t.length > 4 && /[sx]$/.test(t) && !INVARIABLES.has(t) ? t.slice(0, -1) : t;
}

export function tokens(requete: string): string[] {
  return normaliser(requete).split(" ").filter((t) => t.length > 1 && !MOTS_VIDES.has(t)).map(racine);
}

// --- marque ---
/** Termes de marque par défaut : le nom de domaine sans TLD ni tirets (blog.indigoneo.fr → indigoneo). */
export function marqueParDefaut(siteUrl: string): string[] {
  const host = siteUrl.replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  const parties = host.split(".");
  const label = parties.length >= 2 ? parties[parties.length - 2]! : parties[0]!;
  // Marques connues : « indigo » couvre « indigoneo » et « indigo neo » ; OPnGO est l'ancien nom de l'appli.
  if (/indigo/.test(label)) return ["indigo", "opngo", "parkindigo"];
  return [label.replace(/-/g, "")];
}

export function estMarque(requete: string, termes: string[]): boolean {
  const compact = normaliser(requete).replace(/\s+/g, "");
  return termes.some((t) => {
    const c = normaliser(t).replace(/\s+/g, "");
    return c.length >= 3 && compact.includes(c);
  });
}

// --- intentions ---
export type Intention = "marque" | "transactionnelle" | "locale" | "informationnelle" | "autre";
const RE_TRANSAC = /\b(prix|tarifs?|cout|couts|pas cher|moins cher|reserv\w*|abonnement\w*|achet\w*|achat|promo\w*|code promo|offre\w*|devis|locations?|louer|comprar|precios?|reservar|tarifa\w*|barat\w*|book\w*|price\w*|cheap\w*|buy)\b/;
const RE_LOCAL = /\b(pres de|proche|a cote|autour|near|cerca|proximite|centre ville|centro)\b/;
const RE_INFO = /\b(comment|pourquoi|quel\w*|qu est|combien|definition|guide|conseils?|astuces?|faut il|est ce|como|cual\w*|cuanto|que es|how|what|why|which|when|quand|ou se garer|donde)\b/;

export function intention(requete: string, marque: boolean): Intention {
  if (marque) return "marque";
  const n = normaliser(requete);
  if (RE_TRANSAC.test(n)) return "transactionnelle";
  if (RE_LOCAL.test(n)) return "locale";
  if (RE_INFO.test(n)) return "informationnelle";
  return "autre";
}

// --- tranches de positions ---
export const TRANCHES = ["top3", "top10", "top20", "top50", "au_dela"] as const;
export type Tranche = (typeof TRANCHES)[number];
export const NOMS_TRANCHES: Record<Tranche, string> = { top3: "Top 3", top10: "4 à 10", top20: "11 à 20", top50: "21 à 50", au_dela: "Au-delà de 50" };

export function tranche(position: number): Tranche {
  const p = Math.round(position);
  if (p <= 3) return "top3";
  if (p <= 10) return "top10";
  if (p <= 20) return "top20";
  if (p <= 50) return "top50";
  return "au_dela";
}

// --- requêtes enrichies ---
export interface Requete {
  requete: string;
  clicks: number; impressions: number; ctr: number; position: number;
  clicksPrec: number; impressionsPrec: number; positionPrec: number | null;
  varClicks: number | null;
  deltaPosition: number | null; // positif = recul
  tranche: Tranche; tranchePrec: Tranche | null;
  marque: boolean; intention: Intention;
  mots: number; // longueur de la requête (longue traîne)
  page?: string; // page principale
  nbPages: number;
  statut: "nouvelle" | "stable" | "hausse" | "baisse";
}

export function enrichirRequetes(cur: Row[], prev: Row[], requetePage: Row[], marque: string[]): Requete[] {
  const p = new Map(prev.map((r) => [r.keys![0]!, r]));
  const pages = new Map<string, Row[]>();
  for (const r of requetePage) {
    const q = r.keys?.[0];
    if (q) pages.set(q, [...(pages.get(q) ?? []), r]);
  }
  return cur.map((r) => {
    const q = r.keys![0]!;
    const a = p.get(q);
    const m = estMarque(q, marque);
    const lp = (pages.get(q) ?? []).sort((x, y) => y.clicks - x.clicks || y.impressions - x.impressions);
    const delta = a ? round(r.position - a.position) : null;
    return {
      requete: q,
      clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: round(r.position),
      clicksPrec: a?.clicks ?? 0, impressionsPrec: a?.impressions ?? 0, positionPrec: a ? round(a.position) : null,
      varClicks: a ? variation(r.clicks, a.clicks) : null,
      deltaPosition: delta,
      tranche: tranche(r.position), tranchePrec: a ? tranche(a.position) : null,
      marque: m, intention: intention(q, m),
      mots: normaliser(q).split(" ").filter(Boolean).length,
      page: lp[0]?.keys?.[1], nbPages: lp.length,
      statut: !a ? "nouvelle" : delta! <= -1 ? "hausse" : delta! >= 1 ? "baisse" : "stable",
    };
  });
}

export interface Agregat { nb: number; clicks: number; impressions: number; ctr: number; position: number; clicksPrec: number; varClicks: number | null }

function agreger(liste: Requete[]): Agregat {
  const t = totaux(liste.map((r) => ({ clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })));
  const clicksPrec = liste.reduce((s, r) => s + r.clicksPrec, 0);
  return { nb: liste.length, ...t, clicksPrec, varClicks: variation(t.clicks, clicksPrec) };
}

/** Nombre de requêtes, clics et impressions par tranche de position, avec la période précédente. */
export function distributionPositions(requetes: Requete[], prev: Row[]) {
  return TRANCHES.map((t) => {
    const l = requetes.filter((r) => r.tranche === t);
    const nbPrec = prev.filter((r) => tranche(r.position) === t).length;
    return { tranche: t, nom: NOMS_TRANCHES[t], ...agreger(l), nbPrec, deltaNb: l.length - nbPrec };
  });
}

/** Mouvements entre tranches : entrées et sorties du Top 3 et du Top 10. */
export function mouvements(requetes: Requete[], prev: Row[]) {
  const cur = new Set(requetes.map((r) => r.requete));
  const rang = (t: Tranche | null) => (t ? TRANCHES.indexOf(t) : 99);
  const entre = (seuil: number) => requetes.filter((r) => rang(r.tranche) <= seuil && rang(r.tranchePrec) > seuil);
  const sort = (seuil: number) => requetes.filter((r) => r.tranchePrec && rang(r.tranchePrec) <= seuil && rang(r.tranche) > seuil);
  const perdues = prev
    .filter((r) => !cur.has(r.keys![0]!) && r.clicks > 0)
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 100)
    .map((r) => ({ requete: r.keys![0]!, clicksPrec: r.clicks, positionPrec: round(r.position) }));
  const tri = (l: Requete[]) => l.sort((a, b) => b.impressions - a.impressions).slice(0, 100);
  return {
    entreesTop3: tri(entre(0)), sortiesTop3: tri(sort(0)),
    entreesTop10: tri(entre(1)), sortiesTop10: tri(sort(1)),
    nouvelles: tri(requetes.filter((r) => r.statut === "nouvelle")),
    perdues,
  };
}

export function segmentMarque(requetes: Requete[]) {
  return { marque: agreger(requetes.filter((r) => r.marque)), horsMarque: agreger(requetes.filter((r) => !r.marque)) };
}

export function parIntention(requetes: Requete[]) {
  const noms: Intention[] = ["marque", "transactionnelle", "locale", "informationnelle", "autre"];
  return noms.map((i) => ({ intention: i, ...agreger(requetes.filter((r) => r.intention === i)) }));
}

export function longueTraine(requetes: Requete[]) {
  const classes = [["1 mot", 1, 1], ["2 mots", 2, 2], ["3 mots", 3, 3], ["4 mots et +", 4, 99]] as const;
  return classes.map(([nom, a, b]) => ({ classe: nom, ...agreger(requetes.filter((r) => r.mots >= a && r.mots <= b)) }));
}

// --- clusters ---
export interface Cluster {
  nom: string;
  page?: string;
  requetes: number;
  clicks: number; impressions: number; ctr: number; position: number; varClicks: number | null;
  top3: number; top10: number;
  principales: Array<{ requete: string; clicks: number; impressions: number; position: number }>;
  potentiel: number; // clics à gagner si le cluster atteignait le CTR attendu en position 3
}

function cluster(nom: string, l: Requete[], page?: string): Cluster {
  const a = agreger(l);
  const potentiel = Math.max(0, Math.round(l.reduce((s, r) => s + Math.max(0, ctrAttendu(Math.min(r.position, 3)) - r.ctr) * r.impressions, 0)));
  return {
    nom, page, requetes: l.length, clicks: a.clicks, impressions: a.impressions, ctr: a.ctr, position: a.position, varClicks: a.varClicks,
    top3: l.filter((r) => r.tranche === "top3").length, top10: l.filter((r) => r.tranche === "top3" || r.tranche === "top10").length,
    principales: [...l].sort((x, y) => y.impressions - x.impressions).slice(0, 8).map((r) => ({ requete: r.requete, clicks: r.clicks, impressions: r.impressions, position: r.position })),
    potentiel,
  };
}

/** Le mot le plus fréquent d'un groupe de requêtes (hors mots trop génériques du site) sert de nom. */
function nommer(l: Requete[], generiques: Set<string>): string {
  const poids = new Map<string, number>();
  for (const r of l) {
    const t = tokens(r.requete);
    for (let i = 0; i < t.length; i++) {
      if (!generiques.has(t[i]!)) poids.set(t[i]!, (poids.get(t[i]!) ?? 0) + r.impressions + 1);
      if (i + 1 < t.length) {
        const bi = `${t[i]} ${t[i + 1]}`;
        poids.set(bi, (poids.get(bi) ?? 0) + (r.impressions + 1) * 1.2);
      }
    }
  }
  return [...poids.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? l[0]?.requete ?? "—";
}

/** Mots présents dans plus de 25 % des requêtes (ex. « parking » sur un site de parkings). */
export function motsGeneriques(requetes: Requete[]): Set<string> {
  const df = new Map<string, number>();
  for (const r of requetes) for (const t of new Set(tokens(r.requete))) df.set(t, (df.get(t) ?? 0) + 1);
  const seuil = Math.max(3, requetes.length * 0.25);
  return new Set([...df.entries()].filter(([, n]) => n >= seuil).map(([t]) => t));
}

/**
 * Cluster par page : les requêtes pour lesquelles Google classe la même page traitent du même sujet
 * (équivalent gratuit d'un clustering par SERP).
 */
export function clustersParPage(requetes: Requete[]): Cluster[] {
  const gen = motsGeneriques(requetes);
  const parPage = new Map<string, Requete[]>();
  for (const r of requetes) if (r.page) parPage.set(r.page, [...(parPage.get(r.page) ?? []), r]);
  return [...parPage.entries()]
    .map(([page, l]) => cluster(nommer(l, gen), l, page))
    .sort((a, b) => b.impressions - a.impressions);
}

/** Cluster par thème : chaque requête rejoint son mot discriminant le plus fort (ville, lieu, service…). */
export function clustersParTheme(toutes: Requete[]): Cluster[] {
  // Les requêtes de marque forment un cluster à part : les thèmes décrivent le hors-marque.
  const requetes = toutes.filter((r) => !r.marque);
  const marque = toutes.filter((r) => r.marque);
  const gen = motsGeneriques(requetes);
  const poids = new Map<string, number>();
  for (const r of requetes) for (const t of new Set(tokens(r.requete))) if (!gen.has(t) && t.length > 2) poids.set(t, (poids.get(t) ?? 0) + r.impressions + 1);
  const groupes = new Map<string, Requete[]>();
  for (const r of requetes) {
    const t = tokens(r.requete).filter((x) => !gen.has(x) && x.length > 2).sort((a, b) => (poids.get(b) ?? 0) - (poids.get(a) ?? 0));
    const cle = t[0] ?? "(générique)";
    groupes.set(cle, [...(groupes.get(cle) ?? []), r]);
  }
  if (marque.length) groupes.set("Marque", marque);
  return [...groupes.entries()]
    .map(([cle, l]) => {
      const c = cluster(cle, l);
      const pages = new Map<string, number>();
      for (const r of l) if (r.page) pages.set(r.page, (pages.get(r.page) ?? 0) + r.impressions);
      const tri = [...pages.entries()].sort((a, b) => b[1] - a[1]);
      return { ...c, page: tri[0]?.[0], pagesDifferentes: tri.length };
    })
    .sort((a, b) => b.impressions - a.impressions);
}

// --- pages et répertoires ---
export function repertoire(url: string): string {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    if (!segs.length) return "/";
    // Les préfixes de langue (/fr/, /es/, /en-gb/) ne suffisent pas à décrire une section.
    if (/^[a-z]{2}(-[a-z]{2})?$/i.test(segs[0]!) && segs.length > 1) return `/${segs[0]}/${segs[1]}/`;
    return segs.length === 1 && /\.[a-z]{2,4}$|-/.test(segs[0]!) ? "/ (pages racine)" : `/${segs[0]}/`;
  } catch {
    return "/";
  }
}

export interface PageGsc { page: string; clicks: number; impressions: number; ctr: number; position: number; clicksPrec: number; impressionsPrec: number; positionPrec: number | null; varClicks: number | null; repertoire: string }

export function enrichirPages(cur: Row[], prev: Row[]): PageGsc[] {
  const p = new Map(prev.map((r) => [r.keys![0]!, r]));
  return cur.map((r) => {
    const a = p.get(r.keys![0]!);
    return {
      page: r.keys![0]!, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: round(r.position),
      clicksPrec: a?.clicks ?? 0, impressionsPrec: a?.impressions ?? 0, positionPrec: a ? round(a.position) : null,
      varClicks: a ? variation(r.clicks, a.clicks) : null, repertoire: repertoire(r.keys![0]!),
    };
  });
}

export function parRepertoire(pages: PageGsc[]) {
  const g = new Map<string, PageGsc[]>();
  for (const p of pages) g.set(p.repertoire, [...(g.get(p.repertoire) ?? []), p]);
  return [...g.entries()]
    .map(([rep, l]) => {
      const t = totaux(l);
      const clicksPrec = l.reduce((s, x) => s + x.clicksPrec, 0);
      const imprPrec = l.reduce((s, x) => s + x.impressionsPrec, 0);
      return { repertoire: rep, pages: l.length, ...t, clicksPrec, varClicks: variation(t.clicks, clicksPrec), varImpressions: variation(t.impressions, imprPrec) };
    })
    .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

// --- alertes ---
export interface Alerte {
  gravite: "critique" | "important" | "info";
  type: string;
  titre: string;
  detail: string;
  cible?: string;
  valeur?: number;
}

export interface SeuilsAlertes { baisseGlobale: number; baissePage: number; minClicsPage: number; reculPosition: number; minImpressions: number }
export const SEUILS_DEFAUT: SeuilsAlertes = { baisseGlobale: 0.1, baissePage: 0.3, minClicsPage: 20, reculPosition: 3, minImpressions: 100 };

const pc = (v: number) => `${round(v * 100, 0)} %`;

export function alertes(
  entree: {
    serie: Array<{ date: string; clicks: number; impressions: number }>;
    requetes: Requete[];
    pages: PageGsc[];
    prevRequetes: Row[];
  },
  seuils: SeuilsAlertes = SEUILS_DEFAUT,
): Alerte[] {
  const out: Alerte[] = [];
  const { requetes, pages } = entree;

  // 1. Tendance globale, marque et hors marque séparées (une baisse de marque n'a pas la même cause).
  const seg = segmentMarque(requetes);
  for (const [nom, a] of [["Trafic total", agreger(requetes)], ["Trafic de marque", seg.marque], ["Trafic hors marque", seg.horsMarque]] as const) {
    if (a.varClicks != null && a.varClicks <= -seuils.baisseGlobale && a.clicksPrec >= 50) {
      out.push({
        gravite: a.varClicks <= -0.25 ? "critique" : "important", type: "baisse_globale",
        titre: `${nom} en baisse de ${pc(-a.varClicks)}`,
        detail: `${a.clicksPrec.toLocaleString("fr-FR")} → ${a.clicks.toLocaleString("fr-FR")} clics par rapport à la période précédente.`,
        valeur: a.varClicks,
      });
    }
  }

  // 2. Rupture récente : 7 derniers jours contre les 7 précédents.
  const s = entree.serie;
  if (s.length >= 14) {
    const som = (l: typeof s) => l.reduce((x, r) => x + r.clicks, 0);
    const d7 = som(s.slice(-7)), p7 = som(s.slice(-14, -7));
    const v = variation(d7, p7);
    if (v != null && v <= -0.15 && p7 >= 30) {
      out.push({ gravite: v <= -0.3 ? "critique" : "important", type: "rupture_semaine", titre: `Clics des 7 derniers jours en baisse de ${pc(-v)}`, detail: `${p7.toLocaleString("fr-FR")} → ${d7.toLocaleString("fr-FR")} clics, semaine contre semaine : vérifier mise en ligne récente, mise à jour Google, indexation.`, valeur: v });
    }
  }

  // 2 bis. Anomalies journalières : écart > 2σ par rapport aux 28 jours précédents.
  for (const a of anomalies(s)) {
    out.push({ gravite: a.z <= -3 ? "critique" : "important", type: "anomalie", titre: `Anomalie le ${a.date.split("-").reverse().join("/")} : ${a.clicks.toLocaleString("fr-FR")} clics`, detail: `Écart de ${a.z.toLocaleString("fr-FR")} σ par rapport à la moyenne des 28 jours précédents (${a.moyenne.toLocaleString("fr-FR")} clics/jour).`, valeur: a.z });
  }

  // 3. Pages qui perdent du trafic.
  for (const p of pages) {
    const perte = p.clicksPrec - p.clicks;
    if (p.clicksPrec >= seuils.minClicsPage && perte > 0 && perte / p.clicksPrec >= seuils.baissePage) {
      out.push({ gravite: perte >= 200 ? "critique" : "important", type: "page_baisse", titre: `Page en baisse de ${pc(perte / p.clicksPrec)}`, detail: `${p.clicksPrec} → ${p.clicks} clics, position ${p.positionPrec ?? "—"} → ${p.position}.`, cible: p.page, valeur: -perte });
    }
  }

  // 4. Requêtes qui reculent.
  for (const r of requetes) {
    if (r.impressions < seuils.minImpressions || r.positionPrec == null) continue;
    if (r.tranchePrec === "top3" && r.tranche !== "top3") {
      out.push({ gravite: r.clicksPrec >= 50 ? "critique" : "important", type: "sortie_top3", titre: `« ${r.requete} » sort du Top 3`, detail: `Position ${r.positionPrec} → ${r.position}, ${r.clicksPrec} → ${r.clicks} clics.`, cible: r.page, valeur: r.deltaPosition ?? 0 });
    } else if ((r.tranchePrec === "top3" || r.tranchePrec === "top10") && r.tranche !== "top3" && r.tranche !== "top10") {
      out.push({ gravite: "important", type: "sortie_top10", titre: `« ${r.requete} » sort du Top 10`, detail: `Position ${r.positionPrec} → ${r.position}.`, cible: r.page, valeur: r.deltaPosition ?? 0 });
    } else if (r.deltaPosition != null && r.deltaPosition >= seuils.reculPosition && r.positionPrec <= 20) {
      out.push({ gravite: "info", type: "recul_position", titre: `« ${r.requete} » recule de ${r.deltaPosition} places`, detail: `Position ${r.positionPrec} → ${r.position}, ${r.impressions.toLocaleString("fr-FR")} impressions.`, cible: r.page, valeur: r.deltaPosition });
    }
  }
  // 5. Requêtes disparues qui apportaient des clics.
  const cur = new Set(requetes.map((r) => r.requete));
  for (const r of entree.prevRequetes) {
    if (!cur.has(r.keys![0]!) && r.clicks >= 10) {
      out.push({ gravite: r.clicks >= 50 ? "important" : "info", type: "requete_perdue", titre: `« ${r.keys![0]} » ne génère plus d'impressions`, detail: `${r.clicks} clics en position ${round(r.position)} sur la période précédente.`, valeur: -r.clicks });
    }
  }
  const ordre = { critique: 0, important: 1, info: 2 };
  return out.sort((a, b) => ordre[a.gravite] - ordre[b.gravite] || Math.abs(b.valeur ?? 0) - Math.abs(a.valeur ?? 0));
}

/** Jours (parmi les 7 derniers) dont les clics s'écartent de plus de 2 écarts-types des 28 jours précédents. */
export function anomalies(serie: Array<{ date: string; clicks: number }>, seuil = 2) {
  const out: Array<{ date: string; clicks: number; moyenne: number; z: number }> = [];
  for (let i = Math.max(28, serie.length - 7); i < serie.length; i++) {
    const fen = serie.slice(i - 28, i).map((r) => r.clicks);
    const m = fen.reduce((a, b) => a + b, 0) / fen.length;
    const sd = Math.sqrt(fen.reduce((a, b) => a + (b - m) ** 2, 0) / fen.length);
    if (!sd || m < 10) continue;
    const z = round((serie[i]!.clicks - m) / sd, 1);
    if (z <= -seuil) out.push({ date: serie[i]!.date, clicks: serie[i]!.clicks, moyenne: Math.round(m), z });
  }
  return out;
}

// KR « Organic Search Visibility » : part de visibilité sur un panier FIXE de requêtes stratégiques hors marque.
//   Visibility Share = Σ (poids × score de position) / Σ (poids × 100)
// Barème : 1 → 100, 2 → 85, 3 → 70, 4-5 → 50, 6-10 → 25, 11-20 → 10, > 20 ou absent → 0.
// Le panier se fige au départ (le KR doit comparer des mois comparables) ; on ne le régénère que volontairement.
import type { Row } from "./analyse.js";
import { estMarque, normaliser } from "./mots-cles.js";

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export const BAREME: Array<[number, number]> = [[1, 100], [2, 85], [3, 70], [5, 50], [10, 25], [20, 10]];

export function scorePosition(position: number | null | undefined): number {
  if (position == null || !(position > 0)) return 0;
  const p = Math.round(position);
  for (const [max, score] of BAREME) if (p <= max) return score;
  return 0;
}

export interface Categorie { id: string; nom: string; motif: string }

/** Typologies INDIGO Neo, dans l'ordre de priorité (une requête prend la première qui correspond). */
export const CATEGORIES_DEFAUT: Categorie[] = [
  { id: "aeroport", nom: "Parking + aéroport", motif: "aeroport|airport|orly|roissy|\\bcdg\\b|charles de gaulle|beauvais|marignane|blagnac|merignac|saint exupery|nice cote d azur|lesquin|bale mulhouse|nantes atlantique|frejorgues|vatry" },
  { id: "gare", nom: "Parking + gare", motif: "\\bgares?\\b|\\bsncf\\b|\\btgv\\b|part dieu|perrache|saint lazare|montparnasse|austerlitz|gare du nord|gare de l est|saint charles|matabiau|saint jean|lille flandres|lille europe|marne la vallee" },
  { id: "evenement", nom: "Parking + événement / stade", motif: "stade|arena|zenith|concert|salon|festival|\\bmatch\\b|parc des princes|roland garros|velodrome|allianz|groupama|accor|paris expo|porte de versailles|villepinte|disney|marche de noel|marathon|olympia|la seine musicale|u arena|ldlc|bercy arena" },
  { id: "abonnement", nom: "Parking + abonnement", motif: "abonnement|mensuel|\\bau mois\\b|\\bpar mois\\b|residentiel|location (de )?place|louer (une )?place|place de parking a louer|annuel" },
  { id: "recharge", nom: "Recharge / borne", motif: "recharge|borne|electrique|\\birve\\b|charging" },
  { id: "poi", nom: "Parking + lieu / landmark", motif: "hopital|\\bchu\\b|clinique|universite|centre commercial|musee|tour eiffel|louvre|la defense|chatelet|opera|champs elysees|vieux port|bellecour|capitole|place |quartier|centre ville|hotel de ville|cathedrale|chateau|plage|port " },
  { id: "ville", nom: "Parking + ville / générique", motif: "." },
];

/** Requêtes de l'univers stationnement : parking, stationnement, se garer, parc relais, recharge. */
export const UNIVERS_DEFAUT = "parking|parkings|stationnement|stationner|se garer|garer|parc relais|parcotrain|\\bp\\+r\\b|recharge|borne";

export interface RequetePanier { requete: string; categorie: string; poids: number }

export interface Panier {
  site: string;
  creeLe: string;
  periodeSource: { debut: string; fin: string };
  marque: string[];
  univers: string;
  categories: Categorie[];
  requetes: RequetePanier[];
  baseline?: string; // mois de référence AAAA-MM
  cible?: number; // part visée (0-1)
  echeance?: string; // ex. 2027-12
}

export function categoriser(requete: string, categories: Categorie[]): string {
  const n = normaliser(requete);
  for (const c of categories) if (new RegExp(c.motif).test(n)) return c.id;
  return categories.at(-1)!.id;
}

/** Poids plafonné : échelle logarithmique des impressions, bornée de 1 à 10 (évite qu'une requête écrase l'indice). */
export function poids(impressions: number): number {
  return Math.max(1, Math.min(10, Math.round(2.5 * Math.log10(impressions + 1))));
}

/**
 * Propose un panier à partir des requêtes Search Console d'une période de référence :
 * hors marque, dans l'univers stationnement, réparties par typologie (au moins `minParCategorie`),
 * complétées par les plus fortes impressions jusqu'à `taille`.
 */
export function proposerPanier(
  site: string,
  rows: Row[],
  opts: { marque: string[]; taille?: number; minParCategorie?: number; periode: { debut: string; fin: string }; categories?: Categorie[]; univers?: string },
): Panier {
  const categories = opts.categories ?? CATEGORIES_DEFAUT;
  const univers = new RegExp(opts.univers ?? UNIVERS_DEFAUT);
  const taille = opts.taille ?? 400;
  const min = opts.minParCategorie ?? 25;
  const candidats = rows
    .filter((r) => r.keys?.[0] && !estMarque(r.keys[0], opts.marque) && univers.test(normaliser(r.keys[0])))
    .filter((r) => normaliser(r.keys![0]!).split(" ").length >= 2) // « parking » seul : trop générique pour piloter
    .sort((a, b) => b.impressions - a.impressions)
    .map((r) => ({ requete: r.keys![0]!, categorie: categoriser(r.keys![0]!, categories), poids: poids(r.impressions), impressions: r.impressions }));
  const choisies = new Map<string, (typeof candidats)[number]>();
  for (const c of categories) for (const x of candidats.filter((y) => y.categorie === c.id).slice(0, min)) choisies.set(x.requete, x);
  for (const x of candidats) { if (choisies.size >= taille) break; choisies.set(x.requete, x); }
  return {
    site, creeLe: new Date().toISOString(), periodeSource: opts.periode, marque: opts.marque, univers: opts.univers ?? UNIVERS_DEFAUT, categories,
    requetes: [...choisies.values()].sort((a, b) => b.impressions - a.impressions).map(({ requete, categorie, poids: p }) => ({ requete, categorie, poids: p })),
  };
}

export interface MesureRequete { requete: string; categorie: string; poids: number; position: number | null; score: number; clicks: number; impressions: number }
export interface Mesure {
  mois: string;
  partiel: boolean;
  part: number; // 0-1
  parCategorie: Array<{ id: string; nom: string; part: number; requetes: number }>;
  top3: number; top10: number; absentes: number;
  clicks: number; impressions: number;
  requetes: MesureRequete[];
}

export function mesurer(panier: Panier, mois: string, rows: Row[], partiel = false): Mesure {
  const parQ = new Map(rows.map((r) => [normaliser(r.keys![0]!), r]));
  const requetes: MesureRequete[] = panier.requetes.map((q) => {
    const r = parQ.get(normaliser(q.requete));
    const position = r ? round(r.position) : null;
    return { ...q, position, score: scorePosition(position), clicks: r?.clicks ?? 0, impressions: r?.impressions ?? 0 };
  });
  const part = (l: MesureRequete[]) => { const den = l.reduce((s, q) => s + q.poids * 100, 0); return den ? round(l.reduce((s, q) => s + q.poids * q.score, 0) / den, 4) : 0; };
  return {
    mois, partiel, part: part(requetes),
    parCategorie: panier.categories.map((c) => { const l = requetes.filter((q) => q.categorie === c.id); return { id: c.id, nom: c.nom, part: part(l), requetes: l.length }; }).filter((c) => c.requetes),
    top3: requetes.filter((q) => q.score >= 70).length,
    top10: requetes.filter((q) => q.score >= 25).length,
    absentes: requetes.filter((q) => q.position == null || q.position > 20).length,
    clicks: requetes.reduce((s, q) => s + q.clicks, 0), impressions: requetes.reduce((s, q) => s + q.impressions, 0),
    requetes,
  };
}

/** Expressions régulières (RE2) qui couvrent exactement les requêtes du panier, découpées pour rester courtes. */
export function regexPanier(requetes: string[], longueurMax = 3500): string[] {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const out: string[] = [];
  let cur: string[] = [], len = 0;
  for (const q of requetes) {
    const e = esc(q);
    if (len + e.length + 1 > longueurMax && cur.length) { out.push(`^(${cur.join("|")})$`); cur = []; len = 0; }
    cur.push(e); len += e.length + 1;
  }
  if (cur.length) out.push(`^(${cur.join("|")})$`);
  return out;
}

/** Mois calendaires de `debut` (AAAA-MM) au mois de `fin` inclus. */
export function moisEntre(debut: string, fin: Date): string[] {
  const out: string[] = [];
  const d = new Date(`${debut}-01T00:00:00Z`);
  while (d <= fin) { out.push(d.toISOString().slice(0, 7)); d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}

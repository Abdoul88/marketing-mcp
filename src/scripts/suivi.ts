// Suivi des articles affiché dans l'onglet « Contenu & social » du dashboard.
// Usage : npm.cmd run suivi -- --site https://blog.indigoneo.fr/ --slug parking-gare-de-lyon \
//           titre="Parking gare de Lyon" requete="parking gare de lyon" etapes.brief=true url=https://...
// Étapes : brief, redige, visuel, publie, facebook, discover.
import { join } from "node:path";
import { args, DATA, ecrireJson, hostKey, lireJson, stop } from "./outils.js";

const { libres, opts } = args();
const site = typeof opts.site === "string" ? opts.site : stop("--site manquant");
const slug = typeof opts.slug === "string" ? opts.slug : stop("--slug manquant");
const chemin = join(DATA, "contenu", hostKey(site), `${slug}.json`);
const fiche = lireJson<Record<string, unknown> & { etapes?: Record<string, boolean> }>(chemin, { slug, etapes: {} });
for (const paire of libres) {
  const i = paire.indexOf("=");
  if (i < 0) stop(`Format attendu cle=valeur : « ${paire} »`);
  const cle = paire.slice(0, i);
  const brut = paire.slice(i + 1);
  const valeur = brut === "true" ? true : brut === "false" ? false : brut;
  if (cle.startsWith("etapes.")) fiche.etapes = { ...fiche.etapes, [cle.slice(7)]: valeur === true };
  else fiche[cle] = valeur;
}
fiche.maj = new Date().toISOString();
ecrireJson(chemin, fiche);
console.log(JSON.stringify(fiche, null, 2));

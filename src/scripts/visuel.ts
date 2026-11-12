// Génère les visuels d'un article aux couleurs du site, gratuitement et sur ton poste.
// Usage :
//   npm.cmd run visuel -- --site https://blog.indigoneo.fr/ --titre "Où se garer près de la gare de Lyon"
//                         [--surtitre "Guide parking"] [--photo C:\chemin\photo.jpg] [--slug parking-gare-de-lyon]
//                         [--police-fichier C:\Windows\Fonts\Montserrat-Bold.ttf]
// Sortie : data/visuels/<site>/<slug>-discover.png (1600×900, image à la une et Google Discover),
//          -facebook.png (1200×630, lien partagé) et -carre.png (1080×1080, post Facebook ou Instagram).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import type { Charte } from "./charte.js";
import { args, DATA, hostKey, lireJson, slugifier, stop, UA } from "./outils.js";

const FORMATS = {
  discover: { w: 1600, h: 900 },
  facebook: { w: 1200, h: 630 },
  carre: { w: 1080, h: 1080 },
} as const;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Coupe le titre en lignes ; réduit la taille de police jusqu'à tenir en maxLignes. */
export function couper(titre: string, largeur: number, tailleMax: number, maxLignes: number): { taille: number; lignes: string[] } {
  for (let taille = tailleMax; taille >= 28; taille -= 4) {
    const parLigne = Math.floor(largeur / (taille * 0.56));
    const lignes: string[] = [];
    let ligne = "";
    for (const mot of titre.split(/\s+/)) {
      const essai = ligne ? `${ligne} ${mot}` : mot;
      if (essai.length > parLigne && ligne) { lignes.push(ligne); ligne = mot; }
      else ligne = essai;
    }
    if (ligne) lignes.push(ligne);
    if (lignes.length <= maxLignes) return { taille, lignes };
  }
  const parLigne = Math.floor(largeur / (28 * 0.56));
  return { taille: 28, lignes: [titre.slice(0, parLigne * maxLignes - 1) + "…"] };
}

function mime(chemin: string, buf: Buffer): string | null {
  const e = extname(chemin.split("?")[0]!).toLowerCase();
  if (e === ".svg" || buf.subarray(0, 200).toString().includes("<svg")) return "image/svg+xml";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  return null; // webp, avif… non pris en charge par le moteur de rendu
}

async function chargerImage(source: string | null | undefined): Promise<string | null> {
  if (!source) return null;
  try {
    const buf = /^https?:/.test(source)
      ? Buffer.from(await (await fetch(source, { headers: { "User-Agent": UA } })).arrayBuffer())
      : existsSync(source) ? readFileSync(source) : null;
    if (!buf) return null;
    const m = mime(source, buf);
    return m ? `data:${m};base64,${buf.toString("base64")}` : null;
  } catch {
    return null;
  }
}

/** Un logo SVG est intégré tel quel (ses textes utilisent alors les polices du poste) ; un PNG/JPEG en <image>. */
function logoEnLigne(logo: string, x: number, y: number, w: number, h: number): string {
  if (logo.startsWith("data:image/svg+xml;base64,")) {
    const src = Buffer.from(logo.slice(26), "base64").toString("utf8").replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>/gi, "");
    const ouverture = /<svg\b[^>]*>/i.exec(src)?.[0];
    if (ouverture) {
      const vb = /viewBox=["']([^"']+)["']/i.exec(ouverture)?.[1]
        ?? `0 0 ${parseFloat(/width=["']([\d.]+)/i.exec(ouverture)?.[1] ?? "100")} ${parseFloat(/height=["']([\d.]+)/i.exec(ouverture)?.[1] ?? "40")}`;
      const ns = /xmlns:xlink/.test(ouverture) ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : "";
      return src.replace(ouverture, `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${vb}" preserveAspectRatio="xMinYMid meet"${ns}>`);
    }
  }
  return `<image href="${logo}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMinYMid meet"/>`;
}

export function svgVisuel(o: {
  w: number; h: number; titre: string; surtitre?: string; charte: Charte; logo: string | null; photo: string | null;
}): string {
  const { w, h, charte } = o;
  const p = charte.couleurs[0] ?? "#2f5bd3";
  const s = charte.couleurs[1] ?? p;
  const police = `${esc(charte.police)}, Segoe UI, Arial, sans-serif`;
  const marge = Math.round(w * 0.06);
  const carre = w === h;
  const { taille, lignes } = couper(o.titre, w - marge * 2, carre ? 84 : Math.round(h * 0.11), carre ? 5 : 3);
  const interligne = Math.round(taille * 1.15);
  const basTitre = h - marge - (carre ? 40 : 30);
  const yPremiere = basTitre - (lignes.length - 1) * interligne;
  const tailleSur = Math.round(taille * 0.42);
  const ySur = yPremiere - taille - Math.round(tailleSur * 0.9);
  const largeurSur = o.surtitre ? Math.round(o.surtitre.length * tailleSur * 0.74 + tailleSur * 1.6) : 0;
  const logoH = Math.round(h * (carre ? 0.07 : 0.09));

  const fond = o.photo
    ? `<image href="${o.photo}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>
       <rect width="${w}" height="${h}" fill="url(#voile)"/>`
    : `<rect width="${w}" height="${h}" fill="${p}"/>
       <circle cx="${w * 0.92}" cy="${h * 0.1}" r="${h * 0.55}" fill="${s}" opacity="0.35"/>
       <circle cx="${w * 0.78}" cy="${h * 0.95}" r="${h * 0.3}" fill="#ffffff" opacity="0.08"/>
       <rect width="${w}" height="${h}" fill="url(#voile)" opacity="0.6"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="voile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="${o.photo ? 0.05 : 0}"/>
      <stop offset="0.45" stop-color="${p}" stop-opacity="${o.photo ? 0.25 : 0}"/>
      <stop offset="1" stop-color="${o.photo ? "#000" : p}" stop-opacity="${o.photo ? 0.82 : 0.9}"/>
    </linearGradient>
  </defs>
  ${fond}
  <rect x="0" y="${h - 12}" width="${w}" height="12" fill="${s}"/>
  ${o.logo
    ? `<rect x="${marge - 14}" y="${marge - 12}" width="${logoH * 3.6}" height="${logoH + 24}" rx="12" fill="#ffffff"/>
       ${logoEnLigne(o.logo, marge, marge, logoH * 3.6 - 28, logoH)}`
    : `<text x="${marge}" y="${marge + logoH * 0.75}" font-family="${police}" font-size="${logoH * 0.7}" font-weight="700" fill="#ffffff">${esc(charte.nom)}</text>`}
  ${o.surtitre
    ? `<rect x="${marge}" y="${ySur - tailleSur * 1.15}" width="${largeurSur}" height="${tailleSur * 1.7}" rx="${tailleSur * 0.85}" fill="${s === p ? "#ffffff" : s}"/>
       <text x="${marge + tailleSur * 0.8}" y="${ySur}" font-family="${police}" font-size="${tailleSur}" font-weight="700" fill="${s === p ? p : "#ffffff"}" letter-spacing="0.5">${esc(o.surtitre.toUpperCase())}</text>`
    : ""}
  ${lignes.map((l, i) => `<text x="${marge}" y="${yPremiere + i * interligne}" font-family="${police}" font-size="${taille}" font-weight="800" fill="#ffffff">${esc(l)}</text>`).join("\n  ")}
</svg>`;
}

async function main() {
  const { opts } = args();
  const site = typeof opts.site === "string" ? opts.site : stop("--site manquant (ex. --site https://blog.indigoneo.fr/)");
  const titre = typeof opts.titre === "string" ? opts.titre : stop("--titre manquant");
  const cle = hostKey(site);
  const charte = lireJson<Charte | null>(join(DATA, "charte", `${cle}.json`), null)
    ?? stop(`Pas de charte pour ${cle} : lance d'abord npm.cmd run charte -- ${site}`);
  const slug = typeof opts.slug === "string" ? opts.slug : slugifier(titre);
  const [logo, photo] = await Promise.all([
    chargerImage(typeof opts.logo === "string" ? opts.logo : charte.logo),
    chargerImage(typeof opts.photo === "string" ? opts.photo : null),
  ]);
  if (opts.photo && !photo) console.error("Photo illisible (formats acceptés : JPEG, PNG) : visuel généré sans photo.");
  const dossier = join(DATA, "visuels", cle);
  mkdirSync(dossier, { recursive: true });
  const fichiers: Record<string, string> = {};
  for (const [nom, { w, h }] of Object.entries(FORMATS)) {
    const svg = svgVisuel({ w, h, titre, surtitre: typeof opts.surtitre === "string" ? opts.surtitre : undefined, charte, logo, photo });
    const png = new Resvg(svg, {
      fitTo: { mode: "width", value: w },
      font: {
        loadSystemFonts: true,
        defaultFontFamily: "Arial",
        ...(typeof opts["police-fichier"] === "string" ? { fontFiles: [opts["police-fichier"]] } : {}),
      },
    }).render().asPng();
    const chemin = join(dossier, `${slug}-${nom}.png`);
    writeFileSync(chemin, png);
    fichiers[nom] = chemin;
  }
  console.log(JSON.stringify({ slug, visuel: `visuels/${cle}/${slug}-discover.png`, fichiers }, null, 2));
}

if (/visuel\.ts$/.test(process.argv[1] ?? "")) await main();

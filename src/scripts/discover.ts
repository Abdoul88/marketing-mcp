// Vérifie qu'une page remplit les conditions techniques pour Google Discover.
// Usage : npm.cmd run discover -- https://blog.indigoneo.fr/mon-article/
// Rappel : Google ne permet pas de soumettre une page à Discover ; on maximise ses chances.
import { args, stop, UA } from "./outils.js";

/** Dimensions d'une image PNG, JPEG, GIF ou WebP à partir de ses premiers octets. */
export function dimensions(b: Uint8Array): { w: number; h: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: dv.getUint32(16), h: dv.getUint32(20) };
  if (b[0] === 0x47 && b[1] === 0x49) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
  if (b[0] === 0x52 && b[8] === 0x57) {
    const type = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!);
    if (type === "VP8X") return { w: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), h: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (type === "VP8 ") return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff };
    if (type === "VP8L") { const v = dv.getUint32(21, true); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
      i += 2 + dv.getUint16(i + 2);
    }
  }
  return null;
}

async function main() {
  const url = args().libres[0] ?? stop("Usage : npm.cmd run discover -- https://www.exemple.fr/article/");
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const html = await res.text();
  const meta = (attr: string, v: string) =>
    new RegExp(`<meta[^>]+${attr}=["']${v}["'][^>]*content=["']([^"']*)["']`, "i").exec(html)?.[1] ??
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*${attr}=["']${v}["']`, "i").exec(html)?.[1] ?? "";
  const robots = meta("name", "robots");
  const ogImage = meta("property", "og:image");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  let dim: { w: number; h: number } | null = null;
  if (ogImage) {
    try {
      const img = await fetch(new URL(ogImage, url), { headers: { "User-Agent": UA, Range: "bytes=0-65535" } });
      dim = dimensions(new Uint8Array(await img.arrayBuffer()));
    } catch { /* image injoignable */ }
  }
  const verifs = [
    { ok: res.ok, critere: `Page accessible (HTTP ${res.status})` },
    { ok: !/noindex/i.test(robots), critere: "Page indexable (pas de noindex)" },
    { ok: /max-image-preview\s*:\s*large/i.test(robots) || /max-image-preview:large/i.test(html), critere: "Balise robots max-image-preview:large (grande image dans Discover)" },
    { ok: !!ogImage, critere: "Image og:image déclarée" },
    { ok: !!dim && dim.w >= 1200, critere: `Image d'au moins 1200 px de large${dim ? ` (actuellement ${dim.w}×${dim.h})` : ""}` },
    { ok: !!dim && dim.w / dim.h >= 1.3, critere: "Image au format paysage (16:9 conseillé)" },
    { ok: title.length > 0 && title.length <= 110, critere: `Titre présent et lisible (${title.length} caractères)` },
    { ok: /"datePublished"|article:published_time/i.test(html), critere: "Date de publication déclarée (Article / datePublished)" },
    { ok: /"author"/i.test(html), critere: "Auteur déclaré dans les données structurées" },
    { ok: /"@type"\s*:\s*"(Article|NewsArticle|BlogPosting)"/i.test(html), critere: "Données structurées Article / BlogPosting" },
    { ok: url.startsWith("https://"), critere: "HTTPS" },
  ];
  for (const v of verifs) console.log(`${v.ok ? "✅" : "❌"} ${v.critere}`);
  const ko = verifs.filter((v) => !v.ok).length;
  console.log(ko ? `\n${ko} point(s) à corriger.` : "\nToutes les conditions techniques sont remplies.");
  console.log("Côté éditorial : sujet frais ou intemporel à fort intérêt, titre fidèle au contenu (pas de clickbait), expertise visible (E-E-A-T).");
  process.exitCode = ko ? 2 : 0;
}

if (/discover\.ts$/.test(process.argv[1] ?? "")) await main();

// Envoie un visuel dans la médiathèque WordPress et le définit comme image à la une,
// via l'API REST de WordPress (gratuite, mot de passe d'application).
//
//   npm.cmd run wordpress -- --site https://blog.indigoneo.fr/ --image data\visuels\...\slug-discover.png --alt "Texte alternatif" [--article 12345]
//
// data/wordpress.json (jamais versionné) :
// { "blog.indigoneo.fr": { "url": "https://blog.indigoneo.fr", "utilisateur": "abdoul", "motDePasseApplication": "xxxx xxxx xxxx xxxx" } }
// Le mot de passe d'application se crée dans WordPress → Comptes → Profil → Mots de passe d'application.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { args, DATA, hostKey, lireJson, stop } from "./outils.js";

const { opts } = args();
const site = typeof opts.site === "string" ? opts.site : stop("--site manquant");
const image = typeof opts.image === "string" ? opts.image : stop("--image manquant");
const comptes = lireJson<Record<string, { url: string; utilisateur: string; motDePasseApplication: string }>>(join(DATA, "wordpress.json"), {});
const c = comptes[hostKey(site)] ?? stop(`Pas d'identifiants pour ${hostKey(site)} dans data/wordpress.json (voir l'en-tête de ce script).`);
const authz = "Basic " + Buffer.from(`${c.utilisateur}:${c.motDePasseApplication.replace(/\s+/g, "")}`).toString("base64");
const api = c.url.replace(/\/$/, "") + "/wp-json/wp/v2";

const up = await fetch(`${api}/media`, {
  method: "POST",
  headers: { Authorization: authz, "Content-Type": "image/png", "Content-Disposition": `attachment; filename="${basename(image)}"` },
  body: readFileSync(image),
});
const media = (await up.json().catch(() => ({}))) as { id?: number; source_url?: string; message?: string };
if (!up.ok || !media.id) stop(`Envoi refusé par WordPress (HTTP ${up.status}) : ${media.message ?? "erreur inconnue"}`);
if (typeof opts.alt === "string") {
  await fetch(`${api}/media/${media.id}`, {
    method: "POST", headers: { Authorization: authz, "Content-Type": "application/json" },
    body: JSON.stringify({ alt_text: opts.alt }),
  });
}
if (typeof opts.article === "string") {
  // Mise à jour de l'image à la une seulement : le contenu et le statut de l'article ne changent pas.
  const r = await fetch(`${api}/posts/${opts.article}`, {
    method: "POST", headers: { Authorization: authz, "Content-Type": "application/json" },
    body: JSON.stringify({ featured_media: media.id }),
  });
  if (!r.ok) stop(`Image envoyée (id ${media.id}) mais non définie comme image à la une (HTTP ${r.status}).`);
}
console.log(JSON.stringify({ mediaId: media.id, url: media.source_url, article: opts.article ?? null }, null, 2));

// Publie un article sur une Page Facebook via l'API Graph (gratuite).
// Par défaut, n'envoie rien : affiche ce qui serait publié. Ajoute --publier pour publier vraiment.
//
//   npm.cmd run facebook -- --lien https://blog.indigoneo.fr/mon-article/ --message "Texte du post"
//   npm.cmd run facebook -- --image data\visuels\...\mon-article-carre.png --message "Texte… https://lien" --publier
//
// Mode lien (défaut) : Facebook affiche l'aperçu de l'article avec son og:image (le visuel 1200×630).
// Mode image (--image) : publie le visuel carré, le lien va dans le texte.
// .env : FB_PAGE_ID, FB_PAGE_TOKEN (jeton de Page longue durée), FB_GRAPH_VERSION (défaut v23.0)
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { args, stop } from "./outils.js";

const { opts } = args();
const message = typeof opts.message === "string" ? opts.message : stop("--message manquant");
const lien = typeof opts.lien === "string" ? opts.lien : undefined;
const image = typeof opts.image === "string" ? opts.image : undefined;
if (!lien && !image) stop("Donne --lien (aperçu d'article) ou --image (visuel).");
const pageId = process.env.FB_PAGE_ID?.trim();
const token = process.env.FB_PAGE_TOKEN?.trim();
const version = process.env.FB_GRAPH_VERSION?.trim() || "v23.0";

const apercu = { page: pageId ?? "(FB_PAGE_ID manquant)", mode: image ? "image" : "lien", message, lien, image };
if (opts.publier !== true) {
  console.log("Aperçu (rien n'a été publié). Ajoute --publier pour publier :\n" + JSON.stringify(apercu, null, 2));
  process.exit(0);
}
if (!pageId || !token) stop("FB_PAGE_ID et FB_PAGE_TOKEN doivent être renseignés dans .env (voir docs/dashboard.md).");

const base = `https://graph.facebook.com/${version}/${pageId}`;
let res: Response;
if (image) {
  const form = new FormData();
  form.set("caption", message);
  form.set("access_token", token);
  form.set("source", new Blob([readFileSync(image)], { type: "image/png" }), basename(image));
  res = await fetch(`${base}/photos`, { method: "POST", body: form });
} else {
  res = await fetch(`${base}/feed`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message, link: lien!, access_token: token }),
  });
}
const json = (await res.json().catch(() => ({}))) as { id?: string; post_id?: string; error?: { message?: string } };
if (!res.ok || json.error) stop(`Facebook a refusé la publication (HTTP ${res.status}) : ${json.error?.message ?? "erreur inconnue"}`);
const id = json.post_id ?? json.id ?? "";
console.log(JSON.stringify({ publie: true, id, url: id ? `https://www.facebook.com/${id}` : null }, null, 2));

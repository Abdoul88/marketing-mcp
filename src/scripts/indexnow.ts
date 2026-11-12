// Signale des URL nouvelles ou modifiées à Bing (et Yandex, Seznam…) via IndexNow, gratuitement.
// Google n'utilise pas IndexNow : pour Google, la page est découverte via le sitemap et les liens internes.
//
//   npm.cmd run indexnow -- --cle          → génère une clé et explique où la déposer
//   npm.cmd run indexnow -- https://blog.indigoneo.fr/article-1/ https://blog.indigoneo.fr/article-2/
// .env : INDEXNOW_KEY (la clé, déposée dans https://ton-site/<clé>.txt)
import { randomBytes } from "node:crypto";
import { args, stop } from "./outils.js";

const { libres, opts } = args();
if (opts.cle) {
  const cle = randomBytes(16).toString("hex");
  console.log(`Clé : ${cle}
1. Crée un fichier texte nommé ${cle}.txt contenant seulement : ${cle}
2. Dépose-le à la racine de chaque site (https://ton-site/${cle}.txt) ; sur WordPress, via le gestionnaire de fichiers de l'hébergeur ou un plugin comme « IndexNow ».
3. Ajoute dans .env : INDEXNOW_KEY=${cle}`);
  process.exit(0);
}
const key = process.env.INDEXNOW_KEY?.trim() || stop("INDEXNOW_KEY manquant dans .env (npm.cmd run indexnow -- --cle).");
if (!libres.length) stop("Donne au moins une URL.");
const parHote = new Map<string, string[]>();
for (const u of libres) {
  const h = new URL(u).host;
  parHote.set(h, [...(parHote.get(h) ?? []), u]);
}
for (const [host, urlList] of parHote) {
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList }),
  });
  const msg: Record<number, string> = { 200: "acceptées", 202: "reçues, clé en cours de vérification", 400: "requête invalide", 403: "clé introuvable sur le site", 422: "URL hors du site ou clé incorrecte", 429: "trop de requêtes" };
  console.log(`${host} : ${urlList.length} URL — HTTP ${res.status} (${msg[res.status] ?? "réponse inattendue"})`);
}

# Scripts du projet marketing-mcp

Tous gratuits, lancés depuis `C:\Users\adiallo3\marketing-mcp`. `--` sépare les arguments de npm.

| Script | Exemple | Effet |
|---|---|---|
| `dashboard` | `npm.cmd run dashboard` | Dashboard sur http://127.0.0.1:4321 |
| `charte` | `npm.cmd run charte -- https://blog.indigoneo.fr/` | Couleurs, police et logo du site → `data/charte/<site>.json` (corrigeable à la main) |
| `visuel` | `npm.cmd run visuel -- --site https://blog.indigoneo.fr/ --titre "…" --surtitre "Guide" [--photo C:\…\photo.jpg] [--slug x]` | 3 PNG dans `data/visuels/<site>/` : `-discover` 1600×900, `-facebook` 1200×630, `-carre` 1080×1080 |
| `wordpress` | `npm.cmd run wordpress -- --site … --image … --alt "…" --article 12345` | Envoie l'image dans la médiathèque et la met à la une (identifiants : `data/wordpress.json`) |
| `facebook` | `npm.cmd run facebook -- --lien URL --message "…"` puis `--publier` | Aperçu, puis publication sur la Page (`FB_PAGE_ID`, `FB_PAGE_TOKEN`) |
| `discover` | `npm.cmd run discover -- URL` | Vérifie l'éligibilité technique à Google Discover |
| `indexnow` | `npm.cmd run indexnow -- URL1 URL2` | Signale les URL à Bing (`INDEXNOW_KEY`) |
| `suivi` | `npm.cmd run suivi -- --site … --slug x titre="…" etapes.publie=true url=…` | Fiche de suivi affichée dans le dashboard |

Fichiers de données (dans `data/`, jamais versionnés) :

- `data/audits/<site>.json` — audit technique (écrit par le dashboard)
- `data/concurrents/<site>.json` — comparaison concurrents (écrit par la skill `seo-concurrents`)
- `data/contenu/<site>/<slug>.json` — suivi des articles
- `data/charte/<site>.json`, `data/visuels/<site>/…`

`<site>` = nom d'hôte sans `www.` (ex. `blog.indigoneo.fr`, `okooltrip.fr`).

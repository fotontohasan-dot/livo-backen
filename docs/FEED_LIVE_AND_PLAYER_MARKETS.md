# Feed contract: live scoreboard, logos, volumes, player markets

All fields are optional and go inside each match of `POST /api/admin/feed-update`
(header `x-feed-key`). Missing data never breaks a page: the UI shows
"Waiting for live feed…" / "–" and fills in by itself when data arrives.

## Match
| field | notes |
|---|---|
| `logo_a`, `logo_b` | `https://…` URL (downloaded once, validated, cached under `public/images/teams/`), a local `/images/…` path, or a small `data:image/…` URI. SVG is never accepted. |
| `live` | scoreboard object, see below (validated by `services/liveData.js`) |

### `live` for cricket
`{ runs, wickets, overs:"15.2", runRate, target, batsmen:[{name,runs,balls,fours,sixes,strike}], bowler:{name,overs,maidens,runs,wickets}, balls:["0","1","4","6","W"] }`

### `live` for football / tennis
- football: `{ clock:"67'", period:"2H", halves:[[1,0],[0,1]], momentum:0-100 }`
- tennis: `{ sets:[[6,4],[3,2]], game:["30","15"], server:0|1, momentum:0-100 }`

## Market runners (matched volume + suspension)
`runners:[{ key, name, back, lay, back_size, lay_size, status:"active|suspended" }]`
`lay` enables the Lay button; `*_size` is shown under the price; `status:"suspended"` greys out that runner.

## Player markets (cricket → "Player Performance" tab)
- `type:"player_runs"` — runners `over` / `under`, name like `V Kohli Runs Over/Under 32.5`
- `type:"player_h2h"` — one runner per player; `name` on each runner is shown as the label

Both use the normal Back/Lay path: Lay reserves `stake × (lay odds − 1)` as liability and
settles through `services/settlement.js` (`winning_runner` = the runner key).

## Logos & CSP
Remote logos are fetched server-side only for URLs that arrive through the authenticated feed
(no public proxy endpoint). Requests are HTTPS-only, pinned to a validated public IP, ≤200 KB,
PNG/JPEG/WEBP/GIF by magic bytes. Render's disk is ephemeral: files are re-downloaded
automatically on the next feed push after a deploy.

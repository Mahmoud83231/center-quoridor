# Center Quoridor

Multiplayer browser Quoridor. Two modes:
- **Center (2–4 players)** — race your pawn to the shared square in the
  middle of an 11×11 board, approaching from any of the 4 sides.
- **Classic 1v1** — the real, standard game: a true 9×9 board, reach the
  opposite edge from where you started.

## Run
```cmd
npm install
npm start
```
Open `http://localhost:3000`.

Requires **Node.js ≥ 22.5** (the server uses the built-in `node:sqlite`
module for account storage — no extra database to install or configure).

## Controls
- Click a square to move.
- Hover near the gap between two cells (desktop) — a preview shows where the
  wall would go. **Click once to arm it, click the same spot again (or
  anywhere on it) to confirm.** Clicking anywhere else cancels the pending
  wall instead of moving, so a stray click near an edge can never place an
  unwanted wall.
- On touch devices, drag a wall tile from the panel next to the board and
  drop it where you want the wall.
- **The board always shows your own pawn at the bottom of your screen**,
  the same way a chess app always shows your own pieces at the bottom —
  regardless of which of the 4 starting sides you were actually assigned.
  This is purely visual; every player sees the same real game underneath.

## Accounts
Register or log in with a **real email address** from the top-right chip
(login is by email + password, not just a display name). Accounts are
stored in a real SQLite database at `data/quoridor.db` (auto-created on
first run; automatically migrates an older `data/users.json` if one is
found), with your `username`, `wins`, and `games` tracked there.

### Email verification
If you set SMTP credentials (see **Environment variables** below), new
accounts get a real verification email and can't log in until they click
the link inside it (valid 24h; a "resend" button appears if login is
blocked on this). **If you don't set SMTP credentials, the server runs in
dev mode**: accounts are auto-verified immediately and the verification
link is only printed to the server console — handy for local testing,
but you'll want real SMTP configured before sending people a live link.

Site-wide admin access (the `/admin.html` dashboard: view rooms, kick,
end a match, ban/promote accounts) is **never** granted automatically —
nobody becomes "owner" just by registering or by visiting the admin page.
To bootstrap yourself as the one true owner, start the server with:
```cmd
ADMIN_USERNAME=your_username npm start
```
The very first time that exact username registers or logs in, and only if
no owner exists yet, it's promoted to owner. Leave `ADMIN_USERNAME` unset
and nobody can ever become owner through the app — you'd need to edit the
database directly. There is no room-level admin/host moderation system
(no per-room kick/ban/promote) — the only site-wide dashboard is the real,
role-gated one.

## Inviting people
Every room shows a 🔗 button next to the room code — it copies a link like
`https://yoursite.com/?room=ABC123`. Anyone who opens it gets the code
pre-filled automatically; they just type their name and hit "دخول". The
plain 6-character code still works too, for people who'd rather type it in.

## Disconnects mid-match
If a player's connection drops mid-game, they get **30 seconds** to
reconnect (a live 🔄 countdown shows next to their name — this covers a
locked phone, a flaky wifi hiccup, a refreshed tab, etc; they're seated
right back in their same slot with the game untouched if they make it
back in time). If they don't reconnect within the 30 seconds, the match
ends immediately and **everyone still connected wins together** — in a
2-player game that's simply "the other player wins"; in a 3–4 player
center-mode game, every remaining player is credited with a win.

## Wall colors
Each wall is drawn in the exact color of the player who placed it (their
own pawn color) — this used to occasionally paint someone's wall in a
different player's color because of how join order and board side were
tracked separately.

## Environment variables
| Variable | Required? | What it does |
|---|---|---|
| `PORT` | No | Set automatically by most hosts (including Railway). Defaults to 3000 locally. |
| `ADMIN_USERNAME` | No | The one username ever eligible to auto-become "owner" (see **Accounts** above). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | No | Real SMTP credentials for sending verification emails. Leave all unset to run in dev mode (see above). `SMTP_PORT` defaults to `587`; set it to `465` for implicit TLS. |
| `MAIL_FROM` | No | The "from" address on verification emails. Defaults to `SMTP_USER`. |
| `PUBLIC_URL` | No | The public base URL used inside verification email links (e.g. `https://yoursite.up.railway.app`). If unset, it's inferred from the incoming request, which is usually fine — set it explicitly if you're behind a custom domain or a proxy that mangles the host header. |
| `RAILWAY_VOLUME_MOUNT_PATH` | No | Set automatically by Railway when you attach a Volume to the service (see **Deploying to Railway** below). When present, the SQLite database is stored there instead of the app's own (ephemeral) folder. |

Any SMTP provider works — Gmail (with an app password), SendGrid, Mailgun,
Resend, Amazon SES, your own mail server, etc. Just plug in their SMTP
host/port/user/pass.

## Deploying to Railway
The app is a plain Node.js/Express + Socket.IO server, so Railway can
build and run it with no extra config — but there's one thing to set up
first so accounts aren't wiped on every deploy: **Railway's container
filesystem is ephemeral and gets reset on every deploy**, so the SQLite
database needs to live on a persistent **Volume** instead of the app's own
folder.

1. **Push this project to a GitHub repo** (Railway deploys from GitHub, or
   from the Railway CLI if you'd rather not use GitHub).
2. **Create a new Railway project** → *Deploy from GitHub repo* → pick
   your repo. Railway auto-detects it's a Node app (via `package.json`)
   and runs `npm install` then `npm start` — no build command to set.
3. **Attach a Volume** so accounts survive redeploys:
   - Open your service → **Settings** → **Volumes** → *Add a volume*.
   - Give it any mount path, e.g. `/data`.
   - Railway automatically sets `RAILWAY_VOLUME_MOUNT_PATH` to that path
     for the service — the server already reads this and stores
     `quoridor.db` inside it, so nothing else to configure here.
4. **Set environment variables** — open the **Variables** tab and add
   whichever of the ones in the table above you need. At minimum, most
   people will want:
   - `ADMIN_USERNAME` — your username, so you become the site owner the
     first time you register/log in.
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` — if
     you want real verification emails instead of dev mode.
   - `PUBLIC_URL` — set this to your Railway-generated domain (or your
     custom domain) once you have it, e.g.
     `https://center-quoridor-production.up.railway.app`.
   - You do **not** need to set `PORT` — Railway provides it automatically
     and the server already reads `process.env.PORT`.
5. **Generate a public domain**: Settings → **Networking** → *Generate
   Domain* (or attach your own custom domain there instead). Railway
   deploys are served over HTTPS automatically either way.
6. From then on, every push to your connected GitHub branch triggers an
   automatic redeploy — the Volume keeps your accounts and stats intact
   across every one of them.

## What's in this build
- **Real 9×9 board for classic 1v1** (was incorrectly reusing the 11×11
  "center mode" board).
- **No yellow goal highlight in classic mode** — both back rows are drawn
  as ordinary cells, since classic Quoridor doesn't have a single glowing
  target square.
- **Two-step wall confirmation** to stop accidental wall placement from an
  imprecise click near a cell edge.
- **Per-player rotated board view** — you always see yourself at the
  bottom, in both modes.
- **Real SQLite-backed accounts with email verification**, with a safe,
  opt-in-only admin bootstrap (see above) instead of "first registrant
  becomes admin."
- **Invite-by-link** — a shareable room URL, not just the 6-character code.
- **30-second reconnect window with forfeit** — drop mid-match and don't
  come back in time, and everyone still in the room wins.
- **Wall colors matched to the placing player's own pawn color.**
- **Removed the per-room host/admin system** entirely (no promote/kick/ban
  buttons in-room).
- **Chess-clock timer** — 5 minutes per player for the whole game, ticking
  only on their own turn, shown per-player in the sidebar.
- **Move history**, **sound effects** (mute toggle, saved locally), and
  **animation** (gliding pawns, popping-in walls) throughout.

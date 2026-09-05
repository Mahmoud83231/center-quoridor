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
Register or log in from the top-right chip. Logged-in games count toward
your **wins / games played** stats, stored in a real SQLite database at
`data/quoridor.db` (auto-created on first run; automatically migrates an
older `data/users.json` if one is found).

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
- **Real SQLite-backed accounts**, with a safe, opt-in-only admin
  bootstrap (see above) instead of "first registrant becomes admin."
- **Removed the per-room host/admin system** entirely (no promote/kick/ban
  buttons in-room).
- **Chess-clock timer** — 5 minutes per player for the whole game, ticking
  only on their own turn, shown per-player in the sidebar.
- **Move history**, **sound effects** (mute toggle, saved locally), and
  **animation** (gliding pawns, popping-in walls) throughout.

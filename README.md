# VOXEL STRIKE — a voxel CS:GO-style FPS

A fully-playable first-person shooter inspired by CS:GO with Minecraft-style voxel
graphics. Runs entirely in the browser (no build step) using Three.js, with an
optional Node.js WebSocket server for online multiplayer.

- **Frontend:** `index.html` — single self-contained file, Three.js r128 via CDN. Deploy to GitHub Pages.
- **Backend:** `server.js` — Node.js + `ws` only. Deploy to Render.com free tier.

## Controls

| Action | Key |
|---|---|
| Move | `W` `A` `S` `D` |
| Look | Mouse (click to lock pointer) |
| Shoot | Left click |
| Reload | `R` |
| Weapons | `1` primary · `2` pistol · `3` knife |
| Jump / Crouch / Walk | `Space` / `Ctrl` / `Shift` |
| Plant / Defuse bomb | Hold `E` near a site |
| AWP scope | Right click |
| Buy menu | `B` (during 15s buy phase) |
| Scoreboard | `Tab` |

## Run locally

The page must be served over `http://` (PointerLock + Three.js won't work from a
bare `file://` path).

```bash
cd CC-5
python -m http.server 8080
# open http://localhost:8080
```

Click **PLAY VS BOTS** to start a single-player match against 5 bots.

## Run the multiplayer server

```bash
cd CC-5
npm install
npm start          # listens on http://localhost:3000  (ws://localhost:3000)
```

Then in the game choose **PLAY ONLINE** and enter `ws://localhost:3000`
(or your deployed `wss://<service>.onrender.com`). Open two browser tabs to test.

## Deploy

**Frontend → GitHub Pages:** push this repo to its own GitHub repo and enable
Pages on the default branch. The game is just `index.html`.

**Backend → Render.com:** create a Web Service from this repo (or use the included
`render.yaml` Blueprint). Build `npm install`, start `npm start`. Render injects
`PORT`; the server also answers `GET /` with `200 Game server running` for the
health check. Use the resulting `wss://…onrender.com` URL in **PLAY ONLINE**.

## Git note

This folder is its own independent git repository (`git init` was run here). It is
nested inside the Desktop-level repo that belongs to the separate **CaleSync**
project — that repo is left completely untouched, so CaleSync keeps deploying
normally. The parent repo will simply list `CC-5/` as an untracked folder; don't
`git add` it from the Desktop root.

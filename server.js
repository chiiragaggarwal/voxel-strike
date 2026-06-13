/*
 * voxel-cs — multiplayer WebSocket server
 * ---------------------------------------
 * Single-file Node.js server using only the `ws` package plus the built-in
 * `http` module. Designed for Render.com free tier.
 *
 * --- render.yaml (also shipped as a separate file in this repo) ---
 * services:
 *   - type: web
 *     name: voxel-cs-server
 *     env: node
 *     plan: free
 *     buildCommand: npm install
 *     startCommand: npm start
 *     healthCheckPath: /
 *     autoDeploy: true
 * -----------------------------------------------------------------
 *
 * Deploy notes:
 *  - Render injects PORT via process.env.PORT — we bind to it (fallback 3000).
 *  - GET / returns 200 "Game server running" so Render's health check + the
 *    free-tier keep-alive pinger see the service as live.
 *  - The WebSocket server shares the same HTTP server (single port), which is
 *    required on Render (only one port is exposed).
 *  - Client connects with wss://<your-service>.onrender.com
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// Static files served alongside the WebSocket server (so `node server.js`
// serves the game page too — no separate static server needed for local play).
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon' };

// ---- Authoritative weapon table (mirrors the client) --------------------
// Used to validate `hit` damage so a client can't claim arbitrary damage.
const WEAPONS = {
  ak47:   { damage: 35,  headMult: 4 },
  m4a4:   { damage: 28,  headMult: 4 },
  awp:    { damage: 115, headMult: 1.5 },
  deagle: { damage: 55,  headMult: 4 },
  glock:  { damage: 25,  headMult: 4 },
  knife:  { damage: 100, headMult: 1 },
};

const MAX_PLAYERS_PER_ROOM = 10;
const BOMB_TIMER = 40;      // seconds after plant
const ROUND_TIME = 115;     // 1:55

// ---- HTTP server (health check + static game files) ---------------------
const server = http.createServer((req, res) => {
  // Render health check probe.
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Game server running');
    return;
  }
  // Serve the game page and its assets from this folder.
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(__dirname, path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ''));
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

// ---- Room management -----------------------------------------------------
let nextRoomId = 1;
let nextPlayerId = 1;
const rooms = new Map(); // roomId -> room

function createRoom() {
  const id = 'room' + nextRoomId++;
  const room = {
    id,
    players: new Map(), // playerId -> player
    state: {
      roundNum: 1,
      scores: { CT: 0, T: 0 },
      bombPlanted: false,
      bombTimer: 0,
      bombSite: null,
      defuseProgress: 0,
      roundTime: ROUND_TIME,
      phase: 'waiting', // waiting | live | over
    },
    started: false,
  };
  rooms.set(id, room);
  return room;
}

function findOrCreateRoom() {
  for (const room of rooms.values()) {
    if (room.players.size < MAX_PLAYERS_PER_ROOM && room.state.phase !== 'over') {
      return room;
    }
  }
  return createRoom();
}

function teamCounts(room) {
  let ct = 0, t = 0;
  for (const p of room.players.values()) {
    if (p.team === 'CT') ct++; else t++;
  }
  return { ct, t };
}

function assignTeam(room) {
  const { ct, t } = teamCounts(room);
  return ct <= t ? 'CT' : 'T';
}

function broadcast(room, msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function serializePlayers(room) {
  return Array.from(room.players.values()).map((p) => ({
    id: p.id, name: p.name, team: p.team, health: p.health,
    money: p.money, weapon: p.weapon, pos: p.pos, rot: p.rot,
    alive: p.alive, kills: p.kills, deaths: p.deaths,
  }));
}

// ---- Connection handling -------------------------------------------------
wss.on('connection', (ws) => {
  const room = findOrCreateRoom();
  const team = assignTeam(room);
  const player = {
    id: 'p' + nextPlayerId++,
    ws,
    name: 'Player' + nextPlayerId,
    team,
    health: 100,
    money: 800,
    weapon: team === 'CT' ? 'm4a4' : 'ak47',
    pos: { x: 0, y: 1.8, z: 0 },
    rot: { x: 0, y: 0 },
    alive: true,
    kills: 0,
    deaths: 0,
    roomId: room.id,
  };
  room.players.set(player.id, player);

  // Send join acknowledgement with full initial state
  send(ws, {
    type: 'joined',
    playerId: player.id,
    team: player.team,
    roomId: room.id,
    state: room.state,
    players: serializePlayers(room),
  });

  // Tell everyone else a new player arrived
  broadcast(room, { type: 'playerJoined', player: {
    id: player.id, name: player.name, team: player.team,
    pos: player.pos, rot: player.rot, health: player.health,
    weapon: player.weapon, alive: player.alive,
  } }, player.id);

  if (!room.started && room.players.size >= 2) {
    room.started = true;
    room.state.phase = 'live';
    broadcast(room, { type: 'roundStart', state: room.state });
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(room, player, msg);
  });

  ws.on('close', () => {
    room.players.delete(player.id);
    broadcast(room, { type: 'playerLeft', playerId: player.id });
    if (room.players.size === 0) rooms.delete(room.id);
  });

  ws.on('error', () => {});
});

function handleMessage(room, player, msg) {
  switch (msg.type) {
    case 'move':
      player.pos = msg.pos || player.pos;
      player.rot = msg.rot || player.rot;
      broadcast(room, {
        type: 'move', id: player.id,
        pos: player.pos, rot: player.rot, vel: msg.vel,
      }, player.id);
      break;

    case 'shoot':
      broadcast(room, {
        type: 'shoot', id: player.id,
        origin: msg.origin, direction: msg.direction, weapon: player.weapon,
      }, player.id);
      break;

    case 'hit': {
      const target = room.players.get(msg.targetId);
      if (!target || !target.alive) break;
      // Server-side damage validation against the weapon table.
      const w = WEAPONS[player.weapon] || WEAPONS.glock;
      let dmg = w.damage;
      if (msg.headshot) dmg = Math.round(dmg * w.headMult);
      target.health -= dmg;
      if (target.health <= 0) {
        target.health = 0;
        target.alive = false;
        target.deaths++;
        player.kills++;
        player.money = Math.min(16000, player.money + 300);
        broadcast(room, {
          type: 'kill', killerId: player.id, victimId: target.id,
          weapon: player.weapon, headshot: !!msg.headshot,
        });
        checkRoundEnd(room);
      }
      broadcast(room, {
        type: 'health', id: target.id, health: target.health, by: player.id,
      });
      break;
    }

    case 'plant':
      if (!room.state.bombPlanted && player.team === 'T') {
        room.state.bombPlanted = true;
        room.state.bombTimer = BOMB_TIMER;
        room.state.bombSite = msg.site || 'A';
        player.money = Math.min(16000, player.money + 300);
        broadcast(room, { type: 'bombPlanted', site: room.state.bombSite, by: player.id });
      }
      break;

    case 'defuse':
      if (room.state.bombPlanted && player.team === 'CT') {
        room.state.defuseProgress = msg.progress || 0;
        if (msg.complete) {
          room.state.bombPlanted = false;
          room.state.scores.CT++;
          broadcast(room, { type: 'bombDefused', by: player.id, state: room.state });
          endRound(room, 'CT');
        } else {
          broadcast(room, { type: 'defuseProgress', progress: room.state.defuseProgress, by: player.id });
        }
      }
      break;

    case 'buy': {
      const cost = msg.cost || 0;
      if (player.money >= cost && WEAPONS[msg.weapon]) {
        player.money -= cost;
        player.weapon = msg.weapon;
        broadcast(room, { type: 'buy', id: player.id, weapon: player.weapon, money: player.money });
      }
      break;
    }

    case 'respawn':
      player.alive = true;
      player.health = 100;
      player.pos = msg.pos || player.pos;
      broadcast(room, { type: 'respawn', id: player.id, pos: player.pos });
      break;

    case 'name':
      if (typeof msg.name === 'string') player.name = msg.name.slice(0, 16);
      break;
  }
}

function aliveCount(room) {
  let ct = 0, t = 0;
  for (const p of room.players.values()) {
    if (!p.alive) continue;
    if (p.team === 'CT') ct++; else t++;
  }
  return { ct, t };
}

function checkRoundEnd(room) {
  if (room.state.phase !== 'live') return;
  const { ct, t } = aliveCount(room);
  if (t === 0 && room.players.size > 1) {
    room.state.scores.CT++;
    endRound(room, 'CT');
  } else if (ct === 0 && room.players.size > 1) {
    room.state.scores.T++;
    endRound(room, 'T');
  }
}

function endRound(room, winner) {
  room.state.phase = 'over';
  broadcast(room, { type: 'roundEnd', winner, state: room.state });
  setTimeout(() => startNextRound(room), 5000);
}

function startNextRound(room) {
  if (!rooms.has(room.id)) return;
  room.state.roundNum++;
  room.state.bombPlanted = false;
  room.state.bombTimer = 0;
  room.state.bombSite = null;
  room.state.defuseProgress = 0;
  room.state.roundTime = ROUND_TIME;
  room.state.phase = 'live';
  for (const p of room.players.values()) {
    p.alive = true;
    p.health = 100;
  }
  broadcast(room, { type: 'roundStart', state: room.state, players: serializePlayers(room) });
}

// ---- Server tick loops ---------------------------------------------------
// Broadcast a compact game-state snapshot every 100ms.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.players.size === 0) continue;
    broadcast(room, {
      type: 'state',
      state: {
        roundNum: room.state.roundNum,
        scores: room.state.scores,
        bombPlanted: room.state.bombPlanted,
        bombTimer: Math.ceil(room.state.bombTimer),
        bombSite: room.state.bombSite,
        phase: room.state.phase,
        roundTime: Math.ceil(room.state.roundTime),
      },
    });
  }
}, 100);

// Round/bomb logic ticks every second.
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state.phase !== 'live') continue;

    if (room.state.bombPlanted) {
      room.state.bombTimer -= 1;
      if (room.state.bombTimer <= 0) {
        room.state.scores.T++;
        broadcast(room, { type: 'bombExploded', state: room.state });
        endRound(room, 'T');
      }
    } else {
      room.state.roundTime -= 1;
      if (room.state.roundTime <= 0) {
        // Time out with no bomb planted → CT win.
        room.state.scores.CT++;
        endRound(room, 'CT');
      }
    }
  }
}, 1000);

server.listen(PORT, () => {
  console.log(`voxel-cs server running on port ${PORT}`);
});

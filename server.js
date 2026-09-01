// server.js
// The transport layer, and nothing else. Every rule of the game lives in
// public/game.js, which offline mode runs too - so the two cannot drift apart.

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const Shared = require('./public/shared.js');
const { GameHost } = require('./public/game.js');
const { spawnBots, driveBots } = require('./public/bots.js');

const { CONFIG } = Shared;

// Match length, score limit and bot count can be set without touching code.
if (process.env.ARENA_SCORE_LIMIT) CONFIG.SCORE_LIMIT = Number(process.env.ARENA_SCORE_LIMIT);
if (process.env.ARENA_ROUND_MS) CONFIG.ROUND_MS = Number(process.env.ARENA_ROUND_MS);
if (process.env.ARENA_INTERMISSION_MS) CONFIG.INTERMISSION_MS = Number(process.env.ARENA_INTERMISSION_MS);
if (process.env.ARENA_MAX_PLAYERS) CONFIG.MAX_PLAYERS = Number(process.env.ARENA_MAX_PLAYERS);

const BOT_COUNT = Number(process.env.ARENA_BOTS || 0);
const BOT_SKILL = process.env.ARENA_BOT_SKILL || 'regular';

// ---------------------------------------------------------------------------

const sockets = new Map();     // playerId -> WebSocket

const host = new GameHost({
  send: (id, msg) => {
    const ws = sockets.get(id);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
});

// Optional bots, so an empty server is still worth joining
const bots = BOT_COUNT > 0 ? spawnBots(host, BOT_COUNT, BOT_SKILL) : [];
if (bots.length) console.log(`${bots.length} bots added (${BOT_SKILL})`);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({
  ok: true,
  players: host.humanCount(),
  bots: bots.length,
  phase: host.match.phase
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const TICK_MS = 1000 / CONFIG.TICK_HZ;
setInterval(() => {
  if (bots.length) driveBots(host, bots, TICK_MS / 1000);
  host.tick();
}, TICK_MS);

setInterval(() => host.pingAll(), 2500);

wss.on('connection', (socket) => {
  let myId = null;

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (myId === null) {
      if (msg.type !== 'join') return;
      const joined = host.join(msg.name);
      if (!joined) {
        socket.send(JSON.stringify({ type: 'full' }));
        socket.close();
        return;
      }
      myId = joined.id;
      sockets.set(myId, socket);
      socket.send(JSON.stringify(joined.welcome));
      console.log(`${joined.player.name} joined ${joined.player.team} ` +
        `(${host.humanCount()} human, ${bots.length} bots)`);
      return;
    }

    host.handle(myId, msg);
  });

  socket.on('close', () => {
    if (myId === null) return;
    const p = host.players.get(myId);
    sockets.delete(myId);
    host.leave(myId);
    console.log(`${p ? p.name : myId} left (${host.humanCount()} human)`);
  });

  socket.on('error', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Arena on http://localhost:${PORT}`));

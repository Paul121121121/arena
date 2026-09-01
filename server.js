// server.js
// The referee. Every browser connects here; nobody talks to anybody else.
//
// The rule that keeps this honest: clients send INPUTS ("I am holding W",
// "I clicked at this angle"), never results ("I am at x=5", "I killed Bob").
// The server owns positions, damage, ammo and score.

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const Shared = require('./public/shared.js');

const { CONFIG, MAP, WEAPONS } = Shared;

// Match length and score limit can be overridden without touching the code -
// handy for a quick test round, or for a server that wants shorter games.
if (process.env.ARENA_SCORE_LIMIT) CONFIG.SCORE_LIMIT = Number(process.env.ARENA_SCORE_LIMIT);
if (process.env.ARENA_ROUND_MS) CONFIG.ROUND_MS = Number(process.env.ARENA_ROUND_MS);
if (process.env.ARENA_INTERMISSION_MS) CONFIG.INTERMISSION_MS = Number(process.env.ARENA_INTERMISSION_MS);
if (process.env.ARENA_MAX_PLAYERS) CONFIG.MAX_PLAYERS = Number(process.env.ARENA_MAX_PLAYERS);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ ok: true, players: players.size, phase: match.phase }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const players = new Map();
let nextId = 1;
let tick = 0;

const match = {
  phase: 'live',          // 'live' or 'intermission'
  scores: { a: 0, b: 0 },
  endsAt: Date.now() + CONFIG.ROUND_MS,
  number: 1
};

const now = () => Date.now();

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

// Shuffle everyone into fresh teams. Called when a match starts, so the
// same two people are not stuck on the same side forever.
function randomiseTeams() {
  const assignment = Shared.balancedShuffle([...players.keys()]);
  for (const id in assignment) players.get(Number(id)).team = assignment[id];
}

// A single player joining mid-match goes to whichever side is short.
function assignTeam() {
  let a = 0, b = 0;
  for (const p of players.values()) p.team === 'a' ? a++ : b++;
  if (a === b) return Math.random() < 0.5 ? 'a' : 'b';
  return a < b ? 'a' : 'b';
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

function pickSpawn(team) {
  const list = MAP.spawns[team];
  let best = list[0], bestScore = -Infinity;
  for (const s of list) {
    let score = Infinity;
    for (const p of players.values()) {
      if (!p.alive) continue;
      const d = Math.hypot(p.x - s.x, p.z - s.z);
      // Enemies nearby are bad; teammates on the exact spot are also bad.
      const weight = p.team === team ? 0.35 : 1;
      score = Math.min(score, d * weight);
    }
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return best;
}

function freshLoadout() {
  return WEAPONS.map(w => ({ ammo: w.mag, reserve: w.reserve }));
}

function makePlayer(id, name, team) {
  const s = pickSpawn(team);
  return {
    id, name, team,
    x: s.x, y: 0, z: s.z, vx: 0, vy: 0, vz: 0,
    yaw: s.yaw, pitch: 0, crouch: false, ads: false, onGround: true,

    health: CONFIG.MAX_HEALTH,
    alive: true,
    respawnAt: 0,
    protectedUntil: now() + CONFIG.SPAWN_PROTECT_MS,

    weapon: 0,
    loadout: freshLoadout(),
    consecutive: 0,          // shots fired without a pause, drives spread
    lastShotAt: 0,
    reloadingUntil: 0,
    switchingUntil: 0,

    kills: 0, deaths: 0, assists: 0, damageDealt: 0,
    recentDamage: new Map(),  // attackerId -> { amount, at } for assists

    lastSeq: 0,
    inputQueue: [],
    // How much simulation time this client is allowed to consume. It refills
    // at real time (with a little slack for jitter). Without this, a client
    // that simply sends inputs faster than 60/s would move faster than
    // everyone else - the server would happily simulate every one of them.
    budget: 0.2,
    history: [],
    rtt: 60,
    socket: null
  };
}

function respawn(p) {
  const s = pickSpawn(p.team);
  p.x = s.x; p.y = 0; p.z = s.z;
  p.vx = p.vy = p.vz = 0;
  p.yaw = s.yaw; p.pitch = 0;
  p.crouch = false;
  p.health = CONFIG.MAX_HEALTH;
  p.alive = true;
  p.loadout = freshLoadout();
  p.weapon = 0;
  p.consecutive = 0;
  p.reloadingUntil = 0;
  p.switchingUntil = 0;
  p.protectedUntil = now() + CONFIG.SPAWN_PROTECT_MS;
  p.recentDamage.clear();
  p.history.length = 0;
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function send(p, msg) {
  if (p.socket && p.socket.readyState === 1) p.socket.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const p of players.values()) {
    if (p.socket && p.socket.readyState === 1) p.socket.send(s);
  }
}

function rosterEntry(p) {
  return { id: p.id, name: p.name, team: p.team, k: p.kills, d: p.deaths, a: p.assists };
}

function sendRoster() {
  broadcast({ type: 'roster', players: [...players.values()].map(rosterEntry) });
}

// ---------------------------------------------------------------------------
// Lag compensation
//
// You shoot at what you SEE, and what you see is about half a ping old plus
// the 100ms we deliberately hold other players back by to keep them smooth.
// So before testing a shot, rewind everyone else to that moment.
// ---------------------------------------------------------------------------

function recordHistory(p, t) {
  p.history.push({ t, x: p.x, y: p.y, z: p.z, crouch: p.crouch });
  while (p.history.length && t - p.history[0].t > 1200) p.history.shift();
}

function positionAt(p, t) {
  const h = p.history;
  if (!h.length) return { x: p.x, y: p.y, z: p.z, crouch: p.crouch };
  if (t >= h[h.length - 1].t) return h[h.length - 1];
  if (t <= h[0].t) return h[0];
  for (let i = h.length - 1; i > 0; i--) {
    if (h[i - 1].t <= t && t <= h[i].t) {
      const a = h[i - 1], b = h[i];
      const span = b.t - a.t;
      const f = span > 0 ? (t - a.t) / span : 0;
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
        crouch: b.crouch
      };
    }
  }
  return h[h.length - 1];
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

// Nudge a direction sideways by a random amount inside a cone.
function applySpread(d, spread) {
  if (spread <= 0) return d;
  // Build any two axes perpendicular to the aim direction
  let ux = -d.z, uy = 0, uz = d.x;
  let ul = Math.hypot(ux, uy, uz);
  if (ul < 1e-6) { ux = 1; uy = 0; uz = 0; ul = 1; }   // aiming straight up or down
  ux /= ul; uy /= ul; uz /= ul;
  const vx = d.y * uz - d.z * uy;
  const vy = d.z * ux - d.x * uz;
  const vz = d.x * uy - d.y * ux;

  const ang = Math.random() * Math.PI * 2;
  // sqrt keeps the scatter even across the circle instead of clumped centre
  const mag = Math.sqrt(Math.random()) * spread;
  const ox = Math.cos(ang) * mag, oy = Math.sin(ang) * mag;

  const rx = d.x + ux * ox + vx * oy;
  const ry = d.y + uy * ox + vy * oy;
  const rz = d.z + uz * ox + vz * oy;
  const l = Math.hypot(rx, ry, rz);
  return { x: rx / l, y: ry / l, z: rz / l };
}

function creditAssists(victim, killerId) {
  const t = now();
  for (const [attackerId, rec] of victim.recentDamage) {
    if (attackerId === killerId) continue;
    if (t - rec.at > 8000) continue;
    if (rec.amount < 25) continue;
    const a = players.get(attackerId);
    if (a && a.team !== victim.team) a.assists++;
  }
}

function handleShot(shooter) {
  const t = now();
  if (!shooter.alive || match.phase !== 'live') return;
  if (t < shooter.reloadingUntil || t < shooter.switchingUntil) return;

  const w = WEAPONS[shooter.weapon];
  const slot = shooter.loadout[shooter.weapon];

  if (t - shooter.lastShotAt < w.fireMs - 6) return;   // server enforces rate of fire
  if (slot.ammo <= 0) { send(shooter, { type: 'dryfire' }); return; }

  shooter.lastShotAt = t;
  slot.ammo--;

  // Firing gives away spawn protection
  shooter.protectedUntil = 0;

  const d0 = Shared.dims(shooter.crouch);
  const eye = { x: shooter.x, y: shooter.y + d0.eye, z: shooter.z };
  const aim = Shared.dirFromAngles(shooter.yaw, shooter.pitch);

  const spread = Shared.currentSpread(w, {
    consecutive: shooter.consecutive,
    vx: shooter.vx, vz: shooter.vz,
    onGround: shooter.onGround,
    crouch: shooter.crouch,
    ads: shooter.ads
  });
  shooter.consecutive++;

  const rewindTo = t - Math.min(shooter.rtt / 2, 250) - CONFIG.INTERP_MS;

  // Snapshot every enemy's rewound position once, then test each pellet.
  const targets = [];
  for (const other of players.values()) {
    if (other === shooter || !other.alive) continue;
    if (other.team === shooter.team) continue;         // no friendly fire
    if (other.protectedUntil > t) continue;            // just spawned
    targets.push({ p: other, at: positionAt(other, rewindTo) });
  }

  const beams = [];
  const damageByTarget = new Map();

  for (let i = 0; i < w.pellets; i++) {
    const d = applySpread(aim, spread);
    const wall = Shared.rayWall(eye.x, eye.y, eye.z, d.x, d.y, d.z, w.range);

    let hit = null;
    for (const tg of targets) {
      const r = Shared.rayPlayer(eye.x, eye.y, eye.z, d.x, d.y, d.z,
        tg.at.x, tg.at.y, tg.at.z, tg.at.crouch);
      if (r && r.t < wall.t && (!hit || r.t < hit.t)) hit = { t: r.t, zone: r.zone, target: tg.p };
    }

    const end = hit ? hit.t : wall.t;
    beams.push({
      ex: +(eye.x + d.x * end).toFixed(2),
      ey: +(eye.y + d.y * end).toFixed(2),
      ez: +(eye.z + d.z * end).toFixed(2),
      s: hit ? 'flesh' : (wall.kind || 'air'),
      nx: hit ? 0 : wall.nx, ny: hit ? 0 : wall.ny, nz: hit ? 0 : wall.nz
    });

    if (hit) {
      const dmg = Shared.damageAt(w, hit.zone, hit.t);
      const cur = damageByTarget.get(hit.target) || { amount: 0, head: false };
      cur.amount += dmg;
      if (hit.zone === 'head') cur.head = true;
      damageByTarget.set(hit.target, cur);
    }
  }

  broadcast({
    type: 'shot',
    id: shooter.id,
    w: w.id,
    ox: +eye.x.toFixed(2), oy: +eye.y.toFixed(2), oz: +eye.z.toFixed(2),
    beams: beams
  });
  send(shooter, { type: 'ammo', ammo: slot.ammo, reserve: slot.reserve });

  for (const [target, info] of damageByTarget) {
    const dmg = Math.round(info.amount);
    target.health -= dmg;
    shooter.damageDealt += dmg;

    const rec = target.recentDamage.get(shooter.id) || { amount: 0, at: 0 };
    rec.amount += dmg; rec.at = t;
    target.recentDamage.set(shooter.id, rec);

    send(shooter, { type: 'hitmarker', head: info.head, dmg: dmg, lethal: target.health <= 0 });
    send(target, {
      type: 'hurt', health: Math.max(0, target.health), by: shooter.name,
      fx: shooter.x, fz: shooter.z
    });

    if (target.health <= 0) {
      target.alive = false;
      target.deaths++;
      target.respawnAt = t + CONFIG.RESPAWN_MS;
      shooter.kills++;
      match.scores[shooter.team]++;
      creditAssists(target, shooter.id);

      broadcast({
        type: 'kill',
        killer: shooter.name, killerId: shooter.id, killerTeam: shooter.team,
        victim: target.name, victimId: target.id, victimTeam: target.team,
        weapon: w.id, head: info.head,
        dist: Math.round(Math.hypot(shooter.x - target.x, shooter.z - target.z))
      });
      broadcast({ type: 'score', scores: match.scores });
      sendRoster();

      if (match.scores[shooter.team] >= CONFIG.SCORE_LIMIT) endMatch(shooter.team);
    }
  }
}

// ---------------------------------------------------------------------------
// Match flow
// ---------------------------------------------------------------------------

function startMatch() {
  match.phase = 'live';
  match.scores = { a: 0, b: 0 };
  match.endsAt = now() + CONFIG.ROUND_MS;
  match.number++;

  randomiseTeams();                        // fresh sides every match
  for (const p of players.values()) {
    p.kills = 0; p.deaths = 0; p.assists = 0; p.damageDealt = 0;
    respawn(p);
  }

  broadcast({
    type: 'match-start',
    number: match.number,
    endsAt: match.endsAt,
    scores: match.scores,
    teams: Object.fromEntries([...players.values()].map(p => [p.id, p.team]))
  });
  sendRoster();
  for (const p of players.values()) {
    send(p, { type: 'respawn', x: p.x, y: p.y, z: p.z, yaw: p.yaw, team: p.team });
  }
  console.log(`Match ${match.number} started`);
}

function endMatch(winner) {
  match.phase = 'intermission';
  match.endsAt = now() + CONFIG.INTERMISSION_MS;
  broadcast({
    type: 'match-end',
    winner: winner,
    scores: match.scores,
    nextIn: CONFIG.INTERMISSION_MS,
    stats: [...players.values()]
      .map(p => ({ name: p.name, team: p.team, k: p.kills, d: p.deaths, a: p.assists, dmg: p.damageDealt }))
      .sort((x, y) => y.k - x.k)
  });
  console.log(`Match ${match.number} won by ${winner || 'nobody'} (${match.scores.a}-${match.scores.b})`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const TICK_MS = 1000 / CONFIG.TICK_HZ;
const SNAP_EVERY = Math.max(1, Math.round(CONFIG.TICK_HZ / CONFIG.SNAPSHOT_HZ));
const SPREAD_RECOVER_DELAY_MS = 90;

setInterval(() => {
  const t = now();
  tick++;

  if (match.phase === 'intermission' && t >= match.endsAt) {
    if (players.size > 0) startMatch();
    else match.endsAt = t + CONFIG.INTERMISSION_MS;
  }
  if (match.phase === 'live' && t >= match.endsAt) {
    endMatch(match.scores.a === match.scores.b ? null
      : match.scores.a > match.scores.b ? 'a' : 'b');
  }

  for (const p of players.values()) {
    if (!p.alive) {
      if (match.phase === 'live' && t >= p.respawnAt) {
        respawn(p);
        send(p, { type: 'respawn', x: p.x, y: p.y, z: p.z, yaw: p.yaw, team: p.team });
      }
      continue;
    }

    // Reload lands
    if (p.reloadingUntil && t >= p.reloadingUntil) {
      p.reloadingUntil = 0;
      const w = WEAPONS[p.weapon], slot = p.loadout[p.weapon];
      const want = w.mag - slot.ammo;
      const take = Math.min(want, slot.reserve);
      slot.ammo += take;
      slot.reserve -= take;
      p.consecutive = 0;
      send(p, { type: 'ammo', ammo: slot.ammo, reserve: slot.reserve, reloaded: true });
    }

    // Spread recovers when you stop shooting
    // Spread recovers once you stop shooting. The client runs the identical
    // formula so the crosshair matches the cone the server will actually use.
    const w = WEAPONS[p.weapon];
    if (p.consecutive > 0 && t - p.lastShotAt > SPREAD_RECOVER_DELAY_MS) {
      p.consecutive = Math.max(0, p.consecutive - w.spreadRecover * (TICK_MS / 1000) * 10);
    }

    // Refill the movement budget for this tick
    p.budget = Math.min(0.25, p.budget + (TICK_MS / 1000) * 1.15);

    const queue = p.inputQueue;
    p.inputQueue = [];
    for (const input of queue) {
      if (input.seq <= p.lastSeq) continue;
      p.ads = !!input.ads;
      // Spend from the budget. A client flooding inputs runs out and its
      // extra inputs simulate as zero time, so flooding buys nothing.
      const allowed = Math.min(input.dt, Math.max(0, p.budget));
      p.budget -= input.dt;
      Shared.stepPlayer(p, input, allowed, w);
      p.onGround = p.y <= Shared.groundHeight(p.x, p.z, p.y) + 0.03;
      p.lastSeq = input.seq;
      if (input.shoot && match.phase === 'live') handleShot(p);
    }

    recordHistory(p, t);
  }

  if (tick % SNAP_EVERY === 0) {
    const list = [];
    for (const p of players.values()) {
      list.push({
        id: p.id,
        x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3),
        yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
        c: p.crouch ? 1 : 0,
        sp: Math.round(Math.hypot(p.vx, p.vz) * 10) / 10,
        h: p.health, al: p.alive ? 1 : 0,
        w: p.weapon,
        pr: p.protectedUntil > now() ? 1 : 0,
        seq: p.lastSeq
      });
    }
    const snap = JSON.stringify({ type: 'snapshot', t, players: list });
    for (const p of players.values()) {
      if (p.socket && p.socket.readyState === 1) p.socket.send(snap);
    }
  }
}, TICK_MS);

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

wss.on('connection', (socket) => {
  let player = null;

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (!player) {
      if (msg.type !== 'join') return;
      if (players.size >= CONFIG.MAX_PLAYERS) {
        socket.send(JSON.stringify({ type: 'full' }));
        socket.close();
        return;
      }
      const name = String(msg.name || 'player').slice(0, 14).replace(/[<>&"']/g, '').trim() || 'player';
      const team = assignTeam();
      player = makePlayer(nextId++, name, team);
      player.socket = socket;
      players.set(player.id, player);

      socket.send(JSON.stringify({
        type: 'welcome',
        id: player.id,
        team: team,
        config: CONFIG,
        weapons: WEAPONS,
        map: MAP,
        match: { phase: match.phase, scores: match.scores, endsAt: match.endsAt, number: match.number },
        you: { x: player.x, y: player.y, z: player.z, yaw: player.yaw },
        players: [...players.values()].map(rosterEntry)
      }));

      broadcast({ type: 'joined', id: player.id, name: player.name, team: team });
      sendRoster();

      // First player in an empty server kicks off a match
      if (players.size === 1 && match.phase === 'intermission') startMatch();
      console.log(`${player.name} joined ${team} (${players.size}/${CONFIG.MAX_PLAYERS})`);
      return;
    }

    switch (msg.type) {
      case 'input': {
        if (typeof msg.seq !== 'number' || !isFinite(msg.seq)) return;
        if (player.inputQueue.length > 70) return;     // flood guard
        player.inputQueue.push({
          seq: msg.seq,
          dt: Math.min(Math.max(Number(msg.dt) || 0, 0), CONFIG.MAX_INPUT_DT),
          forward: Math.max(-1, Math.min(1, Number(msg.forward) || 0)),
          right: Math.max(-1, Math.min(1, Number(msg.right) || 0)),
          jump: !!msg.jump,
          crouch: !!msg.crouch,
          sprint: !!msg.sprint,
          ads: !!msg.ads,
          shoot: !!msg.shoot,
          yaw: isFinite(msg.yaw) ? Number(msg.yaw) : player.yaw,
          pitch: Math.max(-1.54, Math.min(1.54, Number(msg.pitch) || 0))
        });
        break;
      }

      case 'switch': {
        const i = Number(msg.slot);
        if (!Number.isInteger(i) || i < 0 || i >= WEAPONS.length) return;
        if (i === player.weapon) return;
        const t = now();
        if (t < player.switchingUntil) return;
        player.weapon = i;
        player.reloadingUntil = 0;
        player.consecutive = 0;
        player.switchingUntil = t + WEAPONS[i].drawMs;
        const slot = player.loadout[i];
        send(player, {
          type: 'weapon', slot: i, drawMs: WEAPONS[i].drawMs,
          ammo: slot.ammo, reserve: slot.reserve
        });
        break;
      }

      case 'reload': {
        const t = now();
        const w = WEAPONS[player.weapon], slot = player.loadout[player.weapon];
        if (!player.alive || player.reloadingUntil || t < player.switchingUntil) break;
        if (slot.ammo >= w.mag || slot.reserve <= 0) break;
        player.reloadingUntil = t + w.reloadMs;
        send(player, { type: 'reloading', ms: w.reloadMs });
        break;
      }

      case 'pong': {
        const rtt = now() - (Number(msg.t) || now());
        player.rtt = player.rtt * 0.8 + Math.max(0, Math.min(600, rtt)) * 0.2;
        send(player, { type: 'ping', value: Math.round(player.rtt) });
        break;
      }
    }
  });

  socket.on('close', () => {
    if (!player) return;
    players.delete(player.id);
    broadcast({ type: 'left', id: player.id, name: player.name });
    sendRoster();
    console.log(`${player.name} left (${players.size}/${CONFIG.MAX_PLAYERS})`);
  });

  socket.on('error', () => {});
});

setInterval(() => {
  for (const p of players.values()) send(p, { type: 'ping-request', t: now() });
}, 2500);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Arena on http://localhost:${PORT}`));
